import { oc, type, type ContractRouterClient } from '@orpc/contract';
import { z } from 'zod';
import { AgentRequestSchema, type AgentRun } from '@packages/agent/proposals';
import { RecipeSchema } from '@packages/nutrition/schemas';
import { FoodEstimateResultSchema } from '@packages/nutrition/food-estimate';
import type { StateResponse } from '@packages/workspace/types';
import {
  applyInputSchema,
  FoodInputSchema,
  importInputSchema,
  importPreviewInputSchema,
  RecipeInputSchema,
  runInputSchema,
  type WorkspaceMutationInput,
} from './schemas.js';

export type User = { id: string; name: string; email: string };
export type AccountPolicy = { emailVerificationRequired: boolean; passwordResetAvailable: boolean };
export type Connection = {
  available: boolean;
  connected: boolean;
  enabled: boolean;
  reason?: string;
  state: string;
  model: string | null;
  models: Array<{ slug: string; displayName: string }>;
  email?: string;
  manageUsageUrl?: string | null;
};
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
const draft = base.meta({ maxBodyBytes: 12 * 1024, public: false });
const importing = base.meta({ maxBodyBytes: 2 * 1024 * 1024, public: false });

/** Application contract only; managed Auth and OAuth redirects keep their own protocols. */
export const contract = {
  account: {
    policy: publicProcedure.input(empty).output(type<AccountPolicy>()),
    session: publicProcedure.input(empty).output(type<{ user: User | null }>()),
  },
  workspace: {
    get: base.input(empty).output(type<StateResponse>()),
    // The store validates the original mutation after fingerprinting. Transport must not normalize it first.
    mutate: base
      .meta({ maxBodyBytes: 192 * 1024, public: false })
      .input(type<WorkspaceMutationInput>())
      .output(type<StateResponse>()),
    previewImport: importing.input(importPreviewInputSchema).output(type<ImportPreview>()),
    import: importing.input(importInputSchema).output(type<StateResponse>()),
  },
  ai: {
    connection: base.input(empty).output(type<Connection>()),
    connect: base.input(z.object({}).strict()).output(type<{ url: string }>()),
    disconnect: base
      .input(z.object({}).strict())
      .output(type<Connection & { revocationConfirmed?: boolean }>()),
    setModel: base
      .input(z.object({ model: z.string().min(1).max(160) }).strict())
      .output(type<Connection>()),
    generateRecipe: draft
      .input(RecipeInputSchema)
      .output(z.object({ recipe: z.unknown().pipe(RecipeSchema), draft: z.literal(true) })),
    estimateFood: draft
      .input(FoodInputSchema)
      .output(z.object({ estimate: z.unknown().pipe(FoodEstimateResultSchema) })),
  },
  agent: {
    list: base.input(empty).output(type<{ runs: AgentRun[] }>()),
    get: base.input(runInputSchema).output(type<{ run: AgentRun }>()),
    start: draft.input(AgentRequestSchema).output(type<{ run: AgentRun }>()),
    cancel: base.input(runInputSchema).output(type<{ run: AgentRun }>()),
    apply: base.input(applyInputSchema).output(type<StateResponse & { run: AgentRun }>()),
  },
};
export type ApiClient = ContractRouterClient<typeof contract>;
