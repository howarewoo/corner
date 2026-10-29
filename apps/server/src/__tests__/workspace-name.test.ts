import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { Pool } from 'pg';
import type { Hono } from 'hono';
import { createInitialState } from '@packages/workspace/initial-state';
import { createApp, type AppEnvironment } from '../app.js';
import type { Config } from '../config.js';
import { ApiError } from '../http.js';
import { createQueries } from '../queries.js';
import { WorkspaceStore } from '../store.js';
import {
  closeTestDatabase,
  createTestAuth,
  neonTestConfig,
  readResponse,
  testDatabase,
} from '../../tests/helpers.ts';

const config: Config = {
  ...neonTestConfig,
  origin: 'http://127.0.0.1:3000',
  host: '127.0.0.1',
  port: 3000,
  dataDir: '/tmp',
  deployment: 'local',
  authSecret: 'workspace-name-test-secret-long-enough-to-use',
  tokenEncryptionKey: Buffer.alloc(32, 7),
};
const signupName = 'Fresh trainee Ω';
const food = {
  type: 'log.save' as const,
  data: {
    id: 'first-food',
    date: '2026-10-27',
    slot: 'lunch' as const,
    name: 'Oats',
    nutrition: { calories: 200, protein: 20, carbs: 25, fat: 5 },
    servings: 2,
    createdAt: '2026-10-27T12:00:00.000Z',
  },
};
const grocery = { type: 'grocery.check' as const, data: { key: 'oats|g', checked: true } };
let db: Pool;
let store: WorkspaceStore;
let app: Hono<AppEnvironment>;
let cookie: string;
let userId: string;

async function rpc(procedure: string, body?: unknown) {
  const response = await app.request(`${config.origin}/api/rpc/workspace/${procedure}`, {
    method: 'POST',
    headers: { Origin: config.origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ json: body }),
  });
  assert.equal(response.status, 200);
  return readResponse(response);
}

beforeEach(async () => {
  db = await testDatabase();
  store = new WorkspaceStore(createQueries(db));
  app = createApp({ config, auth: await createTestAuth(config, db), store });
  const signup = await app.request(`${config.origin}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { Origin: config.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: signupName,
      email: 'fresh-name@example.test',
      password: 'Synthetic-name-regression-password!',
    }),
  });
  assert.equal(signup.status, 200);
  cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(';', 1)[0])
    .join('; ');
  userId = (await readResponse(signup)).user.id;
});
afterEach(async () => closeTestDatabase(db));

test('first food save persists the authenticated name across reload and matching retries', async () => {
  assert.equal((await rpc('get')).settings.name, signupName);
  assert.equal((await db.query('SELECT COUNT(*) AS n FROM workspace_metadata')).rows[0].n, 0);
  const body = { requestId: 'first-food-request', mutation: food, expectedRevision: 0 };
  assert.deepEqual(await rpc('mutate', body), { revision: 1 });
  const reloaded = new WorkspaceStore(createQueries(db));
  assert.equal((await reloaded.bootstrap(userId)).settings.name, signupName);
  assert.deepEqual(await rpc('mutate', body), { revision: 1 });
  assert.deepEqual(await reloaded.mutate(userId, body.requestId, food, 0, 'Changed account name'), {
    revision: 1,
  });
  await assert.rejects(
    reloaded.mutate(userId, body.requestId, grocery, 0, signupName),
    (error: unknown) => error instanceof ApiError && error.code === 'REQUEST_ID_REUSED',
  );
  const saved = await reloaded.exportSnapshot(userId);
  assert.equal(saved.state.settings.name, signupName);
  assert.deepEqual(saved.state.logs, [food.data]);
  assert.equal(saved.revision, 1);
  assert.equal((await rpc('get')).settings.name, signupName);
});

test('a non-food first mutation preserves the signup name without an earlier workspace read', async () => {
  assert.deepEqual(await rpc('mutate', { requestId: 'first-grocery-request', mutation: grocery }), {
    revision: 1,
  });
  const saved = await new WorkspaceStore(createQueries(db)).exportSnapshot(userId);
  assert.equal(saved.state.settings.name, signupName);
  assert.equal(saved.state.groceryChecks['oats|g'], true);
});

for (const name of ['Chosen preferred name', 'Your workspace']) {
  test(`explicitly saved name ${JSON.stringify(name)} survives later writes`, async () => {
    await rpc('mutate', {
      requestId: 'explicit-settings-request',
      mutation: { type: 'settings.save', data: createInitialState(name).settings },
    });
    await rpc('mutate', { requestId: 'food-after-settings', mutation: food });
    assert.equal(
      (await new WorkspaceStore(createQueries(db)).bootstrap(userId)).settings.name,
      name,
    );
    assert.equal((await rpc('get')).settings.name, name);
  });
}

test('an imported preferred name survives subsequent authenticated mutations', async () => {
  await rpc('import', {
    requestId: 'import-name-request',
    state: createInitialState('Imported preferred name'),
    expectedRevision: 0,
  });
  await rpc('mutate', { requestId: 'food-after-import', mutation: food });
  assert.equal(
    (await new WorkspaceStore(createQueries(db)).bootstrap(userId)).settings.name,
    'Imported preferred name',
  );
});
