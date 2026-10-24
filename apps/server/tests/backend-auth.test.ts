import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Pool } from 'pg';
import { testDatabase, closeTestDatabase, createTestAuth, neonTestConfig } from './helpers.ts';
import type { CornerAuth } from '../src/auth.ts';
import { createApp, type AppEnvironment } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import { json } from '../src/http.ts';
import { WorkspaceStore } from '../src/store.ts';
import { createInitialState } from '@packages/shared/seed';

const config: Config = {
  ...neonTestConfig,
  origin: 'http://127.0.0.1:3000',
  host: '127.0.0.1',
  port: 3000,
  dataDir: '/tmp',
  deployment: 'local',
  authSecret: 'unit-test-auth-secret-that-is-long-enough-to-use',
  tokenEncryptionKey: Buffer.alloc(32, 7),
};
let db: Pool;
let store: WorkspaceStore;
let auth: CornerAuth;
let app: ReturnType<typeof createApp>;
let alice: { cookie: string; id: string };
let bob: { cookie: string; id: string };
const password = 'test-only-password-with-twelve-characters';

function request(
  path: string,
  options: {
    body?: unknown;
    cookie?: string;
    method?: string;
    origin?: string | null;
    headers?: Record<string, string>;
  } = {},
) {
  const method = options.method ?? (options.body !== undefined ? 'POST' : 'GET');
  const headers = new Headers({ 'x-corner-client-ip': '127.0.0.1', ...options.headers });
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (options.origin !== null) headers.set('Origin', options.origin ?? config.origin);
  if (options.cookie) headers.set('Cookie', options.cookie);
  return app.request(`${config.origin}${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

async function account(name: string, email: string) {
  const response = await request('/api/auth/sign-up/email', { body: { name, email, password } });
  assert.equal(response.status, 200, 'actual Better Auth sign-up should succeed');
  const cookies = response.headers.getSetCookie();
  assert(cookies.some((value) => /httponly/i.test(value) && /samesite=lax/i.test(value)));
  const payload = await response.json();
  return {
    cookie: cookies.map((value) => value.split(';', 1)[0]).join('; '),
    id: payload.user.id as string,
  };
}

async function expectError(response: Response, status: number, expectedCode: string) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.code, expectedCode);
  assert.equal(typeof body.error, 'string');
  return body;
}

before(async () => {
  db = await testDatabase();
  auth = await createTestAuth(config, db);
  store = new WorkspaceStore(db);
  const extraRoutes = new Hono<AppEnvironment>().on(
    'GET',
    ['/api/identity-test', '/auth/callback'],
    (c) => {
      const principal = c.get('principal');
      return json({ owner: principal.userId, hasVerifiedSession: Boolean(principal.sessionId) });
    },
  );
  app = createApp({ config, auth, store, extraRoutes });
  alice = await account('Alice', 'alice@example.test');
  bob = await account('Bob', 'bob@example.test');
});
after(async () => await closeTestDatabase(db));

test('anonymous requests and forged Sites headers cannot authenticate or select a workspace', async () => {
  assert.deepEqual(await (await request('/api/session')).json(), { user: null });
  await expectError(
    await request('/api/state', {
      headers: {
        'oai-authenticated-user-id': alice.id,
        'oai-authenticated-user-email': 'alice@example.test',
      },
    }),
    401,
    'SIGN_IN_REQUIRED',
  );
  await expectError(await request('/api/identity-test'), 401, 'SIGN_IN_REQUIRED');
  await expectError(await request('/auth/callback'), 401, 'SIGN_IN_REQUIRED');
  assert.equal((await request('/api/health')).status, 200);
  const session = await (await request('/api/session', { cookie: alice.cookie })).json();
  assert.equal(session.user.id, alice.id);
  assert.equal(session.user.sessionId, undefined);
  assert.equal(session.user.token, undefined);
});

test('new authenticated accounts are empty and protected extra routes receive the verified session', async () => {
  const state = await (await request('/api/state', { cookie: alice.cookie })).json();
  assert.equal(state.state.settings.name, 'Alice');
  assert.equal(state.revision, 0);
  assert.equal(state.aiAvailable, false);
  assert.deepEqual(state.state.recipes, []);
  assert.deepEqual(state.state.training.sessions, []);
  const callback = await request('/auth/callback?code=test-only', {
    cookie: alice.cookie,
    origin: null,
  });
  assert.deepEqual(await callback.json(), { owner: alice.id, hasVerifiedSession: true });
});

test('cookie-authenticated writes reject missing or foreign origins before changes', async () => {
  const body = {
    requestId: 'origin-check-123',
    mutation: { type: 'grocery.check', data: { key: 'oats|g', checked: true } },
  };
  await expectError(
    await request('/api/mutate', { cookie: alice.cookie, body, origin: null }),
    403,
    'ORIGIN_REQUIRED',
  );
  await expectError(
    await request('/api/mutate', { cookie: alice.cookie, body, origin: 'https://other.example' }),
    403,
    'ORIGIN_NOT_ALLOWED',
  );
  await expectError(
    await request('/api/mutate', {
      cookie: alice.cookie,
      body,
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    }),
    403,
    'ORIGIN_NOT_ALLOWED',
  );
  await expectError(
    await request('/api/auth/sign-out', {
      cookie: alice.cookie,
      body: {},
      origin: 'https://other.example',
    }),
    403,
    'ORIGIN_NOT_ALLOWED',
  );
  assert.equal((await store.read(alice.id)).revision, 0);
});

test('two real account sessions isolate writes and retries preserve revision', async () => {
  const body = {
    requestId: 'alice-settings-123',
    mutation: {
      type: 'settings.save',
      data: {
        ...createInitialState('Alice').settings,
        training: { calories: 2300, protein: 140, carbs: 290, fat: 65 },
      },
    },
  };
  const first = await request('/api/mutate', {
    cookie: alice.cookie,
    body,
    headers: { 'oai-authenticated-user-id': bob.id },
  });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).revision, 1);
  const replay = await request('/api/mutate', { cookie: alice.cookie, body });
  assert.equal((await replay.json()).revision, 1);
  assert.equal((await store.read(alice.id)).state.settings.training.calories, 2300);
  assert.equal((await store.read(bob.id)).state.settings.training.calories, 0);
  await expectError(
    await request('/api/mutate', {
      cookie: alice.cookie,
      body: { ...body, expectedRevision: 0, requestId: 'alice-conflict-123' },
    }),
    409,
    'REVISION_CONFLICT',
  );
});

test('import preview performs no writes and imported records belong only to the current account', async () => {
  const imported = createInitialState('Imported profile');
  imported.logs = [
    {
      id: 'past-log',
      date: '2026-10-21',
      slot: 'lunch',
      name: 'Lunch',
      nutrition: { calories: 500, protein: 30, carbs: 55, fat: 18 },
      servings: 1,
      createdAt: '2026-10-21T12:00:00.000Z',
    },
  ];
  const { training: _training, ...legacyExport } = imported;
  const preview = await request('/api/import/preview', {
    cookie: bob.cookie,
    body: { state: legacyExport },
  });
  assert.equal(preview.status, 200);
  const details = await preview.json();
  assert.equal(details.summary.foodEntries, 1);
  assert.equal(details.canImport, true);
  assert.equal((await store.read(bob.id)).revision, 0);
  await expectError(
    await request('/api/import', {
      cookie: bob.cookie,
      body: { state: legacyExport, requestId: 'import-bob-123' },
    }),
    400,
    'INVALID_INPUT',
  );
  const result = await request('/api/import', {
    cookie: bob.cookie,
    body: { state: legacyExport, requestId: 'import-bob-123', expectedRevision: 0 },
  });
  assert.equal(result.status, 200);
  const saved = await result.json();
  assert.deepEqual(saved.state.logs, imported.logs);
  assert.deepEqual(saved.state.training.sessions, []);
  assert.equal((await store.read(alice.id)).state.logs.length, 0);
  await expectError(
    await request('/api/import', {
      cookie: bob.cookie,
      body: { state: legacyExport, requestId: 'import-bob-again', expectedRevision: 1 },
    }),
    409,
    'WORKSPACE_NOT_EMPTY',
  );
});

test('JSON/body limits and error envelopes avoid internal data exposure', async () => {
  const large = new Request(`${config.origin}/api/mutate`, {
    method: 'POST',
    headers: { Cookie: alice.cookie, Origin: config.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ junk: 'x'.repeat(192 * 1024) }),
  });
  await expectError(await app.fetch(large), 413, 'REQUEST_TOO_LARGE');
  const nonJson = new Request(`${config.origin}/api/mutate`, {
    method: 'POST',
    headers: { Cookie: alice.cookie, Origin: config.origin, 'Content-Type': 'text/plain' },
    body: 'hello',
  });
  await expectError(await app.fetch(nonJson), 415, 'JSON_REQUIRED');
  const extraRoutes = new Hono<AppEnvironment>().get('/api/failing', () => {
    throw new Error('private-database-details-and-secret');
  });
  const failed = createApp({ config, auth, store, extraRoutes });
  const response = await failed.request(`${config.origin}/api/failing`, {
    headers: { Cookie: alice.cookie },
  });
  const safe = await expectError(response, 503, 'SERVICE_UNAVAILABLE');
  assert(!JSON.stringify(safe).includes('private-database'));
});

test('real sign-out revokes the cookie session while password sign-in creates a new session', async () => {
  const logout = await request('/api/auth/sign-out', { cookie: bob.cookie, body: {} });
  assert.equal(logout.status, 200);
  await expectError(await request('/api/state', { cookie: bob.cookie }), 401, 'SIGN_IN_REQUIRED');
  const login = await request('/api/auth/sign-in/email', {
    body: { email: 'bob@example.test', password },
  });
  assert.equal(login.status, 200);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';', 1)[0])
    .join('; ');
  const state = await request('/api/state', { cookie });
  assert.equal(state.status, 200);
  assert.equal((await state.json()).state.logs[0].id, 'past-log');
});

test('expired database sessions cannot keep reading workspace data', async () => {
  await db.query('UPDATE session SET "expiresAt" = $1 WHERE "userId" = $2', [
    new Date(0),
    alice.id,
  ]);
  await expectError(await request('/api/state', { cookie: alice.cookie }), 401, 'SIGN_IN_REQUIRED');
});
