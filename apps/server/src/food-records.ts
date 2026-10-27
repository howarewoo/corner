import { and, asc, eq, gt, gte, lte, ne, or, sql } from 'drizzle-orm';
import type { FoodEntry, PlanEntry } from '@packages/nutrition/types';
import { FoodEntrySchema } from '@packages/nutrition/schemas';
import { validateFoodEntry } from '@packages/workspace/mutations';
import type { Transaction } from './queries.js';
import { foodEntries, plannedMeals, recipes } from './schema.js';
import { ApiError } from './http.js';

import { foodWindowSchema, type FoodWindowInput } from '@packages/api/schemas';
import type { FoodWindow } from '@packages/api/workspace-data';

export function foodRecord(row: typeof foodEntries.$inferSelect): FoodEntry {
  return FoodEntrySchema.parse({
    id: row.id,
    date: row.date,
    slot: row.slot,
    name: row.name,
    nutrition: { calories: row.calories, protein: row.protein, carbs: row.carbs, fat: row.fat },
    servings: row.servings,
    createdAt: row.created_at,
    ...(row.recipe_id === null ? {} : { recipeId: row.recipe_id }),
    ...(row.plan_entry_id === null ? {} : { planEntryId: row.plan_entry_id }),
  });
}

export async function saveFoodRecord(
  connection: Transaction,
  userId: string,
  entry: FoodEntry,
  position: number,
): Promise<void> {
  const existing = (
    await connection
      .select()
      .from(foodEntries)
      .where(and(eq(foodEntries.user_id, userId), eq(foodEntries.id, entry.id)))
      .limit(1)
  )[0];
  const recipe =
    entry.recipeId && entry.recipeId !== existing?.recipe_id
      ? (
          await connection
            .select({ id: recipes.id })
            .from(recipes)
            .where(and(eq(recipes.user_id, userId), eq(recipes.id, entry.recipeId)))
            .limit(1)
        )[0]
      : undefined;
  const planned = entry.planEntryId
    ? (
        await connection
          .select()
          .from(plannedMeals)
          .where(and(eq(plannedMeals.user_id, userId), eq(plannedMeals.id, entry.planEntryId)))
          .limit(1)
      )[0]
    : undefined;
  const duplicate = entry.planEntryId
    ? (
        await connection
          .select({ id: foodEntries.id })
          .from(foodEntries)
          .where(
            and(
              eq(foodEntries.user_id, userId),
              eq(foodEntries.plan_entry_id, entry.planEntryId),
              ne(foodEntries.id, entry.id),
            ),
          )
          .limit(1)
      )[0]
    : undefined;
  validateFoodEntry(entry, {
    existing: existing && foodRecord(existing),
    recipeExists: Boolean(recipe),
    planned: planned && {
      id: planned.id,
      date: planned.date,
      slot: planned.slot as PlanEntry['slot'],
      recipeId: planned.recipe_id,
      servings: planned.servings,
    },
    alreadyLogged: Boolean(duplicate),
  });
  const values = {
    user_id: userId,
    id: entry.id,
    position: existing?.position ?? position,
    date: entry.date,
    slot: entry.slot,
    name: entry.name,
    ...entry.nutrition,
    servings: entry.servings,
    recipe_id: entry.recipeId ?? null,
    plan_entry_id: entry.planEntryId ?? null,
    created_at: entry.createdAt,
  };
  await connection
    .insert(foodEntries)
    .values(values)
    .onConflictDoUpdate({
      target: [foodEntries.user_id, foodEntries.id],
      set: values,
    });
}

/** Called in a repeatable-read snapshot so totals, page, and revision share one committed version. */
export async function readFoodWindow(
  connection: Transaction,
  userId: string,
  raw: FoodWindowInput,
  revision: number,
): Promise<FoodWindow> {
  const input = foodWindowSchema.parse(raw);
  if (input.cursor && input.cursor.revision !== revision)
    throw new ApiError(
      409,
      'CURSOR_INVALIDATED',
      'Your food log changed. Refresh this date range.',
    );
  const range = and(
    eq(foodEntries.user_id, userId),
    gte(foodEntries.date, input.from),
    lte(foodEntries.date, input.through),
  );
  const after =
    input.cursor &&
    or(
      gt(foodEntries.date, input.cursor.date),
      and(eq(foodEntries.date, input.cursor.date), gt(foodEntries.position, input.cursor.position)),
      and(
        eq(foodEntries.date, input.cursor.date),
        eq(foodEntries.position, input.cursor.position),
        gt(foodEntries.id, input.cursor.id),
      ),
    );
  const rows = await connection
    .select()
    .from(foodEntries)
    .where(and(range, after))
    .orderBy(asc(foodEntries.date), asc(foodEntries.position), asc(foodEntries.id))
    .limit(input.limit + 1);
  const [totals] = await connection
    .select({
      calories: sql<number>`coalesce(sum(${foodEntries.calories} * ${foodEntries.servings}), 0)::float8`,
      protein: sql<number>`coalesce(sum(${foodEntries.protein} * ${foodEntries.servings}), 0)::float8`,
      carbs: sql<number>`coalesce(sum(${foodEntries.carbs} * ${foodEntries.servings}), 0)::float8`,
      fat: sql<number>`coalesce(sum(${foodEntries.fat} * ${foodEntries.servings}), 0)::float8`,
    })
    .from(foodEntries)
    .where(range);
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    revision,
    entries: page.map(foodRecord),
    totals,
    nextCursor:
      rows.length > input.limit && last
        ? { revision, date: last.date, position: last.position, id: last.id }
        : null,
  };
}
