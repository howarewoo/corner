import { Hono } from 'hono';
import { requirePrincipal } from './auth.js';
import type { Config } from './config.js';
import { ApiError, errorResponse, json, readJson, requireSameOrigin } from './http.js';
import { RPC_PREFIX } from '@packages/api/protocol';
import { delegatedAccountReturn } from '@packages/api/delegation';
import { createRPCHandler, type RPCServices } from './rpc.js';
import { createDelegationService, type DelegationService } from './delegation.js';
import { handleMcp, protectedResourceMetadata } from './mcp.js';

const redirectFields = [
  'callbackURL',
  'redirectTo',
  'errorCallbackURL',
  'newUserCallbackURL',
] as const;
function accountRedirect(value: unknown, config: Config, expectedPath?: string): string {
  if (
    typeof value === 'string' &&
    value &&
    value.length <= 2048 &&
    !/[\\\u0000-\u0020\u007f]/.test(value) &&
    !value.startsWith('//')
  ) {
    try {
      const destination = new URL(value, config.origin);
      if (
        destination.origin === config.origin &&
        !destination.username &&
        !destination.password &&
        !destination.hash &&
        (!expectedPath || destination.pathname === expectedPath)
      ) {
        return destination.href;
      }
    } catch {}
  }
  throw new ApiError(
    400,
    'INVALID_ACCOUNT_REDIRECT',
    'Account links must return to this Corner installation.',
  );
}
function accountBody(path: string, raw: unknown, config: Config): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const body = { ...raw } as Record<string, unknown>;
  for (const key of redirectFields)
    if (body[key] !== undefined) body[key] = accountRedirect(body[key], config);
  if (path === '/api/auth/sign-up/email') {
    body.callbackURL = accountRedirect(body.callbackURL ?? config.origin, config, '/');
  }
  if (path === '/api/auth/request-password-reset') {
    body.redirectTo = accountRedirect(
      body.redirectTo ?? `${config.origin}/account/reset-password`,
      config,
      '/account/reset-password',
    );
    const destination = new URL(body.redirectTo as string);
    const returnValues = destination.searchParams.getAll('oauthReturn');
    if (
      [...destination.searchParams.keys()].some((key) => key !== 'oauthReturn') ||
      returnValues.length > 1 ||
      (returnValues.length === 1 &&
        delegatedAccountReturn(returnValues[0], config.origin) !== returnValues[0])
    ) {
      throw new ApiError(
        400,
        'INVALID_ACCOUNT_REDIRECT',
        'Use a valid Corner recovery return link.',
      );
    }
  }
  return body;
}

/** Shared Hono API app; runtime entrypoints own listeners, assets, and resources. */
export function createApp(options: RPCServices & { delegation?: DelegationService }) {
  const { config, auth } = options;
  const rpc = createRPCHandler(options);
  const delegation = options.delegation ?? createDelegationService(config);
  // Preserve literal API paths instead of Hono's default percent-decoding.
  const app = new Hono({ getPath: (request) => new URL(request.url).pathname });
  app.onError(errorResponse);
  app.notFound(() =>
    errorResponse(new ApiError(404, 'NOT_FOUND', 'This endpoint does not exist.')),
  );
  app.use('*', async (c, next) => {
    await next();
    c.res = auth.withCookies(c.req.raw, c.res);
    c.header('Cache-Control', 'private, no-store, max-age=0');
    c.header('Pragma', 'no-cache');
    c.header('Vary', 'Cookie, Origin');
  });

  // Hono also dispatches HEAD to GET. Only GET is public in the existing API.
  app.get('/api/health', (c, next) => (c.req.method === 'GET' ? json({ ok: true }) : next()));
  app.on('ALL', '/mcp', (c) => handleMcp(c.req.raw, options.store, delegation, config.origin));
  app.get('/.well-known/oauth-protected-resource/mcp', (c, next) =>
    c.req.method === 'GET' ? protectedResourceMetadata(config.origin) : next(),
  );
  app.on('ALL', ['/api/auth', '/api/auth/*'], async (c) => {
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
      if (response.status >= 500)
        throw new ApiError(
          503,
          'ACCOUNT_SERVICE_UNAVAILABLE',
          'The account service is temporarily unavailable. Try again later.',
        );
      return response;
    }
    const url = new URL(request.url);
    for (const key of redirectFields) {
      for (const value of url.searchParams.getAll(key)) accountRedirect(value, config);
    }
    return auth.handler(request);
  });
  app.on('ALL', [RPC_PREFIX, `${RPC_PREFIX}/*`], (c) => rpc(c.req.raw));

  app.use('*', async (c, next) => {
    if (!c.req.path.startsWith('/api/')) {
      throw new ApiError(404, 'NOT_FOUND', 'This endpoint does not exist.');
    }
    await requirePrincipal(auth, c.req.raw);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method))
      requireSameOrigin(c.req.raw, config.origin);
    if (c.req.method === 'HEAD') return c.notFound();
    await next();
  });
  return app;
}
