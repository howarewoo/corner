import { and, eq } from 'drizzle-orm';
import type { PlanEntry, Recipe, RecipeRequest } from '@packages/nutrition/types';
import { PlanEntrySchema, RecipeRequestSchema, RecipeSchema } from '@packages/nutrition/schemas';
import type { Transaction } from './queries.js';
import { plannedMeals, recipeRequests, recipes } from './schema.js';

export function recipeRecord(row: typeof recipes.$inferSelect): Recipe {
  return RecipeSchema.parse({
    ...row.content,
    id: row.id,
    name: row.name,
    category: row.category,
    favorite: row.favorite,
    createdAt: row.created_at,
    nutrition: { calories: row.calories, protein: row.protein, carbs: row.carbs, fat: row.fat },
  });
}
export function planRecord(row: typeof plannedMeals.$inferSelect): PlanEntry {
  return PlanEntrySchema.parse({
    id: row.id,
    date: row.date,
    slot: row.slot,
    recipeId: row.recipe_id,
    servings: row.servings,
  });
}
export function recipeRequestRecord(row: typeof recipeRequests.$inferSelect): RecipeRequest {
  return RecipeRequestSchema.parse({
    id: row.id,
    prompt: row.prompt,
    calories: row.calories,
    protein: row.protein,
    maxMinutes: row.max_minutes,
    status: row.status,
    createdAt: row.created_at,
    ...(row.recipe_id === null ? {} : { recipeId: row.recipe_id }),
  });
}
export async function saveRecipe(
  connection: Transaction,
  userId: string,
  recipe: Recipe,
  position: number,
) {
  const { id, name, category, favorite, createdAt, nutrition, ...content } = recipe;
  const existing = (
    await connection
      .select({ position: recipes.position })
      .from(recipes)
      .where(and(eq(recipes.user_id, userId), eq(recipes.id, id)))
      .limit(1)
  )[0];
  const values = {
    user_id: userId,
    id,
    name,
    category,
    favorite,
    created_at: createdAt,
    ...nutrition,
    content,
    position: existing?.position ?? position,
  };
  await connection
    .insert(recipes)
    .values(values)
    .onConflictDoUpdate({ target: [recipes.user_id, recipes.id], set: values });
}
export async function savePlan(
  connection: Transaction,
  userId: string,
  entry: PlanEntry,
  position: number,
) {
  const existing = (
    await connection
      .select({ position: plannedMeals.position })
      .from(plannedMeals)
      .where(and(eq(plannedMeals.user_id, userId), eq(plannedMeals.id, entry.id)))
      .limit(1)
  )[0];
  const values = {
    user_id: userId,
    id: entry.id,
    date: entry.date,
    slot: entry.slot,
    recipe_id: entry.recipeId,
    servings: entry.servings,
    position: existing?.position ?? position,
  };
  await connection
    .insert(plannedMeals)
    .values(values)
    .onConflictDoUpdate({ target: [plannedMeals.user_id, plannedMeals.id], set: values });
}
export async function saveRecipeRequest(
  connection: Transaction,
  userId: string,
  entry: RecipeRequest,
  position: number,
) {
  const existing = (
    await connection
      .select({ position: recipeRequests.position })
      .from(recipeRequests)
      .where(and(eq(recipeRequests.user_id, userId), eq(recipeRequests.id, entry.id)))
      .limit(1)
  )[0];
  const values = {
    user_id: userId,
    id: entry.id,
    prompt: entry.prompt,
    calories: entry.calories,
    protein: entry.protein,
    max_minutes: entry.maxMinutes,
    status: entry.status,
    created_at: entry.createdAt,
    recipe_id: entry.recipeId ?? null,
    position: existing?.position ?? position,
  };
  await connection
    .insert(recipeRequests)
    .values(values)
    .onConflictDoUpdate({ target: [recipeRequests.user_id, recipeRequests.id], set: values });
}
