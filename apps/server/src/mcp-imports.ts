import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requestIdSchema, revisionSchema } from '@packages/api/schemas';
import { ImportSourceSchema } from '@packages/workspace/mutations';
import type { WorkspaceStore } from './store.js';
import type { DelegatedAccess } from './delegation.js';
import type { OriginalToolArguments } from './mcp-writes.js';
import { workoutSourceSchema, MAX_IMPORT_RECORDS,
  workoutImportAdapter, routineImportAdapter, recipeImportAdapter, mealPlanImportAdapter,
  foodLogImportAdapter, checkInImportAdapter, scheduledDateImportAdapter, groceryCheckImportAdapter,
  type ImportAdapter } from './additive-import.js';
import { ApiError } from './http.js';

const guard = { operationId: requestIdSchema, expectedRevision: revisionSchema,
  sourceNamespace: ImportSourceSchema.shape.sourceNamespace };
function importSchema<K extends string, T extends z.ZodType>(key: K, schema: T) {
  return z.object({ ...guard, records: z.array(z.object({
    sourceRecordId: ImportSourceSchema.shape.sourceRecordId, [key]: schema,
  }).strict()).min(1).max(MAX_IMPORT_RECORDS) }).strict();
}
// Keep the original workout DTO's field names and inferred type precise.
export const workoutImportSchema = z.object({ ...guard, records: z.array(z.object({
  sourceRecordId: ImportSourceSchema.shape.sourceRecordId, workout: workoutSourceSchema,
}).strict()).min(1).max(MAX_IMPORT_RECORDS) }).strict();
export type WorkoutImportInput = z.infer<typeof workoutImportSchema>;

export function registerImports(server: McpServer, store: WorkspaceStore,
  access: DelegatedAccess, original: OriginalToolArguments): void {
  function register<T>(tool: string, key: string, adapter: ImportAdapter<T>, detail: string) {
    const scope = `${adapter.recordType}:import`;
    if (!access.scopes.includes(scope)) return;
    const schema = importSchema(key, adapter.schema);
    server.registerTool(tool, {
      description: `Atomically import 1–100 native records with stable sourceNamespace/sourceRecordId and native IDs. Requires operationId and expectedRevision. Identical normalized sources skip even after manual edits or deletion; changed sources and occupied destinations conflict without overwrite. Corner generates createdAt/updatedAt metadata; omit those fields. Complete MCP JSON requests must fit 2 MiB UTF-8; split larger batches. Returns revision and created/skipped IDs only. No implied reads, edits, deletes or configuration writes. ${detail}`,
      inputSchema: tool === 'import_workouts' ? workoutImportSchema : schema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async () => {
      try {
        // Re-parse the original request through the same schema: the SDK's dynamic
        // record shape is not a typed domain value until the adapter validates it.
        const originalArguments = original(tool);
        const parsed = schema.parse(originalArguments);
        const records = parsed.records.map((member) => ({
          sourceRecordId: ImportSourceSchema.shape.sourceRecordId.parse(member.sourceRecordId),
          record: adapter.schema.parse(member[key]),
        }));
        const result = await store.delegatedImport(access, scope, tool, originalArguments,
          parsed.operationId, parsed.expectedRevision, parsed.sourceNamespace, records, adapter);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        const result = error instanceof ApiError ? { code: error.code, error: error.message }
          : error instanceof z.ZodError ? { code: 'INVALID_INPUT', error: 'Check the import fields and try again.' }
            : { code: 'IMPORT_FAILED', error: 'This import could not be completed.' };
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
      }
    });
  }
  register('import_workouts', 'workout', workoutImportAdapter, 'All native-valid statuses are supported; noncompleted workouts require known planning facts. Historical templateId is metadata only. No implicit scheduled dates or routines.');
  register('import_routines', 'routine', routineImportAdapter, 'Full native routine targets are required. Does not rewrite workout snapshots.');
  register('import_recipes', 'recipe', recipeImportAdapter, 'Native nutrition is PER SERVING. Native pdf is restricted Corner path metadata, not an attachment upload or availability guarantee.');
  register('import_meal_plans', 'mealPlan', mealPlanImportAdapter, 'Import owner recipes before active dated meal plans; no implicit recipes.');
  register('import_food_logs', 'foodLog', foodLogImportAdapter, 'Name and nutrition are authoritative historical snapshots; nutrition is PER SERVING, with servings the recorded multiplier. Historical recipeId/planEntryId may be orphaned. Only one food log per planEntryId.');
  register('import_check_ins', 'checkIn', checkInImportAdapter, 'Native bodyWeight is in pounds (lb) and waist is in inches, irrespective of profile defaultWorkoutUnit. Native body/recovery measurements retain zero and unknown values; no unit inference or conversion.');
  register('import_scheduled_dates', 'scheduledDate', scheduledDateImportAdapter, 'Explicit ISO date markers only; no workout or configured schedule is created.');
  register('import_grocery_checks', 'groceryCheck', groceryCheckImportAdapter, 'Native keys (including Unicode, spaces and pipes) and checked=false are preserved exactly.');
}
