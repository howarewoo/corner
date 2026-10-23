import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg'; import { testDatabase, closeTestDatabase, createTestAuth, neonTestConfig } from './helpers.ts'
import { createApp } from '../src/app.ts';
import { createAuth } from '../src/auth.ts';
import { createAIRouter } from '../src/ai-routes.ts';
import { PlanningAgent } from '../src/planning-agent.ts';
import { WorkspaceStore } from '../src/store.ts';
import type { Config } from '../src/config.ts';
import type { SubscriptionProvider, SubscriptionStatus } from '../src/subscription.ts';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('an accepted planning request cannot launch background work after shutdown begins', { timeout: 15000 }, async () => {
  const db = await testDatabase();
  const config: Config = { ...neonTestConfig, origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000, dataDir: '/tmp', deployment: 'local',
  authSecret: 'synthetic-shutdown-auth-secret-more-than-32-characters', tokenEncryptionKey: Buffer.alloc(32, 7), }
  const auth = await createTestAuth(config, db);
  const store = new WorkspaceStore(db);
  const statusEntered = gate();
  const releaseStatus = gate();
  let inferenceCalls = 0;
  const provider = {
    async status(): Promise<SubscriptionStatus> {
      statusEntered.resolve();
      await releaseStatus.promise;
      return {
        supported: true, connected: true, planEnabled: true, state: 'connected', account: null,
        model: 'synthetic-test-model', models: [], message: 'Synthetic connection for this isolated test.',
        manageUsageUrl: 'https://example.test/usage',
      };
    },
    async respond() {
      inferenceCalls++;
      throw new Error('No inference may start after shutdown begins.');
    },
  };
  const agent = new PlanningAgent(store, provider);
  await agent.initialize();
  const app = createApp({ config, auth, store, extraRoutes: createAIRouter(provider as unknown as SubscriptionProvider, agent) });
  let pendingResponse: Promise<Response> | undefined;
  try {
    const signup = await app.request(`${config.origin}/api/auth/sign-up/email`, {
      method: 'POST', headers: { Origin: config.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Shutdown test', email: 'shutdown@example.test', password: 'synthetic-shutdown-test-password' }),
    });
    assert.equal(signup.status, 200);
    const cookie = signup.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
    assert(cookie);

    // This real authenticated handler has already passed origin/session checks
    // and parsed its request. Hold it at an asynchronous pre-launch boundary.
    pendingResponse = Promise.resolve(app.request(`${config.origin}/api/agent/runs`, {
      method: 'POST', headers: { Origin: config.origin, Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'shutdown-race', prompt: 'Help me plan a breakfast.', referenceDate: '2026-10-22' }),
    }));
    await statusEntered.promise;
    const closing = agent.close();
    releaseStatus.resolve();

    const response = await pendingResponse;
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'AGENT_SHUTTING_DOWN');
    await closing;
    assert.equal(inferenceCalls, 0);
    assert.equal((await db.query("SELECT COUNT(*) AS count FROM corner_ai_runs", [])).rows[0]?.count, 0);
  } finally {
    releaseStatus.resolve();
    await pendingResponse?.catch(() => {});
    await agent.close();
    await closeTestDatabase(db);
  }
});
