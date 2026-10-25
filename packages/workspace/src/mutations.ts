import { z } from 'zod';
import {
  DateSchema,
  FoodEntrySchema,
  MacrosSchema,
  PlanEntrySchema,
  RecipeRequestSchema,
  RecipeSchema,
} from '@packages/nutrition/schemas';
import { mondayOf, weekDates } from '@packages/nutrition/dates';
import { applyTrainingMutation, ensureTrainingState, TrainingMutationOptions } from '@packages/training/workouts';
import type { AppState, Mutation } from './types.js';

const text = (max: number) => z.string().trim().max(max);
const id = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_:.\-]+$/, 'Use a valid item ID.');
const finite = (max: number) => z.number().finite().min(0).max(max);
const TimestampSchema = z
  .string()
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Use a valid timestamp.');
export const SettingsSchema = z.object({
  name: text(80).min(1),
  timezone: text(100).refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, 'Choose a valid time zone.'),
  training: MacrosSchema,
  rest: MacrosSchema,
  schedule: z
    .record(z.string(), text(80).min(1))
    .refine(
      (value) =>
        Object.keys(value).length === 7 &&
        Array.from({ length: 7 }, (_, i) => String(i)).every((key) => key in value),
      'Include all seven weekdays.',
    ),
  profile: z
    .object({
      goals: text(2000),
      experience: text(500),
      sessionMinutes: finite(600).int(),
      dietaryPreferences: text(2000),
      groceryPreferences: text(1000),
      equipment: text(2000),
      defaultWorkoutUnit: z.enum(['lb', 'kg']),
      constraints: text(3000),
    })
    .optional(),
  setup: z
    .object({ completedAt: TimestampSchema.nullable(), nutritionTargetsSet: z.boolean() })
    .optional(),
});
export const MutationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('recipe.save'), data: RecipeSchema }),
  z.object({ type: z.literal('recipe.delete'), data: z.object({ id }) }),
  z.object({ type: z.literal('recipe.favorite'), data: z.object({ id, favorite: z.boolean() }) }),
  z.object({ type: z.literal('plan.save'), data: PlanEntrySchema }),
  z.object({ type: z.literal('plan.delete'), data: z.object({ id }) }),
  z.object({
    type: z.literal('plan.week'),
    data: z.object({
      entries: z.array(PlanEntrySchema).max(100),
      weekStart: DateSchema,
      replace: z.boolean(),
    }),
  }),
  z.object({ type: z.literal('log.save'), data: FoodEntrySchema }),
  z.object({ type: z.literal('log.delete'), data: z.object({ id }) }),
  z.object({ type: z.literal('settings.save'), data: SettingsSchema }),
  z.object({
    type: z.literal('grocery.check'),
    data: z.object({
      key: text(500)
        .min(1)
        .refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value)),
      checked: z.boolean(),
    }),
  }),
  z.object({ type: z.literal('request.save'), data: RecipeRequestSchema }),
  z.object({ type: z.literal('request.fulfill'), data: z.object({ id, recipe: RecipeSchema }) }),
  ...TrainingMutationOptions,
]);
function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  return items.some((value) => value.id === item.id)
    ? items.map((value) => (value.id === item.id ? item : value))
    : [...items, item];
}
export function applyMutation(previous: AppState, input: Mutation): AppState {
  const parsed = MutationSchema.safeParse(input);
  if (!parsed.success)
    throw new Error(
      parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .slice(0, 3)
        .join('; '),
    );
  const mutation = parsed.data;
  const next = ensureTrainingState(structuredClone(previous));
  const requireRecipe = (recipeId: string) => {
    if (!next.recipes.some((recipe) => recipe.id === recipeId))
      throw new Error('That recipe is no longer available. Refresh and choose a recipe.');
  };
  switch (mutation.type) {
    case 'recipe.save':
      next.recipes = upsert(next.recipes, mutation.data);
      break;
    case 'recipe.delete':
      if (next.plan.some((entry) => entry.recipeId === mutation.data.id))
        throw new Error(
          'Remove this recipe from your meal plan before deleting it. Your food log will stay intact.',
        );
      next.recipes = next.recipes.filter((recipe) => recipe.id !== mutation.data.id);
      break;
    case 'recipe.favorite':
      requireRecipe(mutation.data.id);
      next.recipes = next.recipes.map((recipe) =>
        recipe.id === mutation.data.id ? { ...recipe, favorite: mutation.data.favorite } : recipe,
      );
      break;
    case 'plan.save':
      requireRecipe(mutation.data.recipeId);
      next.plan = upsert(next.plan, mutation.data);
      break;
    case 'plan.delete':
      next.plan = next.plan.filter((entry) => entry.id !== mutation.data.id);
      break;
    case 'plan.week': {
      const dates = new Set(weekDates(mutation.data.weekStart));
      if (mondayOf(mutation.data.weekStart) !== mutation.data.weekStart)
        throw new Error('The week must start on a Monday.');
      for (const entry of mutation.data.entries) {
        if (!dates.has(entry.date))
          throw new Error('Every meal must fall within the selected week.');
        requireRecipe(entry.recipeId);
      }
      if (
        new Set(mutation.data.entries.map((entry) => entry.id)).size !==
        mutation.data.entries.length
      )
        throw new Error('Meal IDs must be unique.');
      const outsideIds = new Set(
        next.plan.filter((entry) => !dates.has(entry.date)).map((entry) => entry.id),
      );
      if (mutation.data.entries.some((entry) => outsideIds.has(entry.id)))
        throw new Error('Use new meal IDs when copying a plan into a different week.');
      if (mutation.data.replace) next.plan = next.plan.filter((entry) => !dates.has(entry.date));
      for (const entry of mutation.data.entries) next.plan = upsert(next.plan, entry);
      break;
    }
    case 'log.save': {
      const entry = mutation.data;
      const existing = next.logs.find((value) => value.id === entry.id);
      if (entry.recipeId && entry.recipeId !== existing?.recipeId) requireRecipe(entry.recipeId);
      if (entry.planEntryId) {
        const planned = next.plan.find((value) => value.id === entry.planEntryId);
        if (!planned && entry.planEntryId !== existing?.planEntryId)
          throw new Error('That planned meal is no longer available.');
        const keepsHistoricalLink =
          existing &&
          existing.planEntryId === entry.planEntryId &&
          existing.recipeId === entry.recipeId &&
          existing.date === entry.date;
        if (
          planned &&
          !keepsHistoricalLink &&
          (planned.date !== entry.date || (entry.recipeId && planned.recipeId !== entry.recipeId))
        )
          throw new Error('The logged meal must match the planned date and recipe.');
      }
      if (
        entry.planEntryId &&
        next.logs.some((value) => value.planEntryId === entry.planEntryId && value.id !== entry.id)
      )
        throw new Error(
          'That planned meal has already been logged. Edit its logged portion if needed.',
        );
      next.logs = upsert(next.logs, entry);
      break;
    }
    case 'log.delete':
      next.logs = next.logs.filter((entry) => entry.id !== mutation.data.id);
      break;
    case 'settings.save':
      next.settings = mutation.data;
      break;
    case 'grocery.check':
      if (mutation.data.checked) next.groceryChecks[mutation.data.key] = true;
      else delete next.groceryChecks[mutation.data.key];
      break;
    case 'request.save':
      if (mutation.data.status !== 'pending') throw new Error('New recipe briefs must be pending.');
      next.requests = upsert(next.requests, mutation.data);
      break;
    case 'request.fulfill':
      if (!next.requests.some((request) => request.id === mutation.data.id))
        throw new Error('That recipe brief no longer exists.');
      next.recipes = upsert(next.recipes, mutation.data.recipe);
      next.requests = next.requests.map((request) =>
        request.id === mutation.data.id
          ? { ...request, status: 'fulfilled', recipeId: mutation.data.recipe.id }
          : request,
      );
      break;
    case 'training.session.save':
    case 'training.session.delete':
    case 'training.week':
    case 'training.template.save':
    case 'training.checkin.save':
    case 'training.request.save':
    case 'training.review.save':
    case 'training.review.apply':
    case 'training.review.dismiss':
      next.training = applyTrainingMutation(next.training, mutation, next.settings.schedule);
      break;
  }
  if (
    next.recipes.length > 1000 ||
    next.plan.length > 10000 ||
    next.logs.length > 20000 ||
    next.requests.length > 1000 ||
    Object.keys(next.groceryChecks).length > 10000
  )
    throw new Error(
      'This collection is full. Export a backup and remove older items before adding more.',
    );
  return next;
}
