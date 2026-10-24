import { extname } from 'node:path';

type Environment = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  SERVER?: { fetch(request: Request): Promise<Response> };
  CF_VERSION_METADATA?: { id: string };
  CORNER_PREVIEW?: string;
  CORNER_PREVIEW_SHA?: string;
  CORNER_PREVIEW_ORIGIN?: string;
  CORNER_PREVIEW_BACKEND_URL?: string;
  CORNER_PREVIEW_ACCESS_CLIENT_ID?: string;
  CORNER_PREVIEW_ACCESS_CLIENT_SECRET?: string;
};

const managedCookie = /^(?:__Secure-)?neon-auth\.(?:session_token|session_data|dont_remember)$/;
function unavailable(status = 502): Response {
  return new Response('Preview request unavailable.', { status, headers: { 'Cache-Control': 'private, no-store' } });
}

function previewTarget(request: Request, env: Environment): URL | Response {
  try {
    const origin = new URL(env.CORNER_PREVIEW_ORIGIN!);
    const target = new URL(env.CORNER_PREVIEW_BACKEND_URL!);
    if (env.CORNER_PREVIEW !== 'true' || origin.protocol !== 'https:' || origin.origin !== env.CORNER_PREVIEW_ORIGIN
      || target.protocol !== 'https:' || target.origin !== env.CORNER_PREVIEW_BACKEND_URL || target.username || target.password
      || !/^[a-f0-9]{40}$/.test(env.CORNER_PREVIEW_SHA || '') || !env.CORNER_PREVIEW_ACCESS_CLIENT_ID || !env.CORNER_PREVIEW_ACCESS_CLIENT_SECRET) return unavailable(503);
    if (new URL(request.url).origin !== origin.origin) return unavailable(400);
    return target;
  } catch { return unavailable(503); }
}

async function proxyPreview(request: Request, env: Environment, target: URL): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers();
  for (const name of ['accept', 'accept-language', 'content-type', 'origin']) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const cookies = (request.headers.get('cookie') || '').split(';').map(part => part.trim()).filter(part => managedCookie.test(part.split('=', 1)[0]!));
  const names = cookies.map(cookie => cookie.split('=', 1)[0]!.replace(/^__Secure-/, ''));
  if (new Set(names).size !== names.length) return unavailable(400);
  if (cookies.length) headers.set('cookie', cookies.join('; '));
  headers.set('CF-Access-Client-Id', env.CORNER_PREVIEW_ACCESS_CLIENT_ID!);
  headers.set('CF-Access-Client-Secret', env.CORNER_PREVIEW_ACCESS_CLIENT_SECRET!);
  try {
    const response = await fetch(new Request(target.origin + url.pathname + url.search, new Request(request, { headers, redirect: 'manual' })));
    if (response.headers.get('X-Corner-Preview-Sha') !== env.CORNER_PREVIEW_SHA) return unavailable();
    const location = response.headers.get('location');
    if (location && new URL(location, request.url).origin !== env.CORNER_PREVIEW_ORIGIN) return unavailable();
    const resultHeaders = new Headers(response.headers);
    resultHeaders.delete('set-cookie');
    for (const cookie of response.headers.getSetCookie()) {
      if (managedCookie.test(cookie.slice(0, cookie.indexOf('=')))) resultHeaders.append('set-cookie', cookie);
    }
    resultHeaders.delete('cf-access-jwt-assertion');
    resultHeaders.set('Cache-Control', 'private, no-store');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: resultHeaders });
  } catch { return unavailable(); }
}

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const url = new URL(request.url);
    const target = env.CORNER_PREVIEW !== undefined ? previewTarget(request, env) : undefined;
    if (target instanceof Response) return target;
    if (url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname === '/auth/callback') {
      if (target) return proxyPreview(request, env, target);
      // Production preserves the original request across the service binding.
      return env.SERVER!.fetch(request);
    }
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    let decoded: string;
    try { decoded = decodeURIComponent(url.pathname); }
    catch { return new Response(null, { status: 400 }); }
    if (decoded.includes('\0') || decoded.split('/').some(part => part.startsWith('.'))) return new Response(null, { status: 404 });
    let response = await env.ASSETS.fetch(request);
    if (response.status === 404 && !extname(decoded)) {
      response = await env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
    }
    const result = new Response(response.body, response);
    result.headers.set('Referrer-Policy', 'no-referrer');
    result.headers.set('X-Frame-Options', 'DENY');
    result.headers.set('X-Content-Type-Options', 'nosniff');
    result.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    result.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    result.headers.set('Cache-Control', url.pathname.startsWith('/assets/') && result.ok ? 'public, max-age=31536000, immutable' : 'no-cache');
    return result;
  },
};
