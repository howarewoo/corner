import { Hono } from 'hono';
import { z } from 'zod';
import { accountPolicy, requirePrincipal, type CornerAuth, type Principal } from './auth.js';
import type { Config } from './config.js';
import { ApiError, errorResponse, json, readJson, requestIdSchema, requireSameOrigin, revisionSchema } from './http.js';
import { isEmptyWorkspace, type WorkspaceSnapshot, type WorkspaceStore } from './store.js';

export type AppEnvironment = { Variables: { principal: Principal } };

export type AppOptions = {
  config: Config;
  auth: CornerAuth;
  store: WorkspaceStore;
  aiAvailable?: (principal: Principal) => Promise<boolean> | boolean;
  extraRoutes?: Hono<AppEnvironment>;
};

const mutationInput = z.object({ mutation: z.unknown(), requestId: requestIdSchema, expectedRevision: revisionSchema.optional() }).strict();
const importPreviewInput = z.object({ state: z.unknown() }).strict();
const importInput = z.object({ state: z.unknown(), requestId: requestIdSchema, expectedRevision: revisionSchema }).strict();

const redirectFields = ['callbackURL', 'redirectTo', 'errorCallbackURL', 'newUserCallbackURL'] as const;
function accountRedirect(value: unknown, config: Config, expectedPath?: string): string {
  if (typeof value === 'string' && value && value.length <= 2048 && !/[\\\u0000-\u0020\u007f]/.test(value) && !value.startsWith('//')) {
    try {
      const destination = new URL(value, config.origin);
      if (destination.origin === config.origin && !destination.username && !destination.password && !destination.hash && (!expectedPath || destination.pathname === expectedPath)) {
        return destination.href;
      }
    } catch {}
  }
  throw new ApiError(400, 'INVALID_ACCOUNT_REDIRECT', 'Account links must return to this Corner installation.');
}
function accountBody(path: string, raw: unknown, config: Config): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const body = { ...raw } as Record<string, unknown>;
  for (const key of redirectFields) if (body[key] !== undefined) body[key] = accountRedirect(body[key], config);
  if (path === '/api/auth/sign-up/email') {
    body.callbackURL = accountRedirect(body.callbackURL ?? config.origin, config, '/');
  }
  if (path === '/api/auth/request-password-reset') {
    body.redirectTo = accountRedirect(body.redirectTo ?? `${config.origin}/account/reset-password`, config, '/account/reset-password');
  }
  return body;
}

/** Shared Hono API app; runtime entrypoints own listeners, assets, and resources. */
export function createApp({ config, auth, store, aiAvailable, extraRoutes }: AppOptions) {
  // Preserve literal API paths instead of Hono's default percent-decoding.
  const app = new Hono<AppEnvironment>({ getPath: request => new URL(request.url).pathname });
  const stateResponse = async (principal: Principal, snapshot?: WorkspaceSnapshot) => json({ ...(snapshot ?? await store.read(principal.userId, principal.name)), aiAvailable: Boolean(await aiAvailable?.(principal)) });
  app.onError(errorResponse);
  app.notFound(() => errorResponse(new ApiError(404, 'NOT_FOUND', 'This endpoint does not exist.')));
  app.use('*', async (c, next) => {
    await next();
    c.res = auth.withCookies(c.req.raw, c.res);
  });

  // Hono also dispatches HEAD to GET. Only GET is public in the existing API.
  app.get('/api/health', (c, next) => c.req.method === 'GET' ? json({ ok: true }) : next());
  app.get('/api/account-policy', (c, next) => c.req.method === 'GET' ? json(accountPolicy(config)) : next());
  app.get('/api/session', async (c, next) => {
    if (c.req.method !== 'GET') return next();
    const principal = await auth.principal(c.req.raw);
    return json({ user: principal ? { id: principal.userId, name: principal.name, email: principal.email } : null });
  });
  app.on('ALL', ['/api/auth', '/api/auth/*'], async c => {
    const request = c.req.raw;
    const path = c.req.path;
    // Cookie writes use the same exact-origin rule as the workspace API.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      requireSameOrigin(request, config.origin);
      const body = accountBody(path, await readJson(request, 16 * 1024), config);
      const headers = new Headers(request.headers);
      headers.delete('Content-Length');
      // Resend must not reveal a different, already signed-in account.
      if (path === '/api/auth/email-otp/send-verification-otp') headers.delete('Cookie');
      const forwarded = new Request(request, { headers, body: JSON.stringify(body) });
      const response = await auth.handler(forwarded);
      if (response.status >= 500) throw new ApiError(503, 'ACCOUNT_SERVICE_UNAVAILABLE', 'The account service is temporarily unavailable. Try again later.');
      return response;
    }
    const url = new URL(request.url);
    for (const key of redirectFields) {
      for (const value of url.searchParams.getAll(key)) accountRedirect(value, config);
    }
    return auth.handler(request);
  });

  app.use('*', async (c, next) => {
    if (!c.req.path.startsWith('/api/') && c.req.path !== '/auth/callback') {
      throw new ApiError(404, 'NOT_FOUND', 'This endpoint does not exist.');
    }
    c.set('principal', await requirePrincipal(auth, c.req.raw));
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) requireSameOrigin(c.req.raw, config.origin);
    if (c.req.method === 'HEAD') return c.notFound();
    await next();
  });
  app.get('/api/state', c => stateResponse(c.get('principal')));
  app.post('/api/mutate', async c => {
    const input = mutationInput.parse(await readJson(c.req.raw));
    const principal = c.get('principal');
    return stateResponse(principal, await store.mutate(principal.userId, input.requestId, input.mutation, input.expectedRevision));
  });
  app.post('/api/import/preview', async c => {
    const input = importPreviewInput.parse(await readJson(c.req.raw, 2 * 1024 * 1024));
    const inspected = store.inspectImport(input.state);
    const principal = c.get('principal');
    const current = await store.read(principal.userId, principal.name);
    return json({ summary: { ...inspected.counts, bytes: inspected.bytes }, canImport: isEmptyWorkspace(current.state), revision: current.revision });
  });
  app.post('/api/import', async c => {
    const input = importInput.parse(await readJson(c.req.raw, 2 * 1024 * 1024));
    const principal = c.get('principal');
    return stateResponse(principal, await store.replaceImport(principal.userId, input.requestId, input.state, input.expectedRevision));
  });
  if (extraRoutes) app.route('/', extraRoutes);
  return app;
}
