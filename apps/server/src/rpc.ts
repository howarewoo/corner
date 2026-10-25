import { ORPCError } from '@orpc/client';
import { StandardRPCJsonSerializer, StandardRPCSerializer } from '@orpc/client/standard';
import { implement, ValidationError } from '@orpc/server';
import { StandardRPCHandler } from '@orpc/server/standard';
import { toFetchResponse, toStandardHeaders } from '@orpc/standard-server-fetch';
import { contract } from '@packages/api/contract';
import { RPC_PREFIX } from '@packages/api/protocol';
import { mutationInputSchema } from '@packages/api/schemas';
import { z } from 'zod';
import { accountPolicy, requirePrincipal, type CornerAuth, type Principal } from './auth.js';
import type { Config } from './config.js';
import { ApiError, json, readJson, requireSameOrigin } from './http.js';
import { connectionDTO } from './ai-routes.js';
import { AgentError, type PlanningAgent } from './planning-agent.js';
import { SubscriptionError, type SubscriptionProvider } from './subscription.js';
import { isEmptyWorkspace, type WorkspaceSnapshot, type WorkspaceStore } from './store.js';

export type RPCServices = {
  config: Config;
  auth: CornerAuth;
  store: WorkspaceStore;
  aiAvailable?: (principal: Principal) => Promise<boolean> | boolean;
  ai?: { provider: SubscriptionProvider; agent: PlanningAgent };
};
type RPCContext = { request: Request; principal?: Principal };
const serializer = new StandardRPCSerializer(new StandardRPCJsonSerializer());
const metadata = new Map<string, { maxBodyBytes: number; public: boolean }>(
  Object.entries(contract).flatMap(([group, procedures]) =>
    Object.entries(procedures).map(
      ([name, procedure]) => [`${RPC_PREFIX}/${group}/${name}`, procedure['~orpc'].meta] as const,
    ),
  ),
);

function rpcError(error: unknown): ORPCError<string, unknown> {
  if (
    error instanceof ApiError ||
    error instanceof AgentError ||
    error instanceof SubscriptionError
  ) {
    if (error.code === 'SIGN_IN_REQUIRED')
      return new ORPCError('SIGN_IN_REQUIRED', {
        status: 401,
        message: error.message,
        defined: true,
      });
    return new ORPCError('CORNER_ERROR', {
      status: error.status,
      message: error.message,
      data: { code: error.code },
      defined: true,
    });
  }
  if (
    error instanceof z.ZodError ||
    (error instanceof ORPCError &&
      error.code === 'BAD_REQUEST' &&
      error.cause instanceof ValidationError)
  ) {
    const issues =
      error instanceof z.ZodError ? error.issues : (error.cause as ValidationError).issues;
    return new ORPCError('CORNER_ERROR', {
      status: 400,
      message: 'Check the fields and try again.',
      defined: true,
      data: {
        code: 'INVALID_INPUT',
        details: issues.slice(0, 4).map((issue) => ({
          field: (issue.path ?? [])
            .map((part) => (typeof part === 'object' ? part.key : part))
            .join('.'),
          message: issue.message,
        })),
      },
    });
  }
  if (error instanceof ORPCError && error.code === 'BAD_REQUEST')
    return new ORPCError('CORNER_ERROR', {
      status: 400,
      message: 'The request is not valid JSON.',
      data: { code: 'INVALID_JSON' },
      defined: true,
    });
  if (
    error instanceof ORPCError &&
    ['CORNER_ERROR', 'SIGN_IN_REQUIRED', 'SERVICE_UNAVAILABLE'].includes(error.code)
  )
    return error;
  return new ORPCError('SERVICE_UNAVAILABLE', {
    status: 503,
    message: 'This request could not be completed. Please try again.',
    defined: true,
  });
}

/** Both early HTTP failures and procedure failures use the native RPC envelope. */
export function rpcErrorResponse(error: unknown): Response {
  const failure = rpcError(error);
  return json(serializer.serialize(failure.toJSON()), failure.status);
}

/** Keep persistence, ownership, request fingerprints, and provider lifecycle in their existing services. */
export function createRPCHandler({ config, auth, store, aiAvailable, ai }: RPCServices) {
  function principal(context: RPCContext): Principal {
    if (!context.principal)
      throw new ApiError(401, 'SIGN_IN_REQUIRED', 'Sign in to open your workspace.');
    return context.principal;
  }
  function services() {
    if (!ai)
      throw new ApiError(503, 'AI_NOT_CONFIGURED', 'AI is not configured for this installation.');
    return ai;
  }
  async function stateResponse(owner: Principal, snapshot?: WorkspaceSnapshot) {
    return {
      ...(snapshot ?? (await store.read(owner.userId, owner.name))),
      aiAvailable: Boolean(await aiAvailable?.(owner)),
    };
  }
  async function available(owner: Principal) {
    const status = connectionDTO(await services().provider.status(owner.userId));
    if (!status.available)
      throw new ApiError(
        503,
        'AI_CONNECTION_REQUIRED',
        status.reason || 'Connect your ChatGPT plan and select a model in My agent.',
      );
  }
  const api = implement(contract).$context<RPCContext>();
  const router = api.router({
    account: {
      policy: api.account.policy.handler(() => accountPolicy(config)),
      session: api.account.session.handler(async ({ context }) => {
        const owner = await auth.principal(context.request);
        return { user: owner ? { id: owner.userId, name: owner.name, email: owner.email } : null };
      }),
    },
    workspace: {
      get: api.workspace.get.handler(({ context }) => stateResponse(principal(context))),
      mutate: api.workspace.mutate.handler(async ({ input, context }) => {
        const raw = mutationInputSchema.parse(input);
        const owner = principal(context);
        return stateResponse(
          owner,
          await store.mutate(owner.userId, raw.requestId, raw.mutation, raw.expectedRevision),
        );
      }),
      previewImport: api.workspace.previewImport.handler(async ({ input, context }) => {
        const owner = principal(context);
        const inspected = store.inspectImport(input.state);
        const current = await store.read(owner.userId, owner.name);
        return {
          summary: { ...inspected.counts, bytes: inspected.bytes },
          canImport: isEmptyWorkspace(current.state),
          revision: current.revision,
        };
      }),
      import: api.workspace.import.handler(async ({ input, context }) => {
        const owner = principal(context);
        return stateResponse(
          owner,
          await store.replaceImport(
            owner.userId,
            input.requestId,
            input.state,
            input.expectedRevision,
          ),
        );
      }),
    },
    ai: {
      connection: api.ai.connection.handler(async ({ context }) => {
        const { provider } = services();
        const owner = principal(context);
        const status = await provider.status(owner.userId);
        if (status.connected && status.planEnabled) {
          try {
            await provider.models(owner.userId);
          } catch (error) {
            if (error instanceof SubscriptionError)
              return {
                ...connectionDTO(await provider.status(owner.userId)),
                available: false,
                reason: error.message,
              };
            throw error;
          }
        }
        return connectionDTO(await provider.status(owner.userId));
      }),
      connect: api.ai.connect.handler(({ context }) => {
        const owner = principal(context);
        return services().provider.begin(owner.userId, owner.sessionId);
      }),
      disconnect: api.ai.disconnect.handler(async ({ context }) => {
        const { provider, agent } = services();
        const owner = principal(context);
        for (const run of (await agent.list(owner.userId)).filter(
          (run) => run.status === 'running',
        ))
          await agent.cancel(owner.userId, run.id);
        const status = await provider.disconnect(owner.userId);
        return { ...connectionDTO(status), revocationConfirmed: status.revocationConfirmed };
      }),
      setModel: api.ai.setModel.handler(async ({ input, context }) =>
        connectionDTO(await services().provider.setModel(principal(context).userId, input.model)),
      ),
      generateRecipe: api.ai.generateRecipe.handler(async ({ input, context }) => {
        const owner = principal(context);
        const { agent } = services();
        if (!(await agent.hasRequest(owner.userId, 'recipe', input))) await available(owner);
        const result = await agent.generateRecipe(owner.userId, input);
        return { recipe: result.recipe, draft: true as const };
      }),
      estimateFood: api.ai.estimateFood.handler(async ({ input, context }) => {
        const owner = principal(context);
        const { agent } = services();
        if (!(await agent.hasRequest(owner.userId, 'food', input))) await available(owner);
        const result = await agent.estimateFood(owner.userId, input);
        return { estimate: result.estimate };
      }),
    },
    agent: {
      list: api.agent.list.handler(async ({ context }) => ({
        runs: await services().agent.list(principal(context).userId),
      })),
      get: api.agent.get.handler(async ({ input, context }) => ({
        run: await services().agent.get(principal(context).userId, input.id),
      })),
      start: api.agent.start.handler(async ({ input, context }) => {
        const owner = principal(context);
        const { agent } = services();
        if (!(await agent.hasRequest(owner.userId, 'plan', input))) await available(owner);
        return { run: await agent.start(owner.userId, input) };
      }),
      cancel: api.agent.cancel.handler(async ({ input, context }) => ({
        run: await services().agent.cancel(principal(context).userId, input.id),
      })),
      apply: api.agent.apply.handler(async ({ input, context }) => {
        const owner = principal(context);
        return {
          ...(await services().agent.apply(owner.userId, input.id, input.requestId)),
          aiAvailable: connectionDTO(await services().provider.status(owner.userId)).available,
        };
      }),
    },
  });
  const handler = new StandardRPCHandler(router, {
    interceptors: [
      async ({ next }) => {
        try {
          return await next();
        } catch (error) {
          throw rpcError(error);
        }
      },
    ],
  });
  return async (request: Request): Promise<Response> => {
    try {
      const meta = metadata.get(new URL(request.url).pathname);
      const owner = meta?.public ? undefined : await requirePrincipal(auth, request);
      if (request.method !== 'POST' || !meta)
        throw new ApiError(404, 'NOT_FOUND', 'This endpoint does not exist.');
      requireSameOrigin(request, config.origin);
      const envelope = await readJson(request, meta.maxBodyBytes);
      const result = await handler.handle(
        {
          url: new URL(request.url),
          method: request.method,
          headers: toStandardHeaders(request.headers),
          body: async () => envelope,
          signal: request.signal,
        },
        { prefix: RPC_PREFIX, context: { request, principal: owner } },
      );
      if (!result.matched) throw new ApiError(404, 'NOT_FOUND', 'This endpoint does not exist.');
      return toFetchResponse(result.response);
    } catch (error) {
      return rpcErrorResponse(error);
    }
  };
}
