import type { Settings } from '@packages/workspace/types';
import type { FoodEntry, Macros, PlanEntry, Recipe } from '@packages/nutrition/types';
import type { GroceryWindow, RecordPage, RecordPageInput, Resources } from '@packages/api/workspace-data';
import { useState } from 'react';
import { rpc, useObservedRevision, useResource, workspaceRevision } from '../../rpc';

export type NutritionWindow = {
  revision: number;
  settings: Settings;
  plan: PlanEntry[];
  recipes: Recipe[];
  training: { sessions: Resources['sessions'][]; scheduledDates: string[] };
  loggedPlanIds: string[];
};
export function requireRevision(expected: number, actual: number) {
  if (expected !== actual) throw new Error('Your data changed while loading. Please retry.');
}
export async function calendarPage<K extends 'plan' | 'sessions' | 'scheduledDates'>(
  resource: K, from: string, through: string, signal: AbortSignal,
) {
  const items: Resources[K][] = [];
  const loggedPlanIds: string[] = [];
  let cursor: RecordPageInput['cursor'];
  let revision: number | undefined;
  do {
    const page = await rpc.workspace.page({ resource, from, through, limit: 100, cursor }, { signal }) as RecordPage<K>;
    if (revision !== undefined) requireRevision(revision, page.revision);
    revision = page.revision;
    items.push(...page.items);
    loggedPlanIds.push(...page.loggedPlanIds);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return { revision: revision!, items, loggedPlanIds };
}
export async function nutritionWindow(from: string, through: string, signal: AbortSignal): Promise<NutritionWindow> {
  const [bootstrap, plan, sessions, scheduledDates] = await Promise.all([
    rpc.workspace.get(undefined, { signal }), calendarPage('plan', from, through, signal),
    calendarPage('sessions', from, through, signal), calendarPage('scheduledDates', from, through, signal),
  ]);
  for (const result of [plan, sessions, scheduledDates]) requireRevision(bootstrap.revision, result.revision);
  const ids = [...new Set(plan.items.map((entry) => entry.recipeId))];
  const recipes: Recipe[] = [];
  for (let index = 0; index < ids.length; index += 100) {
    const details = await rpc.workspace.details({ recipeIds: ids.slice(index, index + 100) }, { signal });
    requireRevision(bootstrap.revision, details.revision);
    recipes.push(...details.recipes);
  }
  return { revision: bootstrap.revision, settings: bootstrap.settings, plan: plan.items, recipes,
    training: { sessions: sessions.items, scheduledDates: scheduledDates.items }, loggedPlanIds: plan.loggedPlanIds };
}
export async function foodDay(date: string, signal: AbortSignal) {
  const entries: FoodEntry[] = [];
  let cursor: { revision: number; date: string; position: number; id: string } | undefined;
  let revision: number | undefined;
  let totals: Macros | undefined;
  do {
    const page = await rpc.workspace.foodWindow({ from: date, through: date, limit: 200, cursor }, { signal });
    if (revision !== undefined) requireRevision(revision, page.revision);
    revision = page.revision;
    totals = page.totals;
    entries.push(...page.entries);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return { revision: revision!, entries, totals: totals! };
}

export function useRecordPage<K extends keyof Resources>(
  input: Omit<RecordPageInput, 'resource' | 'cursor'> & { resource: K }, enabled = true,
) {
  const revision = useObservedRevision();
  const signature = JSON.stringify([input, revision]);
  const [navigation, setNavigation] = useState<{ signature: string; cursors: Array<RecordPageInput['cursor']> }>({ signature, cursors: [undefined] });
  const cursors = navigation.signature === signature ? navigation.cursors : [undefined];
  const cursor = cursors[cursors.length - 1];
  const query = useResource(input.resource, { ...input, cursor },
    // Invalidation can refetch before React has rendered the reset navigation.
    (signal) => rpc.workspace.page({ ...input, cursor: cursor && cursor.revision >= workspaceRevision() ? cursor : undefined }, { signal }) as Promise<RecordPage<K>>, enabled);
  const reset = () => setNavigation({ signature, cursors: [undefined] });
  return { ...query,
    paging: {
      hasPrevious: cursors.length > 1,
      hasNext: Boolean(query.data?.nextCursor),
      busy: query.isFetching,
      previous: () => setNavigation({ signature, cursors: cursors.slice(0, -1) }),
      next: () => {
        if (query.data?.nextCursor)
          setNavigation({ signature, cursors: [...cursors, query.data.nextCursor] });
      },
    },
    reload: () => { reset(); if (!cursor) void query.refetch(); },
  };
}

export async function groceryWeek(weekStart: string, signal: AbortSignal): Promise<GroceryWindow> {
  const items: GroceryWindow['items'] = [];
  const checks: GroceryWindow['checks'] = {};
  let cursor: NonNullable<GroceryWindow['nextCursor']> | undefined;
  let revision: number | undefined;
  do {
    const page = await rpc.workspace.groceries({ weekStart, limit: 200, cursor }, { signal });
    if (revision !== undefined) requireRevision(revision, page.revision);
    revision = page.revision;
    items.push(...page.items);
    Object.assign(checks, page.checks);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  items.sort((a, b) => a.aisle.localeCompare(b.aisle) || a.name.localeCompare(b.name));
  return { revision: revision!, items, checks, nextCursor: null };
}

export function useCursorResource<T extends { revision: number; nextCursor?: { revision: number } | null }>(
  family: string, parameters: unknown,
  operation: (cursor: NonNullable<T['nextCursor']> | undefined, signal: AbortSignal) => Promise<T>,
  enabled = true,
) {
  type Cursor = NonNullable<T['nextCursor']> | undefined;
  const revision = useObservedRevision();
  const signature = JSON.stringify([parameters, revision]);
  const [navigation, setNavigation] = useState<{ signature: string; cursors: Cursor[] }>({ signature, cursors: [undefined] });
  const cursors: Cursor[] = navigation.signature === signature ? navigation.cursors : [undefined];
  const cursor = cursors[cursors.length - 1];
  const query = useResource(family, { parameters, cursor },
    (signal) => operation(cursor && cursor.revision >= workspaceRevision() ? cursor : undefined, signal), enabled);
  return { ...query, paging: {
    hasPrevious: cursors.length > 1, hasNext: Boolean(query.data?.nextCursor), busy: query.isFetching,
    previous: () => setNavigation({ signature, cursors: cursors.slice(0, -1) }),
    next: () => {
      if (query.data?.nextCursor)
        setNavigation({ signature, cursors: [...cursors, query.data.nextCursor as NonNullable<T['nextCursor']>] });
    },
  }, reload: () => {
    setNavigation({ signature, cursors: [undefined] });
    if (!cursor) void query.refetch();
  } };
}
