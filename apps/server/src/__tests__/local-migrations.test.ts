import assert from 'node:assert/strict';
import test from 'node:test';
import { getMigrations } from 'better-auth/db/migration';
import { testDatabase, closeTestDatabase } from '../../tests/helpers.ts';
import { initializeLocalDatabase, localAuthOptions } from '../../scripts/local-services.mjs';
import { migrateLocalDatabase } from '../local-migrations.js';

const instance = 'e'.repeat(32);

async function fixture(emptyLedger = false) {
  const database = await testDatabase();
  try {
    await database.query('CREATE TABLE corner_local_identity (instance TEXT PRIMARY KEY)');
    await database.query('INSERT INTO corner_local_identity VALUES ($1)', [instance]);
    await initializeLocalDatabase(database, instance);
    await database.query(
      'CREATE TABLE corner_schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL)',
    );
    await database.query('INSERT INTO corner_schema_migrations VALUES ($1,$2)', [
      '001_corner.sql',
      'retained historical audit checksum',
    ]);
    await database.query('INSERT INTO workspace_state VALUES ($1,$2,$3,$4)', [
      'owner',
      '{"saved":"local record"}',
      7,
      '2026-10-25T12:00:00.000Z',
    ]);
    await database.query(
      'INSERT INTO corner_subscription_accounts(user_id,encrypted) VALUES ($1,$2)',
      ['owner', 'retained encrypted local credential'],
    );
    const options = localAuthOptions(
      database,
      'https://127.0.0.1:45901/neondb/auth',
      'http://127.0.0.1:45900',
      'synthetic-local-fixture-test-secret-over-32-characters',
    );
    await (await getMigrations(options)).runMigrations();
    await database.query(
      'INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$2,$3,false,$4,$4)',
      ['owner', 'Local owner', 'owner@corner.test', '2026-10-25T12:00:00.000Z'],
    );
    await database.query('INSERT INTO corner_local_seeds VALUES ($1,$2,$3,$4)', [
      'demo',
      'owner',
      '2026-10-25',
      true,
    ]);
    const history = (await database.query('SELECT hash,created_at FROM __drizzle_migrations')).rows;
    await database.query(
      emptyLedger ? 'DELETE FROM __drizzle_migrations' : 'DROP TABLE __drizzle_migrations',
    );
    const snapshot = async () => {
      const rows = [];
      for (const table of [
        'workspace_state',
        'corner_subscription_accounts',
        'corner_schema_migrations',
        'corner_local_identity',
        'corner_local_seeds',
        'user',
      ])
        rows.push((await database.query(`SELECT * FROM "${table}"`)).rows);
      return rows;
    };
    return { database, history, snapshot, before: await snapshot() };
  } catch (error) {
    await closeTestDatabase(database);
    throw error;
  }
}

test('owned local baseline adoption preserves saved workspaces, credentials, accounts, seed state and audit metadata', async () => {
  const f = await fixture(true);
  try {
    await Promise.all([
      migrateLocalDatabase(f.database, instance),
      migrateLocalDatabase(f.database, instance),
    ]);
    assert.deepEqual(
      (await f.database.query('SELECT hash,created_at FROM __drizzle_migrations')).rows,
      f.history,
    );
    await migrateLocalDatabase(f.database, instance);
    assert.deepEqual(await f.snapshot(), f.before);
  } finally {
    await closeTestDatabase(f.database);
  }
});

test('local baseline refuses schema drift and rolls back without recording history or changing records', async (t) => {
  for (const drift of [
    'ALTER TABLE workspace_state ALTER COLUMN version SET DEFAULT 7',
    'DROP INDEX corner_ai_runs_owner',
    'ALTER TABLE corner_ai_runs DROP CONSTRAINT corner_ai_runs_user_id_kind_request_id_key',
    'ALTER TABLE workspace_state ADD COLUMN unexpected TEXT',
    'ALTER TABLE workspace_state ADD CONSTRAINT unexpected CHECK (version >= 0)',
  ]) {
    await t.test(drift, async () => {
      const f = await fixture();
      try {
        await f.database.query(drift);
        const before = await f.snapshot();
        await assert.rejects(migrateLocalDatabase(f.database, instance));
        assert.equal(
          (await f.database.query("SELECT to_regclass('__drizzle_migrations') AS name")).rows[0]
            .name,
          null,
        );
        assert.deepEqual(await f.snapshot(), before);
      } finally {
        await closeTestDatabase(f.database);
      }
    });
  }
});

test('a different local installation cannot adopt the database', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      migrateLocalDatabase(f.database, 'f'.repeat(32)),
      /identity does not match/,
    );
    assert.equal(
      (await f.database.query("SELECT to_regclass('__drizzle_migrations') AS name")).rows[0].name,
      null,
    );
    assert.deepEqual(await f.snapshot(), f.before);
  } finally {
    await closeTestDatabase(f.database);
  }
});
