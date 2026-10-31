import { and, or, eq, inArray, gte, lte } from 'drizzle-orm';
import type { z } from 'zod';
import { MutationSchema } from '@packages/workspace/mutations';
import type { Settings } from '@packages/workspace/types';
import { mondayOf, weekDates } from '@packages/nutrition/dates';
import { prepareTrainingCommand } from '@packages/training/workouts';
import type { TrainingMutation } from '@packages/training/types';
import type { Transaction } from './queries.js';
import * as tables from './schema.js';
import { savePlan, saveRecipe } from './nutrition-records.js';
import { saveFoodRecord } from './food-records.js';
import {
  saveCheckIn,
  saveSession,
  saveTemplate,
  sessionRecords,
  templateRecord,
} from './training-records.js';

type Command = z.infer<typeof MutationSchema>;
/** Dependencies and writes are scoped to the addressed entities; never reconstruct a lifetime state. */
export async function executeEntityCommand(
  connection: Transaction,
  userId: string,
  mutation: Command,
  settings: Settings,
  allocatePosition: () => number,
): Promise<Settings> {
  const requireRecipe = async (id: string) => {
    if (
      !(
        await connection
          .select({ id: tables.recipes.id })
          .from(tables.recipes)
          .where(and(eq(tables.recipes.user_id, userId), eq(tables.recipes.id, id)))
          .limit(1)
      ).length
    )
      throw new Error('That recipe is no longer available. Refresh and choose a recipe.');
  };
  switch (mutation.type) {
    case 'recipe.save':
      await saveRecipe(connection, userId, mutation.data, allocatePosition());
      break;
    case 'recipe.delete':
      if (
        (
          await connection
            .select({ id: tables.plannedMeals.id })
            .from(tables.plannedMeals)
            .where(
              and(
                eq(tables.plannedMeals.user_id, userId),
                eq(tables.plannedMeals.recipe_id, mutation.data.id),
              ),
            )
            .limit(1)
        ).length
      )
        throw new Error(
          'Remove this recipe from your meal plan before deleting it. Your food log will stay intact.',
        );
      await connection
        .delete(tables.recipes)
        .where(and(eq(tables.recipes.user_id, userId), eq(tables.recipes.id, mutation.data.id)));
      break;
    case 'recipe.favorite':
      await requireRecipe(mutation.data.id);
      await connection
        .update(tables.recipes)
        .set({ favorite: mutation.data.favorite })
        .where(and(eq(tables.recipes.user_id, userId), eq(tables.recipes.id, mutation.data.id)));
      break;
    case 'plan.save':
      await requireRecipe(mutation.data.recipeId);
      await savePlan(connection, userId, mutation.data, allocatePosition());
      break;
    case 'plan.delete':
      await connection
        .delete(tables.plannedMeals)
        .where(
          and(
            eq(tables.plannedMeals.user_id, userId),
            eq(tables.plannedMeals.id, mutation.data.id),
          ),
        );
      break;
    case 'plan.week': {
      const { entries, weekStart, replace } = mutation.data;
      const dates = weekDates(weekStart);
      if (mondayOf(weekStart) !== weekStart) throw new Error('The week must start on a Monday.');
      if (entries.some((entry) => !dates.includes(entry.date)))
        throw new Error('Every meal must fall within the selected week.');
      if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
        throw new Error('Meal IDs must be unique.');
      const existing = entries.length
        ? await connection
            .select()
            .from(tables.plannedMeals)
            .where(
              and(
                eq(tables.plannedMeals.user_id, userId),
                inArray(
                  tables.plannedMeals.id,
                  entries.map((entry) => entry.id),
                ),
              ),
            )
        : [];
      if (existing.some((entry) => !dates.includes(entry.date)))
        throw new Error('Use new meal IDs when copying a plan into a different week.');
      for (const entry of entries) await requireRecipe(entry.recipeId);
      if (replace)
        await connection
          .delete(tables.plannedMeals)
          .where(
            and(eq(tables.plannedMeals.user_id, userId), inArray(tables.plannedMeals.date, dates)),
          );
      for (const entry of entries) await savePlan(connection, userId, entry, allocatePosition());
      break;
    }
    case 'log.save':
      await saveFoodRecord(connection, userId, mutation.data, allocatePosition());
      break;
    case 'log.delete':
      await connection
        .delete(tables.foodEntries)
        .where(
          and(eq(tables.foodEntries.user_id, userId), eq(tables.foodEntries.id, mutation.data.id)),
        );
      break;
    case 'settings.save':
      return mutation.data;
    case 'grocery.check':
      if (mutation.data.checked)
        await connection
          .insert(tables.groceryChecks)
          .values({
            user_id: userId,
            key: mutation.data.key,
            position: allocatePosition(),
          })
          .onConflictDoUpdate({
            target: [tables.groceryChecks.user_id, tables.groceryChecks.key],
            set: { checked: true },
          });
      else
        await connection
          .delete(tables.groceryChecks)
          .where(
            and(
              eq(tables.groceryChecks.user_id, userId),
              eq(tables.groceryChecks.key, mutation.data.key),
            ),
          );
      break;
    default:
      await executeTrainingCommand(connection, userId, mutation, settings, allocatePosition);
  }
  return settings;
}

async function executeTrainingCommand(
  connection: Transaction,
  userId: string,
  mutation: TrainingMutation,
  settings: Settings,
  allocatePosition: () => number,
): Promise<void> {
  let sessionIds: string[] = [];
  let templateIds: string[] = [];
  let dates: string[] = [];
  if (mutation.type === 'training.session.save') sessionIds = [mutation.data.session.id];
  if (mutation.type === 'training.session.delete') sessionIds = [mutation.data.id];
  if (mutation.type === 'training.template.save') templateIds = [mutation.data.id];
  if (mutation.type === 'training.week') {
    dates = weekDates(mutation.data.weekStart);
    templateIds = Object.values(settings.schedule)
      .filter((value) => value.startsWith('routine:'))
      .map((value) => value.slice(8));
  }
  const sessions = await sessionRecords(
    connection,
    userId,
    sessionIds.length || dates.length
      ? await connection
          .select()
          .from(tables.workoutSessions)
          .where(
            and(
              eq(tables.workoutSessions.user_id, userId),
              dates.length
                ? and(
                    gte(tables.workoutSessions.date, dates[0]),
                    lte(tables.workoutSessions.date, dates[6]),
                  )
                : or(
                    inArray(tables.workoutSessions.id, sessionIds),
                    mutation.type === 'training.session.save' &&
                      mutation.data.session.status === 'in_progress'
                      ? eq(tables.workoutSessions.status, 'in_progress')
                      : undefined,
                  ),
            ),
          )
      : [],
  );
  const templates = templateIds.length
    ? (
        await connection
          .select()
          .from(tables.workoutTemplates)
          .where(
            and(
              eq(tables.workoutTemplates.user_id, userId),
              inArray(tables.workoutTemplates.id, templateIds),
            ),
          )
      ).map(templateRecord)
    : [];
  const markedDates = dates.length
    ? (
        await connection
          .select()
          .from(tables.scheduledDates)
          .where(
            and(
              eq(tables.scheduledDates.user_id, userId),
              inArray(tables.scheduledDates.date, dates),
            ),
          )
      ).map((row) => row.date)
    : [];
  const changes = prepareTrainingCommand(mutation, {
    sessions,
    templates,
    scheduledDates: markedDates,
    schedule: settings.schedule,
  });
  for (const id of changes.deletedSessionIds)
    await connection
      .delete(tables.workoutSessions)
      .where(and(eq(tables.workoutSessions.user_id, userId), eq(tables.workoutSessions.id, id)));
  for (const session of changes.sessions)
    await saveSession(connection, userId, session, allocatePosition());
  for (const template of changes.templates)
    await saveTemplate(connection, userId, template, allocatePosition());
  for (const checkIn of changes.checkIns)
    await saveCheckIn(connection, userId, checkIn, allocatePosition());
  for (const date of changes.scheduledDates)
    await connection
      .insert(tables.scheduledDates)
      .values({ user_id: userId, date, position: allocatePosition() })
      .onConflictDoNothing();
}
