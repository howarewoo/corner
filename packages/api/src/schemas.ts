import { z } from 'zod';
import { MutationSchema } from '@packages/workspace/mutations';
import { DateSchema } from '@packages/nutrition/schemas';

export const foodWindowSchema = z
  .object({
    from: DateSchema,
    through: DateSchema,
    limit: z.number().int().min(1).max(200).default(100),
    cursor: z
      .object({
        revision: z.number().int().nonnegative(),
        date: DateSchema,
        position: z.number().int().nonnegative(),
        id: z.string().min(1).max(120),
      })
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.from <= value.through &&
      Date.parse(value.through) - Date.parse(value.from) <= 92 * 86400000,
    'Choose a date range of at most 93 days.',
  );
export type FoodWindowInput = z.input<typeof foodWindowSchema>;

export const requestIdSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/, 'Use a unique request identifier.');
export const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const mutationInputSchema = z
  .object({
    mutation: z.unknown(),
    requestId: requestIdSchema,
    expectedRevision: revisionSchema.optional(),
  })
  .strict();
export type WorkspaceMutationInput = Omit<z.input<typeof mutationInputSchema>, 'mutation'> & {
  mutation: z.input<typeof MutationSchema>;
};
export const importPreviewInputSchema = z.object({ state: z.unknown() }).strict();
export const importInputSchema = z
  .object({ state: z.unknown(), requestId: requestIdSchema, expectedRevision: revisionSchema })
  .strict();
export const runInputSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-zA-Z0-9-]+$/),
  })
  .strict();
export const applyInputSchema = runInputSchema.extend({ requestId: z.string().min(1).max(120) });
