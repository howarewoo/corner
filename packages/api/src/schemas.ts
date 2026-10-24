import { z } from 'zod';
import { MutationSchema } from '@packages/shared/domain';
import { FoodDescriptionSchema } from '@packages/shared/food-estimate';

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
const draftRequestId = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_:.\-]+$/);
export const RecipeInputSchema = z
  .object({
    requestId: draftRequestId,
    prompt: z.string().trim().min(8).max(1600),
    calories: z.number().int().min(150).max(1500),
    protein: z.number().int().min(5).max(120),
    maxMinutes: z.number().int().min(5).max(120),
  })
  .strict();
export const FoodInputSchema = z
  .object({ requestId: draftRequestId, description: FoodDescriptionSchema })
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
