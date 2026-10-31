import { extname } from 'node:path';
import type { Config } from './config.js';

type Assets = { fetch(request: Request): Promise<Response> };

// Preserve static HTTP semantics without forwarding session or Access credentials.
const assetRequestHeaders = [
  'Accept',
  'Accept-Encoding',
  'If-Match',
  'If-None-Match',
  'If-Modified-Since',
  'If-Unmodified-Since',
  'Range',
  'If-Range',
] as const;

export function secureResponse(
  response: Response,
  api: boolean,
  versionId?: string,
  docs = false,
): Response {
  const result = new Response(response.body, response);
  result.headers.set('Referrer-Policy', 'no-referrer');
  result.headers.set('X-Frame-Options', 'DENY');
  result.headers.set('X-Content-Type-Options', 'nosniff');
  if (versionId) result.headers.set('X-Corner-Version', versionId);
  if (api) result.headers.set('Cache-Control', 'private, no-store');
  else {
    result.headers.set(
      'Content-Security-Policy',
      // Astro's native meta policy owns generated script hashes; an HTTP script/default
      // directive would intersect them away. These HTTP-only protections compose with it.
      docs
        ? "base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'"
        : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    result.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  }
  return result;
}

/** Asset prefixes are private bundle layout, never public application paths. */
export async function fetchSiteAssets(
  request: Request,
  config: Pick<Config, 'origin' | 'landingOrigin' | 'docsOrigin'>,
  assets: Assets,
  versionId?: string,
): Promise<Response> {
  const url = new URL(request.url);
  const landing = url.origin === config.landingOrigin;
  const docs = url.origin === config.docsOrigin;
  if (!['GET', 'HEAD'].includes(request.method))
    return secureResponse(new Response(null, { status: 405 }), true, versionId);
  const destination =
    (landing || docs) && url.pathname === '/open-app'
      ? config.origin
      : landing && url.pathname === '/open-docs'
        ? config.docsOrigin
        : undefined;
  if (destination)
    return secureResponse(
      new Response(null, {
        status: 302,
        headers: { Location: destination, 'Cache-Control': 'no-store' },
      }),
      true,
      versionId,
    );
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return secureResponse(new Response(null, { status: 400 }), true, versionId);
  }
  if (
    decoded.includes('\0') ||
    decoded.includes('\\') ||
    decoded.split('/').some((part) => part.startsWith('.')) ||
    /^\/(?:app|landing|docs)(?:\/|$)/.test(decoded) ||
    ((landing || docs) &&
      /^\/(?:api(?:\/|$)|auth(?:\/|$)|account(?:\/|$)|oauth(?:\/|$)|mcp(?:\/|$)|sw\.js$|manifest\.webmanifest$)/.test(
        decoded,
      ))
  )
    return secureResponse(new Response(null, { status: 404 }), true, versionId);
  const prefix = docs ? '/docs' : landing ? '/landing' : '/app';
  const headers: Record<string, string> = {};
  for (const name of assetRequestHeaders) {
    const value = request.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  const fetchAsset = (path: string) => {
    const internal = new URL(prefix + path, url.origin);
    return assets.fetch(new Request(internal, { method: request.method, headers }));
  };
  let response = await fetchAsset(url.pathname === '/' ? '/index.html' : url.pathname);
  if (docs && response.status === 404 && !extname(decoded))
    response = await fetchAsset(`${url.pathname.replace(/\/$/, '')}/index.html`);
  if (!landing && !docs && response.status === 404 && !extname(decoded))
    response = await fetchAsset('/index.html');
  const result = secureResponse(
    response,
    false,
    versionId,
    docs && /^text\/html(?:;|$)/i.test(response.headers.get('Content-Type') ?? ''),
  );
  result.headers.delete('Set-Cookie');
  result.headers.delete('Service-Worker-Allowed');
  result.headers.set(
    'Cache-Control',
    url.pathname.startsWith('/oauth/')
      ? 'private, no-store, max-age=0'
      : result.ok && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/_astro/'))
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
  );
  return result;
}
