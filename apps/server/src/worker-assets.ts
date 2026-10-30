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

export function secureResponse(response: Response, api: boolean, versionId?: string): Response {
  const result = new Response(response.body, response);
  result.headers.set('Referrer-Policy', 'no-referrer');
  result.headers.set('X-Frame-Options', 'DENY');
  result.headers.set('X-Content-Type-Options', 'nosniff');
  if (versionId) result.headers.set('X-Corner-Version', versionId);
  if (api) result.headers.set('Cache-Control', 'private, no-store');
  else {
    result.headers.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    result.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  }
  return result;
}

/** Asset prefixes are private bundle layout, never public application paths. */
export async function fetchSiteAssets(
  request: Request,
  config: Pick<Config, 'origin' | 'landingOrigin'>,
  assets: Assets,
  versionId?: string,
): Promise<Response> {
  const url = new URL(request.url);
  const landing = url.origin === config.landingOrigin;
  if (!['GET', 'HEAD'].includes(request.method))
    return secureResponse(new Response(null, { status: 405 }), true, versionId);
  if (landing && url.pathname === '/open-app')
    return secureResponse(
      new Response(null, {
        status: 302,
        headers: { Location: config.origin, 'Cache-Control': 'no-store' },
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
    decoded.split('/').some((part) => part.startsWith('.'))
  )
    return secureResponse(new Response(null, { status: 404 }), true, versionId);
  const prefix = landing ? '/landing' : '/app';
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
  if (!landing && response.status === 404 && !extname(decoded))
    response = await fetchAsset('/index.html');
  const result = secureResponse(response, false, versionId);
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
