import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuth } from '../auth.ts';
import { ApiError } from '../http.ts';
import type { Config } from '../config.ts';

const config: Config = {
  origin: 'http://127.0.0.1:3000',
  host: '127.0.0.1',
  port: 3000,
  deployment: 'local',
  dataDir: '/tmp',
  databaseUrl: 'postgresql://unused.invalid/test',
  neonAuthBaseUrl: 'https://auth.example.test/neondb/auth',
  neonAuthRequireEmailVerification: true,
  authSecret: 'synthetic-session-binding-secret-32-characters',
  tokenEncryptionKey: Buffer.alloc(32, 7),
};
const valid = {
  user: { id: 'owner-a', name: 'Alice', email: 'alice@example.test', emailVerified: true },
  session: { id: 'session-a', userId: 'owner-a', expiresAt: '2099-01-01T00:00:00.000Z' },
};

// The managed service is a trusted but fallible external boundary, not a browser identity claim.
test('session validation rejects expired, mismatched, unverified, and malformed managed identities', async () => {
  const request = new Request(config.origin + '/api/state', {
    headers: { Cookie: 'neon-auth.session_token=opaque' },
  });
  for (const data of [
    { ...valid, session: { ...valid.session, userId: 'owner-b' } },
    { ...valid, session: { ...valid.session, expiresAt: '2000-01-01T00:00:00.000Z' } },
    { ...valid, user: { ...valid.user, emailVerified: false } },
  ]) {
    const auth = createAuth(config, async () => Response.json(data));
    assert.equal(await auth.principal(request), null);
  }
  const malformed = createAuth(config, async () => Response.json({ user: valid.user }));
  await assert.rejects(
    malformed.principal(request),
    (error) => error instanceof ApiError && error.status === 503,
  );
  const failed = createAuth(config, async () => {
    throw new Error('private-service-details');
  });
  await assert.rejects(
    failed.principal(request),
    (error) =>
      error instanceof ApiError &&
      error.code === 'ACCOUNT_SERVICE_UNAVAILABLE' &&
      !error.message.includes('private-service'),
  );
});

test('session renewal cookies remain host-only and valid on HTTP and HTTPS without leaking unrelated cookies', async () => {
  for (const origin of [config.origin, 'https://corner.example.test']) {
    const secure = origin.startsWith('https:');
    const request = new Request(origin + '/api/session', {
      headers: {
        Cookie: `${secure ? '__Secure-' : ''}neon-auth.session_token=opaque; unrelated=private`,
      },
    });
    const auth = createAuth({ ...config, origin }, async (_input, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('Cookie'), '__Secure-neon-auth.session_token=opaque');
      const response = Response.json(valid);
      response.headers.append(
        'Set-Cookie',
        '__Secure-neon-auth.session_token=renewed; Domain=auth.example.test; Path=/neondb/auth; Secure; HttpOnly; SameSite=None; Partitioned',
      );
      response.headers.append('Set-Cookie', '__Secure-neon-auth.dont_remember=; Max-Age=0; Secure');
      return response;
    });
    const principal = await auth.principal(request);
    assert.equal(principal?.userId, 'owner-a');
    const response = auth.withCookies(
      request,
      secure
        ? Response.redirect(origin + '/?ai=connected', 303)
        : Response.json({ user: principal?.userId }),
    );
    assert.equal(response.status, secure ? 303 : 200);
    if (secure) assert.equal(response.headers.get('Location'), origin + '/?ai=connected');
    const cookies = response.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    for (const cookie of cookies) {
      assert.doesNotMatch(cookie, /Domain=|Partitioned|SameSite=None/i);
      assert.match(cookie, /Path=\/; HttpOnly; SameSite=Lax/);
      assert.equal(/; Secure(?:;|$)/i.test(cookie), secure);
      assert.equal(cookie.startsWith('__Secure-'), secure);
    }
    assert.match(cookies[1], /Max-Age=0/);
  }
});

test('managed session failures keep the public 503 but emit correlated, sanitized categories', async (t) => {
  const cases = [
    { category: 'network', status: null, fetcher: async () => { throw new Error('private-service-details'); } },
    { category: 'timeout', status: null, fetcher: async () => { throw new DOMException('private-timeout', 'TimeoutError'); } },
    { category: 'upstream_status', status: 429, fetcher: async () => new Response('private-rate-limit', { status: 429 }) },
    { category: 'upstream_status', status: 502, fetcher: async () => new Response('private-upstream', { status: 502 }) },
    { category: 'invalid_json', status: 200, fetcher: async () => new Response('private-invalid-json') },
    { category: 'invalid_session', status: 200, fetcher: async () => Response.json({ user: valid.user }) },
  ] as const;
  for (const scenario of cases) {
    await t.test(`${scenario.category} ${scenario.status}`, async (t) => {
      const events: Array<Record<string, unknown>> = [];
      t.mock.method(console, 'warn', (message: string) => events.push(JSON.parse(message)));
      if (scenario.category === 'timeout')
        t.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort(new DOMException('Timed out', 'TimeoutError')));
      const request = new Request(config.origin + '/api/rpc/workspace/get?email=private-query', {
        headers: { Cookie: 'neon-auth.session_token=opaque; unrelated=private-cookie',
          Authorization: 'Bearer private-token', 'X-Corner-Request-Id': 'private-client-id' },
      });
      const auth = createAuth(config, scenario.fetcher, 'synthetic-version');
      await assert.rejects(auth.principal(request), (error) =>
        error instanceof ApiError && error.status === 503 && error.code === 'ACCOUNT_SERVICE_UNAVAILABLE');
      const response = auth.withCookies(request, Response.json({}, { status: 503 }));
      assert.equal(events.length, 1);
      const event = events[0];
      const requestId = response.headers.get('X-Corner-Request-Id');
      assert.match(requestId!, /^[0-9a-f-]{36}$/);
      assert.deepEqual(event, {
        event: 'ACCOUNT_SESSION_LOOKUP_FAILED', severity: 'warn', deployment: 'local',
        requestId, procedure: 'workspace.get', servingVersion: 'synthetic-version',
        category: scenario.category, upstreamStatus: scenario.status, durationMs: event.durationMs,
        timestamp: event.timestamp, service: 'managed-auth',
      });
      assert.equal(typeof event.durationMs, 'number');
      assert.ok(Number(event.durationMs) >= 0);
      assert.doesNotMatch(JSON.stringify(event), /private|opaque|Alice|alice|owner-a|session-a/);
      assert.equal(auth.withCookies(request, Response.json({})).headers.get('X-Corner-Request-Id'), null);
    });
  }
});

test('missing and invalid sessions stay signed out without unavailable diagnostics or identity caching', async (t) => {
  const warnings = t.mock.method(console, 'warn', () => {});
  let lookups = 0;
  const auth = createAuth(config, async () => {
    lookups++;
    return lookups === 1 ? Response.json(valid) : new Response(null, { status: 401 });
  });
  assert.equal(await auth.principal(new Request(config.origin)), null);
  const request = new Request(config.origin + '/api/rpc/account/session', {
    headers: { Cookie: 'neon-auth.session_token=opaque' },
  });
  assert.equal((await auth.principal(request))?.userId, 'owner-a');
  assert.equal(await auth.principal(request), null);
  assert.equal(lookups, 2);
  assert.equal(warnings.mock.callCount(), 0);
});
