import { z } from 'zod';

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
