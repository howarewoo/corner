import { z } from 'zod';
import { contract } from '@packages/api/contract';
import { RPC_PREFIX } from '@packages/api/protocol';
import type { Config } from './config.js';
import { ApiError } from './http.js';

export type Principal = { userId: string; name: string; email: string; sessionId: string };
export type CornerAuth = {
  handler(request: Request): Promise<Response>;
  principal(request: Request): Promise<Principal | null>;
  withCookies(request: Request, response: Response): Response;
};

export function accountPolicy(config: Config) {
  return {
    emailVerificationRequired: config.neonAuthRequireEmailVerification,
    passwordResetAvailable: true,
  };
}

const sessionSchema = z.object({
  user: z.object({
    id: z.string().min(1),
    name: z.string(),
    email: z.string().email(),
    emailVerified: z.boolean(),
  }),
  session: z.object({
    id: z.string().min(1),
    userId: z.string().min(1),
    expiresAt: z.string().datetime({ offset: true }),
  }),
});
const endpoints: Record<string, string> = {
  '/sign-up/email': 'POST',
  '/sign-in/email': 'POST',
  '/sign-out': 'POST',
  '/request-password-reset': 'POST',
  '/reset-password': 'POST',
  '/email-otp/send-verification-otp': 'POST',
  '/email-otp/verify-email': 'POST',
};
class AccountServiceUnavailable extends ApiError {
  constructor(
    readonly category:
      | 'network'
      | 'timeout'
      | 'upstream_status'
      | 'invalid_json'
      | 'invalid_session',
    readonly upstreamStatus: number | null = null,
  ) {
    super(
      503,
      'ACCOUNT_SERVICE_UNAVAILABLE',
      'The account service is temporarily unavailable. Try again later.',
    );
  }
}
const procedures = new Map<string, string>(
  Object.entries(contract).flatMap(([group, entries]) =>
    Object.keys(entries).map(
      (name) => [`${RPC_PREFIX}/${group}/${name}`, `${group}.${name}`] as const,
    ),
  ),
);
const cookieNames = [
  'neon-auth.session_token',
  'neon-auth.session_data',
  'neon-auth.dont_remember',
];
/** Same-origin, uncached managed sessions. No browser-supplied identity is authoritative. */
export function createAuth(
  config: Config,
  fetcher: typeof fetch = fetch,
  servingVersion?: string,
): CornerAuth {
  const cookies = new WeakMap<Request, string[]>();
  const failureIds = new WeakMap<Request, string>();
  const secure = new URL(config.origin).protocol === 'https:';
  function outboundCookies(request: Request): string {
    return (request.headers.get('cookie') ?? '')
      .split(';')
      .flatMap((part) => {
        const separator = part.indexOf('=');
        if (separator < 1) return [];
        const name = part.slice(0, separator).trim();
        const plain = name.replace(/^__Secure-/, '');
        if (!cookieNames.includes(plain)) return [];
        // Managed Auth uses secure names; local HTTP stores the unprefixed equivalent.
        return [`__Secure-${plain}=${part.slice(separator + 1)}`];
      })
      .join('; ');
  }
  function localCookie(cookie: string): string {
    const parts = cookie.split(';');
    const pair = parts.shift()!.trim();
    const separator = pair.indexOf('=');
    let name = pair.slice(0, separator);
    if (!secure) name = name.replace(/^__Secure-/, '');
    const attributes = parts
      .map((part) => part.trim())
      .filter((part) => !/^(domain|path|secure|httponly|samesite|partitioned)(=|$)/i.test(part));
    return [
      `${name}=${pair.slice(separator + 1)}`,
      ...attributes,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      ...(secure ? ['Secure'] : []),
    ].join('; ');
  }
  async function upstream(request: Request, path: string, body?: string): Promise<Response> {
    const headers = new Headers({
      Accept: 'application/json',
      Origin: config.origin,
      'x-neon-auth-middleware': 'true',
    });
    const cookie = outboundCookies(request);
    if (cookie) headers.set('Cookie', cookie);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    let response: Response;
    const timeout = AbortSignal.timeout(15_000);
    try {
      response = await fetcher(`${config.neonAuthBaseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: timeout,
      });
    } catch {
      throw new AccountServiceUnavailable(timeout.aborted ? 'timeout' : 'network');
    }
    if (response.status >= 500)
      throw new AccountServiceUnavailable('upstream_status', response.status);
    const received = response.headers.getSetCookie().map(localCookie);
    if (received.length) cookies.set(request, [...(cookies.get(request) ?? []), ...received]);
    return response;
  }
  function withCookies(request: Request, response: Response): Response {
    const pending = cookies.get(request);
    const failureId = failureIds.get(request);
    if (pending?.length || failureId) {
      // Fetch/redirect responses may have immutable headers.
      response = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      for (const cookie of pending ?? []) response.headers.append('Set-Cookie', cookie);
      if (failureId) response.headers.set('X-Corner-Request-Id', failureId);
    }
    cookies.delete(request);
    failureIds.delete(request);
    return response;
  }
  return {
    async handler(request) {
      const url = new URL(request.url);
      const path = url.pathname.slice('/api/auth'.length);
      if (endpoints[path] !== request.method)
        throw new ApiError(404, 'NOT_FOUND', 'This account endpoint does not exist.');
      let body = await request.text();
      if (path === '/email-otp/send-verification-otp') {
        const input = z
          .object({ email: z.string().email(), type: z.literal('email-verification') })
          .strict()
          .parse(JSON.parse(body));
        body = JSON.stringify(input);
      }
      if (path === '/sign-up/email' || path === '/reset-password') {
        const input = JSON.parse(body);
        z.string()
          .min(12)
          .max(128)
          .parse(path === '/sign-up/email' ? input.password : input.newPassword);
      }
      const response = await upstream(request, path + url.search, body);
      // Session tokens remain opaque HttpOnly cookies, never application JSON.
      const text = await response.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new AccountServiceUnavailable('invalid_json', response.status);
      }
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const { token: _token, ...rest } = data as Record<string, unknown>;
        data = { ...rest, ...(_token === null ? { token: null } : {}) };
      }
      return withCookies(
        request,
        new Response(JSON.stringify(data), {
          status: response.status,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        }),
      );
    },
    async principal(request) {
      if (!outboundCookies(request)) return null;
      const started = performance.now();
      try {
        const response = await upstream(request, '/get-session?disableCookieCache=true');
        if (response.status === 401) return null;
        if (!response.ok) throw new AccountServiceUnavailable('upstream_status', response.status);
        let data: unknown;
        try {
          data = await response.json();
        } catch (error) {
          throw new AccountServiceUnavailable(
            error instanceof SyntaxError
              ? 'invalid_json'
              : error instanceof DOMException && error.name === 'TimeoutError'
                ? 'timeout'
                : 'network',
            response.status,
          );
        }
        if (data === null) return null;
        const parsed = sessionSchema.safeParse(data);
        if (!parsed.success)
          throw new AccountServiceUnavailable('invalid_session', response.status);
        const { user, session } = parsed.data;
        if (session.userId !== user.id || Date.parse(session.expiresAt) <= Date.now()) return null;
        if (config.neonAuthRequireEmailVerification && !user.emailVerified) return null;
        return { userId: user.id, name: user.name, email: user.email, sessionId: session.id };
      } catch (error) {
        if (error instanceof AccountServiceUnavailable) {
          const requestId = crypto.randomUUID();
          failureIds.set(request, requestId);
          // Only allowlisted procedure names and typed failure metadata leave this boundary.
          console.warn(
            JSON.stringify({
              event: 'ACCOUNT_SESSION_LOOKUP_FAILED',
              timestamp: new Date().toISOString(),
              service: 'managed-auth',
              severity: 'warn',
              deployment: config.deployment,
              requestId,
              procedure: procedures.get(new URL(request.url).pathname) ?? null,
              servingVersion: servingVersion ?? null,
              category: error.category,
              upstreamStatus: error.upstreamStatus,
              durationMs: Math.round(performance.now() - started),
            }),
          );
        }
        throw error;
      }
    },
    withCookies,
  };
}

export async function requirePrincipal(auth: CornerAuth, request: Request): Promise<Principal> {
  const principal = await auth.principal(request);
  if (!principal)
    throw new ApiError(401, 'SIGN_IN_REQUIRED', 'Sign in to your Corner account to continue.');
  return principal;
}
