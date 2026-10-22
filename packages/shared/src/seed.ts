import type { AppState, PlanEntry, Recipe, Settings } from './types.js';
import { createTrainingState } from './training.js';

export const DEFAULT_PROFILE: NonNullable<Settings['profile']> = {
  goals: '', experience: '', sessionMinutes: 45, dietaryPreferences: '',
  groceryPreferences: '', equipment: '', defaultWorkoutUnit: 'lb', constraints: '',
};
export const DEFAULT_SETTINGS: Settings = {
  name: 'Your workspace', timezone: 'UTC',
  training: { calories: 0, protein: 0, carbs: 0, fat: 0 },
  rest: { calories: 0, protein: 0, carbs: 0, fat: 0 },
  schedule: { '0': 'rest', '1': 'rest', '2': 'rest', '3': 'rest', '4': 'rest', '5': 'rest', '6': 'rest' },
  profile: DEFAULT_PROFILE,
  setup: { completedAt: null, nutritionTargetsSet: false },
};
// New accounts contain only their own records. No personal sample plan is installed.
export const SEED_RECIPES: Recipe[] = [];
export function starterWeek(_date?: string): PlanEntry[] { return []; }
export function createInitialState(name?: string): AppState {
  const settings = structuredClone(DEFAULT_SETTINGS);
  if (name?.trim()) settings.name = name.trim().slice(0, 80);
  return { recipes: [], plan: [], logs: [], settings, groceryChecks: {}, requests: [], training: createTrainingState() };
}
