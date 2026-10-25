import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDatabase } from '../database.js';
import type { Pool } from 'pg';
import { migrate } from '../migrate.js';
import { migrationsFolder } from '../migration-inventory.js';

async function fixture() {
  assert.ok(process.env.CORNER_TEST_DATABASE_URL, 'Disposable PostgreSQL is required.');
  const url = new URL(process.env.CORNER_TEST_DATABASE_URL);
  const admin = createDatabase(url.href);
  const schema = `corner_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const database = createDatabase(url.href);
  return {
    database,
    async close() {
      await database.end();
      try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
      finally { await admin.end(); }
    },
  };
}

async function savedRecord(database: Pool) {
  await database.query('INSERT INTO workspace_state VALUES ($1,$2,$3,$4)', [
    'owner', JSON.stringify({ saved: 'record' }), 7, '2026-10-24T12:00:00.000Z',
  ]);
  return (await database.query('SELECT * FROM workspace_state')).rows;
}

test('concurrent fresh migrations serialize and replays preserve saved records and native history', async () => {
  const f = await fixture();
  try {
    await Promise.all([migrate(f.database), migrate(f.database)]);
    const before = await savedRecord(f.database);
    const history = (await f.database.query('SELECT * FROM __drizzle_migrations')).rows;
    assert.equal(history.length, 1);
    await migrate(f.database);
    assert.deepEqual((await f.database.query('SELECT * FROM workspace_state')).rows, before);
    assert.deepEqual((await f.database.query('SELECT * FROM __drizzle_migrations')).rows, history);
  } finally { await f.close(); }
});

test('a failing pending migration rolls back its DDL and ledger entry without losing existing records', async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'corner-migration-'));
  const folder = join(directory, 'migrations');
  try {
    await migrate(f.database);
    const before = await savedRecord(f.database);
    const history = (await f.database.query('SELECT * FROM __drizzle_migrations')).rows;
    await cp(migrationsFolder, folder, { recursive: true });
    const journalPath = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    const snapshot = JSON.parse(await readFile(join(folder, 'meta/0000_snapshot.json'), 'utf8'));
    snapshot.prevId = snapshot.id;
    snapshot.id = randomUUID();
    journal.entries.push({ idx: 1, version: '7', when: journal.entries[0].when + 1, tag: '0001_failure', breakpoints: true });
    await writeFile(journalPath, JSON.stringify(journal));
    await writeFile(join(folder, 'meta/0001_snapshot.json'), JSON.stringify(snapshot));
    await writeFile(join(folder, '0001_failure.sql'),
      'ALTER TABLE workspace_state ADD COLUMN migration_note TEXT;\n--> statement-breakpoint\nSELECT corner_missing_migration_function();');
    await assert.rejects(migrate(f.database, folder));
    assert.deepEqual((await f.database.query('SELECT * FROM workspace_state')).rows, before);
    assert.deepEqual((await f.database.query('SELECT * FROM __drizzle_migrations')).rows, history);
    const column = await f.database.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='workspace_state' AND column_name='migration_note'",
    );
    assert.equal(column.rowCount, 0);
  } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
});

test('modified applied SQL and unknown ledger entries refuse before changing saved records', async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'corner-migration-integrity-'));
  const folder = join(directory, 'migrations');
  try {
    await migrate(f.database);
    const before = await savedRecord(f.database);
    await cp(migrationsFolder, folder, { recursive: true });
    const path = join(folder, '0000_corner.sql');
    await writeFile(path, `${await readFile(path, 'utf8')}\nDELETE FROM workspace_state;`);
    await assert.rejects(migrate(f.database, folder));
    assert.deepEqual((await f.database.query('SELECT * FROM workspace_state')).rows, before);
    await f.database.query('INSERT INTO __drizzle_migrations(hash,created_at) VALUES ($1,$2)', ['f'.repeat(64), Number.MAX_SAFE_INTEGER]);
    await assert.rejects(migrate(f.database));
    assert.deepEqual((await f.database.query('SELECT * FROM workspace_state')).rows, before);
  } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
});
