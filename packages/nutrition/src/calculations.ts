import { weekDates } from './dates.js';
import type { GroceryItem, Macros, PlanEntry, Recipe } from './types.js';

export function macroTotal(items: Array<{ nutrition: Macros; servings: number }>): Macros {
  const total = items.reduce(
    (sum, item) => ({
      calories: sum.calories + item.nutrition.calories * item.servings,
      protein: sum.protein + item.nutrition.protein * item.servings,
      carbs: sum.carbs + item.nutrition.carbs * item.servings,
      fat: sum.fat + item.nutrition.fat * item.servings,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
  return {
    calories: Math.round(total.calories),
    protein: Math.round(total.protein * 10) / 10,
    carbs: Math.round(total.carbs * 10) / 10,
    fat: Math.round(total.fat * 10) / 10,
  };
}

export function groceryList(
  state: { recipes: Recipe[]; plan: PlanEntry[] },
  weekStart: string,
): GroceryItem[] {
  const days = new Set(weekDates(weekStart));
  const recipes = new Map(state.recipes.map((recipe) => [recipe.id, recipe]));
  const items = new Map<string, GroceryItem>();
  for (const entry of state.plan.filter((entry) => days.has(entry.date))) {
    for (const ingredient of recipes.get(entry.recipeId)?.ingredients ?? []) {
      if (ingredient.optional || ingredient.name.trim().toLowerCase() === 'water') continue;
      const quantity = (ingredient.shoppingQuantity ?? ingredient.quantity) * entry.servings;
      if (quantity <= 0) continue;
      const unit = ingredient.shoppingUnit ?? ingredient.unit;
      const key = `${ingredient.name.trim().toLowerCase()}|${unit.trim().toLowerCase()}`;
      const current = items.get(key) ?? {
        key,
        name: ingredient.name,
        quantity: 0,
        unit,
        aisle: ingredient.aisle,
        notes: [],
      };
      current.quantity += quantity;
      if (ingredient.note && !current.notes.includes(ingredient.note))
        current.notes.push(ingredient.note);
      items.set(key, current);
    }
  }
  return [...items.values()]
    .map((item) => ({ ...item, quantity: Math.round(item.quantity * 100) / 100 }))
    .sort((a, b) => a.aisle.localeCompare(b.aisle) || a.name.localeCompare(b.name));
}
