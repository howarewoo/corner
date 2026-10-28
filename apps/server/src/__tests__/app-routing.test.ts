import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Pool } from 'pg';
import { createApp } from '../app.ts';
import maintenanceWorker from '../maintenance-worker.ts';
import type { WorkerEnvironment } from '../worker.ts';
import type { Config } from '../config.ts';
import { WorkspaceStore } from '../store.ts';
import { createQueries } from '../queries.ts';
import {
  closeTestDatabase,
  createTestAuth,
  neonTestConfig,
  testDatabase,
  readResponse,
} from '../../tests/helpers.ts';

const config: Config = {
  ...neonTestConfig,
  origin: 'http://127.0.0.1:3000',
  host: '127.0.0.1',
  port: 3000,
  dataDir: '/tmp',
  deployment: 'local',
};
let db: Pool;
let app: ReturnType<typeof createApp>;
let cookie: string;

before(async () => {
  db = await testDatabase();
  const auth = await createTestAuth(config, db);
  app = createApp({ config, auth, store: new WorkspaceStore(createQueries(db)) });
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
  const signedHead = await request('/api/rpc/workspace/get', {
    method: 'HEAD',
    headers: { Cookie: cookie },
  });
  assert.equal(signedHead.status, 404);
  assert.equal(await signedHead.text(), '');
  assert.equal(
    (await request('/api/rpc/account/policy', { method: 'HEAD', headers: { Cookie: cookie } }))
      .status,
    404,
  );
});

test('unknown API routes preserve authentication, origin checks, and JSON errors', async () => {
  const anonymous = await request('/api/missing');
  assert.equal(anonymous.status, 401);
  assert.equal((await readResponse(anonymous)).code, 'SIGN_IN_REQUIRED');
  const signed = await request('/api/missing', { headers: { Cookie: cookie } });
  assert.equal(signed.status, 404);
  assert.equal((await readResponse(signed)).code, 'NOT_FOUND');
  const crossOrigin = await request('/api/missing', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: 'https://foreign.example.test' },
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await readResponse(crossOrigin)).code, 'ORIGIN_NOT_ALLOWED');
  const outsideApi = await request('/not-an-api-route');
  assert.equal(outsideApi.status, 404);
  assert.equal((await readResponse(outsideApi)).code, 'NOT_FOUND');
});

test('account proxy and exact paths do not broaden during route composition', async () => {
  const accountRoot = await request('/api/auth', {
    method: 'POST',
    headers: { Origin: config.origin, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(accountRoot.status, 404);
  assert.equal((await readResponse(accountRoot)).code, 'NOT_FOUND');
  assert.equal((await request('/api/authentic')).status, 401);
  assert.equal((await request('/api/health/', { headers: { Cookie: cookie } })).status, 404);
  assert.equal(
    (await request('/api/rpc/workspace/%67et', { headers: { Cookie: cookie } })).status,
    404,
  );
});

test('retired provider and planning routes reject while callback stays a no-store 404', async () => {
  for (const sessionCookie of ['', cookie]) {
    const response = await request('/auth/callback?code=retired&state=retired', {
      headers: sessionCookie ? { Cookie: sessionCookie } : {},
    });
    assert.equal(response.status, 404);
    assert.match(response.headers.get('Cache-Control') ?? '', /no-store/);
    assert.equal((await readResponse(response)).code, 'NOT_FOUND');
  }
  for (const path of [
    'ai/connection',
    'ai/connect',
    'ai/disconnect',
    'ai/setModel',
    'agent/list',
    'agent/get',
    'agent/start',
    'agent/cancel',
    'agent/apply',
  ]) {
    const response = await request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: config.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        json: { id: 'retained-run', requestId: 'retired-request', prompt: 'Do not apply' },
      }),
    });
    assert.equal(response.status, 404, path);
    assert.match(response.headers.get('Cache-Control') ?? '', /no-store/);
  }
});

test('archival requests and reviews are not active resource query capabilities', async () => {
  for (const resource of ['recipeRequests', 'trainingRequests', 'reviews']) {
    const response = await request('/api/rpc/workspace/page', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: config.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ json: { resource } }),
    });
    assert.equal(response.status, 400, resource);
    const body = await readResponse(response);
    assert.equal(body.data.code, 'INVALID_INPUT');
  }
});

test('maintenance Worker responds 503 with Retry-After and no-store without invoking DB, Auth, or ASSETS', async () => {
  const versionId = '11111111-2222-4333-8444-555555555555';
  let assetsCalled = 0;
  const env: WorkerEnvironment = {
    CORNER_ORIGIN: 'https://corner.example.test',
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
    NEON_AUTH_BASE_URL: 'https://auth.example.test/neondb/auth',
    NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
    CF_VERSION_METADATA: { id: versionId },
    ASSETS: {
      fetch: async () => {
        assetsCalled += 1;
        throw new Error('ASSETS binding must never be invoked during maintenance');
      },
    },
  };

  const wrongOrigin = await maintenanceWorker.fetch(
    new Request('https://wrong.example.test/api/health'),
    env,
  );
  assert.equal(wrongOrigin.status, 400);
  assert.equal(wrongOrigin.headers.get('X-Corner-Version'), versionId);
  assert.equal(await wrongOrigin.text(), 'Open Corner using its configured origin.');

  const health = await maintenanceWorker.fetch(
    new Request('https://corner.example.test/api/health'),
    env,
  );
  assert.equal(health.status, 503);
  assert.equal(health.headers.get('X-Corner-Version'), versionId);
  assert.equal(health.headers.get('Retry-After'), '60');
  assert.equal(health.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(await health.json(), {
    ok: false,
    maintenance: true,
    code: 'MAINTENANCE_ACTIVE',
    error: 'Corner is temporarily unavailable for scheduled maintenance. Please try again shortly.',
  });

  const rpc = await maintenanceWorker.fetch(
    new Request('https://corner.example.test/api/rpc/workspace/get', {
      method: 'POST',
      headers: { Origin: 'https://corner.example.test', 'Content-Type': 'application/json' },
      body: '{}',
    }),
    env,
  );
  assert.equal(rpc.status, 503);
  const rpcPayload = await rpc.json();
  assert.deepEqual(rpcPayload, {
    json: {
      defined: true,
      code: 'SERVICE_UNAVAILABLE',
      status: 503,
      message:
        'Corner is temporarily unavailable for scheduled maintenance. Please try again shortly.',
      data: { code: 'MAINTENANCE_ACTIVE' },
    },
  });

  const authReq = await maintenanceWorker.fetch(
    new Request('https://corner.example.test/api/auth/sign-in/email', {
      method: 'POST',
      headers: { Origin: 'https://corner.example.test', 'Content-Type': 'application/json' },
      body: '{}',
    }),
    env,
  );
  assert.equal(authReq.status, 503);
  assert.equal((await authReq.json()).code, 'MAINTENANCE_ACTIVE');

  const page = await maintenanceWorker.fetch(
    new Request('https://corner.example.test/'),
    env,
  );
  assert.equal(page.status, 503);
  assert.equal(page.headers.get('Retry-After'), '60');
  assert.match(page.headers.get('Content-Security-Policy') ?? '', /frame-ancestors 'none'/);
  assert.match(await page.text(), /Corner is updating/);

  const asset = await maintenanceWorker.fetch(
    new Request('https://corner.example.test/assets/index.js'),
    env,
  );
  assert.equal(asset.status, 503);
  assert.equal(asset.headers.get('Retry-After'), '60');

  assert.equal(assetsCalled, 0);
});
