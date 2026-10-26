import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { createDatabase } from './database.js';
import { applicationCatalog, quoteIdentifier as quote } from './schema-catalog.js';
import { migrationHistory, recordBaseline, migrationLock } from './migration-history.js';
import { migrationInventory } from './migration-inventory.js';

const directory = new URL('../migrations/', import.meta.url);
const refuse = () => new Error('STAGING_BASELINE_REFUSED');
function need(condition: unknown): asserts condition {
  if (!condition) throw refuse();
}

export interface StagingBaselineOptions {
  source: Pool;
  expectedTargetHost?: string;
  target: Pool;
  reference: Pool;
  /** Non-public schemas are only for isolated disposable PostgreSQL fixtures. */
  sourceSchema?: string;
  targetSchema?: string;
}

async function identity(client: PoolClient, schema: string): Promise<string> {
  const { rows } = await client.query(
    `SELECT current_database() AS db, current_setting('neon.branch_id', true) AS branch,
      inet_server_addr()::text AS host, inet_server_port() AS port`,
  );
  const row = rows[0];
  // Neon's proxy address is shared across branches and computes can move between servers.
  return JSON.stringify([row.branch ? { db: row.db, branch: row.branch } : row, schema]);
}

async function emptyTables(client: PoolClient, schema: string, lock: boolean): Promise<void> {
  const { rows } = await client.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p','f','m') ORDER BY c.relname`,
    [schema],
  );
  for (const row of rows) {
    const table = `${quote(schema)}.${quote(row.relname)}`;
    if (lock) await client.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
    need(!(await client.query(`SELECT 1 FROM ${table} LIMIT 1`)).rowCount);
  }
}

/** Explicit operator operation; never invoked by startup or migrate(). No source application rows are read. */
export async function baselineStaging(options: StagingBaselineOptions): Promise<void> {
  const { source, target, reference, sourceSchema = 'public', targetSchema = 'public' } = options;
  const clients: PoolClient[] = [];
  try {
    if (sourceSchema === 'public' || targetSchema === 'public') {
      need(sourceSchema === 'public' && targetSchema === 'public');
      const sourceUrl = endpoint(source.options.connectionString ?? '');
      const targetUrl = endpoint(target.options.connectionString ?? '');
      const referenceUrl = endpoint(reference.options.connectionString ?? '');
      need(
        Boolean(options.expectedTargetHost) && targetUrl.hostname === options.expectedTargetHost,
      );
      const hosts = [sourceUrl, targetUrl, referenceUrl].map((url) =>
        url.hostname.replace('-pooler.', '.'),
      );
      need(new Set(hosts).size === 3);
    } else {
      need(
        /^corner_test_[a-f0-9]{32}$/.test(sourceSchema) &&
          /^corner_test_[a-f0-9]{32}$/.test(targetSchema),
      );
      const disposable = new URL(process.env.CORNER_TEST_DATABASE_URL ?? '');
      disposable.searchParams.delete('options');
      for (const pool of [source, target, reference]) {
        const configured = new URL(pool.options.connectionString ?? '');
        configured.searchParams.delete('options');
        need(configured.href === disposable.href);
      }
    }
    for (const pool of [source, target, reference]) clients.push(await pool.connect());
    const [src, dst, ref] = clients as [PoolClient, PoolClient, PoolClient];
    need((await identity(src, sourceSchema)) !== (await identity(dst, targetSchema)));
    if (sourceSchema === 'public' || targetSchema === 'public') {
      need((await identity(ref, 'public')) !== (await identity(src, 'public')));
      need((await identity(ref, 'public')) !== (await identity(dst, 'public')));
    }
    await src.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const sourceTables = (
      await src.query(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r' ORDER BY c.relname`,
        [sourceSchema],
      )
    ).rows;
    for (const table of sourceTables)
      await src.query(
        `LOCK TABLE ${quote(sourceSchema)}.${quote(table.relname)} IN ACCESS SHARE MODE`,
      );
    await dst.query('BEGIN');
    await dst.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [migrationLock]);
    await ref.query('BEGIN');
    const referenceSchema = `corner_baseline_${randomUUID().replaceAll('-', '')}`;
    await ref.query(`CREATE SCHEMA ${quote(referenceSchema)}`);
    await ref.query(`SET LOCAL search_path TO ${quote(referenceSchema)}, pg_catalog`);
    const inventory = await migrationInventory();
    need(inventory[0]!.name === '0000_corner.sql');
    const history = await migrationHistory(src, sourceSchema, inventory, true);
    need((await migrationHistory(dst, targetSchema, inventory)).length === 0);
    for (const migration of inventory) {
      const sql = await readFile(new URL(migration.name, directory), 'utf8');
      need(createHash('sha256').update(sql).digest('hex') === migration.sha256);
      await ref.query(sql);
    }
    const expected = await applicationCatalog(ref, referenceSchema);
    need(expected === (await applicationCatalog(src, sourceSchema)));
    await emptyTables(dst, targetSchema, true);
    await emptyTables(dst, 'neon_auth', true);
    need(expected === (await applicationCatalog(dst, targetSchema)));
    await recordBaseline(dst, targetSchema, history[0]!);
    for (const migration of history.slice(1))
      await dst.query(
        `INSERT INTO ${quote(targetSchema)}.__drizzle_migrations (hash,created_at) VALUES ($1,$2)`,
        [migration.sha256, migration.when],
      );
    await migrationHistory(dst, targetSchema, inventory, true);
    await dst.query('COMMIT');
  } catch {
    throw refuse();
  } finally {
    await Promise.all(
      clients.map(async (client) => {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* Preserve private-safe failure. */
        } finally {
          client.release();
        }
      }),
    );
  }
}

function endpoint(value: string): URL {
  const url = new URL(value);
  need(['postgres:', 'postgresql:'].includes(url.protocol));
  need(!url.searchParams.has('options'));
  return url;
}

export async function stagingBaselineCli(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const pools: Pool[] = [];
  let failed = false;
  try {
    const source = endpoint(environment.STAGING_BASELINE_SOURCE_URL ?? '');
    const target = endpoint(environment.DATABASE_URL_UNPOOLED ?? '');
    const reference = endpoint(environment.CORNER_TEST_DATABASE_URL ?? '');
    for (const url of [source, target, reference]) pools.push(createDatabase(url.href));
    await baselineStaging({
      source: pools[0]!,
      target: pools[1]!,
      reference: pools[2]!,
      expectedTargetHost: environment.STAGING_DATABASE_HOST,
    });
  } catch {
    failed = true;
  }
  const closed = await Promise.allSettled(pools.map((pool) => pool.end()));
  if (failed || closed.some((result) => result.status === 'rejected')) throw refuse();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length !== 3 || process.argv[2] !== '--apply') {
    process.stderr.write('STAGING_BASELINE_REQUIRES_EXPLICIT_APPLY\n');
    process.exitCode = 1;
  } else {
    try {
      await stagingBaselineCli();
      process.stdout.write('Staging migration baseline recorded.\n');
    } catch {
      process.stderr.write('STAGING_BASELINE_REFUSED\n');
      process.exitCode = 1;
    }
  }
}
