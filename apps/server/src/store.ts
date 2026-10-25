import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { createQueries, type Database, type QueryConnection, type Transaction } from './queries.js';
import { mutationReceipts, workspaceState } from './schema.js';
import { z } from 'zod';
import { applyMutation, MutationSchema, SettingsSchema } from '@packages/workspace/mutations';
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

export const MAX_STATE_BYTES = 1_800_000;
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
    recipes: z.array(RecipeSchema).max(500),
    plan: z.array(PlanEntrySchema).max(4000),
    logs: z.array(FoodEntrySchema).max(10000),
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
      .refine((value) => Object.keys(value).length <= 4000, 'Too many grocery checkboxes.'),
    requests: z.array(RecipeRequestSchema).max(200),
    training: TrainingStateSchema,
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
  let serialized: string;
  try {
    serialized = JSON.stringify(rawState);
  } catch {
    throw new ApiError(400, 'INVALID_STATE', 'Choose a valid Corner JSON export.');
  }
  if (!serialized || Buffer.byteLength(serialized) > MAX_STATE_BYTES)
    throw new ApiError(413, 'STATE_TOO_LARGE', 'This workspace exceeds the supported import size.');
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
  return { state, counts, bytes: Buffer.byteLength(JSON.stringify(state)) };
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

export function isEmptyWorkspace(state: AppState): boolean {
  return (
    !state.recipes.length &&
    !state.plan.length &&
    !state.logs.length &&
    !state.requests.length &&
    !Object.keys(state.groceryChecks).length &&
    !state.training.templates.length &&
    !state.training.sessions.length &&
    !state.training.checkIns.length &&
    !state.training.requests.length &&
    !state.training.reviews.length &&
    !state.training.scheduledDates.length
  );
}

export class WorkspaceStore {
  readonly db: Database;

  constructor(pool: Pool) {
    this.db = createQueries(pool);
  }

  async read(
    userId: string,
    name?: string,
    connection: QueryConnection = this.db,
  ): Promise<WorkspaceSnapshot> {
    userSchema.parse(userId);
    const row = (
      await connection
        .select({ data: workspaceState.data, version: workspaceState.version })
        .from(workspaceState)
        .where(eq(workspaceState.user_id, userId))
    )[0];
    if (!row) return { state: createInitialState(name), revision: 0 };
    try {
      return {
        state: inspectImport(JSON.parse(row.data)).state,
        revision: revisionSchema.parse(row.version),
      };
    } catch {
      throw new ApiError(
        503,
        'STATE_UNAVAILABLE',
        'Your saved workspace could not be loaded. Restore a backup or try again.',
      );
    }
  }

  async mutate(
    userId: string,
    requestId: string,
    mutation: unknown,
    expectedRevision?: number,
  ): Promise<WorkspaceSnapshot> {
    return this.commit(
      userId,
      requestId,
      { kind: 'mutation', mutation, expectedRevision },
      expectedRevision,
      (current) => {
        const parsed = MutationSchema.parse(mutation) as Mutation;
        return this.apply(current.state, parsed);
      },
    );
  }

  /** onApplied uses the same transaction as the state and receipt. */
  async applyBatch(
    userId: string,
    requestId: string,
    mutations: Mutation[],
    expectedRevision: number,
    onApplied?: (connection: Transaction) => Promise<void>,
  ): Promise<WorkspaceSnapshot> {
    revisionSchema.parse(expectedRevision);
    const parsed = z.array(MutationSchema).min(1).max(200).parse(mutations) as Mutation[];
    return this.commit(
      userId,
      requestId,
      { kind: 'batch', mutations: parsed, expectedRevision },
      expectedRevision,
      (current) => {
        let next = current.state;
        for (const mutation of parsed) next = this.apply(next, mutation);
        return next;
      },
      onApplied,
    );
  }

  inspectImport(rawState: unknown) {
    return inspectImport(rawState);
  }

  async replaceImport(
    userId: string,
    requestId: string,
    rawState: unknown,
    expectedRevision: number,
  ): Promise<WorkspaceSnapshot> {
    revisionSchema.parse(expectedRevision);
    const imported = inspectImport(rawState).state;
    return this.commit(
      userId,
      requestId,
      { kind: 'import', state: imported, expectedRevision },
      expectedRevision,
      (current) => {
        if (!isEmptyWorkspace(current.state))
          throw new ApiError(
            409,
            'WORKSPACE_NOT_EMPTY',
            'Import into an empty account so your existing records are preserved.',
          );
        return imported;
      },
    );
  }

  private apply(state: AppState, mutation: Mutation): AppState {
    try {
      return applyMutation(state, mutation);
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof ApiError) throw error;
      // These messages are the domain's own bounded validation messages, never
      // database/provider exceptions or arbitrary caller-controlled fields.
      throw new ApiError(
        400,
        'INVALID_INPUT',
        error instanceof Error && error.message.length <= 300
          ? error.message
          : 'This change is not valid. Refresh and check the fields.',
      );
    }
  }

  private async commit(
    userId: string,
    requestId: string,
    payload: unknown,
    expectedRevision: number | undefined,
    update: (current: WorkspaceSnapshot) => AppState,
    onApplied?: (connection: Transaction) => Promise<void>,
  ): Promise<WorkspaceSnapshot> {
    userSchema.parse(userId);
    requestIdSchema.parse(requestId);
    if (expectedRevision !== undefined) revisionSchema.parse(expectedRevision);
    const hash = fingerprint(payload);
    return this.db.transaction(async (connection) => {
      // Also serializes the first mutation, when no workspace row exists yet.
      await connection.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
      const receipt = (
        await connection
          .select({ payload_hash: mutationReceipts.payload_hash })
          .from(mutationReceipts)
          .where(
            and(eq(mutationReceipts.user_id, userId), eq(mutationReceipts.request_id, requestId)),
          )
      )[0];
      if (receipt) {
        if (receipt.payload_hash !== hash)
          throw new ApiError(
            409,
            'REQUEST_ID_REUSED',
            'This request identifier was already used for a different change.',
          );
        const replay = await this.read(userId, undefined, connection);
        await onApplied?.(connection);
        return replay;
      }
      const current = await this.read(userId, undefined, connection);
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
      const next = inspectImport(update(current)).state;
      const revision = current.revision + 1;
      const now = new Date().toISOString();
      const data = JSON.stringify(next);
      await connection
        .insert(workspaceState)
        .values({
          user_id: userId,
          data,
          version: revision,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: workspaceState.user_id,
          set: { data, version: revision, updated_at: now },
        });
      await connection.insert(mutationReceipts).values({
        user_id: userId,
        request_id: requestId,
        payload_hash: hash,
        revision,
        created_at: now,
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
      return { state: next, revision };
    });
  }
}
