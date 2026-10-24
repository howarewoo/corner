import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { createDatabase } from './database.js';

const ledger = 'corner_schema_migrations';
const directory = new URL('../migrations/', import.meta.url);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
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
    'SELECT current_database() AS db, inet_server_addr()::text AS host, inet_server_port() AS port',
  );
  return JSON.stringify([rows[0], schema]);
}

// Deliberately limited to the plain tables, built-in column types and btree indexes
// in 001_corner.sql. New object kinds require extending this validator first.
async function catalog(client: PoolClient, schema: string, includeLedger = false): Promise<string> {
  const unsupported = await client.query(
    `SELECT
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND (c.relkind NOT IN ('r','i') OR c.relispartition OR c.relrowsecurity OR c.relforcerowsecurity OR c.reloptions IS NOT NULL OR c.reltablespace<>0 OR c.relacl IS NOT NULL)) OR
    EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=$1 AND NOT
      (t.typtype='c' AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=t.typrelid AND c.relkind='r') OR
       t.typelem<>0 AND EXISTS (SELECT 1 FROM pg_type b JOIN pg_class c ON c.oid=b.typrelid WHERE b.oid=t.typelem AND b.typtype='c' AND c.relkind='r'))) OR
    EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND c.contype NOT IN ('p','u')) OR
    EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_type t ON t.oid=a.atttypid JOIN pg_namespace tn ON tn.oid=t.typnamespace
      WHERE n.nspname=$1 AND c.relkind='r' AND a.attnum>0 AND (a.attisdropped OR a.attidentity<>'' OR a.attgenerated<>'' OR a.atthasmissing OR a.attacl IS NOT NULL OR tn.nspname<>'pg_catalog' OR EXISTS (SELECT 1 FROM pg_collation co JOIN pg_namespace cn ON cn.oid=co.collnamespace WHERE co.oid=a.attcollation AND cn.nspname<>'pg_catalog'))) OR
    EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_statistic_ext s JOIN pg_namespace n ON n.oid=s.stxnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_default_acl a JOIN pg_namespace n ON n.oid=a.defaclnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_operator o JOIN pg_namespace n ON n.oid=o.oprnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_opclass o JOIN pg_namespace n ON n.oid=o.opcnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_opfamily o JOIN pg_namespace n ON n.oid=o.opfnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_conversion c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_ts_config c JOIN pg_namespace n ON n.oid=c.cfgnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_ts_dict d JOIN pg_namespace n ON n.oid=d.dictnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_ts_parser p JOIN pg_namespace n ON n.oid=p.prsnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_ts_template t JOIN pg_namespace n ON n.oid=t.tmplnamespace WHERE n.nspname=$1) AS unsupported`,
    [schema],
  );
  need(!unsupported.rows[0].unsupported);
  await client.query(`SET LOCAL search_path TO ${quote(schema)}, pg_catalog`);
  const queries = [
    `SELECT c.relname,c.relkind,c.relpersistence,c.relreplident,am.amname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_am am ON am.oid=c.relam WHERE n.nspname=$1 AND c.relname<>$2 AND NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid WHERE i.indexrelid=c.oid AND t.relname=$2) ORDER BY c.relname`,
    `SELECT c.relname,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attstorage,a.attcompression,co.collname,pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum LEFT JOIN pg_collation co ON co.oid=a.attcollation WHERE n.nspname=$1 AND c.relkind='r' AND c.relname<>$2 AND a.attnum>0 ORDER BY c.relname,a.attnum`,
    `SELECT t.relname,c.conname,c.contype,c.condeferrable,c.condeferred,c.convalidated,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname<>$2 ORDER BY t.relname,c.conname`,
    `SELECT t.relname,c.relname AS index_name,i.indisunique,i.indisprimary,i.indisvalid,i.indisready,i.indislive,i.indisreplident,i.indnullsnotdistinct,replace(pg_get_indexdef(i.indexrelid), ' ON ' || quote_ident($1) || '.', ' ON ') AS definition FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname<>$2 ORDER BY t.relname,c.relname`,
  ];
  const result = [];
  for (const sql of queries)
    result.push((await client.query(sql, [schema, includeLedger ? '' : ledger])).rows);
  return JSON.stringify(result);
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

/** Explicit operator operation; never invoked by startup or migrate(). No source rows are read. */
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
    // The reference connection must not point at either application database.
    // Disposable schema fixtures can share their isolated test database.
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
    await dst.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('corner:schema-migrations', 0))",
    );
    await ref.query('BEGIN');
    const referenceSchema = `corner_baseline_${randomUUID().replaceAll('-', '')}`;
    await ref.query(`CREATE SCHEMA ${quote(referenceSchema)}`);
    await ref.query(`SET LOCAL search_path TO ${quote(referenceSchema)}, pg_catalog`);
    const history = (
      await src.query(`SELECT name,checksum FROM ${quote(sourceSchema)}.${ledger} ORDER BY name`)
    ).rows as { name: string; checksum: string }[];
    const names = (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
    need(history.length > 0 && history.length <= names.length);
    // This bounded baseline supports only the current initial migration.
    need(history.length === 1 && history[0]!.name === '001_corner.sql');
    for (const [index, applied] of history.entries()) {
      need(applied.name === names[index]);
      const sql = await readFile(new URL(applied.name, directory), 'utf8');
      need(createHash('sha256').update(sql).digest('hex') === applied.checksum);
      await ref.query(sql);
    }
    const sourceCatalog = await catalog(src, sourceSchema);
    need(sourceCatalog === (await catalog(ref, referenceSchema)));
    await emptyTables(dst, targetSchema, true);
    await emptyTables(dst, 'neon_auth', true);
    need(sourceCatalog === (await catalog(dst, targetSchema)));
    await ref.query(`CREATE TABLE ${ledger} (name TEXT PRIMARY KEY, checksum TEXT NOT NULL)`);
    const expected = await catalog(ref, referenceSchema, true);
    need(expected === (await catalog(src, sourceSchema, true)));
    const ledgerExists = (
      await dst.query('SELECT to_regclass($1) AS name', [`${quote(targetSchema)}.${ledger}`])
    ).rows[0].name;
    if (!ledgerExists)
      await dst.query(
        `CREATE TABLE ${quote(targetSchema)}.${ledger} (name TEXT PRIMARY KEY, checksum TEXT NOT NULL)`,
      );
    need(expected === (await catalog(dst, targetSchema, true)));
    for (const applied of history)
      await dst.query(
        `INSERT INTO ${quote(targetSchema)}.${ledger} (name,checksum) VALUES ($1,$2)`,
        [applied.name, applied.checksum],
      );
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
