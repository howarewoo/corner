import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ImportSourceSchema } from '@packages/workspace/mutations';
import type { ImportSource } from '@packages/workspace/types';
import { WorkoutSessionSchema } from '@packages/training/workouts';
import type { WorkoutSession } from '@packages/training/types';
import type { Transaction } from './queries.js';
import type { WorkspaceBootstrap } from './store.js';
import { fingerprint } from './fingerprint.js';
import { importSources, workoutSessions } from './schema.js';
import { saveSession } from './training-records.js';
import { ApiError } from './http.js';

export const MAX_IMPORT_RECORDS = 100;
// Enough for full native workouts including all 25 exercises × 30 sets; batches may
// hit this finite UTF-8 ceiling before the count ceiling and must then be split.
export const MAX_MCP_REQUEST_BYTES = 2 * 1024 * 1024;
export const ImportOutcomeSchema = z.object({
  sourceRecordId: ImportSourceSchema.shape.sourceRecordId,
  destinationId: ImportSourceSchema.shape.destinationId,
  outcome: z.enum(['created', 'skipped']),
}).strict();
export type ImportOutcome = z.infer<typeof ImportOutcomeSchema>;
export const ImportOutcomesSchema = z.array(ImportOutcomeSchema).min(1).max(MAX_IMPORT_RECORDS);
export type ImportResult = { revision: number; outcomes: ImportOutcome[] };
export type ImportMember<T> = { sourceRecordId: string; record: T };

/** Called only inside WorkspaceStore's owner-locked transaction. Never overwrites. */
export interface ImportAdapter<T> {
  recordType: ImportSource['recordType'];
  schema: z.ZodType<T>;
  destinationId(record: T): string;
  exists(connection: Transaction, ownerId: string, record: T): Promise<boolean>;
  create(connection: Transaction, ownerId: string, record: T,
    current: WorkspaceBootstrap, position: () => number): Promise<void>;
}

export type CompletedWorkoutSource = Omit<WorkoutSession, 'createdAt' | 'updatedAt'>;
export const completedWorkoutSchema = z.object(WorkoutSessionSchema.shape)
  .omit({ createdAt: true, updatedAt: true }).strict().superRefine((record, context) => {
    // These fields are Corner persistence metadata, not historical source facts.
    // Validate the complete native domain rules without requiring callers to invent them.
    const validationTimestamp = '2000-01-01T00:00:00.000Z';
    const result = WorkoutSessionSchema.safeParse({
      ...record, createdAt: validationTimestamp, updatedAt: validationTimestamp,
    });
    if (!result.success) for (const issue of result.error.issues) context.addIssue({
      code: 'custom', path: issue.path, message: issue.message,
    });
    if (record.status !== 'completed') context.addIssue({
      code: 'custom', path: ['status'], message: 'Only completed workouts can be imported.',
    });
  });
export const workoutImportAdapter: ImportAdapter<CompletedWorkoutSource> = {
  recordType: 'workouts',
  schema: completedWorkoutSchema,
  destinationId: (record) => record.id,
  async exists(connection, ownerId, record) {
    return (await connection.select({ id: workoutSessions.id }).from(workoutSessions)
      .where(and(eq(workoutSessions.user_id, ownerId), eq(workoutSessions.id, record.id)))
      .limit(1)).length > 0;
  },
  async create(connection, ownerId, record, _current, position) {
    // Historical imports do not create explicit scheduling markers.
    // templateId remains snapshot metadata, never a routine lookup.
    const now = new Date().toISOString();
    await saveSession(connection, ownerId,
      { ...record, createdAt: now, updatedAt: now }, position());
  },
};

export async function importBatch<T>(
  connection: Transaction,
  ownerId: string,
  sourceNamespace: string,
  records: ImportMember<T>[],
  adapter: ImportAdapter<T>,
  current: WorkspaceBootstrap,
  position: () => number,
): Promise<ImportOutcome[]> {
  const namespace = ImportSourceSchema.shape.sourceNamespace.parse(sourceNamespace);
  if (!records.length || records.length > MAX_IMPORT_RECORDS)
    throw new ApiError(400, 'INVALID_INPUT', 'Import between 1 and 100 records.');
  const outcomes: ImportOutcome[] = [];
  const seen = new Set<string>();
  for (const member of records) {
    const sourceRecordId = ImportSourceSchema.shape.sourceRecordId.parse(member.sourceRecordId);
    if (seen.has(sourceRecordId))
      throw new ApiError(400, 'INVALID_INPUT', 'Source record IDs must be unique within a batch.');
    seen.add(sourceRecordId);
    const record = adapter.schema.parse(member.record);
    const destinationId = ImportSourceSchema.shape.destinationId.parse(adapter.destinationId(record));
    const sourceFingerprint = fingerprint(record);
    const previous = (await connection.select().from(importSources).where(and(
      eq(importSources.user_id, ownerId), eq(importSources.source_namespace, namespace),
      eq(importSources.record_type, adapter.recordType), eq(importSources.source_record_id, sourceRecordId),
    )).limit(1))[0];
    if (previous) {
      if (previous.source_fingerprint !== sourceFingerprint)
        throw new ApiError(409, 'SOURCE_CONFLICT', 'An imported source record changed. No records were imported.');
      outcomes.push({ sourceRecordId, destinationId: previous.destination_id, outcome: 'skipped' });
      continue;
    }
    const claimed = (await connection.select({ id: importSources.destination_id }).from(importSources)
      .where(and(eq(importSources.user_id, ownerId), eq(importSources.record_type, adapter.recordType),
        eq(importSources.destination_id, destinationId))).limit(1)).length > 0;
    if (claimed || await adapter.exists(connection, ownerId, record))
      throw new ApiError(409, 'DESTINATION_CONFLICT', 'An import destination is already occupied. No records were imported.');
    await adapter.create(connection, ownerId, record, current, position);
    await connection.insert(importSources).values({
      user_id: ownerId, source_namespace: namespace, record_type: adapter.recordType,
      source_record_id: sourceRecordId, source_fingerprint: sourceFingerprint,
      destination_id: destinationId, position: position(),
    });
    outcomes.push({ sourceRecordId, destinationId, outcome: 'created' });
  }
  return outcomes;
}
