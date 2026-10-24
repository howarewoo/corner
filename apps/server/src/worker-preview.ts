import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export type PreviewEnvironment = {
  CORNER_PREVIEW?: string;
  CORNER_PREVIEW_SHA?: string;
  CORNER_PREVIEW_ORIGIN?: string;
  CORNER_PREVIEW_ACCESS_ISSUER?: string;
  CORNER_PREVIEW_ACCESS_AUD?: string;
  CORNER_PREVIEW_ACCESS_CLIENT_ID?: string;
};
const keys = new Map<string, JWTVerifyGetKey>();

function reject(status: number): Response {
  return new Response('Preview request unavailable.', { status, headers: { 'Cache-Control': 'private, no-store' } });
}

export async function authenticatePreview(request: Request, env: PreviewEnvironment, verificationKey?: JWTVerifyGetKey): Promise<Request | Response> {
  let origin: URL;
  let issuer: URL;
  try {
    origin = new URL(env.CORNER_PREVIEW_ORIGIN!);
    issuer = new URL(env.CORNER_PREVIEW_ACCESS_ISSUER!);
    if (origin.protocol !== 'https:' || origin.origin !== env.CORNER_PREVIEW_ORIGIN || origin.username || origin.password
      || issuer.protocol !== 'https:' || issuer.origin !== env.CORNER_PREVIEW_ACCESS_ISSUER || !issuer.hostname.endsWith('.cloudflareaccess.com')
      || !/^[a-f0-9]{40}$/.test(env.CORNER_PREVIEW_SHA || '') || !env.CORNER_PREVIEW_ACCESS_AUD || !env.CORNER_PREVIEW_ACCESS_CLIENT_ID) return reject(503);
  } catch { return reject(503); }
  try {
    const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!assertion) return reject(403);
    let key = verificationKey || keys.get(issuer.origin);
    if (!key) {
      key = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer));
      keys.set(issuer.origin, key);
    }
    const { payload } = await jwtVerify(assertion, key, { issuer: issuer.origin, audience: env.CORNER_PREVIEW_ACCESS_AUD, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'common_name'] });
    if (payload.common_name !== env.CORNER_PREVIEW_ACCESS_CLIENT_ID) return reject(403);
    const url = new URL(request.url);
    if (url.protocol !== 'https:') return reject(403);
    const headers = new Headers(request.headers);
    for (const name of [...headers.keys()]) {
      if (name.toLowerCase().startsWith('cf-access-') || name.toLowerCase().startsWith('x-forwarded-') || name.toLowerCase().startsWith('x-corner-') || name.toLowerCase() === 'forwarded') headers.delete(name);
    }
    return new Request(origin.origin + url.pathname + url.search, new Request(request, { headers }));
  } catch { return reject(403); }
}
