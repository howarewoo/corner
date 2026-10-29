import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { requestIdSchema, revisionSchema } from '@packages/api/schemas';
import { PlanEntrySchema } from '@packages/nutrition/schemas';
import type { DelegatedAccess } from './delegation.js';
import type { WorkspaceStore } from './store.js';
import { ApiError } from './http.js';
import { plannedMeals } from './schema.js';
import { planRecord } from './nutrition-records.js';
import { executeEntityCommand } from './entity-commands.js';

const guard = { operationId: requestIdSchema, expectedRevision: revisionSchema };
const createMeal = z.object({ action: z.literal('create'), entry: PlanEntrySchema.strict() }).strict();
const updateMeal = z.object({
  action: z.literal('update'),
  id: PlanEntrySchema.shape.id,
  patch: PlanEntrySchema.omit({ id: true }).partial().strict().refine((patch) => Object.keys(patch).length > 0, 'Supply at least one changed field.'),
}).strict();
export const mealPlanBatchSchema = z.object({
  ...guard,
  changes: z.array(z.discriminatedUnion('action', [createMeal, updateMeal])).min(1).max(100),
}).strict();

/** A per-request closure preserves JSON before the SDK applies schema transformations. */
export type OriginalToolArguments = (tool: string) => unknown;

export function registerNutritionWrites(server: McpServer, store: WorkspaceStore, access: DelegatedAccess, original: OriginalToolArguments): void {
  if (!access.scopes.includes('meal-plans:write')) return;
  server.registerTool('edit_meal_plans', {
    description: 'Atomically create or patch up to 100 dated meals. Create rejects existing IDs; update rejects missing IDs. Requires a current workspace revision and a stable operationId. Exact retries replay the committed revision; never silently rebases. Returns only the committed revision.',
    inputSchema: mealPlanBatchSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    try {
      const result = await store.delegatedWrite(access, 'meal-plans:write', 'edit_meal_plans', original('edit_meal_plans'), input.operationId, input.expectedRevision,
        async (connection, current, position) => {
          const ids = new Set<string>();
          for (const change of input.changes) {
            const id = change.action === 'create' ? change.entry.id : change.id;
            if (ids.has(id)) throw new ApiError(400, 'INVALID_INPUT', 'A meal ID may appear only once per batch.');
            ids.add(id);
            const row = (await connection.select().from(plannedMeals).where(and(eq(plannedMeals.user_id, access.ownerId), eq(plannedMeals.id, id))).limit(1))[0];
            if (change.action === 'create' && row) throw new ApiError(409, 'ALREADY_EXISTS', 'That meal already exists.');
            if (change.action === 'update' && !row) throw new ApiError(404, 'NOT_FOUND', 'That meal no longer exists.');
            const entry = change.action === 'create' ? change.entry : PlanEntrySchema.parse({ ...planRecord(row!), ...change.patch });
            await executeEntityCommand(connection, access.ownerId, { type: 'plan.save', data: entry }, current.settings, position);
          }
        });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      const result = error instanceof ApiError ? { code: error.code, error: error.message }
        : error instanceof z.ZodError ? { code: 'INVALID_INPUT', error: 'Check the fields and try again.' }
        : { code: 'WRITE_FAILED', error: 'This change could not be completed.' };
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
    }
  });
}
