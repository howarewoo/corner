import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Pool } from 'pg';
import {
  testDatabase,
  closeTestDatabase,
  createTestAuth,
  neonTestConfig,
  readResponse,
} from './helpers.ts';
import type { CornerAuth } from '../src/auth.ts';
import { createApp } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import type { SubscriptionProvider } from '../src/subscription.ts';
import type { PlanningAgent } from '../src/planning-agent.ts';
import { WorkspaceStore } from '../src/store.ts';
import { createQueries } from '../src/queries.ts';
import { createInitialState } from '@packages/workspace/initial-state';

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
let callbackOwner: { owner: string; hasVerifiedSession: boolean } | undefined;

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
  const rpc = path.startsWith('/api/rpc/');
  const method = options.method ?? (rpc || options.body !== undefined ? 'POST' : 'GET');
  const headers = new Headers({ 'x-corner-client-ip': '127.0.0.1', ...options.headers });
  if (rpc || options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (options.origin !== null) headers.set('Origin', options.origin ?? config.origin);
  if (options.cookie) headers.set('Cookie', options.cookie);
  return app.request(`${config.origin}${path}`, {
    method,
    headers,
    ...(rpc
      ? { body: JSON.stringify({ json: options.body }) }
      : options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
  });
}

async function account(name: string, email: string) {
  const response = await request('/api/auth/sign-up/email', { body: { name, email, password } });
  assert.equal(response.status, 200, 'actual Better Auth sign-up should succeed');
  const cookies = response.headers.getSetCookie();
  assert(cookies.some((value) => /httponly/i.test(value) && /samesite=lax/i.test(value)));
  const payload = await readResponse(response);
  return {
    cookie: cookies.map((value) => value.split(';', 1)[0]).join('; '),
    id: payload.user.id as string,
  };
}

async function expectError(response: Response, status: number, expectedCode: string) {
  assert.equal(response.status, status);
  const body = await readResponse(response);
  assert.equal(body.data?.code ?? body.code, expectedCode);
  assert.equal(typeof (body.message ?? body.error), 'string');
  return body;
}

before(async () => {
  db = await testDatabase();
  auth = await createTestAuth(config, db);
  store = new WorkspaceStore(createQueries(db));
  const provider = {
    async callback(owner: string, _url: URL, sessionId: string) {
      callbackOwner = { owner, hasVerifiedSession: Boolean(sessionId) };
    },
    async models() {
      return [];
    },
  } as unknown as SubscriptionProvider;
  app = createApp({ config, auth, store, ai: { provider, agent: {} as PlanningAgent } });
  alice = await account('Alice', 'alice@example.test');
  bob = await account('Bob', 'bob@example.test');
});
after(async () => await closeTestDatabase(db));

test('anonymous requests and forged Sites headers cannot authenticate or select a workspace', async () => {
  assert.deepEqual(await readResponse(await request('/api/rpc/account/session')), { user: null });
  await expectError(
    await request('/api/rpc/workspace/get', {
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
  const session = await readResponse(
    await request('/api/rpc/account/session', { cookie: alice.cookie }),
  );
  assert.equal(session.user.id, alice.id);
  assert.equal(session.user.sessionId, undefined);
  assert.equal(session.user.token, undefined);
});

test('unverified managed sign-in resolves only when application verification is disabled', async () => {
  const requiredConfig = { ...config, neonAuthRequireEmailVerification: true };
  const requiredApp = createApp({
    config: requiredConfig,
    auth: await createTestAuth(requiredConfig, db),
    store,
  });
  const signIn = await requiredApp.request(config.origin + '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { Origin: config.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'alice@example.test', password }),
  });
  assert.equal(signIn.status, 200);
  const payload = await readResponse(signIn);
  assert.equal(payload.user.emailVerified, false);
  assert.equal(payload.token, undefined);
  const cookie = signIn.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
  assert.match(cookie, /neon-auth.session_token=/);
  const lookup = (path: string) => requiredApp.request(config.origin + path, {
    method: 'POST',
    headers: { Origin: config.origin, 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({}),
  });
  const denied = await lookup('/api/rpc/account/session');
  assert.equal(denied.status, 200);
  assert.deepEqual(await readResponse(denied), { user: null });
  await expectError(await lookup('/api/rpc/workspace/get'), 401, 'SIGN_IN_REQUIRED');

  const allowed = await request('/api/rpc/account/session', { cookie });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await readResponse(allowed), {
    user: { id: alice.id, name: 'Alice', email: 'alice@example.test' },
  });
  assert.equal((await request('/api/rpc/workspace/get', { cookie })).status, 200);
});

test('new authenticated accounts are empty and OAuth callbacks receive the verified session', async () => {
  const state = await readResponse(
    await request('/api/rpc/workspace/get', { cookie: alice.cookie }),
  );
  assert.equal(state.settings.name, 'Alice');
  assert.equal(state.revision, 0);
  assert.equal(state.aiAvailable, false);
  assert.equal('state' in state, false);
  const exported = await readResponse(
    await request('/api/rpc/workspace/export', { cookie: alice.cookie }),
  );
  assert.deepEqual(exported.state.recipes, []);
  assert.deepEqual(exported.state.training.sessions, []);
  const callback = await request('/auth/callback?code=test-only', {
    cookie: alice.cookie,
    origin: null,
  });
  assert.equal(callback.status, 303);
  assert.deepEqual(callbackOwner, { owner: alice.id, hasVerifiedSession: true });
});

test('cookie-authenticated writes reject missing or foreign origins before changes', async () => {
  const body = {
    requestId: 'origin-check-123',
    mutation: { type: 'grocery.check', data: { key: 'oats|g', checked: true } },
  };
  await expectError(
    await request('/api/rpc/workspace/mutate', { cookie: alice.cookie, body, origin: null }),
    403,
    'ORIGIN_REQUIRED',
  );
  await expectError(
    await request('/api/rpc/workspace/mutate', {
      cookie: alice.cookie,
      body,
      origin: 'https://other.example',
    }),
    403,
    'ORIGIN_NOT_ALLOWED',
  );
  await expectError(
    await request('/api/rpc/workspace/mutate', {
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
  assert.equal((await store.bootstrap(alice.id)).revision, 0);
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
  const first = await request('/api/rpc/workspace/mutate', {
    cookie: alice.cookie,
    body,
    headers: { 'oai-authenticated-user-id': bob.id },
  });
  assert.equal(first.status, 200);
  assert.equal((await readResponse(first)).revision, 1);
  const replay = await request('/api/rpc/workspace/mutate', { cookie: alice.cookie, body });
  assert.equal((await readResponse(replay)).revision, 1);
  assert.equal((await store.bootstrap(alice.id)).settings.training.calories, 2300);
  assert.equal((await store.bootstrap(bob.id)).settings.training.calories, 0);
  await expectError(
    await request('/api/rpc/workspace/mutate', {
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
  const preview = await request('/api/rpc/workspace/previewImport', {
    cookie: bob.cookie,
    body: { state: legacyExport },
  });
  assert.equal(preview.status, 200);
  const details = await readResponse(preview);
  assert.equal(details.summary.foodEntries, 1);
  assert.equal(details.canImport, true);
  assert.equal((await store.bootstrap(bob.id)).revision, 0);
  await expectError(
    await request('/api/rpc/workspace/import', {
      cookie: bob.cookie,
      body: { state: legacyExport, requestId: 'import-bob-123' },
    }),
    400,
    'INVALID_INPUT',
  );
  const result = await request('/api/rpc/workspace/import', {
    cookie: bob.cookie,
    body: { state: legacyExport, requestId: 'import-bob-123', expectedRevision: 0 },
  });
  assert.equal(result.status, 200);
  const saved = await readResponse(result);
  assert.deepEqual(saved, { revision: 1 });
  const exported = await store.exportSnapshot(bob.id);
  assert.deepEqual(exported.state.logs, imported.logs);
  assert.deepEqual(exported.state.training.sessions, []);
  assert.equal((await store.exportSnapshot(alice.id)).state.logs.length, 0);
  await expectError(
    await request('/api/rpc/workspace/import', {
      cookie: bob.cookie,
      body: { state: legacyExport, requestId: 'import-bob-again', expectedRevision: 1 },
    }),
    409,
    'WORKSPACE_NOT_EMPTY',
  );
});

test('JSON/body limits and error envelopes avoid internal data exposure', async () => {
  const large = new Request(`${config.origin}/api/rpc/workspace/mutate`, {
    method: 'POST',
    headers: { Cookie: alice.cookie, Origin: config.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ junk: 'x'.repeat(192 * 1024) }),
  });
  await expectError(await app.fetch(large), 413, 'REQUEST_TOO_LARGE');
  const nonJson = new Request(`${config.origin}/api/rpc/workspace/mutate`, {
    method: 'POST',
    headers: { Cookie: alice.cookie, Origin: config.origin, 'Content-Type': 'text/plain' },
    body: 'hello',
  });
  await expectError(await app.fetch(nonJson), 415, 'JSON_REQUIRED');
  const originalRead = store.bootstrap.bind(store);
  store.bootstrap = async () => {
    throw new Error('private-database-details-and-secret');
  };
  try {
    const response = await request('/api/rpc/workspace/get', { cookie: alice.cookie });
    const safe = await expectError(response, 503, 'SERVICE_UNAVAILABLE');
    assert(!JSON.stringify(safe).includes('private-database'));
  } finally {
    store.bootstrap = originalRead;
  }
});

test('RPC preserves raw mutation identity before domain normalization and retained receipt replay', async () => {
  const requestId = 'raw-fingerprint-123';
  const mutation = {
    type: 'grocery.check',
    data: { key: ' oats|g ', checked: true, extra: 'retained' },
  };
  const committed = await store.mutate(alice.id, requestId, mutation);
  const replay = await request('/api/rpc/workspace/mutate', {
    cookie: alice.cookie,
    body: { requestId, mutation },
  });
  assert.equal(replay.status, 200);
  assert.equal((await readResponse(replay)).revision, committed.revision);
  await expectError(
    await request('/api/rpc/workspace/mutate', {
      cookie: alice.cookie,
      body: {
        requestId,
        mutation: { type: 'grocery.check', data: { key: 'oats|g', checked: true } },
      },
    }),
    409,
    'REQUEST_ID_REUSED',
  );
  const saved = await store.exportSnapshot(alice.id);
  assert.equal(saved.revision, committed.revision);
  assert.equal(saved.state.groceryChecks['oats|g'], true);
});

test('real sign-out revokes the cookie session while password sign-in creates a new session', async () => {
  const logout = await request('/api/auth/sign-out', { cookie: bob.cookie, body: {} });
  assert.equal(logout.status, 200);
  await expectError(
    await request('/api/rpc/workspace/get', { cookie: bob.cookie }),
    401,
    'SIGN_IN_REQUIRED',
  );
  const login = await request('/api/auth/sign-in/email', {
    body: { email: 'bob@example.test', password },
  });
  assert.equal(login.status, 200);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';', 1)[0])
    .join('; ');
  const state = await request('/api/rpc/workspace/foodWindow', {
    cookie, body: { from: '2026-10-21', through: '2026-10-21' },
  });
  assert.equal(state.status, 200);
  assert.equal((await readResponse(state)).entries[0].id, 'past-log');
});

test('expired database sessions cannot keep reading workspace data', async () => {
  await db.query('UPDATE session SET "expiresAt" = $1 WHERE "userId" = $2', [
    new Date(0),
    alice.id,
  ]);
  await expectError(
    await request('/api/rpc/workspace/get', { cookie: alice.cookie }),
    401,
    'SIGN_IN_REQUIRED',
  );
});
