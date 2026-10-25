import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';
import { createDatabase } from './database.js';
import { currentSchema, migrationHistory, migrationLock } from './migration-history.js';
import { migrationInventory, migrationsFolder } from './migration-inventory.js';
import { adoptLegacySchema } from './legacy-adoption.js';

export async function migrate(database: Pool, folder = migrationsFolder, legacyAdoption = false): Promise<void> {
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
    if (legacyAdoption) await adoptLegacySchema(connection, folder);
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
  const stagingAdoption = args.includes('--adopt-staging');
  const productionAdoption = args.includes('--adopt-production');
  if (!args.includes('--apply') || new Set(args).size !== args.length ||
      args.some(arg => arg !== '--apply' && arg !== '--adopt-staging' && arg !== '--adopt-production') ||
      (stagingAdoption && productionAdoption))
    throw new Error('Expected --apply with at most one explicit adoption mode.');
  const url = directDatabaseUrl(process.env.DATABASE_URL_UNPOOLED);
  if (stagingAdoption && (new URL(url).hostname !== process.env.STAGING_ADOPTION_HOST ||
      process.env.STAGING_ADOPTION_MODE !== 'pinned-manual'))
    throw new Error('Explicit pinned staging adoption required.');
  if (productionAdoption && (
      process.env.GITHUB_ACTIONS !== 'true' ||
      process.env.GITHUB_REF !== 'refs/heads/main' ||
      process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
      process.env.PRODUCTION_ADOPTION_MODE !== 'pinned-bootstrap' ||
      new URL(url).hostname !== process.env.PRODUCTION_ADOPTION_HOST))
    throw new Error('Protected pinned production bootstrap adoption required.');
  const database = createDatabase(url);
  try {
    await migrate(database, migrationsFolder, stagingAdoption || productionAdoption);
    process.stdout.write('Corner Drizzle PostgreSQL schema is current.\n');
  } finally {
    await database.end();
  }
}

if (import.meta.main) {
  await migrationCli();
}
