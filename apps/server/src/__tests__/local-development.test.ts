import assert from 'node:assert/strict';
import { test } from 'node:test';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { createInitialState } from '@packages/workspace/initial-state';
import { testDatabase, closeTestDatabase, neonTestConfig } from '../../tests/helpers.ts';
import { createAuth } from '../auth.ts';
import { createApp } from '../app.ts';
import { WorkspaceStore } from '../store.ts';
import { createQueries } from '../queries.ts';
import type { Config } from '../config.ts';

import * as local from '../../scripts/local-services.mjs';
const instance = 'e'.repeat(32);
const origin = 'http://127.0.0.1:45900';
const authUrl = 'https://127.0.0.1:45901/neondb/auth';
const config: Config = {
  ...neonTestConfig,
  origin,
  host: '127.0.0.1',
  port: 45900,
  deployment: 'local',
  dataDir: '/unused',
  neonAuthBaseUrl: authUrl,
  authSecret: 'synthetic-local-fixture-test-secret-over-32-characters',
  tokenEncryptionKey: Buffer.alloc(32, 11),
};

test('local seeding recovers lost signup/import acknowledgements and never overwrites later edits', async () => {
  const database = await testDatabase();
  try {
    // A nonempty database is never silently adopted by the local initializer.
    await assert.rejects(local.initializeLocalDatabase(database, instance), /nonempty database/);
    await database.query('CREATE TABLE corner_local_identity (instance TEXT PRIMARY KEY)');
    await database.query('INSERT INTO corner_local_identity VALUES ($1)', [instance]);
    await local.initializeLocalDatabase(database, instance);
    await assert.rejects(
      local.initializeLocalDatabase(database, 'wrong-owner'),
      /identity does not match/,
    );
    const options = local.localAuthOptions(database, authUrl, origin, config.authSecret);
    await (await getMigrations(options)).runMigrations();
    const managed = betterAuth(options);
    await managed.$context;
    const store = new WorkspaceStore(createQueries(database));
    const app = createApp({
      config,
      store,
      auth: createAuth(config, (input, init) => managed.handler(new Request(String(input), init))),
    });
    const input = {
      database,
      managed,
      app,
      origin,
      authUrl,
      instance,
      initialState: createInitialState,
      now: new Date('2026-10-21T12:00:00Z'),
    };
    let loseSignup = true;
    await assert.rejects(
      local.seedLocalUsers({
        ...input,
        managed: {
          handler: async (request: Request) => {
            const response = await managed.handler(request);
            if (loseSignup && request.url.endsWith('/sign-up/email') && response.ok) {
              loseSignup = false;
              throw new Error('Lost signup acknowledgement');
            }
            return response;
          },
        },
      }),
      /Lost signup acknowledgement/,
    );
    let loseImport = true;
    await assert.rejects(
      local.seedLocalUsers({
        ...input,
        app: {
          fetch: async (request: Request) => {
            const response = await app.fetch(request);
            if (loseImport && request.url.endsWith('/workspace/import') && response.ok) {
              loseImport = false;
              throw new Error('Lost import acknowledgement');
            }
            return response;
          },
        },
      }),
      /Lost import acknowledgement/,
    );
    const records = (await database.query('SELECT * FROM corner_local_seeds ORDER BY fixture'))
      .rows;
    const demo = records.find((row) => row.fixture === 'demo');
    const empty = records.find((row) => row.fixture === 'empty');
    assert.notEqual(demo.user_id, empty.user_id);
    assert.equal(demo.complete, false);
    assert.equal((await store.read(empty.user_id)).state.recipes.length, 0);
    const populated = await store.read(demo.user_id);
    assert.equal(populated.state.plan[0].recipeId, populated.state.recipes[0].id);
    assert.equal(populated.state.training.sessions[0].status, 'completed');
    assert.equal(populated.state.training.sessions[0].exercises[0].sets[0].completed, true);
    assert.equal(populated.state.training.checkIns[0].date, '2026-10-07');
    await store.mutate(demo.user_id, 'local-development-user-edit', {
      type: 'recipe.favorite',
      data: { id: 'local-oats', favorite: false },
    });
    await local.seedLocalUsers({ ...input, now: new Date('2026-10-25T12:00:00Z') });
    assert.equal((await store.read(demo.user_id)).state.recipes[0].favorite, false);
    assert.equal((await store.read(demo.user_id)).revision, 2);
    // Completion is durable beyond the store's bounded idempotency-receipt retention.
    await database.query('DELETE FROM mutation_receipts');
    await local.seedLocalUsers({ ...input, now: new Date('2026-11-01T12:00:00Z') });
    assert.equal((await store.read(demo.user_id)).state.recipes[0].favorite, false);
    assert.equal((await store.read(demo.user_id)).revision, 2);
    assert.equal(
      (await database.query('SELECT count(*)::int AS count FROM "user"')).rows[0].count,
      2,
    );
    assert.equal(
      (await database.query('SELECT complete FROM corner_local_seeds WHERE fixture = $1', ['demo']))
        .rows[0].complete,
      true,
    );
  } finally {
    await closeTestDatabase(database);
  }
});
