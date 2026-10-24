import type { AppState, FoodEntry, MealSlot, Mutation, Recipe } from '@packages/shared/types';

export type View =
  | 'agent'
  | 'today'
  | 'workouts'
  | 'planner'
  | 'recipes'
  | 'groceries'
  | 'studio'
  | 'settings';

export type Overlay =
  | { kind: 'recipe'; recipe: Recipe }
  | { kind: 'recipeForm'; recipe?: Recipe }
  | { kind: 'food'; food?: FoodEntry }
  | { kind: 'pick'; date: string; slot: MealSlot; recipeId?: string }
  | null;

export type ApiPayload = {
  state?: AppState;
  revision?: number;
  aiAvailable?: boolean;
  recipe?: Recipe;
  code?: string;
  error?: string | { message?: string; code?: string };
};

export type CornerAppProps = {
  initialState: AppState;
  preview: boolean;
  displayName: string;
  initialRevision?: number;
  accountEmail?: string;
  signingOut?: boolean;
  onSignOut?: () => void;
  onSessionExpired?: () => void;
};

export type Mutate = (mutation: Mutation, success?: string) => Promise<boolean>;
export type Notify = (message: string, error?: boolean) => void;
export type Confirmation = { title: string; description: string; confirm: () => Promise<boolean> };
