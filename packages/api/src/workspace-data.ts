import { z } from 'zod';
import { DateSchema } from '@packages/nutrition/schemas';
import type { FoodEntry, Macros, GroceryItem } from '@packages/nutrition/types';
import type { AppState, Settings } from '@packages/workspace/types';

/** Compact workspace JSON/file limit; RPC envelopes have a separate small allowance. */
export const MAX_WORKSPACE_TRANSFER_BYTES = 32 * 1024 * 1024;

export type Bootstrap = { settings: Settings; revision: number; aiAvailable: boolean };
export type CommandResult = { revision: number };
export type FoodWindow = {
  revision: number;
  entries: FoodEntry[];
  totals: Macros;
  nextCursor: { revision: number; date: string; position: number; id: string } | null;
};
export type Resources = {
  recipes: AppState['recipes'][number];
  plan: AppState['plan'][number];
  sessions: AppState['training']['sessions'][number];
  templates: AppState['training']['templates'][number];
  checkIns: AppState['training']['checkIns'][number];
  recipeRequests: AppState['requests'][number];
  trainingRequests: AppState['training']['requests'][number];
  reviews: AppState['training']['reviews'][number];
  scheduledDates: string;
  groceryChecks: { key: string; checked: boolean };
};
export const resourceSchema = z.enum([
  'recipes',
  'plan',
  'sessions',
  'templates',
  'checkIns',
  'recipeRequests',
  'trainingRequests',
  'reviews',
  'scheduledDates',
  'groceryChecks',
]);
export const pageCursorSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    position: z.number().int().nonnegative(),
    id: z.string().max(500),
    date: DateSchema.optional(),
    updatedAt: z.string().datetime().optional(),
  })
  .strict();
export const recordPageSchema = z
  .object({
    resource: resourceSchema,
    from: DateSchema.optional(),
    through: DateSchema.optional(),
    search: z.string().trim().max(200).optional(),
    category: z.enum(['breakfast', 'main', 'snack']).optional(),
    favorite: z.boolean().optional(),
    status: z.string().max(30).optional(),
    order: z.enum(['collection', 'recent']).default('collection'),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: pageCursorSchema.optional(),
  })
  .strict()
  .refine(
    (input) =>
      (!input.from && !input.through) ||
      Boolean(
        input.from &&
        input.through &&
        input.from <= input.through &&
        Date.parse(input.through) - Date.parse(input.from) <= 92 * 86400000,
      ),
    'Choose a date range of at most 93 days.',
  )
  .refine(
    (input) =>
      !['plan', 'scheduledDates'].includes(input.resource) || Boolean(input.from && input.through),
    'Include a bounded calendar range.',
  );
export type RecordPageInput = z.input<typeof recordPageSchema>;
export type RecordPage<K extends keyof Resources = keyof Resources> = {
  [R in K]: {
    resource: R;
    revision: number;
    items: Resources[R][];
    loggedPlanIds: string[];
    nextCursor: z.infer<typeof pageCursorSchema> | null;
  };
}[K];
export const detailsSchema = z
  .object({
    recipeIds: z.array(z.string().min(1).max(120)).max(100).default([]),
    planIds: z.array(z.string().min(1).max(120)).max(100).default([]),
    sessionIds: z.array(z.string().min(1).max(120)).max(25).default([]),
    templateIds: z.array(z.string().min(1).max(120)).max(100).default([]),
  })
  .strict();
export type RecordDetails = {
  revision: number;
  recipes: AppState['recipes'];
  plan: AppState['plan'];
  sessions: AppState['training']['sessions'];
  templates: AppState['training']['templates'];
};
export const rangeSchema = z
  .object({ from: DateSchema, through: DateSchema })
  .strict()
  .refine(
    (input) =>
      input.from <= input.through &&
      Date.parse(input.through) - Date.parse(input.from) <= 92 * 86400000,
    'Choose a date range of at most 93 days.',
  );
export const groceriesSchema = z
  .object({
    weekStart: DateSchema,
    limit: z.number().int().min(1).max(200).default(100),
    cursor: z
      .object({ revision: z.number().int().nonnegative(), key: z.string().max(500) })
      .optional(),
  })
  .strict();
export type GroceryWindow = {
  revision: number;
  items: GroceryItem[];
  checks: Record<string, boolean>;
  nextCursor: { revision: number; key: string } | null;
};
export type TrainingStats = {
  sessions: number;
  strengthSessions: number;
  boxingSessions: number;
  conditioningSessions: number;
  minutes: number;
  workingSets: number;
  externalVolumeLb: number;
  averageRpe: number | null;
};
export type Progress = {
  revision: number;
  completedCount: number;
  stats: TrainingStats;
  latestWeight: AppState['training']['checkIns'][number] | null;
  weekly: Array<{ week: string; stats: TrainingStats }>;
};
export const exerciseHistorySchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    limit: z.number().int().min(1).max(100).default(30),
    cursor: z
      .object({
        revision: z.number().int().nonnegative(),
        date: DateSchema,
        updatedAt: z.string().datetime(),
        id: z.string().min(1).max(120),
      })
      .optional(),
  })
  .strict();
export type ExerciseHistoryPage = {
  revision: number;
  sessions: AppState['training']['sessions'];
  nextCursor: z.infer<typeof exerciseHistorySchema>['cursor'] | null;
};
export const prefillSchema = z.object({ session: z.unknown() }).strict();
export type PrefillHistory = { revision: number; sessions: AppState['training']['sessions'] };
export const exerciseChoicesSchema = z
  .object({
    search: z.string().trim().max(160).default(''),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z
      .object({ revision: z.number().int().nonnegative(), name: z.string().max(160) })
      .optional(),
  })
  .strict();
export type ExerciseChoices = {
  revision: number;
  names: string[];
  nextCursor: { revision: number; name: string } | null;
};
