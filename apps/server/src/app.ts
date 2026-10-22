import { z } from 'zod';
import { accountPolicy, getPrincipal, requirePrincipal, type CornerAuth, type Principal } from './auth.js';
import type { Config } from './config.js';
import { ApiError, errorResponse, json, readJson, requestIdSchema, requireSameOrigin, revisionSchema } from './http.js';
import { isEmptyWorkspace, type WorkspaceStore } from './store.js';

export type AppOptions = {
  config: Config;
  auth: CornerAuth;
  store: WorkspaceStore;
  aiAvailable?: (principal: Principal) => Promise<boolean> | boolean;
  extraRoute?: (request: Request, principal: Principal) => Promise<Response | null>;
};

const mutationInput = z.object({ mutation: z.unknown(), requestId: requestIdSchema, expectedRevision: revisionSchema.optional() }).strict();
const importPreviewInput = z.object({ state: z.unknown() }).strict();
const importInput = z.object({ state: z.unknown(), requestId: requestIdSchema, expectedRevision: revisionSchema }).strict();

const redirectFields = ['callbackURL', 'redirectTo', 'errorCallbackURL', 'newUserCallbackURL'] as const;
function accountRedirect(value: unknown, config: Config, expectedPath?: string): string {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\\\u0000-\u0020\u007f]/.test(value) || value.startsWith('//')) {
    throw new ApiError(400, 'INVALID_ACCOUNT_REDIRECT', 'Account links must return to this Corner installation.');
  }
  let destination: URL;
  try { destination = new URL(value, config.origin); }
  catch { throw new ApiError(400, 'INVALID_ACCOUNT_REDIRECT', 'Account links must return to this Corner installation.'); }
  if (destination.origin !== config.origin || destination.username || destination.password || destination.hash || (expectedPath && destination.pathname !== expectedPath)) {
    throw new ApiError(400, 'INVALID_ACCOUNT_REDIRECT', 'Account links must return to this Corner installation.');
  }
  return destination.href;
}
function accountBody(path: string, raw: unknown, config: Config): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const body = { ...raw } as Record<string, unknown>;
  for (const key of redirectFields) if (body[key] !== undefined) body[key] = accountRedirect(body[key], config);
  if (path === '/api/auth/sign-up/email' || path === '/api/auth/send-verification-email') {
    body.callbackURL = accountRedirect(body.callbackURL ?? `${config.origin}/?account=verified`, config, '/');
  }
  if (path === '/api/auth/request-password-reset') {
    body.redirectTo = accountRedirect(body.redirectTo ?? `${config.origin}/account/reset-password`, config, '/account/reset-password');
  }
  return body;
}

/** Web-standard API handler; the Node entrypoint serves UI assets separately. */
export function createApp({ config, auth, store, aiAvailable, extraRoute }: AppOptions): (request: Request) => Promise<Response> {
  const stateResponse = async (principal: Principal, snapshot = store.read(principal.userId, principal.name)) => json({ ...snapshot, aiAvailable: Boolean(await aiAvailable?.(principal)) });
  return async (request: Request): Promise<Response> => {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/api/health' && request.method === 'GET') return json({ ok: true });
      if (path === '/api/account-policy' && request.method === 'GET') return json(accountPolicy(config));
      if (path === '/api/session' && request.method === 'GET') {
        const principal = await getPrincipal(auth, request);
        return json({ user: principal ? { id: principal.userId, name: principal.name, email: principal.email } : null });
      }
      if (path === '/api/auth' || path.startsWith('/api/auth/')) {
        const emailEndpoint = ['/api/auth/send-verification-email', '/api/auth/verify-email', '/api/auth/request-password-reset', '/api/auth/reset-password'].includes(path) || path.startsWith('/api/auth/reset-password/');
        if (emailEndpoint && !config.mail) throw new ApiError(503, 'ACCOUNT_EMAIL_UNAVAILABLE', 'Account email is not configured for this installation.');
        // Cookie writes use the same exact-origin rule as the workspace API.
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
          requireSameOrigin(request, config.origin);
          const body = accountBody(path, await readJson(request, 16 * 1024), config);
          const headers = new Headers(request.headers);
          headers.delete('Content-Length');
          // Resend is a public recovery action: do not expose whether the
          // supplied address matches a different, already signed-in account.
          if (path === '/api/auth/send-verification-email') headers.delete('Cookie');
          const response = await auth.handler(new Request(request, { headers, body: JSON.stringify(body) }));
          if (response.status >= 500) throw new ApiError(503, 'ACCOUNT_SERVICE_UNAVAILABLE', 'The account service is temporarily unavailable. Try again later.');
          return response;
        }
        const url = new URL(request.url);
        for (const key of redirectFields) {
          for (const value of url.searchParams.getAll(key)) accountRedirect(value, config);
        }
        if (path === '/api/auth/verify-email') url.searchParams.set('callbackURL', accountRedirect(url.searchParams.get('callbackURL') ?? `${config.origin}/?account=verified`, config, '/'));
        if (path.startsWith('/api/auth/reset-password/')) url.searchParams.set('callbackURL', accountRedirect(url.searchParams.get('callbackURL') ?? `${config.origin}/account/reset-password`, config, '/account/reset-password'));
        return await auth.handler(new Request(url, request));
      }
      if (!path.startsWith('/api/') && path !== '/auth/callback') throw new ApiError(404, 'NOT_FOUND', 'This endpoint does not exist.');
      const principal = await requirePrincipal(auth, request);
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) requireSameOrigin(request, config.origin);
      if (path === '/api/state' && request.method === 'GET') return await stateResponse(principal);
      if (path === '/api/mutate' && request.method === 'POST') {
        const input = mutationInput.parse(await readJson(request));
        return await stateResponse(principal, store.mutate(principal.userId, input.requestId, input.mutation, input.expectedRevision));
      }
      if (path === '/api/import/preview' && request.method === 'POST') {
        const input = importPreviewInput.parse(await readJson(request, 2 * 1024 * 1024));
        const inspected = store.inspectImport(input.state);
        const current = store.read(principal.userId, principal.name);
        return json({ summary: { ...inspected.counts, bytes: inspected.bytes }, canImport: isEmptyWorkspace(current.state), revision: current.revision });
      }
      if (path === '/api/import' && request.method === 'POST') {
        const input = importInput.parse(await readJson(request, 2 * 1024 * 1024));
        return await stateResponse(principal, store.replaceImport(principal.userId, input.requestId, input.state, input.expectedRevision));
      }
      const extra = await extraRoute?.(request, principal);
      if (extra) return extra;
      throw new ApiError(404, 'NOT_FOUND', 'This endpoint does not exist.');
    } catch (error) { return errorResponse(error); }
  };
}
