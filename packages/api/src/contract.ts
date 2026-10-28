import { oc, type, type ContractRouterClient } from '@orpc/contract';
import { z } from 'zod';
import type { AppState } from '@packages/workspace/types';
import {
  importInputSchema,
  importPreviewInputSchema,
  type WorkspaceMutationInput,
} from './schemas.js';
import {
  detailsSchema,
  exerciseHistorySchema,
  groceriesSchema,
  prefillSchema,
  rangeSchema,
  recordPageSchema,
  type Bootstrap,
  type CommandResult,
  type ExerciseHistoryPage,
  type FoodWindow,
  type GroceryWindow,
  type PrefillHistory,
  type Progress,
  type RecordDetails,
  type RecordPage,
} from './workspace-data.js';
import { foodWindowSchema } from './schemas.js';
import { exerciseChoicesSchema, type ExerciseChoices } from './workspace-data.js';
import { MAX_WORKSPACE_TRANSFER_BYTES } from './workspace-data.js';

export type User = { id: string; name: string; email: string };
export type AccountPolicy = { emailVerificationRequired: boolean; passwordResetAvailable: boolean };
export type ImportPreview = {
  summary: {
    recipes: number;
    plannedMeals: number;
    foodEntries: number;
    workoutTemplates: number;
    workouts: number;
    checkIns: number;
    recipeRequests: number;
    trainingRequests: number;
    reviews: number;
    bytes: number;
  };
  canImport: boolean;
  revision: number;
};

const base = oc.$meta({ maxBodyBytes: 1024, public: false }).errors({
  SIGN_IN_REQUIRED: { status: 401 },
  CORNER_ERROR: {
    data: z.object({
      code: z.string(),
      details: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
    }),
  },
  SERVICE_UNAVAILABLE: { status: 503 },
});
const empty = z.void();
const publicProcedure = base.meta({ maxBodyBytes: 1024, public: true });
const importing = base.meta({ maxBodyBytes: MAX_WORKSPACE_TRANSFER_BYTES + 65536, public: false });

/** Application contract only; managed Auth keeps its own protocol. */
export const contract = {
  account: {
    policy: publicProcedure.input(empty).output(type<AccountPolicy>()),
    session: publicProcedure.input(empty).output(type<{ user: User | null }>()),
  },
  workspace: {
    get: base.input(empty).output(type<Bootstrap>()),
    foodWindow: base.input(foodWindowSchema).output(type<FoodWindow>()),
    page: base.input(recordPageSchema).output(type<RecordPage>()),
    details: base
      .meta({ maxBodyBytes: 48 * 1024, public: false })
      .input(detailsSchema)
      .output(type<RecordDetails>()),
    groceries: base.input(groceriesSchema).output(type<GroceryWindow>()),
    progress: base.input(rangeSchema).output(type<Progress>()),
    exerciseHistory: base.input(exerciseHistorySchema).output(type<ExerciseHistoryPage>()),
    exerciseChoices: base.input(exerciseChoicesSchema).output(type<ExerciseChoices>()),
    prefill: base
      .meta({ maxBodyBytes: 192 * 1024, public: false })
      .input(prefillSchema)
      .output(type<PrefillHistory>()),
    export: base.input(empty).output(type<{ state: AppState; revision: number }>()),
    // Transport preserves raw mutations for store validation and original-payload fingerprinting.
    mutate: base
      .meta({ maxBodyBytes: 192 * 1024, public: false })
      .input(type<WorkspaceMutationInput>())
      .output(type<CommandResult>()),
    previewImport: importing.input(importPreviewInputSchema).output(type<ImportPreview>()),
    import: importing.input(importInputSchema).output(type<CommandResult>()),
  },
};
export type ApiClient = ContractRouterClient<typeof contract>;
