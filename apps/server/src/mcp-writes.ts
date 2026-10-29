import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { requestIdSchema, revisionSchema } from '@packages/api/schemas';
import { FoodEntrySchema, MacrosSchema, PlanEntrySchema, RecipeSchema } from '@packages/nutrition/schemas';
import type { DelegatedAccess } from './delegation.js';
import type { WorkspaceBootstrap, WorkspaceStore } from './store.js';
import type { Transaction } from './queries.js';
import { ApiError } from './http.js';
import { foodEntries, plannedMeals, recipes } from './schema.js';
import { planRecord, recipeRecord } from './nutrition-records.js';
import { foodRecord } from './food-records.js';
import { executeEntityCommand } from './entity-commands.js';

const guard = { operationId: requestIdSchema, expectedRevision: revisionSchema };
const guardSchema = z.object(guard);
const nonemptyPatch = (patch: object) => Object.keys(patch).length > 0;
const createMeal = z.object({ action: z.literal('create'), entry: PlanEntrySchema.strict() }).strict();
const updateMeal = z.object({
  action: z.literal('update'),
  id: PlanEntrySchema.shape.id,
  patch: PlanEntrySchema.omit({ id: true }).partial().strict().refine(nonemptyPatch, 'Supply at least one changed field.'),
}).strict();
export const mealPlanBatchSchema = z.object({
  ...guard,
  changes: z.array(z.discriminatedUnion('action', [createMeal, updateMeal])).min(1).max(100),
}).strict();
const macroPatch = MacrosSchema.partial().strict().refine(nonemptyPatch, 'Supply at least one nutrition field.');
const recipePatch = RecipeSchema.omit({ id: true }).partial().extend({
  nutrition: macroPatch.optional(),
  pdf: RecipeSchema.shape.pdf.unwrap().nullable().optional(),
  nutritionNote: RecipeSchema.shape.nutritionNote.unwrap().nullable().optional(),
}).strict().refine(nonemptyPatch, 'Supply at least one changed field.');
const foodPatch = FoodEntrySchema.omit({ id: true }).partial().extend({
  nutrition: macroPatch.optional(),
  recipeId: FoodEntrySchema.shape.recipeId.unwrap().nullable().optional(),
  planEntryId: FoodEntrySchema.shape.planEntryId.unwrap().nullable().optional(),
}).strict().refine(nonemptyPatch, 'Supply at least one changed field.');
const deleteSchema = z.object({ ...guard, id: PlanEntrySchema.shape.id }).strict();

/** A per-request closure preserves JSON before the SDK applies schema transformations. */
export type OriginalToolArguments = (tool: string) => unknown;

export function registerNutritionWrites(server: McpServer, store: WorkspaceStore, access: DelegatedAccess, original: OriginalToolArguments): void {
  function register<S extends z.ZodRawShape>(
    name: string,
    scope: string,
    description: string,
    inputSchema: z.ZodObject<S, z.core.$strict>,
    destructive: boolean,
    update: (input: z.output<z.ZodObject<S, z.core.$strict>>, connection: Transaction, current: WorkspaceBootstrap, position: () => number) => Promise<void>,
  ): void {
    if (!access.scopes.includes(scope)) return;
    server.registerTool<z.ZodRawShape, z.ZodObject<S, z.core.$strict>>(name, {
      description: `${description} Requires expectedRevision and stable operationId. Exact retained retries replay the committed revision; stale new writes fail without rebasing. Returns only { revision }.`,
      inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: destructive, idempotentHint: true, openWorldHint: false },
    }, async (input) => {
      try {
        const { operationId, expectedRevision } = guardSchema.parse(input);
        const result = await store.delegatedWrite(access, scope, name, original(name), operationId, expectedRevision,
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

  register('edit_meal_plans', 'meal-plans:write',
    'Atomically create or patch up to 100 dated meals. Create rejects existing IDs; update rejects missing IDs. Patches preserve unspecified fields.',
    mealPlanBatchSchema, true, async (input, connection, current, position) => {
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

  register('create_recipe', 'recipes:write', 'Create a recipe from explicitly supplied fields. Rejects an existing ID.',
    z.object({ ...guard, recipe: RecipeSchema.strict() }).strict(), false, async (input, connection, current, position) => {
      const row = (await connection.select({ id: recipes.id }).from(recipes).where(and(eq(recipes.user_id, access.ownerId), eq(recipes.id, input.recipe.id))).limit(1))[0];
      if (row) throw new ApiError(409, 'ALREADY_EXISTS', 'That recipe already exists.');
      await executeEntityCommand(connection, access.ownerId, { type: 'recipe.save', data: input.recipe }, current.settings, position);
    });
  register('update_recipe', 'recipes:write', 'Patch an existing recipe, preserving unspecified fields and nutrition values. Arrays replace their addressed field; null removes pdf or nutritionNote. Does not rewrite historical food snapshots.',
    z.object({ ...guard, id: RecipeSchema.shape.id, patch: recipePatch }).strict(), true, async (input, connection, current, position) => {
      const row = (await connection.select().from(recipes).where(and(eq(recipes.user_id, access.ownerId), eq(recipes.id, input.id))).limit(1))[0];
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'That recipe no longer exists.');
      const existing = recipeRecord(row);
      const merged = { ...existing, ...input.patch, nutrition: { ...existing.nutrition, ...input.patch.nutrition } };
      const recipe = RecipeSchema.parse({ ...merged, pdf: merged.pdf ?? undefined, nutritionNote: merged.nutritionNote ?? undefined });
      await executeEntityCommand(connection, access.ownerId, { type: 'recipe.save', data: recipe }, current.settings, position);
    });
  register('delete_recipe', 'recipes:delete', 'Delete an existing recipe only if no meal plan uses it. Historical food logs remain intact.',
    deleteSchema, true, async (input, connection, current, position) => {
      const row = (await connection.select({ id: recipes.id }).from(recipes).where(and(eq(recipes.user_id, access.ownerId), eq(recipes.id, input.id))).limit(1))[0];
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'That recipe no longer exists.');
      await executeEntityCommand(connection, access.ownerId, { type: 'recipe.delete', data: { id: input.id } }, current.settings, position);
    });

  register('create_food_log', 'food-logs:write', 'Create a recorded food snapshot from explicitly supplied name, nutrition and other fields. Does not copy recipe content. Rejects existing IDs and already-logged meal plans.',
    z.object({ ...guard, entry: FoodEntrySchema.strict() }).strict(), false, async (input, connection, current, position) => {
      const row = (await connection.select({ id: foodEntries.id }).from(foodEntries).where(and(eq(foodEntries.user_id, access.ownerId), eq(foodEntries.id, input.entry.id))).limit(1))[0];
      if (row) throw new ApiError(409, 'ALREADY_EXISTS', 'That food log already exists.');
      await executeEntityCommand(connection, access.ownerId, { type: 'log.save', data: input.entry }, current.settings, position);
    });
  register('update_food_log', 'food-logs:write', 'Patch an existing recorded food snapshot, preserving unspecified fields and nutrition values. Null removes recipeId or planEntryId. Historical unchanged source links may outlive their sources.',
    z.object({ ...guard, id: FoodEntrySchema.shape.id, patch: foodPatch }).strict(), true, async (input, connection, current, position) => {
      const row = (await connection.select().from(foodEntries).where(and(eq(foodEntries.user_id, access.ownerId), eq(foodEntries.id, input.id))).limit(1))[0];
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'That food log no longer exists.');
      const existing = foodRecord(row);
      const merged = { ...existing, ...input.patch, nutrition: { ...existing.nutrition, ...input.patch.nutrition } };
      const entry = FoodEntrySchema.parse({ ...merged, recipeId: merged.recipeId ?? undefined, planEntryId: merged.planEntryId ?? undefined });
      await executeEntityCommand(connection, access.ownerId, { type: 'log.save', data: entry }, current.settings, position);
    });
  register('delete_food_log', 'food-logs:delete', 'Delete one existing food log. Does not delete its recipe or meal plan.',
    deleteSchema, true, async (input, connection, current, position) => {
      const row = (await connection.select({ id: foodEntries.id }).from(foodEntries).where(and(eq(foodEntries.user_id, access.ownerId), eq(foodEntries.id, input.id))).limit(1))[0];
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'That food log no longer exists.');
      await executeEntityCommand(connection, access.ownerId, { type: 'log.delete', data: { id: input.id } }, current.settings, position);
    });
}
