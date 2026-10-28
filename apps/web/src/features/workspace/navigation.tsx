import {
  Home,
  Sparkles,
  CalendarDays,
  UtensilsCrossed,
  ShoppingBasket,
  Dumbbell,
} from 'lucide-react';
import type { View } from './types';

export const viewPaths: Record<View, string> = {
  today: '/',
  agent: '/agent',
  workouts: '/workouts',
  planner: '/planner',
  recipes: '/recipes',
  groceries: '/groceries',
  settings: '/settings',
};
export const isNutritionView = (v: View): v is 'planner' | 'recipes' | 'groceries' =>
  v === 'planner' || v === 'recipes' || v === 'groceries';
export const sidebarGroups = [
  {
    items: [
      {
        id: 'today' as const,
        label: 'Today',
        href: viewPaths.today,
        icon: <Home size={18} strokeWidth={1.8} />,
      },
      {
        id: 'agent' as const,
        label: 'My agent',
        href: viewPaths.agent,
        icon: <Sparkles size={18} strokeWidth={1.8} />,
      },
    ],
  },
  {
    label: 'Nutrition',
    items: [
      {
        id: 'planner' as const,
        label: 'Meal planner',
        href: viewPaths.planner,
        icon: <CalendarDays size={18} strokeWidth={1.8} />,
      },
      {
        id: 'recipes' as const,
        label: 'Recipes',
        href: viewPaths.recipes,
        icon: <UtensilsCrossed size={18} strokeWidth={1.8} />,
      },
      {
        id: 'groceries' as const,
        label: 'Grocery list',
        href: viewPaths.groceries,
        icon: <ShoppingBasket size={18} strokeWidth={1.8} />,
      },
    ],
  },
  {
    label: 'Training',
    items: [
      {
        id: 'workouts' as const,
        label: 'Workouts',
        href: viewPaths.workouts,
        icon: <Dumbbell size={18} strokeWidth={1.8} />,
      },
    ],
  },
];
