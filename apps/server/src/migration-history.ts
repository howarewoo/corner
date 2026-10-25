import type { PoolClient } from 'pg';
import { quoteIdentifier as quote } from './schema-catalog.js';
import type { MigrationIdentity } from './migration-inventory.js';

export const migrationTable = '__drizzle_migrations';
export const migrationLock = 'corner:schema-migrations';

export async function currentSchema(client: PoolClient): Promise<string> {
  const schema: unknown = (await client.query('SELECT current_schema() AS schema')).rows[0]?.schema;
  if (typeof schema !== 'string' || !schema) throw new Error('Application schema is required.');
  return schema;
}

export async function migrationHistory(
  client: PoolClient,
  schema: string,
  inventory: MigrationIdentity[],
  complete = false,
): Promise<MigrationIdentity[]> {
  const table = `${quote(schema)}.${quote(migrationTable)}`;
  if (!(await client.query('SELECT to_regclass($1) AS name', [table])).rows[0].name) {
    if (complete) throw new Error('Drizzle migration baseline is required.');
    return [];
  }
  const structure = (
    await client.query(
      `SELECT c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition
       AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND c.reloptions IS NULL
       AND s.relkind='S' AND s.relpersistence='p' AND s.relnamespace=c.relnamespace
       AND pg_get_expr(d.adbin,d.adrelid)=format('nextval(%L::regclass)',s.oid::regclass::text)
       AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype<>'n')=1
       AND EXISTS (
         SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND contype='p'
           AND conkey=ARRAY[1]::smallint[] AND NOT condeferrable
       )
       AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
       AS valid
     FROM pg_class c
     JOIN pg_class s ON s.oid=pg_get_serial_sequence($1,'id')::regclass
     JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=1
     WHERE c.oid=$1::regclass`,
      [table],
    )
  ).rows[0];
  if (!structure?.valid) throw new Error('Invalid Drizzle migration ledger.');
  const columns = (
    await client.query(
      `SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull
     FROM pg_attribute a WHERE a.attrelid=$1::regclass AND a.attnum>0 ORDER BY a.attnum`,
      [table],
    )
  ).rows;
  if (
    JSON.stringify(columns) !==
    JSON.stringify([
      { attname: 'id', type: 'integer', attnotnull: true },
      { attname: 'hash', type: 'text', attnotnull: true },
      { attname: 'created_at', type: 'bigint', attnotnull: false },
    ])
  )
    throw new Error('Invalid Drizzle migration ledger.');
  const rows = (await client.query(`SELECT hash,created_at FROM ${table} ORDER BY created_at,id`))
    .rows as { hash: string; created_at: number }[];
  if (
    (complete && rows.length !== inventory.length) ||
    rows.length > inventory.length ||
    rows.some(
      (row, index) =>
        row.hash !== inventory[index]!.sha256 || Number(row.created_at) !== inventory[index]!.when,
    )
  )
    throw new Error('Unknown or modified Drizzle migration history.');
  return inventory.slice(0, rows.length);
}

/** Record only a schema-verified baseline; the ordinary migrator never adopts existing tables. */
export async function recordBaseline(
  client: PoolClient,
  schema: string,
  baseline: MigrationIdentity,
): Promise<void> {
  const table = `${quote(schema)}.${quote(migrationTable)}`;
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${table} (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at BIGINT)`,
  );
  if ((await migrationHistory(client, schema, [baseline])).length)
    throw new Error('Baseline already exists.');
  await client.query(`INSERT INTO ${table} (hash,created_at) VALUES ($1,$2)`, [
    baseline.sha256,
    baseline.when,
  ]);
}
