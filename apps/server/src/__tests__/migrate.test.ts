import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDatabase } from '../database.js';
import type { Pool } from 'pg';
import { migrate } from '../migrate.js';
import { migrationsFolder } from '../migration-inventory.js';
import { createInitialState } from '@packages/workspace/initial-state';

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
      try {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    },
  };
}

async function savedRecord(database: Pool) {
  const { timezone, ...settings } = createInitialState().settings;
  await database.query(
    'INSERT INTO workspace_metadata(user_id,settings,timezone,revision,next_position) VALUES ($1,$2,$3,7,0)',
    ['owner', JSON.stringify(settings), timezone],
  );
  return (await database.query('SELECT * FROM workspace_metadata')).rows;
}

async function appendFixtureMigration(folder: string, name: string, source: string) {
  const journalPath = join(folder, 'meta/_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  const previous = journal.entries.at(-1);
  const prefix = String(journal.entries.length).padStart(4, '0');
  const snapshot = JSON.parse(
    await readFile(
      join(folder, `meta/${String(previous.idx).padStart(4, '0')}_snapshot.json`),
      'utf8',
    ),
  );
  snapshot.prevId = snapshot.id;
  snapshot.id = randomUUID();
  journal.entries.push({
    idx: journal.entries.length,
    version: '7',
    when: previous.when + 1,
    tag: `${prefix}_${name}`,
    breakpoints: true,
  });
  await writeFile(journalPath, JSON.stringify(journal));
  await writeFile(join(folder, `meta/${prefix}_snapshot.json`), JSON.stringify(snapshot));
  await writeFile(join(folder, `${prefix}_${name}.sql`), source);
}

test('concurrent fresh migrations serialize and replays preserve saved records and native history', async () => {
  const f = await fixture();
  try {
    await Promise.all([migrate(f.database), migrate(f.database)]);
    const before = await savedRecord(f.database);
    const history = (await f.database.query('SELECT * FROM __drizzle_migrations')).rows;
    await migrate(f.database);
    assert.deepEqual((await f.database.query('SELECT * FROM workspace_metadata')).rows, before);
    assert.deepEqual((await f.database.query('SELECT * FROM __drizzle_migrations')).rows, history);
  } finally {
    await f.close();
  }
});

test('populated recorded-workout migration upgrades additively without rewriting records, keys or historical receipts', async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'corner-import-upgrade-'));
  const folder = join(directory, 'migrations');
  try {
    const journal = JSON.parse(
      await readFile(join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
    );
    const previousEntries = journal.entries.slice(0, 4);
    await mkdir(join(folder, 'meta'), { recursive: true });
    await writeFile(
      join(folder, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: previousEntries }),
    );
    for (const entry of previousEntries) {
      await cp(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
      const snapshot = `meta/${String(entry.idx).padStart(4, '0')}_snapshot.json`;
      await cp(join(migrationsFolder, snapshot), join(folder, snapshot));
    }
    await migrate(f.database, folder);
    const metadata = await savedRecord(f.database);
    await f.database.query(
      `INSERT INTO workspace_workout_sessions
      (user_id,id,position,date,name,kind,status,unit,planned_minutes,duration_minutes,notes,change_reason,created_at,updated_at)
      VALUES ('owner','retained-history',0,'2026-10-28','Retained walk','conditioning','completed','kg',NULL,28,'Keep original','',$1,$1)`,
      ['2026-10-28T12:00:00.000Z'],
    );
    await f.database
      .query(`INSERT INTO mutation_receipts(user_id,request_id,payload_hash,revision,created_at)
      VALUES ('owner','old-operation','old-original-fingerprint',7,'2026-10-28T12:00:00.000Z')`);
    await f.database.query(
      "INSERT INTO corner_subscription_meta(key,value) VALUES ('retained-key','synthetic-private-key')",
    );
    const workouts = (await f.database.query('SELECT * FROM workspace_workout_sessions')).rows;
    const history = (await f.database.query('SELECT * FROM __drizzle_migrations ORDER BY id')).rows;
    await migrate(f.database);
    assert.deepEqual((await f.database.query('SELECT * FROM workspace_metadata')).rows, metadata);
    assert.deepEqual(
      (await f.database.query('SELECT * FROM workspace_workout_sessions')).rows,
      workouts.map((workout) => ({ ...workout, timing: null })),
    );
    assert.deepEqual(
      (await f.database.query('SELECT * FROM __drizzle_migrations ORDER BY id')).rows.slice(0, 4),
      history,
    );
    assert.deepEqual(
      (
        await f.database.query(
          'SELECT request_id,payload_hash,revision,import_outcomes FROM mutation_receipts',
        )
      ).rows,
      [
        {
          request_id: 'old-operation',
          payload_hash: 'old-original-fingerprint',
          revision: 7,
          import_outcomes: null,
        },
      ],
    );
    assert.equal(
      (
        await f.database.query(
          "SELECT value FROM corner_subscription_meta WHERE key='retained-key'",
        )
      ).rows[0].value,
      'synthetic-private-key',
    );
    assert.equal(
      (await f.database.query('SELECT count(*)::int AS n FROM workspace_import_sources')).rows[0].n,
      0,
    );
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
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
    await appendFixtureMigration(
      folder,
      'failure',
      'ALTER TABLE workspace_metadata ADD COLUMN migration_note TEXT;\n--> statement-breakpoint\nSELECT corner_missing_migration_function();',
    );
    await assert.rejects(migrate(f.database, folder));
    assert.deepEqual((await f.database.query('SELECT * FROM workspace_metadata')).rows, before);
    assert.deepEqual((await f.database.query('SELECT * FROM __drizzle_migrations')).rows, history);
    const column = await f.database.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='workspace_metadata' AND column_name='migration_note'",
    );
    assert.equal(column.rowCount, 0);
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
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
    await writeFile(path, `${await readFile(path, 'utf8')}\nDELETE FROM workspace_metadata;`);
    await assert.rejects(migrate(f.database, folder));
    assert.deepEqual((await f.database.query('SELECT * FROM workspace_metadata')).rows, before);
    await f.database.query('INSERT INTO __drizzle_migrations(hash,created_at) VALUES ($1,$2)', [
      'f'.repeat(64),
      Number.MAX_SAFE_INTEGER,
    ]);
    await assert.rejects(migrate(f.database));
    assert.deepEqual((await f.database.query('SELECT * FROM workspace_metadata')).rows, before);
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('native follow-up migration preserves application records and legacy audit metadata', async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'corner-native-next-'));
  const folder = join(directory, 'migrations');
  try {
    await migrate(f.database);
    const before = await savedRecord(f.database);
    const history = (await f.database.query('SELECT * FROM __drizzle_migrations ORDER BY id')).rows;
    await f.database.query(
      'CREATE TABLE corner_schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL)',
    );
    await f.database.query('INSERT INTO corner_schema_migrations VALUES ($1,$2)', [
      '001_corner.sql',
      'retained historical checksum',
    ]);
    const audit = (await f.database.query('SELECT * FROM corner_schema_migrations')).rows;
    await cp(migrationsFolder, folder, { recursive: true });
    await appendFixtureMigration(
      folder,
      'next',
      'CREATE TABLE migration_next (id TEXT PRIMARY KEY);',
    );
    await migrate(f.database, folder);
    assert.equal(
      (await f.database.query("SELECT to_regclass('migration_next') AS name")).rows[0].name,
      'migration_next',
    );
    assert.deepEqual((await f.database.query('SELECT * FROM workspace_metadata')).rows, before);
    assert.deepEqual(
      (await f.database.query('SELECT * FROM corner_schema_migrations')).rows,
      audit,
    );
    assert.deepEqual(
      (await f.database.query('SELECT * FROM __drizzle_migrations ORDER BY id')).rows.slice(
        0,
        history.length,
      ),
      history,
    );
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
