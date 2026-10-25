import { z } from 'zod';
import type {
  AppState,
  GroceryItem,
  Macros,
  Mutation,
  Settings,
} from './types.js';
import { applyTrainingMutation, ensureTrainingState, TrainingMutationOptions } from './training.js';

const text = (max: number) => z.string().trim().max(max);
const id = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_:.\-]+$/, 'Use a valid item ID.');
const finite = (max: number) => z.number().finite().min(0).max(max);
export const MacrosSchema = z.object({
  calories: finite(10000),
  protein: finite(1500),
  carbs: finite(2500),
  fat: finite(1500),
});
const validDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) &&
  new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
export const DateSchema = z.string().refine(validDate, 'Choose a valid calendar date.');
const TimestampSchema = z
  .string()
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Use a valid timestamp.');
const SlotSchema = z.enum(['breakfast', 'lunch', 'dinner', 'snack', 'fuel']);
const ServingsSchema = z.number().finite().min(0.05).max(100);

export const RecipeSchema = z.object({
  id,
  name: text(160).min(1),
  description: text(1600),
  category: z.enum(['breakfast', 'main', 'snack']),
  prepMinutes: finite(1440),
  cookMinutes: finite(1440),
  nutrition: MacrosSchema,
  ingredients: z
    .array(
      z.object({
        name: text(180).min(1),
        quantity: finite(20000),
        unit: text(40).min(1),
        display: text(300).optional(),
        note: text(800).optional(),
        shoppingQuantity: finite(20000).optional(),
        shoppingUnit: text(40).min(1).optional(),
        aisle: text(80).min(1),
        optional: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(60),
  steps: z.array(text(2000).min(1)).min(1).max(40),
  storage: text(2000),
  variation: text(1600),
  tags: z.array(text(60)).max(20),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  source: z.enum(['plan', 'manual', 'ai']),
  favorite: z.boolean(),
  pdf: z
    .string()
    .max(200)
    .regex(/^\/recipes\/[a-zA-Z0-9_\-]+\.pdf$/)
    .optional(),
  createdAt: TimestampSchema,
  nutritionNote: text(1200).optional(),
});

export const PlanEntrySchema = z.object({
  id,
  date: DateSchema,
  slot: SlotSchema,
  recipeId: id,
  servings: ServingsSchema,
});
export const FoodEntrySchema = z.object({
  id,
  date: DateSchema,
  slot: SlotSchema,
  name: text(180).min(1),
  nutrition: MacrosSchema,
  servings: ServingsSchema,
  recipeId: id.optional(),
  planEntryId: id.optional(),
  createdAt: TimestampSchema,
});
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
export const RecipeRequestSchema = z.object({
  id,
  prompt: text(4000).min(3),
  calories: finite(3000),
  protein: finite(300),
  maxMinutes: finite(240),
  status: z.enum(['pending', 'fulfilled']),
  createdAt: TimestampSchema,
  recipeId: id.optional(),
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

export function dateKey(date = new Date(), timezone = 'UTC'): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (name: string) => parts.find((value) => value.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function shiftDate(date: string, days: number): string {
  DateSchema.parse(date);
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function mondayOf(date: string): string {
  DateSchema.parse(date);
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return shiftDate(date, -((day + 6) % 7));
}

export function weekDates(date: string): string[] {
  const monday = mondayOf(date);
  return Array.from({ length: 7 }, (_, index) => shiftDate(monday, index));
}

export function macroTotal(items: Array<{ nutrition: Macros; servings: number }>): Macros {
  const total = items.reduce(
    (sum, item) => ({
      calories: sum.calories + item.nutrition.calories * item.servings,
      protein: sum.protein + item.nutrition.protein * item.servings,
      carbs: sum.carbs + item.nutrition.carbs * item.servings,
      fat: sum.fat + item.nutrition.fat * item.servings,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
  return {
    calories: Math.round(total.calories),
    protein: Math.round(total.protein * 10) / 10,
    carbs: Math.round(total.carbs * 10) / 10,
    fat: Math.round(total.fat * 10) / 10,
  };
}

export function activityForDate(settings: Settings, date: string): string {
  DateSchema.parse(date);
  return settings.schedule[String(new Date(`${date}T12:00:00Z`).getUTCDay())] || 'Recovery';
}

export function targetForDate(settings: Settings, date: string): Macros {
  return /\b(rest|recovery|off)\b/i.test(activityForDate(settings, date))
    ? settings.rest
    : settings.training;
}

/** Explicit workout dates take precedence over the recurring schedule. */
export function activityForStateDate(state: AppState, date: string): string {
  DateSchema.parse(date);
  const sessions = state.training?.sessions.filter((session) => session.date === date) ?? [];
  if (!sessions.length && !state.training?.scheduledDates.includes(date))
    return activityForDate(state.settings, date);
  const kinds = new Set(
    sessions.filter((session) => session.status !== 'skipped').map((session) => session.kind),
  );
  const activities = [
    kinds.has('boxing') ? 'Boxing' : '',
    kinds.has('strength') ? 'Strength' : '',
    kinds.has('conditioning') ? 'Conditioning' : '',
  ].filter(Boolean);
  return activities.join(' + ') || 'Recovery';
}

export function targetForStateDate(state: AppState, date: string): Macros {
  const explicit =
    state.training?.scheduledDates.includes(date) ||
    state.training?.sessions.some((session) => session.date === date);
  if (!explicit) return targetForDate(state.settings, date);
  const hasTraining = state.training.sessions.some(
    (session) =>
      session.date === date && session.status !== 'skipped' && session.kind !== 'recovery',
  );
  return hasTraining ? state.settings.training : state.settings.rest;
}

export function groceryList(state: AppState, weekStart: string): GroceryItem[] {
  const days = new Set(weekDates(weekStart));
  const recipes = new Map(state.recipes.map((recipe) => [recipe.id, recipe]));
  const items = new Map<string, GroceryItem>();
  for (const entry of state.plan.filter((entry) => days.has(entry.date))) {
    for (const ingredient of recipes.get(entry.recipeId)?.ingredients ?? []) {
      if (ingredient.optional || ingredient.name.trim().toLowerCase() === 'water') continue;
      const quantity = (ingredient.shoppingQuantity ?? ingredient.quantity) * entry.servings;
      if (quantity <= 0) continue;
      const unit = ingredient.shoppingUnit ?? ingredient.unit;
      const key = `${ingredient.name.trim().toLowerCase()}|${unit.trim().toLowerCase()}`;
      const current = items.get(key) ?? {
        key,
        name: ingredient.name,
        quantity: 0,
        unit,
        aisle: ingredient.aisle,
        notes: [],
      };
      current.quantity += quantity;
      if (ingredient.note && !current.notes.includes(ingredient.note))
        current.notes.push(ingredient.note);
      items.set(key, current);
    }
  }
  return [...items.values()]
    .map((item) => ({ ...item, quantity: Math.round(item.quantity * 100) / 100 }))
    .sort((a, b) => a.aisle.localeCompare(b.aisle) || a.name.localeCompare(b.name));
}

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  return items.some((value) => value.id === item.id)
    ? items.map((value) => (value.id === item.id ? item : value))
    : [...items, item];
}

/** Every client mutation is validated again on the server before it reaches D1. */
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
