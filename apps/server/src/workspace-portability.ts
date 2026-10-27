import { and, asc, eq, gt } from 'drizzle-orm';
import type { AppState, Settings } from '@packages/workspace/types';
import { createInitialState } from '@packages/workspace/initial-state';
import type { Transaction } from './queries.js';
import * as tables from './schema.js';
import { foodRecord } from './food-records.js';
import { planRecord, recipeRecord, recipeRequestRecord, savePlan, saveRecipe, saveRecipeRequest } from './nutrition-records.js';
import { checkInRecord, reviewRecord, sessionRecords, templateRecord, trainingRequestRecord,
  saveCheckIn, saveReview, saveSession, saveTemplate, saveTrainingRequest } from './training-records.js';
import { ApiError } from './http.js';

import { MAX_WORKSPACE_TRANSFER_BYTES } from '@packages/api/workspace-data';

export async function importRelational(connection: Transaction, userId: string, state: AppState, position: () => number): Promise<void> {
  for (const recipe of state.recipes) await saveRecipe(connection, userId, recipe, position());
  for (const plan of state.plan) await savePlan(connection, userId, plan, position());
  // Import is the historical serialization boundary, not a new live-source command.
  for (const entry of state.logs) await connection.insert(tables.foodEntries).values({
    user_id: userId, id: entry.id, position: position(), date: entry.date,
    slot: entry.slot, name: entry.name, ...entry.nutrition, servings: entry.servings,
    recipe_id: entry.recipeId ?? null, plan_entry_id: entry.planEntryId ?? null, created_at: entry.createdAt,
  });
  for (const key of Object.keys(state.groceryChecks))
    await connection.insert(tables.groceryChecks).values({ user_id: userId, key, checked: state.groceryChecks[key], position: position() });
  for (const request of state.requests) await saveRecipeRequest(connection, userId, request, position());
  for (const template of state.training.templates) await saveTemplate(connection, userId, template, position());
  for (const session of state.training.sessions) await saveSession(connection, userId, session, position());
  for (const checkIn of state.training.checkIns) await saveCheckIn(connection, userId, checkIn, position());
  for (const request of state.training.requests) await saveTrainingRequest(connection, userId, request, position());
  for (const review of state.training.reviews) await saveReview(connection, userId, review, position());
  for (const date of state.training.scheduledDates) await connection.insert(tables.scheduledDates).values({ user_id: userId, date, position: position() });
}

/** Caller supplies one repeatable-read transaction; each database result is a bounded batch. */
export async function exportRelational(connection: Transaction, userId: string, settings: Settings): Promise<AppState> {
  const state = createInitialState();
  state.settings = settings;
  let bytes = Buffer.byteLength(JSON.stringify(state));
  let checks = 0;
  const append = <T>(target: T[], values: T[]) => {
    if (!values.length) return;
    bytes += Buffer.byteLength(JSON.stringify(values)) - 2 + (target.length ? 1 : 0);
    if (bytes > MAX_WORKSPACE_TRANSFER_BYTES) throw new ApiError(413, 'EXPORT_TOO_LARGE', 'This export exceeds the supported transfer size.');
    target.push(...values);
  };
  const batches = async <T extends { position: number }>(fetch: (after: number) => Promise<T[]>, consume: (rows: T[]) => void | Promise<void>) => {
    let after = -1;
    for (;;) {
      const rows = await fetch(after);
      if (!rows.length) return;
      await consume(rows);
      after = rows[rows.length - 1].position;
    }
  };
  await batches((after) => connection.select().from(tables.recipes)
    .where(and(eq(tables.recipes.user_id, userId), gt(tables.recipes.position, after))).orderBy(asc(tables.recipes.position)).limit(200),
    (rows) => append(state.recipes, rows.map(recipeRecord)));
  await batches((after) => connection.select().from(tables.plannedMeals)
    .where(and(eq(tables.plannedMeals.user_id, userId), gt(tables.plannedMeals.position, after))).orderBy(asc(tables.plannedMeals.position)).limit(200),
    (rows) => append(state.plan, rows.map(planRecord)));
  await batches((after) => connection.select().from(tables.foodEntries)
    .where(and(eq(tables.foodEntries.user_id, userId), gt(tables.foodEntries.position, after))).orderBy(asc(tables.foodEntries.position)).limit(200),
    (rows) => append(state.logs, rows.map(foodRecord)));
  await batches((after) => connection.select().from(tables.groceryChecks)
    .where(and(eq(tables.groceryChecks.user_id, userId), gt(tables.groceryChecks.position, after))).orderBy(asc(tables.groceryChecks.position)).limit(200),
    (rows) => {
      for (const row of rows) bytes += Buffer.byteLength(JSON.stringify(row.key)) + (row.checked ? 5 : 6) + (checks++ ? 1 : 0);
      if (bytes > MAX_WORKSPACE_TRANSFER_BYTES) throw new ApiError(413, 'EXPORT_TOO_LARGE', 'This export exceeds the supported transfer size.');
      for (const row of rows) state.groceryChecks[row.key] = row.checked;
    });
  await batches((after) => connection.select().from(tables.recipeRequests)
    .where(and(eq(tables.recipeRequests.user_id, userId), gt(tables.recipeRequests.position, after))).orderBy(asc(tables.recipeRequests.position)).limit(200),
    (rows) => append(state.requests, rows.map(recipeRequestRecord)));
  await batches((after) => connection.select().from(tables.workoutTemplates)
    .where(and(eq(tables.workoutTemplates.user_id, userId), gt(tables.workoutTemplates.position, after))).orderBy(asc(tables.workoutTemplates.position)).limit(200),
    (rows) => append(state.training.templates, rows.map(templateRecord)));
  await batches((after) => connection.select().from(tables.workoutSessions)
    .where(and(eq(tables.workoutSessions.user_id, userId), gt(tables.workoutSessions.position, after))).orderBy(asc(tables.workoutSessions.position)).limit(50),
    async (rows) => append(state.training.sessions, await sessionRecords(connection, userId, rows)));
  await batches((after) => connection.select().from(tables.checkIns)
    .where(and(eq(tables.checkIns.user_id, userId), gt(tables.checkIns.position, after))).orderBy(asc(tables.checkIns.position)).limit(200),
    (rows) => append(state.training.checkIns, rows.map(checkInRecord)));
  await batches((after) => connection.select().from(tables.trainingRequests)
    .where(and(eq(tables.trainingRequests.user_id, userId), gt(tables.trainingRequests.position, after))).orderBy(asc(tables.trainingRequests.position)).limit(200),
    (rows) => append(state.training.requests, rows.map(trainingRequestRecord)));
  await batches((after) => connection.select().from(tables.trainingReviews)
    .where(and(eq(tables.trainingReviews.user_id, userId), gt(tables.trainingReviews.position, after))).orderBy(asc(tables.trainingReviews.position)).limit(20),
    (rows) => append(state.training.reviews, rows.map(reviewRecord)));
  await batches((after) => connection.select().from(tables.scheduledDates)
    .where(and(eq(tables.scheduledDates.user_id, userId), gt(tables.scheduledDates.position, after))).orderBy(asc(tables.scheduledDates.position)).limit(200),
    (rows) => append(state.training.scheduledDates, rows.map((row) => row.date)));
  return state;
}
