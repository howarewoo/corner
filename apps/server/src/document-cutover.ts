import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import type { PoolClient } from 'pg';
import { currentSchema, migrationHistory } from './migration-history.js';
import {
  migrationInventory,
  migrationsFolder,
  type MigrationIdentity,
} from './migration-inventory.js';
import { validatePersistedRecords } from './persisted-records.js';
import type { Database } from './queries.js';
import { quoteIdentifier as quote } from './schema-catalog.js';
import * as tables from './schema.js';
import { WorkspaceStore, inspectImport } from './store.js';
import { importRelational } from './workspace-portability.js';

const operationIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const fenceConstraint = 'workspace_state_cutover_fenced';

export type CutoverPhase =
  | 'untouched'
  | 'source-staged'
  | 'native-schema-advanced'
  | 'import-partial'
  | 'completed';

export interface CutoverInspection {
  phase: CutoverPhase;
  targetSchema: string;
  recoverySchema: string;
  operationId: string | null;
  legacyTablePresent: boolean;
  legacyRowCount: number;
  legacyFenced: boolean;
  relationalSchemaPresent: boolean;
  appliedMigrations: number;
  archivedOwners: number;
  importedOwners: number;
  pendingOwners: number;
}

export interface CutoverResult extends CutoverInspection {
  phase: 'completed';
  operationId: string;
  newlyStagedOwners: number;
  newlyImportedOwners: number;
  skippedImportedOwners: number;
}

export function cutoverRecoverySchema(applicationSchema: string): string {
  if (typeof applicationSchema !== 'string' || !applicationSchema)
    throw new Error('Application schema is required.');
  if (applicationSchema === 'public') return 'corner_cutover_recovery';
  const digest = createHash('sha256').update(applicationSchema).digest('hex').slice(0, 24);
  return `corner_cutover_recovery_${digest}`;
}

export function validOperationId(operationId: string): string {
  if (typeof operationId !== 'string' || !operationIdPattern.test(operationId))
    throw new Error('A valid cutover operation ID is required.');
  return operationId;
}

interface ArchiveRow {
  user_id: string;
  data: string;
  data_bytes: Buffer;
  version: string | number;
  updated_at: string;
}

async function parseArchiveRow(client: PoolClient, row: ArchiveRow) {
  if (
    typeof row.user_id !== 'string' ||
    !row.user_id ||
    row.user_id.length > 256 ||
    row.user_id.includes('\0') ||
    row.user_id.includes('\r') ||
    row.user_id.includes('\n')
  )
    throw new Error('Invalid legacy workspace owner identity.');
  if (typeof row.data !== 'string' || typeof row.updated_at !== 'string' || !row.updated_at)
    throw new Error('Invalid legacy workspace payload.');
  const bytes = Buffer.isBuffer(row.data_bytes)
    ? row.data_bytes
    : Buffer.from(row.data_bytes as Uint8Array);
  if (bytes.toString('utf8') !== row.data || !Buffer.from(row.data, 'utf8').equals(bytes))
    throw new Error('Legacy workspace UTF-8 byte mismatch.');
  const version = Number(row.version);
  if (!Number.isSafeInteger(version) || version < 0)
    throw new Error('Invalid legacy workspace version.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.data);
  } catch {
    throw new Error('Invalid legacy workspace JSON.');
  }
  const { state } = inspectImport(parsed);
  // Date.parse can normalize impossible dates that the destination timestamp type rejects.
  const timestamps = [
    ...state.recipes.map((entry) => entry.createdAt),
    ...state.logs.map((entry) => entry.createdAt),
    ...state.requests.map((entry) => entry.createdAt),
    ...state.training.templates.flatMap((entry) => [entry.createdAt, entry.updatedAt]),
    ...state.training.sessions.flatMap((entry) => [entry.createdAt, entry.updatedAt]),
    ...state.training.requests.map((entry) => entry.createdAt),
    ...state.training.reviews.map((entry) => entry.createdAt),
  ];
  await client.query(
    'SELECT value::timestamp(3) with time zone FROM unnest($1::text[]) AS timestamps(value)',
    [timestamps],
  );
  return { userId: row.user_id, state, version };
}

function cutoverLineage(inventory: MigrationIdentity[]) {
  const source = inventory[0];
  const target = inventory[1];
  if (
    inventory.length < 2 ||
    source?.name !== '0000_corner.sql' ||
    !target?.name.startsWith('0001_')
  )
    throw new Error('Cutover requires checked-in 0000 and 0001 migration lineage.');
  return { sourceSha256: source.sha256, targetSha256: target.sha256 };
}

async function verifyRecoveryCatalog(
  client: PoolClient,
  targetSchema: string,
  recoverySchema: string,
): Promise<void> {
  const unsupported = await client.query(
    `SELECT
      NOT EXISTS (
        SELECT 1 FROM pg_namespace r
        JOIN pg_namespace t ON t.nspname=$2
        JOIN pg_class m ON m.relnamespace=t.oid AND m.relname='__drizzle_migrations' AND m.relkind='r'
        WHERE r.nspname=$1 AND r.nspowner=m.relowner AND r.nspacl IS NULL
      ) OR
      EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_namespace t ON t.nspname=$2
        JOIN pg_class m ON m.relnamespace=t.oid AND m.relname='__drizzle_migrations' AND m.relkind='r'
        WHERE n.nspname=$1 AND (
          c.relowner<>m.relowner OR
          c.relacl IS NOT NULL OR
          c.relispartition OR
          c.relrowsecurity OR
          c.relforcerowsecurity OR
          c.reloptions IS NOT NULL OR
          c.reltablespace<>0 OR
          c.relpersistence<>'p' OR
          c.relkind NOT IN ('r','i','t')
        )
      ) OR
      EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1) OR
      EXISTS (SELECT 1 FROM pg_trigger tr JOIN pg_class c ON c.oid=tr.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1) OR
      EXISTS (SELECT 1 FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1) OR
      EXISTS (SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1) OR
      EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1) OR
      EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND (c.contype NOT IN ('p','c','n') OR c.condeferrable OR c.condeferred OR NOT c.convalidated)) OR
      EXISTS (
        SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relkind='r' AND a.attnum>0 AND (
          a.attisdropped OR a.attidentity<>'' OR a.attgenerated<>'' OR a.atthasmissing OR a.attacl IS NOT NULL OR a.atthasdef
        )
      ) AS unsupported`,
    [recoverySchema, targetSchema],
  );
  if (unsupported.rows[0]?.unsupported)
    throw new Error('Unsafe or foreign-owned cutover recovery catalog.');
  const relations = (
    await client.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relkind='r' ORDER BY c.relname`,
      [recoverySchema],
    )
  ).rows;
  if (
    JSON.stringify(relations) !==
    JSON.stringify([{ relname: 'operation' }, { relname: 'workspace_state_archive' }])
  )
    throw new Error('Unexpected relations in cutover recovery schema.');
  const columns = (
    await client.query(
      `SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull
       FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relkind='r' AND a.attnum>0 ORDER BY c.relname, a.attnum`,
      [recoverySchema],
    )
  ).rows;
  if (
    JSON.stringify(columns) !==
    JSON.stringify([
      { relname: 'operation', attname: 'id', type: 'integer', attnotnull: true },
      { relname: 'operation', attname: 'operation_id', type: 'text', attnotnull: true },
      { relname: 'operation', attname: 'database_name', type: 'text', attnotnull: true },
      { relname: 'operation', attname: 'branch_id', type: 'text', attnotnull: false },
      { relname: 'operation', attname: 'target_schema', type: 'text', attnotnull: true },
      { relname: 'operation', attname: 'source_migration_sha256', type: 'text', attnotnull: true },
      { relname: 'operation', attname: 'target_migration_sha256', type: 'text', attnotnull: true },
      { relname: 'operation', attname: 'archived_count', type: 'integer', attnotnull: true },
      { relname: 'operation', attname: 'created_at', type: 'text', attnotnull: true },
      {
        relname: 'workspace_state_archive',
        attname: 'operation_id',
        type: 'text',
        attnotnull: true,
      },
      {
        relname: 'workspace_state_archive',
        attname: 'target_schema',
        type: 'text',
        attnotnull: true,
      },
      { relname: 'workspace_state_archive', attname: 'user_id', type: 'text', attnotnull: true },
      { relname: 'workspace_state_archive', attname: 'data', type: 'text', attnotnull: true },
      {
        relname: 'workspace_state_archive',
        attname: 'data_bytes',
        type: 'bytea',
        attnotnull: true,
      },
      { relname: 'workspace_state_archive', attname: 'version', type: 'bigint', attnotnull: true },
      {
        relname: 'workspace_state_archive',
        attname: 'updated_at',
        type: 'text',
        attnotnull: true,
      },
      {
        relname: 'workspace_state_archive',
        attname: 'staged_at',
        type: 'text',
        attnotnull: true,
      },
      {
        relname: 'workspace_state_archive',
        attname: 'imported_at',
        type: 'text',
        attnotnull: false,
      },
    ])
  )
    throw new Error('Invalid cutover recovery column definitions.');
}

async function readRecoveryState(
  client: PoolClient,
  targetSchema: string,
  inventory: MigrationIdentity[],
  expectedOperationId?: string,
): Promise<{
  recoverySchema: string;
  operationId: string | null;
  archivedOwners: number;
  importedOwners: number;
  pendingOwners: number;
}> {
  const recoverySchema = cutoverRecoverySchema(targetSchema);
  const lineage = cutoverLineage(inventory);
  const schemaExists = Boolean(
    (await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [recoverySchema])).rowCount,
  );
  const opTable = `${quote(recoverySchema)}."operation"`;
  const archiveTable = `${quote(recoverySchema)}."workspace_state_archive"`;
  const opReg = (await client.query('SELECT to_regclass($1) AS name', [opTable])).rows[0]?.name;
  const archiveReg = (await client.query('SELECT to_regclass($1) AS name', [archiveTable])).rows[0]
    ?.name;
  if (!schemaExists && !opReg && !archiveReg) {
    return {
      recoverySchema,
      operationId: null,
      archivedOwners: 0,
      importedOwners: 0,
      pendingOwners: 0,
    };
  }
  if (!schemaExists || !opReg || !archiveReg)
    throw new Error('Incomplete or unrecognized cutover recovery schema.');
  await verifyRecoveryCatalog(client, targetSchema, recoverySchema);
  const envRow = (
    await client.query(
      `SELECT current_database() AS db, nullif(current_setting('neon.branch_id', true), '') AS branch`,
    )
  ).rows[0];
  const ops = (
    await client.query(
      `SELECT id, operation_id, database_name, branch_id, target_schema, source_migration_sha256,
              target_migration_sha256, archived_count
       FROM ${opTable}`,
    )
  ).rows;
  if (ops.length !== 1 || Number(ops[0].id) !== 1)
    throw new Error('Cutover recovery operation metadata is missing or ambiguous.');
  const op = ops[0];
  validOperationId(op.operation_id);
  if (
    op.database_name !== envRow?.db ||
    (op.branch_id ?? null) !== (envRow?.branch ?? null) ||
    op.target_schema !== targetSchema ||
    op.source_migration_sha256 !== lineage.sourceSha256 ||
    op.target_migration_sha256 !== lineage.targetSha256
  )
    throw new Error(
      'Cutover recovery provenance does not match target database, Neon branch, schema, or SQL.',
    );
  if (expectedOperationId !== undefined && op.operation_id !== expectedOperationId)
    throw new Error('Cutover recovery schema belongs to a different operation ID.');
  const counts = (
    await client.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE imported_at IS NOT NULL)::int AS imported,
              count(*) FILTER (WHERE imported_at IS NULL)::int AS pending,
              count(*) FILTER (WHERE operation_id <> $1 OR target_schema <> $2)::int AS mismatched
       FROM ${archiveTable}`,
      [op.operation_id, targetSchema],
    )
  ).rows[0];
  if (
    counts.mismatched > 0 ||
    counts.total !== Number(op.archived_count) ||
    counts.total !== counts.imported + counts.pending
  )
    throw new Error('Cutover recovery archive row provenance or count mismatch.');
  return {
    recoverySchema,
    operationId: op.operation_id as string,
    archivedOwners: counts.total as number,
    importedOwners: counts.imported as number,
    pendingOwners: counts.pending as number,
  };
}

export async function readCutoverState(
  client: PoolClient,
  schema: string,
  inventory: MigrationIdentity[],
  expectedOperationId?: string,
): Promise<CutoverInspection> {
  const applied = await migrationHistory(client, schema, inventory);
  const recovery = await readRecoveryState(client, schema, inventory, expectedOperationId);
  const legacyTable = `${quote(schema)}."workspace_state"`;
  const metadataTable = `${quote(schema)}."workspace_metadata"`;
  const legacyTablePresent = Boolean(
    (await client.query('SELECT to_regclass($1) AS name', [legacyTable])).rows[0]?.name,
  );
  const relationalSchemaPresent = Boolean(
    (await client.query('SELECT to_regclass($1) AS name', [metadataTable])).rows[0]?.name,
  );
  let legacyRowCount = 0;
  let legacyFenced = false;
  if (legacyTablePresent) {
    legacyRowCount = (await client.query(`SELECT count(*)::int AS count FROM ${legacyTable}`))
      .rows[0].count;
    const fence = (
      await client.query(
        `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         WHERE c.conrelid=$1::regclass AND c.conname=$2 AND c.contype='c' AND c.convalidated`,
        [legacyTable, fenceConstraint],
      )
    ).rows[0]?.def;
    legacyFenced = typeof fence === 'string' && /CHECK\s*\(\s*false\s*\)/i.test(fence);
  }
  let phase: CutoverPhase;
  if (applied.length === 0) {
    if (recovery.operationId !== null || legacyTablePresent || relationalSchemaPresent)
      throw new Error('Unbaselined schema has unexpected cutover or application tables.');
    phase = 'untouched';
  } else if (applied.length === 1) {
    if (!legacyTablePresent || relationalSchemaPresent)
      throw new Error('Inconsistent 0000 schema state during cutover inspection.');
    if (recovery.operationId === null) {
      if (legacyFenced)
        throw new Error('Legacy workspace_state is fenced without a recovery operation record.');
      phase = 'untouched';
    } else {
      if (!legacyFenced || legacyRowCount !== 0 || recovery.importedOwners > 0)
        throw new Error('Inconsistent staged cutover state on 0000 schema.');
      phase = 'source-staged';
    }
  } else if (applied.length >= 2) {
    if (legacyTablePresent || !relationalSchemaPresent)
      throw new Error('Inconsistent relational schema state after migration.');
    if (recovery.pendingOwners === 0) {
      phase = 'completed';
    } else if (recovery.importedOwners === 0) {
      phase = 'native-schema-advanced';
    } else {
      phase = 'import-partial';
    }
  } else {
    throw new Error('Unsupported intermediate migration count.');
  }
  return {
    phase,
    targetSchema: schema,
    recoverySchema: recovery.recoverySchema,
    operationId: recovery.operationId,
    legacyTablePresent,
    legacyRowCount,
    legacyFenced,
    relationalSchemaPresent,
    appliedMigrations: applied.length,
    archivedOwners: recovery.archivedOwners,
    importedOwners: recovery.importedOwners,
    pendingOwners: recovery.pendingOwners,
  };
}

export async function assertNoPendingCutover(
  client: PoolClient,
  schema: string,
  inventory: MigrationIdentity[],
): Promise<void> {
  if (
    inventory.length >= 2 &&
    inventory[0]?.name === '0000_corner.sql' &&
    inventory[1]?.name.startsWith('0001_')
  ) {
    const state = await readCutoverState(client, schema, inventory);
    if (
      state.phase === 'source-staged' ||
      state.phase === 'native-schema-advanced' ||
      state.phase === 'import-partial' ||
      state.legacyFenced ||
      state.pendingOwners > 0
    ) {
      throw new Error(
        `Ordinary migration refused: preserving cutover operation ${
          state.operationId ?? 'unknown'
        } is incomplete (${state.phase}). Resume with --preserving-cutover.`,
      );
    }
  }
}

async function preflightArchiveBatch(
  client: PoolClient,
  archiveTable: string,
  operationId: string,
  targetSchema: string,
): Promise<void> {
  let after = '';
  for (;;) {
    const rows: ArchiveRow[] = (
      await client.query(
        `SELECT user_id, data, data_bytes, version, updated_at
         FROM ${archiveTable}
         WHERE operation_id=$1 AND target_schema=$2 AND imported_at IS NULL AND user_id > $3
         ORDER BY user_id LIMIT 100`,
        [operationId, targetSchema, after],
      )
    ).rows;
    if (!rows.length) return;
    for (const row of rows) await parseArchiveRow(client, row);
    if (rows.length < 100) return;
    after = rows.at(-1)!.user_id;
  }
}

async function stageLegacyWorkspaces(
  client: PoolClient,
  schema: string,
  inventory: MigrationIdentity[],
  operationId: string,
): Promise<number> {
  const lineage = cutoverLineage(inventory);
  await client.query('BEGIN');
  try {
    const initial = await readCutoverState(client, schema, inventory, operationId);
    if (initial.appliedMigrations !== 1) {
      await client.query('ROLLBACK');
      return 0;
    }
    const legacyTable = `${quote(schema)}."workspace_state"`;
    await client.query(`LOCK TABLE ${legacyTable} IN ACCESS EXCLUSIVE MODE`);
    const recovery = await readRecoveryState(client, schema, inventory, operationId);
    const liveCount = (await client.query(`SELECT count(*)::int AS count FROM ${legacyTable}`))
      .rows[0].count as number;
    if (liveCount === 0 && recovery.operationId === null) {
      await client.query('ROLLBACK');
      return 0;
    }
    if (recovery.operationId !== null && liveCount > 0)
      throw new Error('Cannot stage new legacy workspace rows into an already-staged operation.');
    const recoverySchema = recovery.recoverySchema;
    const opTable = `${quote(recoverySchema)}."operation"`;
    const archiveTable = `${quote(recoverySchema)}."workspace_state_archive"`;
    if (liveCount > 0) {
      let after = '';
      for (;;) {
        const rows: ArchiveRow[] = (
          await client.query(
            `SELECT user_id, data, convert_to(data, 'UTF8') AS data_bytes, version, updated_at
             FROM ${legacyTable}
             WHERE user_id > $1
             ORDER BY user_id LIMIT 100`,
            [after],
          )
        ).rows;
        if (!rows.length) break;
        for (const row of rows) await parseArchiveRow(client, row);
        if (rows.length < 100) break;
        after = rows.at(-1)!.user_id;
      }
      const now = new Date().toISOString();
      const envRow = (
        await client.query(
          `SELECT current_database() AS db, nullif(current_setting('neon.branch_id', true), '') AS branch`,
        )
      ).rows[0] as { db: string; branch: string | null };
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${quote(recoverySchema)}`);
      await client.query(
        `CREATE TABLE ${opTable} (
           id integer PRIMARY KEY CHECK (id = 1),
           operation_id text NOT NULL,
           database_name text NOT NULL,
           branch_id text,
           target_schema text NOT NULL,
           source_migration_sha256 text NOT NULL,
           target_migration_sha256 text NOT NULL,
           archived_count integer NOT NULL CHECK (archived_count >= 0),
           created_at text NOT NULL
         )`,
      );
      await client.query(
        `CREATE TABLE ${archiveTable} (
           operation_id text NOT NULL,
           target_schema text NOT NULL,
           user_id text PRIMARY KEY,
           data text NOT NULL,
           data_bytes bytea NOT NULL,
           version bigint NOT NULL CHECK (version >= 0),
           updated_at text NOT NULL,
           staged_at text NOT NULL,
           imported_at text
         )`,
      );
      await client.query(
        `INSERT INTO ${opTable}
           (id, operation_id, database_name, branch_id, target_schema, source_migration_sha256, target_migration_sha256, archived_count, created_at)
         VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          operationId,
          envRow.db,
          envRow.branch,
          schema,
          lineage.sourceSha256,
          lineage.targetSha256,
          liveCount,
          now,
        ],
      );
      await client.query(
        `INSERT INTO ${archiveTable}
           (operation_id, target_schema, user_id, data, data_bytes, version, updated_at, staged_at, imported_at)
         SELECT $1, $2, user_id, data, convert_to(data, 'UTF8'), version, updated_at, $3, NULL
         FROM ${legacyTable}
         ORDER BY user_id`,
        [operationId, schema, now],
      );
      await client.query(`DELETE FROM ${legacyTable}`);
      await client.query(
        `ALTER TABLE ${legacyTable} ADD CONSTRAINT ${quote(fenceConstraint)} CHECK (false)`,
      );
      await readRecoveryState(client, schema, inventory, operationId);
      await client.query('COMMIT');
      return liveCount;
    }
    await preflightArchiveBatch(client, archiveTable, operationId, schema);
    const fenced = (
      await client.query(
        `SELECT 1 FROM pg_constraint WHERE conrelid=$1::regclass AND conname=$2 AND contype='c'`,
        [legacyTable, fenceConstraint],
      )
    ).rowCount;
    if (!fenced) {
      await client.query(
        `ALTER TABLE ${legacyTable} ADD CONSTRAINT ${quote(fenceConstraint)} CHECK (false)`,
      );
    }
    await client.query('COMMIT');
    return 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function importArchivedWorkspaces(
  client: PoolClient,
  schema: string,
  inventory: MigrationIdentity[],
  operationId: string,
): Promise<{ newlyImportedOwners: number; skippedImportedOwners: number }> {
  const recovery = await readRecoveryState(client, schema, inventory, operationId);
  if (recovery.operationId === null) {
    return { newlyImportedOwners: 0, skippedImportedOwners: 0 };
  }
  const archiveTable = `${quote(recovery.recoverySchema)}."workspace_state_archive"`;
  await preflightArchiveBatch(client, archiveTable, operationId, schema);
  const db = drizzle({ client, schema: tables }) as Database;
  const store = new WorkspaceStore(db);
  let newlyImportedOwners = 0;
  let skippedImportedOwners = 0;
  let after = '';
  for (;;) {
    const rows: Array<ArchiveRow & { imported_at: string | null }> = (
      await client.query(
        `SELECT user_id, data, data_bytes, version, updated_at, imported_at
         FROM ${archiveTable}
         WHERE operation_id=$1 AND target_schema=$2 AND user_id > $3
         ORDER BY user_id LIMIT 100`,
        [operationId, schema, after],
      )
    ).rows;
    if (!rows.length) break;
    for (const row of rows) {
      if (row.imported_at !== null) {
        skippedImportedOwners++;
        continue;
      }
      const { userId, state, version } = await parseArchiveRow(client, row);
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
        const currentArchive = (
          await tx.execute(
            sql.raw(
              `SELECT imported_at FROM ${archiveTable} WHERE operation_id=${client.escapeLiteral(
                operationId,
              )} AND target_schema=${client.escapeLiteral(
                schema,
              )} AND user_id=${client.escapeLiteral(userId)} FOR UPDATE`,
            ),
          )
        ).rows[0] as { imported_at: string | null } | undefined;
        if (!currentArchive) throw new Error('Missing archived workspace row during import.');
        if (currentArchive.imported_at !== null) {
          skippedImportedOwners++;
          return;
        }
        const existingMetadata = (
          await tx
            .select({ user_id: tables.workspaceMetadata.user_id })
            .from(tables.workspaceMetadata)
            .where(eq(tables.workspaceMetadata.user_id, userId))
            .limit(1)
        )[0];
        const empty = await store.isEmpty(userId, tx);
        if (existingMetadata || !empty) {
          throw new Error(
            'Relational cutover conflict: destination workspace already contains unmarked relational records.',
          );
        }
        const { timezone, ...preferences } = state.settings;
        await tx.insert(tables.workspaceMetadata).values({
          user_id: userId,
          revision: version,
          next_position: 0,
          timezone,
          settings: preferences,
        });
        let nextPosition = 0;
        const allocatePosition = () => {
          if (nextPosition >= Number.MAX_SAFE_INTEGER)
            throw new Error('Workspace position limit exceeded during cutover.');
          return nextPosition++;
        };
        await importRelational(tx, userId, state, allocatePosition);
        await tx
          .update(tables.workspaceMetadata)
          .set({
            revision: version,
            next_position: nextPosition,
            timezone,
            settings: preferences,
          })
          .where(eq(tables.workspaceMetadata.user_id, userId));
        const importedAt = new Date().toISOString();
        await tx.execute(
          sql.raw(
            `UPDATE ${archiveTable} SET imported_at=${client.escapeLiteral(
              importedAt,
            )} WHERE operation_id=${client.escapeLiteral(
              operationId,
            )} AND target_schema=${client.escapeLiteral(schema)} AND user_id=${client.escapeLiteral(
              userId,
            )}`,
          ),
        );
        newlyImportedOwners++;
      });
    }
    if (rows.length < 100) break;
    after = rows.at(-1)!.user_id;
  }
  return { newlyImportedOwners, skippedImportedOwners };
}

export async function runPreservingCutover(
  connection: PoolClient,
  operationId: string,
  folder = migrationsFolder,
): Promise<CutoverResult> {
  validOperationId(operationId);
  const inventory = await migrationInventory(folder);
  cutoverLineage(inventory);
  const schema = await currentSchema(connection);
  const initial = await readCutoverState(connection, schema, inventory, operationId);
  const newlyStagedOwners =
    initial.appliedMigrations === 1
      ? await stageLegacyWorkspaces(connection, schema, inventory, operationId)
      : 0;
  await migrationHistory(connection, schema, inventory);
  await drizzleMigrate(drizzle({ client: connection }), {
    migrationsFolder: folder,
    migrationsSchema: schema,
  });
  await migrationHistory(connection, schema, inventory, true);
  const { newlyImportedOwners, skippedImportedOwners } = await importArchivedWorkspaces(
    connection,
    schema,
    inventory,
    operationId,
  );
  await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await validatePersistedRecords(connection, schema);
    const finalState = await readCutoverState(connection, schema, inventory, operationId);
    if (finalState.phase !== 'completed' || finalState.pendingOwners !== 0)
      throw new Error('Preserving document cutover did not reach completed state.');
    await connection.query('COMMIT');
    return {
      ...finalState,
      phase: 'completed',
      operationId,
      newlyStagedOwners,
      newlyImportedOwners,
      skippedImportedOwners,
    };
  } catch (validationError) {
    await connection.query('ROLLBACK');
    throw validationError;
  }
}
