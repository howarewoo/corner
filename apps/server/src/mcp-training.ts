import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { requestIdSchema, revisionSchema } from '@packages/api/schemas';
import { ExerciseTargetSchema, WorkoutSessionSchema, WorkoutTemplateSchema, hasRecordedData } from '@packages/training/workouts';
import type { DelegatedAccess } from './delegation.js';
import type { WorkspaceBootstrap, WorkspaceStore } from './store.js';
import type { Transaction } from './queries.js';
import type { OriginalToolArguments } from './mcp-writes.js';
import { ApiError } from './http.js';
import { workoutSessions, workoutTemplates } from './schema.js';
import { sessionRecords, templateRecord } from './training-records.js';
import { executeEntityCommand } from './entity-commands.js';

const guard = { operationId: requestIdSchema, expectedRevision: revisionSchema };
const sessionFields = WorkoutSessionSchema.shape;
const routineFields = WorkoutTemplateSchema.shape;
const routine = z.object({ name: routineFields.name, kind: routineFields.kind, description: routineFields.description,
  durationMinutes: routineFields.durationMinutes, exercises: routineFields.exercises }).strict();
const planned = z.object({ date: sessionFields.date, name: sessionFields.name, kind: sessionFields.kind,
  unit: sessionFields.unit, exercises: z.array(ExerciseTargetSchema).max(25), plannedMinutes: sessionFields.plannedMinutes,
  notes: sessionFields.notes, changeReason: sessionFields.changeReason }).strict();
const history = z.object(WorkoutSessionSchema.shape).omit({ id: true, status: true, createdAt: true, updatedAt: true, templateId: true }).partial().strict();
const nonempty = <T extends Record<string, unknown>>(patch: T) => Object.keys(patch).length > 0;
const version = sessionFields.updatedAt;
const createRoutine = z.object({ ...guard, routine: routine.extend({ id: routineFields.id }) }).strict();
const updateRoutine = z.object({ ...guard, id: routineFields.id, patch: routine.partial().refine(nonempty, 'Supply at least one changed field.') }).strict();
const plans = z.object({ ...guard, changes: z.array(z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), entry: planned.extend({ id: sessionFields.id }) }).strict(),
  z.object({ action: z.literal('update'), id: sessionFields.id, expectedUpdatedAt: version,
    patch: planned.partial().refine(nonempty, 'Supply at least one changed field.') }).strict(),
])).min(1).max(100) }).strict();
const historyUpdate = z.object({ ...guard, id: sessionFields.id, expectedUpdatedAt: version,
  patch: history.refine(nonempty, 'Supply at least one changed field.') }).strict();

/** Patches replace supplied collections wholesale; omitted fields are retained under the owner lock. */
export function registerTrainingWrites(server: McpServer, store: WorkspaceStore, access: DelegatedAccess, original: OriginalToolArguments): void {
  function register<S extends z.ZodRawShape>(name: string, scope: string, inputSchema: z.ZodObject<S, z.core.$strict>, description: string,
    update: (input: z.output<z.ZodObject<S, z.core.$strict>>, connection: Transaction, current: WorkspaceBootstrap, position: () => number) => Promise<void>): void {
    if (!access.scopes.includes(scope)) return;
    server.registerTool<z.ZodRawShape, z.ZodObject<S, z.core.$strict>>(name, { description: description + ' Requires operationId and expectedRevision; exact retries return the committed revision only. Collections replace wholesale; omitted patch fields remain unchanged.', inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: name !== 'create_routine', idempotentHint: true, openWorldHint: false } }, async (input) => {
      try {
        const guarded = z.object(guard).parse(input);
        const result = await store.delegatedWrite(access, scope, name, original(name), guarded.operationId, guarded.expectedRevision,
          (connection, current, position) => update(input, connection, current, position));
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        const result = error instanceof ApiError ? { code: error.code, error: error.message }
          : error instanceof z.ZodError ? { code: 'INVALID_INPUT', error: 'Check the fields and try again.' }
          : { code: 'WRITE_FAILED', error: 'This change could not be completed.' };
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
      }
    });
  }
  register('create_routine', 'routines:write', createRoutine, 'Create an explicitly supplied routine; rejects existing IDs. Does not copy or rewrite workout snapshots.', async (input, connection, current, position) => {
    const row = (await connection.select().from(workoutTemplates).where(and(eq(workoutTemplates.user_id, access.ownerId), eq(workoutTemplates.id, input.routine.id))).limit(1))[0];
    if (row) throw new ApiError(409, 'ALREADY_EXISTS', 'That routine already exists.');
    const now = new Date().toISOString();
    await executeEntityCommand(connection, access.ownerId, { type: 'training.template.save', data: WorkoutTemplateSchema.parse({ ...input.routine, createdAt: now, updatedAt: now }) }, current.settings, position);
  });
  register('update_routine', 'routines:write', updateRoutine, 'Patch an existing routine only. Scheduled and recorded workout snapshots are not changed.', async (input, connection, current, position) => {
    const row = (await connection.select().from(workoutTemplates).where(and(eq(workoutTemplates.user_id, access.ownerId), eq(workoutTemplates.id, input.id))).limit(1))[0];
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'That routine no longer exists.');
    const existing = templateRecord(row);
    const updatedAt = new Date(Math.max(Date.now(), Date.parse(existing.updatedAt) + 1)).toISOString();
    await executeEntityCommand(connection, access.ownerId, { type: 'training.template.save', data: WorkoutTemplateSchema.parse({ ...existing, ...input.patch, updatedAt }) }, current.settings, position);
  });
  register('edit_workout_plans', 'workout-plans:write', plans, 'Atomically create or patch up to 100 scheduled workouts using explicit planned fields, never routine contents. Refuses started or recorded activity. Updates require the actual expectedUpdatedAt token.', async (input, connection, current, position) => {
    const ids = new Set<string>();
    for (const change of input.changes) {
      const id = change.action === 'create' ? change.entry.id : change.id;
      if (ids.has(id)) throw new ApiError(400, 'INVALID_INPUT', 'A workout ID may appear only once per batch.');
      ids.add(id);
      const rows = await connection.select().from(workoutSessions).where(and(eq(workoutSessions.user_id, access.ownerId), eq(workoutSessions.id, id))).limit(1);
      const existing = (await sessionRecords(connection, access.ownerId, rows))[0];
      if (change.action === 'create' && existing) throw new ApiError(409, 'ALREADY_EXISTS', 'That workout already exists.');
      if (change.action === 'update' && !existing) throw new ApiError(404, 'NOT_FOUND', 'That workout no longer exists.');
      if (existing && (existing.status !== 'planned' || hasRecordedData(existing) || existing.readiness !== null))
        throw new ApiError(409, 'HISTORY_PROTECTED', 'Use the separately granted history correction tool for started or recorded workouts.');
      if (change.action === 'update' && existing!.updatedAt !== change.expectedUpdatedAt)
        throw new ApiError(409, 'RECORD_CONFLICT', 'This workout changed. Read its latest version before saving.');
      const fields = change.action === 'create' ? change.entry : change.patch;
      const now = new Date().toISOString();
      const base = change.action === 'update' ? existing : {
        status: 'planned', durationMinutes: null, rounds: null, sessionRpe: null, readiness: null, createdAt: now, updatedAt: now,
      };
      const session = WorkoutSessionSchema.parse({ ...base, ...fields,
        ...(fields.exercises ? { exercises: fields.exercises.map((exercise) => ({ ...exercise, sets: [] })) } : {}) });
      await executeEntityCommand(connection, access.ownerId, { type: 'training.session.save', data: { session, expectedUpdatedAt: existing?.updatedAt ?? null } }, current.settings, position);
    }
  });
  register('update_workout_history', 'workout-history:write', historyUpdate, 'Correct an existing started or recorded workout only; never creates, starts, completes or resets lifecycle status. Requires the actual expectedUpdatedAt token. No deletion.', async (input, connection, current, position) => {
    const rows = await connection.select().from(workoutSessions).where(and(eq(workoutSessions.user_id, access.ownerId), eq(workoutSessions.id, input.id))).limit(1);
    const existing = (await sessionRecords(connection, access.ownerId, rows))[0];
    if (!existing) throw new ApiError(404, 'NOT_FOUND', 'That workout no longer exists.');
    if (!['in_progress', 'completed'].includes(existing.status) && !hasRecordedData(existing) && existing.readiness === null)
      throw new ApiError(409, 'NOT_RECORDED', 'Use the separately granted workout planning tool for an unstarted plan.');
    if (existing.updatedAt !== input.expectedUpdatedAt) throw new ApiError(409, 'RECORD_CONFLICT', 'This workout changed. Read its latest version before saving.');
    const session = WorkoutSessionSchema.parse({ ...existing, ...input.patch });
    await executeEntityCommand(connection, access.ownerId, { type: 'training.session.save', data: { session, expectedUpdatedAt: input.expectedUpdatedAt } }, current.settings, position);
  });
}
