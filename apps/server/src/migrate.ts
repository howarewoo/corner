import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool, PoolClient } from 'pg';
import { createDatabase } from './database.js';
import {
  assertNoPendingCutover,
  cutoverRecoverySchema,
  readCutoverState,
  runPreservingCutover,
  validOperationId,
  type CutoverInspection,
  type CutoverPhase,
  type CutoverResult,
} from './document-cutover.js';
import { currentSchema, migrationHistory, migrationLock } from './migration-history.js';
import { migrationInventory, migrationsFolder } from './migration-inventory.js';

export { cutoverRecoverySchema, type CutoverInspection, type CutoverPhase, type CutoverResult };

async function withMigrationLock<T>(
  database: Pool,
  run: (connection: PoolClient) => Promise<T>,
): Promise<T> {
  const connection = await database.connect();
  let locked = false;
  let failed = false;
  let failure: unknown;
  let result: T | undefined;
  try {
    // A session lock spans the native engine's metadata setup and SQL transaction.
    // This connection is direct for deployment; it never passes through transaction pooling.
    await connection.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [migrationLock]);
    locked = true;
    result = await run(connection);
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    let discard = false;
    try {
      if (locked)
        await connection.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
          migrationLock,
        ]);
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
  return result as T;
}

export async function inspectDocumentCutover(
  database: Pool,
  operationId?: string,
  folder = migrationsFolder,
): Promise<CutoverInspection> {
  if (operationId !== undefined) validOperationId(operationId);
  const inventory = await migrationInventory(folder);
  const connection = await database.connect();
  try {
    await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const schema = await currentSchema(connection);
    return await readCutoverState(connection, schema, inventory, operationId);
  } finally {
    try {
      await connection.query('ROLLBACK');
    } catch {
      /* Read-only snapshot cleanup. */
    } finally {
      connection.release();
    }
  }
}

export async function preservingDocumentCutover(
  database: Pool,
  operationId: string,
  folder = migrationsFolder,
): Promise<CutoverResult> {
  validOperationId(operationId);
  return withMigrationLock(database, (connection) =>
    runPreservingCutover(connection, operationId, folder),
  );
}

export async function migrate(database: Pool, folder = migrationsFolder): Promise<void> {
  const inventory = await migrationInventory(folder);
  await withMigrationLock(database, async (connection) => {
    const schema = await currentSchema(connection);
    await migrationHistory(connection, schema, inventory);
    await assertNoPendingCutover(connection, schema, inventory);
    await drizzleMigrate(drizzle({ client: connection }), {
      migrationsFolder: folder,
      migrationsSchema: schema,
    });
    await migrationHistory(connection, schema, inventory, true);
  });
}

export function directDatabaseUrl(value: string | undefined): string {
  if (!value) throw new Error('DATABASE_URL_UNPOOLED is required for schema operations.');
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname.includes('-pooler.') ||
    [...url.searchParams.keys()].some((key) => key !== 'sslmode' && key !== 'channel_binding')
  )
    throw new Error(
      'Schema operations require a direct PostgreSQL URL without connection overrides.',
    );
  return value;
}

function parseCliOptions(
  args: string[],
  environment: NodeJS.ProcessEnv,
):
  | { mode: 'apply' }
  | { mode: 'preserving-cutover'; operationId: string }
  | { mode: 'inspect-cutover'; operationId: string | undefined } {
  if (args.length === 1 && args[0] === '--apply') return { mode: 'apply' };
  if (args[0] === '--preserving-cutover' || args[0] === '--inspect-cutover') {
    const mode = args[0] === '--preserving-cutover' ? 'preserving-cutover' : 'inspect-cutover';
    let operationId: string | undefined;
    if (args.length === 1) {
      operationId = environment.CORNER_CUTOVER_OPERATION_ID || undefined;
    } else if (args.length === 2 && args[1]!.startsWith('--operation-id=')) {
      operationId = args[1]!.slice('--operation-id='.length);
    } else if (args.length === 3 && args[1] === '--operation-id') {
      operationId = args[2];
    } else {
      throw new Error(`Invalid arguments for ${args[0]}.`);
    }
    if (mode === 'preserving-cutover') {
      if (!operationId)
        throw new Error('Cutover requires --operation-id or CORNER_CUTOVER_OPERATION_ID.');
      return { mode, operationId: validOperationId(operationId) };
    }
    if (operationId !== undefined) validOperationId(operationId);
    return { mode, operationId };
  }
  throw new Error('Expected --apply, --preserving-cutover, or --inspect-cutover.');
}

export async function migrationCli(
  args = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const parsed = parseCliOptions(args, environment);
  const url = directDatabaseUrl(environment.DATABASE_URL_UNPOOLED);
  const database = createDatabase(url);
  try {
    if (parsed.mode === 'apply') {
      await migrate(database);
      process.stdout.write('Corner Drizzle PostgreSQL schema is current.\n');
    } else if (parsed.mode === 'preserving-cutover') {
      try {
        const result = await preservingDocumentCutover(database, parsed.operationId);
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } catch {
        throw new Error('PRESERVING_DOCUMENT_CUTOVER_REFUSED');
      }
    } else {
      try {
        const inspection = await inspectDocumentCutover(database, parsed.operationId);
        process.stdout.write(`${JSON.stringify(inspection)}\n`);
      } catch {
        throw new Error('DOCUMENT_CUTOVER_INSPECTION_REFUSED');
      }
    }
  } finally {
    await database.end();
  }
}

if (import.meta.main) {
  try {
    await migrationCli();
  } catch (error) {
    const code =
      error instanceof Error &&
      ['PRESERVING_DOCUMENT_CUTOVER_REFUSED', 'DOCUMENT_CUTOVER_INSPECTION_REFUSED'].includes(
        error.message,
      )
        ? error.message
        : 'SCHEMA_MIGRATION_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
