import type {
  FoodEntry,
  Macros,
  PlanEntry,
  Recipe,
  RecipeRequest,
} from '@packages/nutrition/types';
import type { TrainingMutation, TrainingState } from '@packages/training/types';

export type Settings = {
  name: string;
  timezone: string;
  training: Macros;
  rest: Macros;
  schedule: Record<string, string>;
  profile?: {
    goals: string;
    experience: string;
    sessionMinutes: number;
    dietaryPreferences: string;
    groceryPreferences: string;
    equipment: string;
    defaultWorkoutUnit: 'lb' | 'kg';
    constraints: string;
  };
  setup?: { completedAt: string | null; nutritionTargetsSet: boolean };
};
export type AppState = {
  recipes: Recipe[];
  plan: PlanEntry[];
  logs: FoodEntry[];
  settings: Settings;
  groceryChecks: Record<string, boolean>;
  requests: RecipeRequest[];
  training: TrainingState;
};
export type Mutation =
  | {
      type:
        | 'recipe.save'
        | 'recipe.delete'
        | 'recipe.favorite'
        | 'plan.save'
        | 'plan.delete'
        | 'plan.week'
        | 'log.save'
        | 'log.delete'
        | 'settings.save'
        | 'grocery.check'
        | 'request.save'
        | 'request.fulfill';
      data: any;
    }
  | TrainingMutation;
export type StateResponse = { state: AppState; revision: number; aiAvailable: boolean };
