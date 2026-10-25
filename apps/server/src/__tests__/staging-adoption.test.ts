import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDatabase } from '../database.js';
import { migrate } from '../migrate.js';
import { migrationsFolder } from '../migration-inventory.js';
import { legacyChecksum } from '../legacy-adoption.js';

async function fixture() {
  assert.ok(process.env.CORNER_TEST_DATABASE_URL, 'Disposable PostgreSQL required');
  const url = new URL(process.env.CORNER_TEST_DATABASE_URL);
  const admin = createDatabase(url.href);
  const schema = `corner_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const target = createDatabase(url.href);
  await target.query(await readFile(new URL('../../migrations/0000_corner.sql', import.meta.url), 'utf8'));
  await target.query('CREATE TABLE corner_schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL)');
  await target.query('INSERT INTO corner_schema_migrations VALUES ($1,$2)', ['001_corner.sql', legacyChecksum]);
  await target.query(`
    INSERT INTO workspace_state VALUES ('owner','private workspace',9,'time');
    INSERT INTO mutation_receipts VALUES ('owner','request','hash',9,'time');
    INSERT INTO corner_ai_runs (id,user_id,request_id,payload_hash,kind,status,prompt,reference_date,base_revision,created_at,updated_at)
      VALUES ('run','owner','request','hash','plan','complete','private prompt','date',9,'time','time');
    INSERT INTO corner_subscription_accounts VALUES ('owner','encrypted private grant',4,'refresh',99);
    INSERT INTO corner_subscription_attempts VALUES ('state','owner','session','encrypted attempt',99);
    INSERT INTO corner_subscription_generations VALUES ('owner',4);
    INSERT INTO corner_subscription_meta VALUES ('key','private key identity');
  `);
  // A separate schema stands in for managed Auth; adoption must not inspect or mutate it.
  const auth = `${schema}_auth`;
  await admin.query(`CREATE SCHEMA "${auth}"; CREATE TABLE "${auth}".accounts (id text, secret text); INSERT INTO "${auth}".accounts VALUES ('account','session')`);
  const tables = ['workspace_state', 'mutation_receipts', 'corner_ai_runs', 'corner_subscription_accounts', 'corner_subscription_attempts', 'corner_subscription_generations', 'corner_subscription_meta', 'corner_schema_migrations'];
  const snapshot = async () => Promise.all(tables.map(async table => (await target.query(`SELECT * FROM ${table}`)).rows));
  const before = await snapshot();
  return { target, snapshot, before, async close() {
    await target.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE; DROP SCHEMA "${auth}" CASCADE`);
    await admin.end();
  }, async unchanged() {
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual((await admin.query(`SELECT * FROM "${auth}".accounts`)).rows, [{ id: 'account', secret: 'session' }]);
  } };
}

test('populated legacy schema adopts atomically, preserves every record, retries, then uses ordinary native migrations', async () => {
  const f = await fixture();
  try {
    await migrate(f.target, migrationsFolder, true);
    const history = (await f.target.query('SELECT * FROM __drizzle_migrations')).rows;
    assert.equal(history.length, 1);
    await migrate(f.target, migrationsFolder, true);
    await migrate(f.target);
    assert.deepEqual((await f.target.query('SELECT * FROM __drizzle_migrations')).rows, history);
    await f.unchanged();
  } finally { await f.close(); }
});

for (const [name, sql] of [
  ['checksum', "UPDATE corner_schema_migrations SET checksum='unknown'"],
  ['extra history', "INSERT INTO corner_schema_migrations VALUES ('unknown.sql','unknown')"],
  ['schema', 'ALTER TABLE workspace_state ALTER COLUMN version SET DEFAULT 7'],
  ['native ledger', "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at BIGINT); INSERT INTO __drizzle_migrations (hash,created_at) VALUES ('unknown',1)"],
] as const) test(`adoption rejects ${name} drift without partially recording native history`, async () => {
  const f = await fixture();
  try {
    await f.target.query(sql);
    const before = await f.snapshot();
    await assert.rejects(migrate(f.target, migrationsFolder, true));
    assert.deepEqual(await f.snapshot(), before);
    if (name === 'native ledger') assert.equal((await f.target.query('SELECT hash FROM __drizzle_migrations')).rows[0].hash, 'unknown');
    else assert.equal((await f.target.query("SELECT to_regclass('__drizzle_migrations') AS name")).rows[0].name, null);
  } finally { await f.close(); }
});

test('adopted staging accepts a subsequent ordinary native migration without rewriting saved rows', async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'corner-adoption-next-'));
  const folder = join(directory, 'migrations');
  try {
    await migrate(f.target, migrationsFolder, true);
    await cp(migrationsFolder, folder, { recursive: true });
    const journalPath = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    const snapshot = JSON.parse(await readFile(join(folder, 'meta/0000_snapshot.json'), 'utf8'));
    snapshot.prevId = snapshot.id;
    snapshot.id = randomUUID();
    journal.entries.push({ idx: 1, version: '7', when: journal.entries[0].when + 1, tag: '0001_next', breakpoints: true });
    await writeFile(journalPath, JSON.stringify(journal));
    await writeFile(join(folder, 'meta/0001_snapshot.json'), JSON.stringify(snapshot));
    await writeFile(join(folder, '0001_next.sql'), 'CREATE TABLE adoption_next (id TEXT PRIMARY KEY);');
    await migrate(f.target, folder);
    assert.equal((await f.target.query('SELECT * FROM __drizzle_migrations')).rows.length, 2);
    assert.equal((await f.target.query("SELECT to_regclass('adoption_next') AS name")).rows[0].name, 'adoption_next');
    await f.unchanged();
  } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
});
