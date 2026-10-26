import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { createDatabase } from '../database.js';
import { migrate } from '../migrate.js';
import { migrationsFolder } from '../migration-inventory.js';
import { createInitialState } from '@packages/workspace/initial-state';

async function fixture(run: (database: Pool, schema: string) => Promise<void>, previous = true) {
  if (!process.env.CORNER_TEST_DATABASE_URL) throw new Error('A disposable CORNER_TEST_DATABASE_URL is required.');
  const url = new URL(process.env.CORNER_TEST_DATABASE_URL);
  const admin = createDatabase(url.href);
  const schema = 'corner_cutover_' + randomUUID().replaceAll('-', '');
  const prefix = await mkdtemp(join(tmpdir(), 'corner-relational-prefix-'));
  await admin.query(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const database = createDatabase(url.href);
  try {
    if (previous) {
      await mkdir(join(prefix, 'meta'));
      const journal = JSON.parse(await readFile(join(migrationsFolder, 'meta/_journal.json'), 'utf8'));
      await writeFile(join(prefix, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: [journal.entries[0]] }));
      await cp(join(migrationsFolder, '0000_corner.sql'), join(prefix, '0000_corner.sql'));
      await cp(join(migrationsFolder, 'meta/0000_snapshot.json'), join(prefix, 'meta/0000_snapshot.json'));
      await migrate(database, prefix);
    }
    await run(database, schema);
  } finally {
    await database.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    await rm(prefix, { recursive: true, force: true });
  }
}
async function waitForLock(database: Pool, mode: string, count = 1) {
  // PostgreSQL lock acquisition is external real I/O; fake JS timers cannot
  // signal it. Poll the actual lock condition, not a guessed race delay.
  for (let attempt = 0; attempt < 1000; attempt++) {
    const result = await database.query(`SELECT count(*)::int AS count FROM pg_locks
      WHERE relation = 'workspace_state'::regclass AND mode=$1 AND NOT granted`, [mode]);
    if (result.rows[0].count >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The controlled legacy-writer race did not reach its lock boundary.');
}

test('fresh and existing-empty native schemas initialize relational storage without rewriting the native prefix', async () => {
  for (const previous of [false, true]) await fixture(async (database) => {
    const before = previous ? (await database.query('SELECT hash,created_at FROM __drizzle_migrations ORDER BY id')).rows : [];
    await migrate(database);
    const after = (await database.query('SELECT hash,created_at FROM __drizzle_migrations ORDER BY id')).rows;
    assert.equal(after.length, 2);
    if (previous) assert.deepEqual(after.slice(0, 1), before);
    assert.equal((await database.query("SELECT to_regclass('workspace_state') AS legacy")).rows[0].legacy, null);
    assert.equal((await database.query('SELECT count(*)::int AS count FROM workspace_metadata')).rows[0].count, 0);
  }, previous);
});

test('any legacy workspace row, even default/settings-only, refuses the whole cutover and preserves unrelated records', async () => {
  await fixture(async (database) => {
    const data = JSON.stringify(createInitialState());
    await database.query('INSERT INTO workspace_state(user_id,data,version,updated_at) VALUES ($1,$2,0,$3)', ['owner', data, '2026-10-22T12:00:00.000Z']);
    await database.query("INSERT INTO corner_subscription_meta(key,value) VALUES ('preserve','opaque-private-metadata')");
    const history = (await database.query('SELECT hash,created_at FROM __drizzle_migrations ORDER BY id')).rows;
    await assert.rejects(migrate(database), /Relational cutover refused/);
    assert.equal((await database.query('SELECT data FROM workspace_state WHERE user_id=$1', ['owner'])).rows[0].data, data);
    assert.equal((await database.query("SELECT to_regclass('workspace_metadata') AS metadata")).rows[0].metadata, null);
    assert.deepEqual((await database.query('SELECT hash,created_at FROM __drizzle_migrations ORDER BY id')).rows, history);
    assert.equal((await database.query("SELECT value FROM corner_subscription_meta WHERE key='preserve'")).rows[0].value, 'opaque-private-metadata');
  });
});

test('a legacy writer committed before the exclusive migration lock is never discarded', async () => {
  await fixture(async (database) => {
    const writer = await database.connect();
    try {
      await writer.query('BEGIN');
      await writer.query('INSERT INTO workspace_state(user_id,data,version,updated_at) VALUES ($1,$2,1,$3)', ['late-owner', JSON.stringify(createInitialState()), '2026-10-22T12:00:00.000Z']);
      const migration = migrate(database).then(() => null, (error: unknown) => error);
      await waitForLock(database, 'AccessExclusiveLock');
      await writer.query('COMMIT');
      const failure = await migration;
      assert.ok(failure instanceof Error && /Relational cutover refused/.test(failure.message));
      assert.equal((await database.query("SELECT count(*)::int AS count FROM workspace_state WHERE user_id='late-owner'")).rows[0].count, 1);
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
    }
  });
});

test('an old writer queued behind retirement fails rather than committing into discarded storage', async () => {
  await fixture(async (database) => {
    const reader = await database.connect();
    const writer = await database.connect();
    try {
      await reader.query('BEGIN');
      await reader.query('SELECT user_id FROM workspace_state');
      const migration = migrate(database);
      await waitForLock(database, 'AccessExclusiveLock');
      const outcome = writer.query('INSERT INTO workspace_state(user_id,data,version,updated_at) VALUES ($1,$2,1,$3)', ['late-owner', JSON.stringify(createInitialState()), '2026-10-22T12:00:00.000Z'])
        .then(() => ({ committed: true, error: null }), (error: unknown) => ({ committed: false, error }));
      await waitForLock(database, 'RowExclusiveLock');
      await reader.query('COMMIT');
      await migration;
      const result = await outcome;
      assert.equal(result.committed, false);
      assert.ok(result.error instanceof Error);
      assert.equal((await database.query("SELECT to_regclass('workspace_state') AS legacy")).rows[0].legacy, null);
      assert.equal((await database.query('SELECT count(*)::int AS count FROM workspace_metadata')).rows[0].count, 0);
    } finally {
      await reader.query('ROLLBACK');
      reader.release(); writer.release();
    }
  });
});
