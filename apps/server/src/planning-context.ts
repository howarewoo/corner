import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { AgentResultSchema, type ProposalDependencies } from '@packages/agent/proposals';
import { createInitialState } from '@packages/workspace/initial-state';
import { SettingsSchema } from '@packages/workspace/mutations';
import type { Database, Transaction } from './queries.js';
import * as tables from './schema.js';
import { ApiError } from './http.js';
import { planRecord, recipeRecord } from './nutrition-records.js';
import { checkInRecord, sessionRecords, templateRecord } from './training-records.js';
import { consistentRead } from './workspace-queries.js';
import type { AppState, Settings } from '@packages/workspace/types';
import type { Recipe, PlanEntry, Macros } from '@packages/nutrition/types';
import type { WorkoutSession, WorkoutTemplate, WorkoutExercise } from '@packages/training/types';
import { WorkoutSessionSchema, WorkoutTemplateSchema } from '@packages/training/workouts';

export type PlanningHistory = {
  nutrition: Array<{ date: string; loggedTotals: Macros; entryCount: number }>;
  training: Array<Pick<WorkoutSession, 'id' | 'date' | 'name' | 'kind' | 'status' | 'unit' | 'durationMinutes' | 'sessionRpe' | 'notes'> & {
    exercises: Array<Pick<WorkoutExercise, 'name' | 'catalogId' | 'loadType' | 'sets'>>;
  }>;
  checkIns: AppState['training']['checkIns'];
  note: string;
};
export type PlanningSnapshot = {
  revision: number;
  context: {
    settings: Settings;
    recipes: Array<Pick<Recipe, 'id' | 'name' | 'category' | 'nutrition' | 'prepMinutes' | 'cookMinutes' | 'tags'>>;
    meals: PlanEntry[];
    workouts: Array<Pick<WorkoutSession, 'id' | 'date' | 'name' | 'kind' | 'status' | 'unit' | 'plannedMinutes'>>;
    routines: Array<Pick<WorkoutTemplate, 'id' | 'name' | 'kind' | 'description' | 'durationMinutes'>>;
    recentHistory: PlanningHistory;
    limits: string;
  };
};

export type RecipeContext = {
  revision: number;
  settings: Settings;
  existingRecipes: string[];
};

export async function recipeContext(db: Database, userId: string): Promise<RecipeContext> {
  return consistentRead(db, userId, async (connection, revision) => ({
    revision,
    settings: await settings(connection, userId),
    existingRecipes: (await connection.select({ name: tables.recipes.name }).from(tables.recipes)
      .where(eq(tables.recipes.user_id, userId)).orderBy(asc(tables.recipes.position)).limit(30))
      .map((recipe) => recipe.name),
  }));
}

function shift(date: string, days: number) {
  const result = new Date(date + 'T12:00:00Z'); result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}
export function requireContextRevision(revision: number, expected: number): void {
  if (revision !== expected) throw new ApiError(409, 'STALE_PROPOSAL',
    'Your workspace changed after this proposal was requested. Ask for a fresh proposal so those changes are preserved.');
}
async function settings(connection: Transaction, userId: string) {
  const [row] = await connection.select({ settings: tables.workspaceMetadata.settings, timezone: tables.workspaceMetadata.timezone })
    .from(tables.workspaceMetadata).where(eq(tables.workspaceMetadata.user_id, userId)).limit(1);
  return row ? SettingsSchema.parse({ ...row.settings, timezone: row.timezone }) : createInitialState().settings;
}
async function history(connection: Transaction, userId: string, date: string, days: number): Promise<PlanningHistory> {
  const from = shift(date, -days + 1);
  const totals = await connection.select({ date: tables.foodEntries.date,
    calories: sql<number>`round(sum(${tables.foodEntries.calories} * ${tables.foodEntries.servings}))::float8`,
    protein: sql<number>`round((sum(${tables.foodEntries.protein} * ${tables.foodEntries.servings}) * 10)::numeric) / 10`,
    carbs: sql<number>`round((sum(${tables.foodEntries.carbs} * ${tables.foodEntries.servings}) * 10)::numeric) / 10`,
    fat: sql<number>`round((sum(${tables.foodEntries.fat} * ${tables.foodEntries.servings}) * 10)::numeric) / 10`,
    count: sql<number>`count(*)::int`,
  }).from(tables.foodEntries).where(and(eq(tables.foodEntries.user_id, userId), gte(tables.foodEntries.date, from), lte(tables.foodEntries.date, date)))
    .groupBy(tables.foodEntries.date).orderBy(asc(tables.foodEntries.date));
  const sessions = await sessionRecords(connection, userId, await connection.select().from(tables.workoutSessions)
    .where(and(eq(tables.workoutSessions.user_id, userId), gte(tables.workoutSessions.date, from), lte(tables.workoutSessions.date, date), inArray(tables.workoutSessions.status, ['in_progress', 'completed'])))
    .orderBy(desc(tables.workoutSessions.position)).limit(40));
  const checks = await connection.select().from(tables.checkIns)
    .where(and(eq(tables.checkIns.user_id, userId), gte(tables.checkIns.date, from), lte(tables.checkIns.date, date)))
    .orderBy(desc(tables.checkIns.position)).limit(30);
  return {
    nutrition: totals.map((row) => ({ date: row.date, loggedTotals: { calories: Number(row.calories), protein: Number(row.protein), carbs: Number(row.carbs), fat: Number(row.fat) }, entryCount: row.count })),
    training: sessions.reverse().map((item) => ({ id: item.id, date: item.date, name: item.name,
      kind: item.kind, status: item.status, unit: item.unit, durationMinutes: item.durationMinutes,
      sessionRpe: item.sessionRpe, notes: item.notes.slice(0, 800), exercises: item.exercises.slice(0, 12).map((exercise) => ({
        name: exercise.name, catalogId: exercise.catalogId, loadType: exercise.loadType,
        sets: exercise.sets.filter((set) => set.completed).slice(0, 8),
      })) })),
    checkIns: checks.reverse().map(checkInRecord),
    note: 'Nutrition totals include every record in the range. Training is limited to the latest 40 sessions (12 exercises/8 completed sets each), and check-ins to the latest 30. Only explicitly logged data is shown; an absent or partial day is not zero intake or a missed workout.',
  };
}
export async function planningContext(db: Database, userId: string, date: string): Promise<PlanningSnapshot> {
  return consistentRead(db, userId, async (connection, revision) => {
    const savedSettings = await settings(connection, userId);
    const recipes = (await connection.select().from(tables.recipes).where(eq(tables.recipes.user_id, userId))
      .orderBy(asc(tables.recipes.position)).limit(60)).map(recipeRecord);
    const meals = (await connection.select().from(tables.plannedMeals)
      .where(and(eq(tables.plannedMeals.user_id, userId), gte(tables.plannedMeals.date, date), lte(tables.plannedMeals.date, shift(date, 13))))
      .orderBy(asc(tables.plannedMeals.position)).limit(100)).map(planRecord);
    const workouts = await connection.select({ id: tables.workoutSessions.id, date: tables.workoutSessions.date,
      name: tables.workoutSessions.name, kind: tables.workoutSessions.kind, status: tables.workoutSessions.status,
      unit: tables.workoutSessions.unit, plannedMinutes: tables.workoutSessions.planned_minutes })
      .from(tables.workoutSessions).where(and(eq(tables.workoutSessions.user_id, userId), gte(tables.workoutSessions.date, date), lte(tables.workoutSessions.date, shift(date, 13))))
      .orderBy(asc(tables.workoutSessions.position)).limit(30);
    const routines = await connection.select({ id: tables.workoutTemplates.id, name: tables.workoutTemplates.name,
      kind: tables.workoutTemplates.kind, description: tables.workoutTemplates.description, durationMinutes: tables.workoutTemplates.duration_minutes })
      .from(tables.workoutTemplates).where(eq(tables.workoutTemplates.user_id, userId))
      .orderBy(asc(tables.workoutTemplates.position)).limit(20);
    return { revision, context: { settings: savedSettings,
      recipes: recipes.map(({ id, name, category, nutrition, prepMinutes, cookMinutes, tags }) => ({ id, name, category, nutrition, prepMinutes, cookMinutes, tags })),
      meals,
      workouts: workouts.map((item) => ({
        ...item,
        kind: WorkoutSessionSchema.shape.kind.parse(item.kind),
        status: WorkoutSessionSchema.shape.status.parse(item.status),
        unit: WorkoutSessionSchema.shape.unit.parse(item.unit),
      })),
      routines: routines.map((item) => ({
        ...item, kind: WorkoutTemplateSchema.shape.kind.parse(item.kind),
        description: item.description.slice(0, 400),
      })),
      recentHistory: await history(connection, userId, date, 14),
      limits: 'Library summary: first 60 recipes/20 routines. Upcoming 14-day summary: first 100 meals/30 workouts. Use detail tools for owned records by ID. These summaries are not exhaustive.',
    } };
  });
}
export async function planningHistory(db: Database, userId: string, date: string, days: number, revision: number) {
  return consistentRead(db, userId, async (connection, current) => {
    requireContextRevision(current, revision);
    return history(connection, userId, date, days);
  });
}
export async function planningDetail(db: Database, userId: string, resource: 'recipe' | 'workout' | 'routine', id: string, revision: number) {
  return consistentRead(db, userId, async (connection, current) => {
    requireContextRevision(current, revision);
    if (resource === 'recipe') {
      const [row] = await connection.select().from(tables.recipes).where(and(eq(tables.recipes.user_id, userId), eq(tables.recipes.id, id))).limit(1);
      return row ? recipeRecord(row) : { error: 'Recipe not found.' };
    }
    if (resource === 'routine') {
      const [row] = await connection.select().from(tables.workoutTemplates).where(and(eq(tables.workoutTemplates.user_id, userId), eq(tables.workoutTemplates.id, id))).limit(1);
      return row ? templateRecord(row) : { error: 'Routine not found.' };
    }
    const sessions = await sessionRecords(connection, userId, await connection.select().from(tables.workoutSessions)
      .where(and(eq(tables.workoutSessions.user_id, userId), eq(tables.workoutSessions.id, id))).limit(1));
    return sessions[0] ?? { error: 'Workout not found.' };
  });
}
export async function proposalDependencies(db: Database, userId: string, raw: unknown, expected: number): Promise<ProposalDependencies> {
  const result = AgentResultSchema.parse(raw);
  return consistentRead(db, userId, async (connection, revision) => {
    requireContextRevision(revision, expected);
    const recipeIds = new Set<string>(); const mealIds = new Set<string>();
    const sessionIds = new Set<string>(); const templateIds = new Set<string>();
    for (const change of result.changes) {
      if (change.type === 'recipe') recipeIds.add(change.data.id);
      if (change.type === 'meal') { mealIds.add(change.data.id); recipeIds.add(change.data.recipeId); }
      if (change.type === 'remove_meal') mealIds.add(change.data.id);
      if (change.type === 'workout' || change.type === 'remove_workout') sessionIds.add(change.data.id);
      if (change.type === 'routine') templateIds.add(change.data.id);
    }
    return { settings: await settings(connection, userId),
      recipes: recipeIds.size ? (await connection.select().from(tables.recipes).where(and(eq(tables.recipes.user_id, userId), inArray(tables.recipes.id, [...recipeIds])))).map(recipeRecord) : [],
      plan: mealIds.size ? (await connection.select().from(tables.plannedMeals).where(and(eq(tables.plannedMeals.user_id, userId), inArray(tables.plannedMeals.id, [...mealIds])))).map(planRecord) : [],
      training: {
        sessions: sessionIds.size ? await sessionRecords(connection, userId, await connection.select().from(tables.workoutSessions).where(and(eq(tables.workoutSessions.user_id, userId), inArray(tables.workoutSessions.id, [...sessionIds])))) : [],
        templates: templateIds.size ? (await connection.select().from(tables.workoutTemplates).where(and(eq(tables.workoutTemplates.user_id, userId), inArray(tables.workoutTemplates.id, [...templateIds])))).map(templateRecord) : [],
      },
    };
  });
}
