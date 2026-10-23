import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuth } from '../auth.ts';
import { ApiError } from '../http.ts';
import type { Config } from '../config.ts';

const config: Config = {
  origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000, deployment: 'local', dataDir: '/tmp',
  databaseUrl: 'postgresql://unused.invalid/test', neonAuthBaseUrl: 'https://auth.example.test/neondb/auth',
  neonAuthRequireEmailVerification: true, authSecret: 'synthetic-session-binding-secret-32-characters', tokenEncryptionKey: Buffer.alloc(32, 7),
};
const valid = {
  user: { id: 'owner-a', name: 'Alice', email: 'alice@example.test', emailVerified: true },
  session: { id: 'session-a', userId: 'owner-a', expiresAt: '2099-01-01T00:00:00.000Z' },
};

// The managed service is a trusted but fallible external boundary, not a browser identity claim.
test('session validation rejects expired, mismatched, unverified, and malformed managed identities', async () => {
  const request = new Request(config.origin + '/api/state', { headers: { Cookie: 'neon-auth.session_token=opaque' } });
  for (const data of [
    { ...valid, session: { ...valid.session, userId: 'owner-b' } },
    { ...valid, session: { ...valid.session, expiresAt: '2000-01-01T00:00:00.000Z' } },
    { ...valid, user: { ...valid.user, emailVerified: false } },
  ]) {
    const auth = createAuth(config, async () => Response.json(data));
    assert.equal(await auth.principal(request), null);
  }
  const malformed = createAuth(config, async () => Response.json({ user: valid.user }));
  await assert.rejects(malformed.principal(request), error => error instanceof ApiError && error.status === 503);
  const failed = createAuth(config, async () => { throw new Error('private-service-details'); });
  await assert.rejects(failed.principal(request), error => error instanceof ApiError && error.code === 'ACCOUNT_SERVICE_UNAVAILABLE' && !error.message.includes('private-service'));
});

test('session renewal cookies remain host-only and valid on HTTP and HTTPS without leaking unrelated cookies', async () => {
  for (const origin of [config.origin, 'https://corner.example.test']) {
    const secure = origin.startsWith('https:');
    const request = new Request(origin + '/api/session', { headers: { Cookie: `${secure ? '__Secure-' : ''}neon-auth.session_token=opaque; unrelated=private` } });
    const auth = createAuth({ ...config, origin }, async (_input, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('Cookie'), '__Secure-neon-auth.session_token=opaque');
      const response = Response.json(valid);
      response.headers.append('Set-Cookie', '__Secure-neon-auth.session_token=renewed; Domain=auth.example.test; Path=/neondb/auth; Secure; HttpOnly; SameSite=None; Partitioned');
      response.headers.append('Set-Cookie', '__Secure-neon-auth.dont_remember=; Max-Age=0; Secure');
      return response;
    });
    const principal = await auth.principal(request);
    assert.equal(principal?.userId, 'owner-a');
    const response = auth.withCookies(request, secure ? Response.redirect(origin + '/?ai=connected', 303) : Response.json({ user: principal?.userId }));
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
