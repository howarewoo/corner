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
import type { WorkspaceStore } from './store.js';
import { recordDetails, recordPage } from './workspace-queries.js';
import { groceries } from './grocery-queries.js';
import {
  exerciseChoices,
  exerciseHistoryPage,
  prefillHistory,
  progress,
} from './training-queries.js';

export type RPCServices = {
  config: Config;
  auth: CornerAuth;
  store: WorkspaceStore;
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
  if (error instanceof ApiError) {
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

/** Keep persistence, ownership, and request fingerprints in their existing services. */
export function createRPCHandler({ config, auth, store }: RPCServices) {
  function principal(context: RPCContext): Principal {
    if (!context.principal)
      throw new ApiError(401, 'SIGN_IN_REQUIRED', 'Sign in to open your workspace.');
    return context.principal;
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
      get: api.workspace.get.handler(async ({ context }) => {
        const owner = principal(context);
        return store.bootstrap(owner.userId, owner.name);
      }),
      foodWindow: api.workspace.foodWindow.handler(({ input, context }) =>
        store.foodWindow(principal(context).userId, input),
      ),
      page: api.workspace.page.handler(({ input, context }) =>
        recordPage(store.db, principal(context).userId, input),
      ),
      details: api.workspace.details.handler(({ input, context }) =>
        recordDetails(store.db, principal(context).userId, input),
      ),
      groceries: api.workspace.groceries.handler(({ input, context }) =>
        groceries(store.db, principal(context).userId, input),
      ),
      progress: api.workspace.progress.handler(({ input, context }) =>
        progress(store.db, principal(context).userId, input),
      ),
      exerciseHistory: api.workspace.exerciseHistory.handler(({ input, context }) =>
        exerciseHistoryPage(store.db, principal(context).userId, input),
      ),
      exerciseChoices: api.workspace.exerciseChoices.handler(({ input, context }) =>
        exerciseChoices(store.db, principal(context).userId, input),
      ),
      prefill: api.workspace.prefill.handler(({ input, context }) =>
        prefillHistory(store.db, principal(context).userId, input),
      ),
      export: api.workspace.export.handler(({ context }) => {
        const owner = principal(context);
        return store.exportSnapshot(owner.userId, owner.name);
      }),
      mutate: api.workspace.mutate.handler(({ input, context }) => {
        const raw = mutationInputSchema.parse(input);
        return store.mutate(
          principal(context).userId,
          raw.requestId,
          raw.mutation,
          raw.expectedRevision,
        );
      }),
      previewImport: api.workspace.previewImport.handler(({ input, context }) =>
        store.importPreview(principal(context).userId, input.state),
      ),
      import: api.workspace.import.handler(({ input, context }) =>
        store.replaceImport(
          principal(context).userId,
          input.requestId,
          input.state,
          input.expectedRevision,
        ),
      ),
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
