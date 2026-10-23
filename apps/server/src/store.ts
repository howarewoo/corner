import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { applyMutation, FoodEntrySchema, MutationSchema, PlanEntrySchema, RecipeRequestSchema, RecipeSchema, SettingsSchema } from '@corner/shared/domain';
import { createInitialState } from '@corner/shared/seed';
import { TrainingStateSchema } from '@corner/shared/training';
import type { AppState, Mutation } from '@corner/shared/types';
import { ApiError, requestIdSchema, revisionSchema } from './http.js';

export const MAX_STATE_BYTES = 1_800_000;
export type WorkspaceSnapshot = { state: AppState; revision: number };
export type ImportCounts = {
  recipes: number; plannedMeals: number; foodEntries: number; workoutTemplates: number;
  workouts: number; checkIns: number; recipeRequests: number; trainingRequests: number; reviews: number;
};

const StateSchema = z.object({
  recipes: z.array(RecipeSchema).max(500),
  plan: z.array(PlanEntrySchema).max(4000),
  logs: z.array(FoodEntrySchema).max(10000),
  settings: SettingsSchema,
  groceryChecks: z.record(z.string().min(1).max(500).refine(key => !['__proto__', 'prototype', 'constructor'].includes(key)), z.boolean()).refine(value => Object.keys(value).length <= 4000, 'Too many grocery checkboxes.'),
  requests: z.array(RecipeRequestSchema).max(200),
  training: TrainingStateSchema,
}).strict();

const emptyTraining = () => ({ templates: [], sessions: [], checkIns: [], requests: [], reviews: [], scheduledDates: [] });

function uniqueIds(items: Array<{ id: string }>, collection: string): void {
  if (new Set(items.map(item => item.id)).size !== items.length) throw new ApiError(400, 'INVALID_STATE', `${collection} contains duplicate item IDs.`);
}

/** Historical log links may outlive deleted recipes/plans; their snapshots remain authoritative. */
export function inspectImport(rawState: unknown): { state: AppState; counts: ImportCounts; bytes: number } {
  let serialized: string;
  try { serialized = JSON.stringify(rawState); }
  catch { throw new ApiError(400, 'INVALID_STATE', 'Choose a valid Corner JSON export.'); }
  if (!serialized || Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw new ApiError(413, 'STATE_TOO_LARGE', 'This workspace exceeds the supported import size.');
  if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) throw new ApiError(400, 'INVALID_STATE', 'Choose a valid Corner JSON export.');
  const raw = rawState as Record<string, unknown>;
  let training = raw.training;
  if (training === undefined) training = emptyTraining();
  else if (training && typeof training === 'object' && !Array.isArray(training) && !Object.hasOwn(training, 'scheduledDates')) {
    const previous = training as Record<string, unknown>;
    training = { ...previous, scheduledDates: Array.isArray(previous.sessions) ? [...new Set(previous.sessions.map(session => (session as { date?: unknown })?.date))] : [] };
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
  if (new Set(state.training.scheduledDates).size !== state.training.scheduledDates.length) throw new ApiError(400, 'INVALID_STATE', 'Scheduled dates must be unique.');
  const recipes = new Set(state.recipes.map(recipe => recipe.id));
  if (state.plan.some(entry => !recipes.has(entry.recipeId))) throw new ApiError(400, 'INVALID_STATE', 'Every planned meal must reference a recipe in this export.');
  const loggedPlans = state.logs.flatMap(entry => entry.planEntryId ? [entry.planEntryId] : []);
  if (new Set(loggedPlans).size !== loggedPlans.length) throw new ApiError(400, 'INVALID_STATE', 'A planned meal can appear in the food log only once.');
  // An applied review or saved historical request can refer to a subsequently
  // removed session. Preserve those references instead of fabricating records.
  const counts: ImportCounts = {
    recipes: state.recipes.length, plannedMeals: state.plan.length, foodEntries: state.logs.length,
    workoutTemplates: state.training.templates.length, workouts: state.training.sessions.length,
    checkIns: state.training.checkIns.length, recipeRequests: state.requests.length,
    trainingRequests: state.training.requests.length, reviews: state.training.reviews.length,
  };
  return { state, counts, bytes: Buffer.byteLength(JSON.stringify(state)) };
}

function canonical(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object') return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function fingerprint(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
const userSchema = z.string().min(1).max(256).refine(value => !/[\u0000\r\n]/.test(value));

export function isEmptyWorkspace(state: AppState): boolean {
  return !state.recipes.length && !state.plan.length && !state.logs.length && !state.requests.length
    && !Object.keys(state.groceryChecks).length && !state.training.templates.length
    && !state.training.sessions.length && !state.training.checkIns.length && !state.training.requests.length
    && !state.training.reviews.length && !state.training.scheduledDates.length;
}

export class WorkspaceStore {
  constructor(public readonly db: Pool) {}

  async read(userId: string, name?: string, connection: Pool | PoolClient = this.db): Promise<WorkspaceSnapshot> {
    userSchema.parse(userId);
    const row = (await connection.query('SELECT data, version FROM workspace_state WHERE user_id = $1', [userId])).rows[0] as { data: string; version: number } | undefined;
    if (!row) return { state: createInitialState(name), revision: 0 };
    try { return { state: inspectImport(JSON.parse(row.data)).state, revision: revisionSchema.parse(row.version) }; }
    catch { throw new ApiError(503, 'STATE_UNAVAILABLE', 'Your saved workspace could not be loaded. Restore a backup or try again.'); }
  }

  async mutate(userId: string, requestId: string, mutation: unknown, expectedRevision?: number): Promise<WorkspaceSnapshot> {
    return this.commit(userId, requestId, { kind: 'mutation', mutation, expectedRevision }, expectedRevision, current => {
      const parsed = MutationSchema.parse(mutation) as Mutation;
      return this.apply(current.state, parsed);
    });
  }

  /** onApplied uses the same transaction as the state and receipt. */
  async applyBatch(userId: string, requestId: string, mutations: Mutation[], expectedRevision: number, onApplied?: (connection: PoolClient) => Promise<void>): Promise<WorkspaceSnapshot> {
    revisionSchema.parse(expectedRevision);
    const parsed = z.array(MutationSchema).min(1).max(200).parse(mutations) as Mutation[];
    return this.commit(userId, requestId, { kind: 'batch', mutations: parsed, expectedRevision }, expectedRevision, current => {
      let next = current.state;
      for (const mutation of parsed) next = this.apply(next, mutation);
      return next;
    }, onApplied);
  }

  inspectImport(rawState: unknown) { return inspectImport(rawState); }

  async replaceImport(userId: string, requestId: string, rawState: unknown, expectedRevision: number): Promise<WorkspaceSnapshot> {
    revisionSchema.parse(expectedRevision);
    const imported = inspectImport(rawState).state;
    return this.commit(userId, requestId, { kind: 'import', state: imported, expectedRevision }, expectedRevision, current => {
      if (!isEmptyWorkspace(current.state)) throw new ApiError(409, 'WORKSPACE_NOT_EMPTY', 'Import into an empty account so your existing records are preserved.');
      return imported;
    });
  }

  private apply(state: AppState, mutation: Mutation): AppState {
    try { return applyMutation(state, mutation); }
    catch (error) {
      if (error instanceof z.ZodError || error instanceof ApiError) throw error;
      // These messages are the domain's own bounded validation messages, never
      // database/provider exceptions or arbitrary caller-controlled fields.
      throw new ApiError(400, 'INVALID_INPUT', error instanceof Error && error.message.length <= 300 ? error.message : 'This change is not valid. Refresh and check the fields.');
    }
  }

  private async commit(userId: string, requestId: string, payload: unknown, expectedRevision: number | undefined, update: (current: WorkspaceSnapshot) => AppState, onApplied?: (connection: PoolClient) => Promise<void>): Promise<WorkspaceSnapshot> {
    userSchema.parse(userId);
    requestIdSchema.parse(requestId);
    if (expectedRevision !== undefined) revisionSchema.parse(expectedRevision);
    const hash = fingerprint(payload);
    const connection = await this.db.connect();
    try {
      await connection.query('BEGIN');
      // Also serializes the first mutation, when no workspace row exists yet.
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [userId]);
      const receipt = (await connection.query('SELECT payload_hash FROM mutation_receipts WHERE user_id = $1 AND request_id = $2', [userId, requestId])).rows[0] as { payload_hash: string } | undefined;
      if (receipt) {
        if (receipt.payload_hash !== hash) throw new ApiError(409, 'REQUEST_ID_REUSED', 'This request identifier was already used for a different change.');
        const replay = await this.read(userId, undefined, connection);
        await onApplied?.(connection);
        await connection.query('COMMIT');
        return replay;
      }
      const current = await this.read(userId, undefined, connection);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new ApiError(409, 'REVISION_CONFLICT', 'Your workspace changed. Refresh and review this change again.');
      if (current.revision >= Number.MAX_SAFE_INTEGER) throw new ApiError(409, 'WORKSPACE_LIMIT', 'This workspace cannot accept further revisions.');
      const next = inspectImport(update(current)).state;
      const revision = current.revision + 1;
      const now = new Date().toISOString();
      await connection.query('INSERT INTO workspace_state (user_id, data, version, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, version = excluded.version, updated_at = excluded.updated_at', [userId, JSON.stringify(next), revision, now]);
      await connection.query('INSERT INTO mutation_receipts (user_id, request_id, payload_hash, revision, created_at) VALUES ($1, $2, $3, $4, $5)', [userId, requestId, hash, revision, now]);
      await connection.query('DELETE FROM mutation_receipts WHERE user_id = $1 AND request_id IN (SELECT request_id FROM mutation_receipts WHERE user_id = $1 ORDER BY revision DESC OFFSET 1000)', [userId]);
      await onApplied?.(connection);
      await connection.query('COMMIT');
      return { state: next, revision };
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
}
