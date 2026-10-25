import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { applicationCatalog, quoteIdentifier as quote } from './schema-catalog.js';
import { currentSchema, migrationHistory, recordBaseline } from './migration-history.js';
import { migrationInventory } from './migration-inventory.js';

export const legacyChecksum = 'f8304ded9b6bf1c380f83972155710d975a46fc1493ed14ecb6ef5a47ac657cf';
const legacyDdl =
  'CREATE TABLE corner_schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL)';

/** Called only by explicitly pinned operator cutovers, under the migration session lock. */
export async function adoptLegacySchema(connection: PoolClient, folder: string): Promise<void> {
  await connection.query('BEGIN');
  try {
    const schema = await currentSchema(connection);
    const inventory = await migrationInventory(folder);
    if (inventory.length !== 1 || inventory[0]!.name !== '0000_corner.sql')
      throw new Error('Unsupported adoption baseline.');
    const tables = (
      await connection.query(
        "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r' ORDER BY c.relname",
        [schema],
      )
    ).rows;
    for (const table of tables)
      await connection.query(
        `LOCK TABLE ${quote(schema)}.${quote(table.relname)} IN ACCESS EXCLUSIVE MODE`,
      );
    const history = await migrationHistory(connection, schema, inventory);
    const legacy = (
      await connection.query(
        `SELECT name,checksum FROM ${quote(schema)}.corner_schema_migrations ORDER BY name`,
      )
    ).rows;
    if (
      JSON.stringify(legacy) !==
      JSON.stringify([{ name: '001_corner.sql', checksum: legacyChecksum }])
    )
      throw new Error('Unknown legacy history.');
    const reference = `corner_adoption_${randomUUID().replaceAll('-', '')}`;
    await connection.query(`CREATE SCHEMA ${quote(reference)}`);
    await connection.query(`SET LOCAL search_path TO ${quote(reference)}, pg_catalog`);
    await connection.query(await readFile(join(folder, inventory[0]!.name), 'utf8'));
    await connection.query(legacyDdl);
    const expected = await applicationCatalog(connection, reference);
    if (expected !== (await applicationCatalog(connection, schema)))
      throw new Error('Legacy application schema differs.');
    if (!history.length) await recordBaseline(connection, schema, inventory[0]!);
    await connection.query(`DROP SCHEMA ${quote(reference)} CASCADE`);
    await connection.query('COMMIT');
  } catch {
    await connection.query('ROLLBACK');
    throw new Error('LEGACY_ADOPTION_REFUSED');
  }
}
