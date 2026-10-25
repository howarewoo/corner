import { weekDates } from '@packages/nutrition/dates';
import type { Macros } from '@packages/nutrition/types';
import { targetForStateDate } from './targets.js';
import type { AppState } from './types.js';

export type MealPlanDaySummary = {
  date: string;
  planned: Macros;
  target: Macros;
  plannedMealCount: number;
};
export type MealPlanSummary = {
  weekStart: string;
  weekEnd: string;
  days: MealPlanDaySummary[];
  planned: Macros;
  target: Macros;
  averagePlanned: Macros;
  averageTarget: Macros;
  plannedMealCount: number;
  plannedDayCount: number;
};

const emptyMacros = (): Macros => ({ calories: 0, protein: 0, carbs: 0, fat: 0 });
const add = (total: Macros, value: Macros, servings = 1): Macros => ({
  calories: total.calories + value.calories * servings,
  protein: total.protein + value.protein * servings,
  carbs: total.carbs + value.carbs * servings,
  fat: total.fat + value.fat * servings,
});
const average = (value: Macros, dayCount: number): Macros => ({
  calories: value.calories / dayCount,
  protein: value.protein / dayCount,
  carbs: value.carbs / dayCount,
  fat: value.fat / dayCount,
});

/** Keep precision through aggregation; formatting is the only rounding step. */
export function getMealPlanSummary(state: AppState, selectedDate: string): MealPlanSummary {
  const dates = weekDates(selectedDate);
  const recipes = new Map(state.recipes.map((recipe) => [recipe.id, recipe]));
  const days: MealPlanDaySummary[] = dates.map((date) => ({
    date,
    planned: emptyMacros(),
    target: { ...targetForStateDate(state, date) },
    plannedMealCount: 0,
  }));
  const byDate = new Map(days.map((day) => [day.date, day]));
  for (const entry of state.plan) {
    const day = byDate.get(entry.date);
    const recipe = recipes.get(entry.recipeId);
    if (!day || !recipe) continue;
    day.planned = add(day.planned, recipe.nutrition, entry.servings);
    day.plannedMealCount += 1;
  }
  const planned = days.reduce((total, day) => add(total, day.planned), emptyMacros());
  const target = days.reduce((total, day) => add(total, day.target), emptyMacros());
  return {
    weekStart: dates[0],
    weekEnd: dates[dates.length - 1],
    days,
    planned,
    target,
    averagePlanned: average(planned, dates.length),
    averageTarget: average(target, dates.length),
    plannedMealCount: days.reduce((total, day) => total + day.plannedMealCount, 0),
    plannedDayCount: days.filter((day) => day.plannedMealCount > 0).length,
  };
}
