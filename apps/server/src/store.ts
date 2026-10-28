import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from './queries.js';
import { mutationReceipts, workspaceMetadata } from './schema.js';
import { z } from 'zod';
import { MutationSchema, SettingsSchema } from '@packages/workspace/mutations';
import {
  FoodEntrySchema,
  PlanEntrySchema,
  RecipeRequestSchema,
  RecipeSchema,
} from '@packages/nutrition/schemas';
import { createInitialState } from '@packages/workspace/initial-state';
import { createTrainingState, TrainingStateSchema } from '@packages/training/workouts';
import type { AppState, Mutation } from '@packages/workspace/types';
import { ApiError } from './http.js';
import { requestIdSchema, revisionSchema } from '@packages/api/schemas';
import type { Settings } from '@packages/workspace/types';
import type { FoodWindowInput } from '@packages/api/schemas';
import { executeEntityCommand } from './entity-commands.js';
import { readFoodWindow } from './food-records.js';
import {
  MAX_WORKSPACE_TRANSFER_BYTES,
  type CommandResult,
  type FoodWindow,
} from '@packages/api/workspace-data';
import { exportRelational, importRelational } from './workspace-portability.js';

export type WorkspaceSnapshot = { state: AppState; revision: number };
export type ImportCounts = {
  recipes: number;
  plannedMeals: number;
  foodEntries: number;
  workoutTemplates: number;
  workouts: number;
  checkIns: number;
  recipeRequests: number;
  trainingRequests: number;
  reviews: number;
};

const StateSchema = z
  .object({
    recipes: z.array(RecipeSchema).max(10000),
    plan: z.array(PlanEntrySchema).max(100000),
    logs: z.array(FoodEntrySchema).max(100000),
    settings: SettingsSchema,
    groceryChecks: z
      .record(
        z
          .string()
          .min(1)
          .max(500)
          .refine((key) => !['__proto__', 'prototype', 'constructor'].includes(key)),
        z.boolean(),
      )
      .refine((value) => Object.keys(value).length <= 100000, 'Too many grocery checkboxes.'),
    requests: z.array(RecipeRequestSchema).max(10000),
    training: TrainingStateSchema.extend({
      templates: z.array(TrainingStateSchema.shape.templates.element).max(10000),
      sessions: z.array(TrainingStateSchema.shape.sessions.element).max(100000),
      checkIns: z.array(TrainingStateSchema.shape.checkIns.element).max(100000),
      requests: z.array(TrainingStateSchema.shape.requests.element).max(10000),
      reviews: z.array(TrainingStateSchema.shape.reviews.element).max(10000),
      scheduledDates: z.array(TrainingStateSchema.shape.scheduledDates.element).max(100000),
    }),
  })
  .strict();

function uniqueIds(items: Array<{ id: string }>, collection: string): void {
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw new ApiError(400, 'INVALID_STATE', `${collection} contains duplicate item IDs.`);
}

/** Historical log links may outlive deleted recipes/plans; their snapshots remain authoritative. */
export function inspectImport(rawState: unknown): {
  state: AppState;
  counts: ImportCounts;
  bytes: number;
} {
  try {
    const serialized = JSON.stringify(rawState);
    if (!serialized || Buffer.byteLength(serialized) > MAX_WORKSPACE_TRANSFER_BYTES)
      throw new ApiError(
        413,
        'STATE_TOO_LARGE',
        'This workspace exceeds the supported import size.',
      );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'INVALID_STATE', 'Choose a valid Corner JSON export.');
  }
  if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState))
    throw new ApiError(400, 'INVALID_STATE', 'Choose a valid Corner JSON export.');
  const raw = rawState as Record<string, unknown>;
  let training = raw.training;
  if (training === undefined) training = createTrainingState();
  else if (
    training &&
    typeof training === 'object' &&
    !Array.isArray(training) &&
    !Object.hasOwn(training, 'scheduledDates')
  ) {
    const previous = training as Record<string, unknown>;
    training = {
      ...previous,
      scheduledDates: Array.isArray(previous.sessions)
        ? [...new Set(previous.sessions.map((session) => (session as { date?: unknown })?.date))]
        : [],
    };
  }
  const state = StateSchema.parse({ ...raw, training }) as AppState;
  uniqueIds(state.recipes, 'Recipes');
  uniqueIds(state.plan, 'Planned meals');
  uniqueIds(state.logs, 'Food entries');
  uniqueIds(state.requests, 'Recipe requests');
  uniqueIds(state.training.templates, 'Workout templates');
  uniqueIds(state.training.sessions, 'Workouts');
  uniqueIds(state.training.checkIns, 'Check-ins');
  uniqueIds(state.training.requests, 'Training requests');
  uniqueIds(state.training.reviews, 'Training reviews');
  if (new Set(state.training.scheduledDates).size !== state.training.scheduledDates.length)
    throw new ApiError(400, 'INVALID_STATE', 'Scheduled dates must be unique.');
  const recipes = new Set(state.recipes.map((recipe) => recipe.id));
  if (state.plan.some((entry) => !recipes.has(entry.recipeId)))
    throw new ApiError(
      400,
      'INVALID_STATE',
      'Every planned meal must reference a recipe in this export.',
    );
  const loggedPlans = state.logs.flatMap((entry) => (entry.planEntryId ? [entry.planEntryId] : []));
  if (new Set(loggedPlans).size !== loggedPlans.length)
    throw new ApiError(
      400,
      'INVALID_STATE',
      'A planned meal can appear in the food log only once.',
    );
  // An applied review or saved historical request can refer to a subsequently
  // removed session. Preserve those references instead of fabricating records.
  const counts: ImportCounts = {
    recipes: state.recipes.length,
    plannedMeals: state.plan.length,
    foodEntries: state.logs.length,
    workoutTemplates: state.training.templates.length,
    workouts: state.training.sessions.length,
    checkIns: state.training.checkIns.length,
    recipeRequests: state.requests.length,
    trainingRequests: state.training.requests.length,
    reviews: state.training.reviews.length,
  };
  const bytes = Buffer.byteLength(JSON.stringify(state));
  if (bytes > MAX_WORKSPACE_TRANSFER_BYTES)
    throw new ApiError(413, 'STATE_TOO_LARGE', 'This workspace exceeds the supported import size.');
  return { state, counts, bytes };
}

function canonical(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object') return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
const userSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\u0000\r\n]/.test(value));

export type WorkspaceBootstrap = { settings: Settings; revision: number };

export class WorkspaceStore {
  readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  async bootstrap(userId: string, name?: string): Promise<WorkspaceBootstrap> {
    userSchema.parse(userId);
    const { settings, revision } = await this.metadata(this.db, userId, name);
    return { settings, revision };
  }

  private async metadata(connection: Database, userId: string, name?: string) {
    const row = (
      await connection
        .select()
        .from(workspaceMetadata)
        .where(eq(workspaceMetadata.user_id, userId))
        .limit(1)
    )[0];
    return row
      ? {
          settings: SettingsSchema.parse({ ...row.settings, timezone: row.timezone }),
          revision: revisionSchema.parse(row.revision),
          nextPosition: row.next_position,
        }
      : { settings: createInitialState(name).settings, revision: 0, nextPosition: 0 };
  }

  async foodWindow(userId: string, input: FoodWindowInput): Promise<FoodWindow> {
    userSchema.parse(userId);
    return this.db.transaction(
      async (connection) => {
        const { revision } = await this.metadata(connection, userId);
        return readFoodWindow(connection, userId, input, revision);
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async mutate(
    userId: string,
    requestId: string,
    mutation: unknown,
    expectedRevision?: number,
    name?: string,
  ): Promise<CommandResult> {
    return this.commit(
      userId,
      requestId,
      { kind: 'mutation', mutation, expectedRevision },
      expectedRevision,
      (connection, current, position) =>
        executeEntityCommand(
          connection,
          userId,
          MutationSchema.parse(mutation),
          current.settings,
          position,
        ),
      undefined,
      name,
    );
  }

  async applyBatch(
    userId: string,
    requestId: string,
    mutations: Mutation[],
    expectedRevision: number,
    onApplied?: (connection: Transaction) => Promise<void>,
  ): Promise<CommandResult> {
    return this.commit(
      userId,
      requestId,
      { kind: 'batch', mutations, expectedRevision },
      expectedRevision,
      async (connection, current, position) => {
        const parsed = z.array(MutationSchema).min(1).max(200).parse(mutations);
        let settings = current.settings;
        for (const command of parsed)
          settings = await executeEntityCommand(connection, userId, command, settings, position);
        return settings;
      },
      onApplied,
    );
  }

  inspectImport(rawState: unknown) {
    return inspectImport(rawState);
  }

  async isEmpty(userId: string, connection: Database = this.db): Promise<boolean> {
    userSchema.parse(userId);
    const result = await connection.execute(sql`SELECT NOT (
      EXISTS (SELECT 1 FROM workspace_recipes WHERE user_id = ${userId}) OR
      EXISTS (SELECT 1 FROM workspace_planned_meals WHERE user_id = ${userId}) OR
      EXISTS (SELECT 1 FROM workspace_food_entries WHERE user_id = ${userId}) OR
      EXISTS (SELECT 1 FROM workspace_grocery_checks WHERE user_id = ${userId}) OR
      EXISTS (SELECT 1 FROM workspace_recipe_requests WHERE user_id = ${userId}) OR
      EXISTS (SELECT 1 FROM workspace_workout_templates WHERE user_id = ${userId}) OR
      EXISTS (SELECT 1 FROM workspace_workout_sessions WHERE user_id = ${userId}) OR
      EXISTS (SELECT 1 FROM workspace_check_ins WHERE user_id = ${userId}) OR
      EXISTS (SELECT 1 FROM workspace_training_requests WHERE user_id = ${userId}) OR
      EXISTS (SELECT 1 FROM workspace_training_reviews WHERE user_id = ${userId}) OR
      EXISTS (SELECT 1 FROM workspace_scheduled_dates WHERE user_id = ${userId})
    ) AS empty`);
    return result.rows[0]?.empty === true;
  }

  async importPreview(userId: string, rawState: unknown) {
    const inspected = inspectImport(rawState);
    return this.db.transaction(
      async (connection) => ({
        summary: { ...inspected.counts, bytes: inspected.bytes },
        canImport: await this.isEmpty(userId, connection),
        revision: (await this.metadata(connection, userId)).revision,
      }),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async replaceImport(
    userId: string,
    requestId: string,
    rawState: unknown,
    expectedRevision: number,
  ): Promise<CommandResult> {
    return this.commit(
      userId,
      requestId,
      { kind: 'import', state: rawState, expectedRevision },
      expectedRevision,
      async (connection, _current, position) => {
        const imported = inspectImport(rawState).state;
        if (!(await this.isEmpty(userId, connection)))
          throw new ApiError(
            409,
            'WORKSPACE_NOT_EMPTY',
            'Import into an empty account so your existing records are preserved.',
          );
        await importRelational(connection, userId, imported, position);
        return imported.settings;
      },
    );
  }

  /** Full portability snapshots are explicit and never used by routine commands. */
  async exportSnapshot(userId: string, name?: string): Promise<WorkspaceSnapshot> {
    userSchema.parse(userId);
    return this.db.transaction(
      async (connection) => {
        const metadata = await this.metadata(connection, userId, name);
        const state = await exportRelational(connection, userId, metadata.settings);
        inspectImport(state);
        return { state, revision: metadata.revision };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  private async commit(
    userId: string,
    requestId: string,
    payload: unknown,
    expectedRevision: number | undefined,
    update: (
      connection: Transaction,
      current: WorkspaceBootstrap,
      position: () => number,
    ) => Promise<Settings>,
    onApplied?: (connection: Transaction) => Promise<void>,
    name?: string,
  ): Promise<CommandResult> {
    userSchema.parse(userId);
    requestIdSchema.parse(requestId);
    if (expectedRevision !== undefined) revisionSchema.parse(expectedRevision);
    const hash = fingerprint(payload);
    return this.db.transaction(async (connection) => {
      await connection.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
      const receipt = (
        await connection
          .select({ payload_hash: mutationReceipts.payload_hash })
          .from(mutationReceipts)
          .where(
            and(eq(mutationReceipts.user_id, userId), eq(mutationReceipts.request_id, requestId)),
          )
          .limit(1)
      )[0];
      const current = await this.metadata(connection, userId, name);
      if (receipt) {
        if (receipt.payload_hash !== hash)
          throw new ApiError(
            409,
            'REQUEST_ID_REUSED',
            'This request identifier was already used for a different change.',
          );
        await onApplied?.(connection);
        return { revision: current.revision };
      }
      if (expectedRevision !== undefined && current.revision !== expectedRevision)
        throw new ApiError(
          409,
          'REVISION_CONFLICT',
          'Your workspace changed. Refresh and review this change again.',
        );
      if (current.revision >= Number.MAX_SAFE_INTEGER)
        throw new ApiError(
          409,
          'WORKSPACE_LIMIT',
          'This workspace cannot accept further revisions.',
        );
      const { timezone: initialTimezone, ...initialSettings } = current.settings;
      await connection
        .insert(workspaceMetadata)
        .values({
          user_id: userId,
          revision: current.revision,
          next_position: current.nextPosition,
          timezone: initialTimezone,
          settings: initialSettings,
        })
        .onConflictDoNothing();
      let nextPosition = current.nextPosition;
      const position = () => {
        if (nextPosition >= Number.MAX_SAFE_INTEGER)
          throw new ApiError(
            409,
            'WORKSPACE_LIMIT',
            'This workspace cannot accept further records.',
          );
        return nextPosition++;
      };
      let settings: Settings;
      try {
        settings = await update(connection, current, position);
      } catch (error) {
        if (error instanceof z.ZodError || error instanceof ApiError) throw error;
        if (error instanceof Error && !('code' in error) && error.message.length <= 300)
          throw new ApiError(400, 'INVALID_INPUT', error.message);
        throw error;
      }
      const revision = current.revision + 1;
      const { timezone, ...preferences } = settings;
      await connection
        .update(workspaceMetadata)
        .set({
          revision,
          next_position: nextPosition,
          timezone,
          settings: preferences,
        })
        .where(eq(workspaceMetadata.user_id, userId));
      await connection.insert(mutationReceipts).values({
        user_id: userId,
        request_id: requestId,
        payload_hash: hash,
        revision,
        created_at: new Date().toISOString(),
      });
      await connection
        .delete(mutationReceipts)
        .where(
          and(
            eq(mutationReceipts.user_id, userId),
            inArray(
              mutationReceipts.request_id,
              connection
                .select({ request_id: mutationReceipts.request_id })
                .from(mutationReceipts)
                .where(eq(mutationReceipts.user_id, userId))
                .orderBy(desc(mutationReceipts.revision))
                .offset(1000),
            ),
          ),
        );
      await onApplied?.(connection);
      return { revision };
    });
  }
}
