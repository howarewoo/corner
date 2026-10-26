import { z } from 'zod';
import {
  DateSchema,
  MacrosSchema,
  PlanEntrySchema,
  RecipeSchema,
} from '@packages/nutrition/schemas';
import type { Recipe } from '@packages/nutrition/types';
import {
  WorkoutSessionSchema,
  WorkoutTemplateSchema,
  hasRecordedData,
  prepareTrainingCommand,
} from '@packages/training/workouts';
import { getCatalogExercise } from '@packages/training/exercise-catalog';
import { MutationSchema } from '@packages/workspace/mutations';
import type { AppState, Mutation } from '@packages/workspace/types';

const id = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_:.\-]+$/);
const text = (max: number) => z.string().trim().min(1).max(max);
const common = { label: text(200), reason: text(1600) };

export const AgentChangeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('recipe'), ...common, data: RecipeSchema }),
  z.object({ type: z.literal('meal'), ...common, data: PlanEntrySchema }),
  z.object({ type: z.literal('workout'), ...common, data: WorkoutSessionSchema }),
  z.object({ type: z.literal('routine'), ...common, data: WorkoutTemplateSchema }),
  z.object({
    type: z.literal('targets'),
    ...common,
    data: z.object({ training: MacrosSchema, rest: MacrosSchema }).strict(),
  }),
  z.object({ type: z.literal('remove_meal'), ...common, data: z.object({ id }).strict() }),
  z.object({ type: z.literal('remove_workout'), ...common, data: z.object({ id }).strict() }),
]);
export const AgentResultSchema = z
  .object({
    status: z.enum(['needs_details', 'proposal', 'answer']),
    title: text(160),
    message: text(16000),
    questions: z.array(text(600)).max(6),
    changes: z.array(AgentChangeSchema).max(100),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.status === 'proposal' && !result.changes.length)
      context.addIssue({ code: 'custom', message: 'A proposal needs at least one change.' });
    if (result.status !== 'proposal' && result.changes.length)
      context.addIssue({ code: 'custom', message: 'Only a proposal can contain changes.' });
    if (result.status === 'needs_details' && !result.questions.length)
      context.addIssue({
        code: 'custom',
        message: 'Ask a specific question when more details are needed.',
      });
  });
export type AgentChange = z.infer<typeof AgentChangeSchema>;
export type AgentResult = z.infer<typeof AgentResultSchema>;
export const AgentRequestSchema = z
  .object({ requestId: id, prompt: text(6000).min(3), referenceDate: DateSchema })
  .strict();
export type AgentRequest = z.infer<typeof AgentRequestSchema>;
export type AgentRun = {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'applied';
  prompt: string;
  referenceDate: string;
  baseRevision: number;
  createdAt: string;
  updatedAt: string;
  result?: AgentResult;
  error?: string;
};

/** Only existing rows addressed by the proposal, plus its live recipe references. */
export type ProposalDependencies = Pick<AppState, 'settings' | 'recipes' | 'plan'> & {
  training: Pick<AppState['training'], 'sessions' | 'templates'>;
};

/** Convert a proposal to the same validated domain operations used by the UI.
 * Only planning operations are permitted; intake and completed work are never generated. */
export function proposalMutations(
  state: ProposalDependencies,
  raw: unknown,
  now = new Date().toISOString(),
): { result: AgentResult; mutations: Mutation[] } {
  const result = AgentResultSchema.parse(raw);
  if (result.status !== 'proposal') return { result, mutations: [] };
  const seen = new Set<string>();
  const mutations: Mutation[] = [];
  const priorities = {
    recipe: 0,
    routine: 1,
    targets: 2,
    remove_meal: 3,
    remove_workout: 3,
    meal: 4,
    workout: 5,
  };
  const changes = result.changes.slice().sort((a, b) => priorities[a.type] - priorities[b.type]);
  for (const change of changes) {
    const entity = change.type.replace('remove_', '');
    const key = entity + ':' + ('id' in change.data ? change.data.id : 'targets');
    if (seen.has(key)) throw new Error('A proposal can change each item only once.');
    seen.add(key);
    if (change.type === 'recipe') {
      validateRecipeEstimate(change.data);
      const existing = state.recipes.find((item) => item.id === change.data.id);
      const data = {
        ...change.data,
        source: 'ai' as const,
        createdAt: existing?.createdAt ?? now,
        favorite: existing?.favorite ?? false,
      };
      delete data.pdf;
      mutations.push({ type: 'recipe.save', data });
      change.data = data;
    } else if (change.type === 'meal') {
      mutations.push({ type: 'plan.save', data: change.data });
    } else if (change.type === 'remove_meal') {
      if (!state.plan.some((item) => item.id === change.data.id))
        throw new Error('The meal to remove no longer exists.');
      mutations.push({ type: 'plan.delete', data: change.data });
    } else if (change.type === 'targets') {
      for (const target of [change.data.training, change.data.rest]) {
        if (target.calories <= 0 || target.protein <= 0 || target.carbs < 0 || target.fat <= 0)
          throw new Error('Nutrition targets must include positive calories, protein, and fat.');
        const energy = target.protein * 4 + target.carbs * 4 + target.fat * 9;
        if (Math.abs(energy - target.calories) > Math.max(150, target.calories * 0.15))
          throw new Error('The calorie and macro targets are inconsistent.');
      }
      mutations.push({
        type: 'settings.save',
        data: {
          ...state.settings,
          ...change.data,
          setup: {
            completedAt: state.settings.setup?.completedAt ?? now,
            nutritionTargetsSet: true,
          },
        },
      });
    } else if (change.type === 'routine') {
      checkCatalog(change.data.exercises);
      const existing = state.training.templates.find((item) => item.id === change.data.id);
      const data = { ...change.data, createdAt: existing?.createdAt ?? now, updatedAt: now };
      mutations.push({ type: 'training.template.save', data });
      change.data = data;
    } else {
      const existing = state.training.sessions.find((item) => item.id === change.data.id);
      if (
        existing &&
        (existing.status !== 'planned' || hasRecordedData(existing) || existing.readiness !== null)
      )
        throw new Error(
          'The agent cannot replace or remove workouts you have started, partially logged, finished, or skipped.',
        );
      if (change.type === 'remove_workout') {
        if (!existing) throw new Error('The workout to remove no longer exists.');
        mutations.push({
          type: 'training.session.delete',
          data: { id: existing.id, expectedUpdatedAt: existing.updatedAt },
        });
      } else {
        const session = change.data;
        if (
          session.status !== 'planned' ||
          session.durationMinutes !== null ||
          session.rounds !== null ||
          session.sessionRpe !== null ||
          session.readiness !== null ||
          session.exercises.some((exercise) =>
            exercise.sets.some(
              (set) =>
                set.completed || set.weight !== null || set.reps !== null || set.rir !== null,
            ),
          )
        )
          throw new Error(
            'A proposed workout may contain targets, but cannot contain completed work or actual results. Keep set weight/reps/rir null; put proposed loads in exercise.targetLoad and use repMin/repMax/targetRir.',
          );
        checkCatalog(session.exercises);
        if (session.kind === 'strength' && !session.exercises.length)
          throw new Error('A strength workout needs at least one exercise.');
        const data = {
          ...session,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          changeReason: change.reason,
        };
        mutations.push({
          type: 'training.session.save',
          data: { session: data, expectedUpdatedAt: existing?.updatedAt ?? null },
        });
        change.data = data;
      }
    }
  }
  const availableRecipes = new Set(state.recipes.map((recipe) => recipe.id));
  for (const mutation of mutations) {
    const parsed = MutationSchema.parse(mutation);
    if (parsed.type === 'recipe.save') availableRecipes.add(parsed.data.id);
    if (parsed.type === 'plan.save' && !availableRecipes.has(parsed.data.recipeId))
      throw new Error('That recipe is no longer available. Refresh and choose a recipe.');
    if (
      parsed.type === 'training.session.save' ||
      parsed.type === 'training.session.delete' ||
      parsed.type === 'training.template.save'
    ) prepareTrainingCommand(parsed, {
      sessions: state.training.sessions, templates: state.training.templates,
      requests: [], reviews: [], scheduledDates: [],
    });
  }
  return { result, mutations };
}

export function validateRecipeEstimate(recipe: Recipe) {
  const { calories, protein, carbs, fat } = recipe.nutrition;
  if (
    calories < 50 ||
    calories > 3000 ||
    Math.abs(calories - (protein * 4 + carbs * 4 + fat * 9)) > Math.max(120, calories * 0.25)
  )
    throw new Error('The estimated recipe calories and macros are inconsistent for one serving.');
  if (
    recipe.ingredients.some(
      (ingredient) => ingredient.shoppingQuantity === undefined || !ingredient.shoppingUnit,
    )
  )
    throw new Error('Every ingredient needs a purchase quantity and unit for the grocery list.');
}

function checkCatalog(exercises: Array<{ catalogId?: string; repMin: number; repMax: number }>) {
  for (const exercise of exercises) {
    if (exercise.catalogId && !getCatalogExercise(exercise.catalogId))
      throw new Error('A proposed exercise references an unknown catalog entry.');
    if (exercise.repMin > exercise.repMax)
      throw new Error('Exercise repetition ranges must be in order.');
  }
}
