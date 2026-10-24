import { z } from 'zod';
import type { Config } from './config.js';
import { ApiError } from './http.js';

export type Principal = { userId: string; name: string; email: string; sessionId: string };
export type CornerAuth = {
  handler(request: Request): Promise<Response>;
  principal(request: Request): Promise<Principal | null>;
  withCookies(request: Request, response: Response): Response;
};

export function accountPolicy(config: Config) {
  return { emailVerificationRequired: config.neonAuthRequireEmailVerification, passwordResetAvailable: true };
}

const sessionSchema = z.object({
  user: z.object({ id: z.string().min(1), name: z.string(), email: z.string().email(), emailVerified: z.boolean() }),
  session: z.object({ id: z.string().min(1), userId: z.string().min(1), expiresAt: z.string().datetime({ offset: true }) }),
});
const endpoints: Record<string, string> = {
  '/sign-up/email': 'POST', '/sign-in/email': 'POST', '/sign-out': 'POST',
  '/request-password-reset': 'POST', '/reset-password': 'POST',
  '/email-otp/send-verification-otp': 'POST', '/email-otp/verify-email': 'POST',
};
const unavailable = () => new ApiError(503, 'ACCOUNT_SERVICE_UNAVAILABLE', 'The account service is temporarily unavailable. Try again later.');
const cookieNames = ['neon-auth.session_token', 'neon-auth.session_data', 'neon-auth.dont_remember'];
/** Same-origin, uncached managed sessions. No browser-supplied identity is authoritative. */
export function createAuth(config: Config, fetcher: typeof fetch = fetch): CornerAuth {
  const cookies = new WeakMap<Request, string[]>();
  const secure = new URL(config.origin).protocol === 'https:';
  function outboundCookies(request: Request): string {
    return (request.headers.get('cookie') ?? '').split(';').flatMap(part => {
      const separator = part.indexOf('=');
      if (separator < 1) return [];
      const name = part.slice(0, separator).trim();
      const plain = name.replace(/^__Secure-/, '');
      if (!cookieNames.includes(plain)) return [];
      // Managed Auth uses secure names; local HTTP stores the unprefixed equivalent.
      return [`__Secure-${plain}=${part.slice(separator + 1)}`];
    }).join('; ');
  }
  function localCookie(cookie: string): string {
    const parts = cookie.split(';');
    const pair = parts.shift()!.trim();
    const separator = pair.indexOf('=');
    let name = pair.slice(0, separator);
    if (!secure) name = name.replace(/^__Secure-/, '');
    const attributes = parts.map(part => part.trim()).filter(part => !/^(domain|path|secure|httponly|samesite|partitioned)(=|$)/i.test(part));
    return [`${name}=${pair.slice(separator + 1)}`, ...attributes, 'Path=/', 'HttpOnly', 'SameSite=Lax', ...(secure ? ['Secure'] : [])].join('; ');
  }
  async function upstream(request: Request, path: string, body?: string): Promise<Response> {
    const headers = new Headers({ Accept: 'application/json', Origin: config.origin, 'x-neon-auth-middleware': 'true' });
    const cookie = outboundCookies(request);
    if (cookie) headers.set('Cookie', cookie);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    let response: Response;
    try {
      response = await fetcher(`${config.neonAuthBaseUrl}${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    } catch { throw unavailable(); }
    if (response.status >= 500) throw unavailable();
    const received = response.headers.getSetCookie().map(localCookie);
    if (received.length) cookies.set(request, [...(cookies.get(request) ?? []), ...received]);
    return response;
  }
  function withCookies(request: Request, response: Response): Response {
    const pending = cookies.get(request);
    if (pending?.length) {
      // Fetch/redirect responses may have immutable headers.
      response = new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
      for (const cookie of pending) response.headers.append('Set-Cookie', cookie);
    }
    cookies.delete(request);
    return response;
  }
  return {
    async handler(request) {
      const url = new URL(request.url);
      const path = url.pathname.slice('/api/auth'.length);
      if (endpoints[path] !== request.method) throw new ApiError(404, 'NOT_FOUND', 'This account endpoint does not exist.');
      let body = await request.text();
      if (path === '/email-otp/send-verification-otp') {
        const input = z.object({ email: z.string().email(), type: z.literal('email-verification') }).strict().parse(JSON.parse(body));
        body = JSON.stringify(input);
      }
      if (path === '/sign-up/email' || path === '/reset-password') {
        const input = JSON.parse(body);
        z.string().min(12).max(128).parse(path === '/sign-up/email' ? input.password : input.newPassword);
      }
      const response = await upstream(request, path + url.search, body);
      // Session tokens remain opaque HttpOnly cookies, never application JSON.
      const text = await response.text();
      let data: unknown;
      try { data = text ? JSON.parse(text) : {}; } catch { throw unavailable(); }
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const { token: _token, ...rest } = data as Record<string, unknown>;
        data = { ...rest, ...(_token === null ? { token: null } : {}) };
      }
      return withCookies(request, new Response(JSON.stringify(data), { status: response.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }));
    },
    async principal(request) {
      if (!outboundCookies(request)) return null;
      const response = await upstream(request, '/get-session?disableCookieCache=true');
      if (response.status === 401) return null;
      if (!response.ok) throw unavailable();
      let data: unknown;
      try { data = await response.json(); } catch { throw unavailable(); }
      if (data === null) return null;
      const parsed = sessionSchema.safeParse(data);
      if (!parsed.success) throw unavailable();
      const { user, session } = parsed.data;
      if (session.userId !== user.id || Date.parse(session.expiresAt) <= Date.now()) return null;
      if (config.neonAuthRequireEmailVerification && !user.emailVerified) return null;
      return { userId: user.id, name: user.name, email: user.email, sessionId: session.id };
    },
    withCookies,
  };
}

export async function requirePrincipal(auth: CornerAuth, request: Request): Promise<Principal> {
  const principal = await auth.principal(request);
  if (!principal) throw new ApiError(401, 'SIGN_IN_REQUIRED', 'Sign in to your Corner account to continue.');
  return principal;
}
