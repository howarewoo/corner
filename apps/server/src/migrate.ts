import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';
import { createDatabase } from './database.js';
import { currentSchema, migrationHistory, migrationLock } from './migration-history.js';
import { migrationInventory, migrationsFolder } from './migration-inventory.js';
import { adoptStaging } from './staging-adoption.js';

export async function migrate(database: Pool, folder = migrationsFolder, stagingAdoption = false): Promise<void> {
  const inventory = await migrationInventory(folder);
  const connection = await database.connect();
  let locked = false;
  let failed = false;
  let failure: unknown;
  try {
    // A session lock spans the native engine's metadata setup and SQL transaction.
    // This connection is direct for deployment; it never passes through transaction pooling.
    await connection.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [migrationLock]);
    locked = true;
    if (stagingAdoption) await adoptStaging(connection, folder);
    const schema = await currentSchema(connection);
    await migrationHistory(connection, schema, inventory);
    await drizzleMigrate(drizzle({ client: connection }), { migrationsFolder: folder, migrationsSchema: schema });
    await migrationHistory(connection, schema, inventory, true);
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    let discard = false;
    try {
      if (locked) await connection.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [migrationLock]);
    } catch (error) {
      discard = true;
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
    connection.release(discard);
  }
  if (failed) throw failure;
}

export function directDatabaseUrl(value: string | undefined): string {
  if (!value) throw new Error('DATABASE_URL_UNPOOLED is required for schema operations.');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname.includes('-pooler.') || url.searchParams.has('options'))
    throw new Error('Schema operations require a direct PostgreSQL URL without connection overrides.');
  return value;
}

export async function migrationCli(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.includes('--apply') || new Set(args).size !== args.length ||
      args.some(arg => arg !== '--apply' && arg !== '--adopt-staging'))
    throw new Error('Expected --apply with optional --adopt-staging.');
  const url = directDatabaseUrl(process.env.DATABASE_URL_UNPOOLED);
  const adoption = process.argv.includes('--adopt-staging');
  if (adoption && (!process.argv.includes('--apply') || new URL(url).hostname !== process.env.STAGING_ADOPTION_HOST ||
      process.env.STAGING_ADOPTION_MODE !== 'pinned-manual'))
    throw new Error('Explicit pinned staging adoption required.');
  const database = createDatabase(url);
  try {
    await migrate(database, migrationsFolder, adoption);
    process.stdout.write('Corner Drizzle PostgreSQL schema is current.\n');
  } finally {
    await database.end();
  }
}

if (import.meta.main) {
  await migrationCli();
}
