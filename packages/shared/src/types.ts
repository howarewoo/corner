import type { TrainingMutation, TrainingState } from './training-types.js';

export type Macros = { calories: number; protein: number; carbs: number; fat: number };
export type RecipeCategory = 'breakfast' | 'main' | 'snack';
export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'fuel';
export type Ingredient = {
  name: string; quantity: number; unit: string; display?: string; note?: string;
  shoppingQuantity?: number; shoppingUnit?: string; aisle: string; optional?: boolean;
};
export type Recipe = {
  id: string; name: string; description: string; category: RecipeCategory;
  prepMinutes: number; cookMinutes: number; nutrition: Macros; ingredients: Ingredient[];
  steps: string[]; storage: string; variation: string; tags: string[];
  color: string; source: 'plan' | 'manual' | 'ai'; favorite: boolean;
  pdf?: string; createdAt: string; nutritionNote?: string;
};
export type PlanEntry = { id: string; date: string; slot: MealSlot; recipeId: string; servings: number };
export type FoodEntry = {
  id: string; date: string; slot: MealSlot; name: string; nutrition: Macros;
  servings: number; recipeId?: string; planEntryId?: string; createdAt: string;
};
export type Settings = {
  name: string; timezone: string; training: Macros; rest: Macros;
  schedule: Record<string,string>;
  profile?: {
    goals: string; experience: string; sessionMinutes: number;
    dietaryPreferences: string; groceryPreferences: string; equipment: string;
    defaultWorkoutUnit: 'lb' | 'kg'; constraints: string;
  };
  setup?: { completedAt: string | null; nutritionTargetsSet: boolean };
};
export type RecipeRequest = {
  id: string; prompt: string; calories: number; protein: number; maxMinutes: number;
  status: 'pending' | 'fulfilled'; createdAt: string; recipeId?: string;
};
export type AppState = {
  recipes: Recipe[]; plan: PlanEntry[]; logs: FoodEntry[]; settings: Settings;
  groceryChecks: Record<string,boolean>; requests: RecipeRequest[];
  training: TrainingState;
};
export type Mutation = { type: 'recipe.save' | 'recipe.delete' | 'recipe.favorite' | 'plan.save' | 'plan.delete' | 'plan.week' | 'log.save' | 'log.delete' | 'settings.save' | 'grocery.check' | 'request.save' | 'request.fulfill'; data: any } | TrainingMutation;
export type StateResponse = { state: AppState; revision: number; aiAvailable: boolean };
export type GroceryItem = { key: string; name: string; quantity: number; unit: string; aisle: string; notes: string[] };
export const SLOTS: MealSlot[] = ['breakfast','lunch','dinner','snack','fuel'];
