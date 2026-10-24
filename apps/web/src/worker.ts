import { extname } from 'node:path';

type Environment = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  SERVER: { fetch(request: Request): Promise<Response> };
  CF_VERSION_METADATA?: { id: string };
};

async function fetchApplication(request: Request, env: Environment): Promise<Response> {
  const url = new URL(request.url);
  if (
    url.pathname === '/api' ||
    url.pathname.startsWith('/api/') ||
    url.pathname === '/auth/callback'
  ) {
    const response = await env.SERVER.fetch(request);
    return new Response(response.body, response);
  }
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (decoded.includes('\0') || decoded.split('/').some((part) => part.startsWith('.')))
    return new Response(null, { status: 404 });
  let response = await env.ASSETS.fetch(request);
  if (response.status === 404 && !extname(decoded)) {
    response = await env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
  }
  const result = new Response(response.body, response);
  result.headers.set('Referrer-Policy', 'no-referrer');
  result.headers.set('X-Frame-Options', 'DENY');
  result.headers.set('X-Content-Type-Options', 'nosniff');
  result.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  result.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  result.headers.set(
    'Cache-Control',
    url.pathname.startsWith('/assets/') && result.ok
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  );
  return result;
}

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const response = await fetchApplication(request, env);
    if (env.CF_VERSION_METADATA?.id)
      response.headers.set('X-Corner-Frontend-Version', env.CF_VERSION_METADATA.id);
    return response;
  },
};
