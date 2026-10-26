import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { migrate } from './migrate.js';
import {
  currentSchema,
  migrationHistory,
  migrationLock,
  recordBaseline,
} from './migration-history.js';
import { migrationInventory, migrationsFolder } from './migration-inventory.js';
import { applicationCatalog, quoteIdentifier as quote } from './schema-catalog.js';

/** Only the owned local controller calls this, after checking the database and role identity. */
export async function migrateLocalDatabase(database: Pool, instance: string): Promise<void> {
  const inventory = await migrationInventory();
  const connection = await database.connect();
  try {
    await connection.query('BEGIN');
    await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      migrationLock,
    ]);
    const schema = await currentSchema(connection);
    const owners = (
      await connection.query(`SELECT instance FROM ${quote(schema)}.corner_local_identity`)
    ).rows;
    if (owners.length !== 1 || owners[0].instance !== instance)
      throw new Error(
        'Local database installation identity does not match. No migration was applied.',
      );
    const history = await migrationHistory(connection, schema, inventory);
    const legacy = (
      await connection.query('SELECT to_regclass($1) AS name', [
        `${quote(schema)}.corner_schema_migrations`,
      ])
    ).rows[0].name;
    if (!history.length && legacy) {
      const baseline = inventory[0]!;
      if (baseline.name !== '0000_corner.sql') throw new Error('Unknown local migration baseline.');
      const sql = await readFile(join(migrationsFolder, baseline.name), 'utf8');
      if (createHash('sha256').update(sql).digest('hex') !== baseline.sha256)
        throw new Error('Modified local migration baseline.');
      // Compare real PostgreSQL definitions, not the old audit checksum or table names alone.
      const reference = `corner_local_baseline_${randomUUID().replaceAll('-', '')}`;
      await connection.query(`CREATE SCHEMA ${quote(reference)}`);
      await connection.query(`SET LOCAL search_path TO ${quote(reference)}, pg_catalog`);
      await connection.query(sql);
      const tables = (
        await connection.query(
          'SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename',
          [reference],
        )
      ).rows.map((row: { tablename: string }) => row.tablename);
      await connection.query(
        `LOCK TABLE ${tables.map((table) => `${quote(schema)}.${quote(table)}`).join(', ')} IN ACCESS EXCLUSIVE MODE`,
      );
      const expected = await applicationCatalog(connection, reference);
      if (expected !== (await applicationCatalog(connection, schema, tables)))
        throw new Error(
          'Local application schema differs from the Drizzle baseline. No baseline was recorded.',
        );
      // Adoption must not commit a native baseline when the following empty-only
      // relational migration cannot run. The exclusive locks above also fence
      // legacy writers until this decision has committed.
      if (inventory.length > 1) {
        const retained = await connection.query(
          `SELECT 1 FROM ${quote(schema)}.workspace_state LIMIT 1`,
        );
        if (retained.rowCount)
          throw new Error(
            'Local workspace records prevent the empty-only relational migration. No baseline was recorded.',
          );
      }
      await connection.query(`DROP SCHEMA ${quote(reference)} CASCADE`);
      await recordBaseline(connection, schema, baseline);
    }
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
  await migrate(database);
}
