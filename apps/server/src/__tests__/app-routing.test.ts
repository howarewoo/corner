import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Pool } from 'pg';
import { createApp } from '../app.ts';
import type { Config } from '../config.ts';
import { WorkspaceStore } from '../store.ts';
import {
  closeTestDatabase,
  createTestAuth,
  neonTestConfig,
  testDatabase,
} from '../../tests/helpers.ts';

const config: Config = {
  ...neonTestConfig,
  origin: 'http://127.0.0.1:3000',
  host: '127.0.0.1',
  port: 3000,
  dataDir: '/tmp',
  deployment: 'local',
  authSecret: 'synthetic-routing-secret-more-than-32-characters',
  tokenEncryptionKey: Buffer.alloc(32, 7),
};
let db: Pool;
let app: ReturnType<typeof createApp>;
let cookie: string;

before(async () => {
  db = await testDatabase();
  const auth = await createTestAuth(config, db);
  app = createApp({ config, auth, store: new WorkspaceStore(db) });
  const response = await app.request(`${config.origin}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { Origin: config.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Routing',
      email: 'routing@example.test',
      password: 'synthetic-routing-test-password',
    }),
  });
  assert.equal(response.status, 200);
  cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';', 1)[0])
    .join('; ');
});
after(async () => closeTestDatabase(db));

const request = (path: string, options: RequestInit = {}) =>
  app.request(config.origin + path, options);

test('implicit HEAD dispatch cannot expose public or protected GET endpoints', async () => {
  const publicHead = await request('/api/health', { method: 'HEAD' });
  assert.equal(publicHead.status, 401);
  assert.equal(await publicHead.text(), '');
  const signedHead = await request('/api/state', { method: 'HEAD', headers: { Cookie: cookie } });
  assert.equal(signedHead.status, 404);
  assert.equal(await signedHead.text(), '');
  assert.equal(
    (await request('/api/account-policy', { method: 'HEAD', headers: { Cookie: cookie } })).status,
    404,
  );
});

test('unknown API routes preserve authentication, origin checks, and JSON errors', async () => {
  const anonymous = await request('/api/missing');
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).code, 'SIGN_IN_REQUIRED');
  const signed = await request('/api/missing', { headers: { Cookie: cookie } });
  assert.equal(signed.status, 404);
  assert.equal((await signed.json()).code, 'NOT_FOUND');
  const crossOrigin = await request('/api/missing', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: 'https://foreign.example.test' },
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await crossOrigin.json()).code, 'ORIGIN_NOT_ALLOWED');
  const outsideApi = await request('/not-an-api-route');
  assert.equal(outsideApi.status, 404);
  assert.equal((await outsideApi.json()).code, 'NOT_FOUND');
});

test('account proxy and exact paths do not broaden during route composition', async () => {
  const accountRoot = await request('/api/auth', {
    method: 'POST',
    headers: { Origin: config.origin, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(accountRoot.status, 404);
  assert.equal((await accountRoot.json()).code, 'NOT_FOUND');
  assert.equal((await request('/api/authentic')).status, 401);
  assert.equal((await request('/api/health/', { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await request('/api/%73tate', { headers: { Cookie: cookie } })).status, 404);
});
