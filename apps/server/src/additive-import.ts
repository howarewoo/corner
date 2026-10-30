import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ImportSourceSchema, ImportDestinationSchema, GroceryKeySchema } from '@packages/workspace/mutations';
import type { ImportSource } from '@packages/workspace/types';
import { WorkoutSessionSchema, WorkoutTemplateSchema, TrainingCheckInSchema, TrainingDateSchema } from '@packages/training/workouts';
import { RecipeSchema, PlanEntrySchema, FoodEntrySchema } from '@packages/nutrition/schemas';
import type { WorkoutSession } from '@packages/training/types';
import type { Transaction } from './queries.js';
import type { WorkspaceBootstrap } from './store.js';
import { fingerprint } from './fingerprint.js';
import { importSources, workoutSessions, workoutTemplates, recipes, plannedMeals, foodEntries, checkIns, scheduledDates, groceryChecks } from './schema.js';
import { saveSession, saveTemplate, saveCheckIn } from './training-records.js';
import { saveRecipe, savePlan } from './nutrition-records.js';
import { writeFoodRecord } from './food-records.js';
import { ApiError } from './http.js';

export const MAX_IMPORT_RECORDS = 100;
// Enough for full native workouts including all 25 exercises × 30 sets; batches may
// hit this finite UTF-8 ceiling before the count ceiling and must then be split.
export const MAX_MCP_REQUEST_BYTES = 2 * 1024 * 1024;
export const ImportOutcomeSchema = z.object({
  sourceRecordId: ImportSourceSchema.shape.sourceRecordId,
  destinationId: ImportDestinationSchema,
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

export type WorkoutSource = Omit<WorkoutSession, 'createdAt' | 'updatedAt'>;
export const workoutSourceSchema = z.object(WorkoutSessionSchema.shape)
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
  });
export const workoutImportAdapter: ImportAdapter<WorkoutSource> = {
  recordType: 'workouts',
  schema: workoutSourceSchema,
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

export const routineSourceSchema = z.object(WorkoutTemplateSchema.shape)
  .omit({ createdAt: true, updatedAt: true }).strict().superRefine((record, context) => {
    const now = '2000-01-01T00:00:00.000Z';
    const result = WorkoutTemplateSchema.safeParse({ ...record, createdAt: now, updatedAt: now });
    if (!result.success) for (const issue of result.error.issues)
      context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  });
export const recipeSourceSchema = RecipeSchema.omit({ createdAt: true }).extend({
  nutrition: RecipeSchema.shape.nutrition.strict(),
  ingredients: RecipeSchema.shape.ingredients.element.strict().array().min(1).max(60),
}).strict();
export const foodLogSourceSchema = FoodEntrySchema.omit({ createdAt: true }).extend({
  nutrition: FoodEntrySchema.shape.nutrition.strict(),
}).strict();
export const scheduledDateSourceSchema = z.object({ date: TrainingDateSchema }).strict();
export const groceryCheckSourceSchema = z.object({ key: GroceryKeySchema, checked: z.boolean() }).strict();

export const routineImportAdapter: ImportAdapter<z.infer<typeof routineSourceSchema>> = {
  recordType: 'routines', schema: routineSourceSchema, destinationId: (record) => record.id,
  async exists(connection, ownerId, record) {
    return (await connection.select({ id: workoutTemplates.id }).from(workoutTemplates)
      .where(and(eq(workoutTemplates.user_id, ownerId), eq(workoutTemplates.id, record.id))).limit(1)).length > 0;
  },
  async create(connection, ownerId, record, _current, position) {
    const now = new Date().toISOString();
    await saveTemplate(connection, ownerId, { ...record, createdAt: now, updatedAt: now }, position());
  },
};
export const recipeImportAdapter: ImportAdapter<z.infer<typeof recipeSourceSchema>> = {
  recordType: 'recipes', schema: recipeSourceSchema, destinationId: (record) => record.id,
  async exists(connection, ownerId, record) {
    return (await connection.select({ id: recipes.id }).from(recipes)
      .where(and(eq(recipes.user_id, ownerId), eq(recipes.id, record.id))).limit(1)).length > 0;
  },
  async create(connection, ownerId, record, _current, position) {
    await saveRecipe(connection, ownerId, { ...record, createdAt: new Date().toISOString() }, position());
  },
};
export const mealPlanImportAdapter: ImportAdapter<z.infer<typeof PlanEntrySchema>> = {
  recordType: 'meal-plans', schema: PlanEntrySchema.strict(), destinationId: (record) => record.id,
  async exists(connection, ownerId, record) {
    return (await connection.select({ id: plannedMeals.id }).from(plannedMeals)
      .where(and(eq(plannedMeals.user_id, ownerId), eq(plannedMeals.id, record.id))).limit(1)).length > 0;
  },
  async create(connection, ownerId, record, _current, position) {
    const parent = await connection.select({ id: recipes.id }).from(recipes)
      .where(and(eq(recipes.user_id, ownerId), eq(recipes.id, record.recipeId))).limit(1);
    if (!parent.length) throw new ApiError(400, 'INVALID_INPUT', 'Import the owner recipe before its dated meal plan.');
    await savePlan(connection, ownerId, record, position());
  },
};
export const foodLogImportAdapter: ImportAdapter<z.infer<typeof foodLogSourceSchema>> = {
  recordType: 'food-logs', schema: foodLogSourceSchema, destinationId: (record) => record.id,
  async exists(connection, ownerId, record) {
    return (await connection.select({ id: foodEntries.id }).from(foodEntries)
      .where(and(eq(foodEntries.user_id, ownerId), eq(foodEntries.id, record.id))).limit(1)).length > 0;
  },
  async create(connection, ownerId, record, _current, position) {
    if (record.planEntryId) {
      const duplicate = await connection.select({ id: foodEntries.id }).from(foodEntries)
        .where(and(eq(foodEntries.user_id, ownerId), eq(foodEntries.plan_entry_id, record.planEntryId))).limit(1);
      if (duplicate.length) throw new ApiError(409, 'DESTINATION_CONFLICT', 'That meal plan already has a food log.');
    }
    await writeFoodRecord(connection, ownerId, { ...record, createdAt: new Date().toISOString() }, position());
  },
};
export const checkInImportAdapter: ImportAdapter<z.infer<typeof TrainingCheckInSchema>> = {
  recordType: 'check-ins', schema: TrainingCheckInSchema, destinationId: (record) => record.id,
  async exists(connection, ownerId, record) {
    return (await connection.select({ id: checkIns.id }).from(checkIns)
      .where(and(eq(checkIns.user_id, ownerId), eq(checkIns.id, record.id))).limit(1)).length > 0;
  },
  async create(connection, ownerId, record, _current, position) {
    await saveCheckIn(connection, ownerId, record, position());
  },
};
export const scheduledDateImportAdapter: ImportAdapter<z.infer<typeof scheduledDateSourceSchema>> = {
  recordType: 'scheduled-dates', schema: scheduledDateSourceSchema, destinationId: (record) => record.date,
  async exists(connection, ownerId, record) {
    return (await connection.select({ date: scheduledDates.date }).from(scheduledDates)
      .where(and(eq(scheduledDates.user_id, ownerId), eq(scheduledDates.date, record.date))).limit(1)).length > 0;
  },
  async create(connection, ownerId, record, _current, position) {
    await connection.insert(scheduledDates).values({ user_id: ownerId, date: record.date, position: position() });
  },
};
export const groceryCheckImportAdapter: ImportAdapter<z.infer<typeof groceryCheckSourceSchema>> = {
  recordType: 'grocery-checks', schema: groceryCheckSourceSchema, destinationId: (record) => record.key,
  async exists(connection, ownerId, record) {
    return (await connection.select({ key: groceryChecks.key }).from(groceryChecks)
      .where(and(eq(groceryChecks.user_id, ownerId), eq(groceryChecks.key, record.key))).limit(1)).length > 0;
  },
  async create(connection, ownerId, record, _current, position) {
    await connection.insert(groceryChecks).values({ user_id: ownerId, ...record, position: position() });
  },
};

const importCollections = {
  workouts: ['workspace_workout_sessions', 100000],
  routines: ['workspace_workout_templates', 10000],
  recipes: ['workspace_recipes', 10000],
  'meal-plans': ['workspace_planned_meals', 100000],
  'food-logs': ['workspace_food_entries', 100000],
  'check-ins': ['workspace_check_ins', 100000],
  'scheduled-dates': ['workspace_scheduled_dates', 100000],
  'grocery-checks': ['workspace_grocery_checks', 100000],
} as const;

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
  let collectionSize: number | undefined;
  const seen = new Set<string>();
  for (const member of records) {
    const sourceRecordId = ImportSourceSchema.shape.sourceRecordId.parse(member.sourceRecordId);
    if (seen.has(sourceRecordId))
      throw new ApiError(400, 'INVALID_INPUT', 'Source record IDs must be unique within a batch.');
    seen.add(sourceRecordId);
    const record = adapter.schema.parse(member.record);
    const destinationId = adapter.destinationId(record);
    const sourceFingerprint = fingerprint(record);
    ImportSourceSchema.parse({ sourceNamespace: namespace, recordType: adapter.recordType,
      sourceRecordId, sourceFingerprint, destinationId });
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
    const [table, limit] = importCollections[adapter.recordType];
    if (collectionSize === undefined) {
      const count = await connection.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE user_id = ${ownerId}`);
      collectionSize = Number(count.rows[0]?.n);
    }
    if (collectionSize >= limit)
      throw new ApiError(409, 'WORKSPACE_LIMIT', 'This collection is full. No records were imported.');
    await adapter.create(connection, ownerId, record, current, position);
    collectionSize++;
    await connection.insert(importSources).values({
      user_id: ownerId, source_namespace: namespace, record_type: adapter.recordType,
      source_record_id: sourceRecordId, source_fingerprint: sourceFingerprint,
      destination_id: destinationId, position: position(),
    });
    outcomes.push({ sourceRecordId, destinationId, outcome: 'created' });
  }
  return outcomes;
}
