import { loadRuntimeConfig } from './runtime-config.js';
import type { WorkerEnvironment } from './worker.js';
import { fetchSiteAssets } from './worker-assets.js';

const RETRY_AFTER_SECONDS = '60';

const maintenancePage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="theme-color" content="#ffffff">
    <meta name="color-scheme" content="light">
    <title>Corner is updating</title>
    <style>
      body { margin: 0; background: #ffffff; color: #173d32; font: 16px/1.6 system-ui, sans-serif; }
      main { max-width: 36rem; margin: 12dvh auto; padding: max(24px, env(safe-area-inset-top)) max(24px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(24px, env(safe-area-inset-left)); }
      h1 { font-size: 2rem; line-height: 1.2; }
      a { display: inline-block; padding-block: 12px; color: inherit; text-underline-offset: 4px; }
      a:focus-visible { outline: 2px solid currentColor; outline-offset: 4px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Corner is updating</h1>
      <p>Scheduled maintenance is in progress while saved workspace records are updated. Please try again shortly.</p>
      <a href="">Try again</a>
    </main>
  </body>
</html>`;

function secure(response: Response, api: boolean, versionId?: string): Response {
  const result = new Response(response.body, response);
  result.headers.set('Referrer-Policy', 'no-referrer');
  result.headers.set('X-Frame-Options', 'DENY');
  result.headers.set('X-Content-Type-Options', 'nosniff');
  result.headers.set('Cache-Control', api ? 'private, no-store' : 'no-store');
  if (!api) {
    result.headers.set(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    result.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  }
  if (versionId) result.headers.set('X-Corner-Version', versionId);
  return result;
}

function maintenanceHeaders(): HeadersInit {
  return {
    'Retry-After': RETRY_AFTER_SECONDS,
    'Cache-Control': 'private, no-store, max-age=0',
    Pragma: 'no-cache',
    Vary: 'Cookie, Origin',
  };
}

export async function fetchMaintenance(
  request: Request,
  env: WorkerEnvironment,
): Promise<Response> {
  const url = new URL(request.url);
  const api =
    url.pathname === '/api' ||
    url.pathname.startsWith('/api/') ||
    url.pathname === '/auth/callback';
  const versionId = env.CF_VERSION_METADATA?.id;
  try {
    // Validate hosted bindings without opening database connections or contacting Auth.
    const config = loadRuntimeConfig(
      {
        CORNER_DEPLOYMENT: 'hosted',
        CORNER_ORIGIN: env.CORNER_ORIGIN,
        CORNER_LANDING_ORIGIN: env.CORNER_LANDING_ORIGIN,
        CORNER_DOCS_ORIGIN: env.CORNER_DOCS_ORIGIN,
        DATABASE_URL: env.DATABASE_URL,
        NEON_AUTH_BASE_URL: env.NEON_AUTH_BASE_URL,
        NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: env.NEON_AUTH_REQUIRE_EMAIL_VERIFICATION,
      },
      { dataDir: '/tmp/corner' },
    );
    if (
      (url.origin !== config.origin &&
        url.origin !== config.landingOrigin &&
        url.origin !== config.docsOrigin) ||
      (request.headers.has('Host') && request.headers.get('Host') !== url.host)
    )
      return secure(
        new Response('Open Corner using its configured origin.', { status: 400 }),
        true,
        versionId,
      );
    if (url.origin !== config.origin)
      return await fetchSiteAssets(request, config, env.ASSETS, versionId);
    if (!api) {
      if (!['GET', 'HEAD'].includes(request.method))
        return secure(new Response(null, { status: 405 }), false, versionId);
      const decoded = decodeURIComponent(url.pathname);
      if (decoded.includes('\0') || decoded.split('/').some((part) => part.startsWith('.')))
        return secure(new Response(null, { status: 404 }), false, versionId);
      const asset = url.pathname.startsWith('/assets/');
      return secure(
        new Response(
          request.method === 'HEAD'
            ? null
            : asset
              ? 'Corner is temporarily unavailable for scheduled maintenance.'
              : maintenancePage,
          {
            status: 503,
            headers: {
              'Content-Type': asset ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8',
              'Retry-After': RETRY_AFTER_SECONDS,
            },
          },
        ),
        false,
        versionId,
      );
    }
    const message =
      'Corner is temporarily unavailable for scheduled maintenance. Please try again shortly.';
    if (url.pathname === '/api/rpc' || url.pathname.startsWith('/api/rpc/')) {
      return secure(
        Response.json(
          {
            json: {
              defined: true,
              code: 'SERVICE_UNAVAILABLE',
              status: 503,
              message,
              data: { code: 'MAINTENANCE_ACTIVE' },
            },
          },
          { status: 503, headers: maintenanceHeaders() },
        ),
        true,
        versionId,
      );
    }
    return secure(
      Response.json(
        {
          ok: false,
          maintenance: true,
          code: 'MAINTENANCE_ACTIVE',
          error: message,
        },
        { status: 503, headers: maintenanceHeaders() },
      ),
      true,
      versionId,
    );
  } catch {
    return secure(
      Response.json(
        { error: 'This request could not be completed.' },
        { status: 500, headers: { 'Retry-After': RETRY_AFTER_SECONDS } },
      ),
      true,
      versionId,
    );
  }
}

export default { fetch: fetchMaintenance };
