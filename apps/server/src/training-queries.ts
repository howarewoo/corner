import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { exerciseChoicesSchema, exerciseHistorySchema, prefillSchema, rangeSchema,
  type ExerciseChoices, type ExerciseHistoryPage, type PrefillHistory, type Progress, type TrainingStats } from '@packages/api/workspace-data';
import { WorkoutSessionSchema } from '@packages/training/workouts';
import { mondayOf } from '@packages/nutrition/dates';
import type { Database, Transaction } from './queries.js';
import * as tables from './schema.js';
import { checkInRecord, sessionRecords } from './training-records.js';
import { checkCursor, consistentRead } from './workspace-queries.js';

async function aggregate(connection: Transaction, userId: string, from: string, through: string): Promise<TrainingStats> {
  const result = await connection.execute(sql`
    WITH eligible AS (
      SELECT * FROM workspace_workout_sessions
      WHERE user_id = ${userId} AND status = 'completed' AND kind <> 'recovery'
        AND date BETWEEN ${from} AND ${through}
    ), sets AS (
      SELECT count(*)::int AS count,
        coalesce(sum(CASE WHEN e.load_type IN ('total', 'per_hand') THEN
          s.weight * s.reps * CASE WHEN e.load_type = 'per_hand' THEN 2 ELSE 1 END *
          CASE WHEN w.unit = 'kg' THEN 2.2046226218 ELSE 1 END ELSE 0 END), 0)::float8 AS volume
      FROM eligible w JOIN workspace_workout_exercises e ON e.user_id = w.user_id AND e.session_id = w.id
        JOIN workspace_workout_sets s ON s.user_id = e.user_id AND s.session_id = e.session_id AND s.exercise_id = e.id
      WHERE s.completed AND s.kind = 'working'
    ) SELECT count(*)::int AS sessions,
      count(*) FILTER (WHERE kind = 'strength')::int AS strength,
      count(*) FILTER (WHERE kind = 'boxing')::int AS boxing,
      count(*) FILTER (WHERE kind = 'conditioning')::int AS conditioning,
      coalesce(sum(duration_minutes), 0)::float8 AS minutes, avg(session_rpe)::float8 AS rpe,
      (SELECT count FROM sets) AS sets, (SELECT volume FROM sets) AS volume FROM eligible`);
  const row = result.rows[0];
  return { sessions: Number(row.sessions), strengthSessions: Number(row.strength),
    boxingSessions: Number(row.boxing), conditioningSessions: Number(row.conditioning),
    minutes: Number(row.minutes), workingSets: Number(row.sets),
    externalVolumeLb: Math.round(Number(row.volume)),
    averageRpe: row.rpe === null ? null : Math.round(Number(row.rpe) * 10) / 10 };
}
export async function progress(db: Database, userId: string, raw: z.input<typeof rangeSchema>): Promise<Progress> {
  const input = rangeSchema.parse(raw);
  return consistentRead(db, userId, async (connection, revision) => {
    const [weight] = await connection.select().from(tables.checkIns)
      .where(and(eq(tables.checkIns.user_id, userId), isNotNull(tables.checkIns.body_weight)))
      .orderBy(desc(tables.checkIns.date), desc(tables.checkIns.position), asc(tables.checkIns.id)).limit(1);
    const [count] = await connection.select({ count: sql<number>`count(*)::int` }).from(tables.workoutSessions)
      .where(and(eq(tables.workoutSessions.user_id, userId), eq(tables.workoutSessions.status, 'completed')));
    const stats = await aggregate(connection, userId, input.from, input.through);
    const weekly: Progress['weekly'] = [];
    for (let week = mondayOf(input.from); week <= input.through;) {
      const end = new Date(week + 'T12:00:00Z'); end.setUTCDate(end.getUTCDate() + 6);
      weekly.push({ week, stats: await aggregate(connection, userId, week, end.toISOString().slice(0, 10)) });
      end.setUTCDate(end.getUTCDate() + 1); week = end.toISOString().slice(0, 10);
    }
    return { revision, completedCount: count.count, stats, latestWeight: weight ? checkInRecord(weight) : null, weekly };
  });
}
export async function exerciseHistoryPage(db: Database, userId: string,
  raw: z.input<typeof exerciseHistorySchema>): Promise<ExerciseHistoryPage> {
  const input = exerciseHistorySchema.parse(raw);
  return consistentRead(db, userId, async (connection, revision) => {
    checkCursor(input.cursor, revision);
    const after = input.cursor ? sql`AND (w.date < ${input.cursor.date} OR
      (w.date = ${input.cursor.date} AND w.updated_at < ${input.cursor.updatedAt}) OR
      (w.date = ${input.cursor.date} AND w.updated_at = ${input.cursor.updatedAt} AND w.id > ${input.cursor.id}))` : sql``;
    const result = await connection.execute(sql`SELECT w.id FROM workspace_workout_sessions w
      WHERE w.user_id = ${userId} AND w.status = 'completed' AND EXISTS (
        SELECT 1 FROM workspace_workout_exercises e
        WHERE e.user_id = w.user_id AND e.session_id = w.id AND lower(btrim(e.name)) = ${input.name.trim().toLowerCase()}
          AND EXISTS (SELECT 1 FROM workspace_workout_sets s WHERE s.user_id = e.user_id AND s.session_id = e.session_id
            AND s.exercise_id = e.id AND s.completed AND s.kind = 'working')
      ) ${after} ORDER BY w.date DESC, w.updated_at DESC, w.id ASC LIMIT ${input.limit + 1}`);
    const ids = result.rows.slice(0, input.limit).map((row) => String(row.id));
    const records = ids.length ? await sessionRecords(connection, userId,
      await connection.select().from(tables.workoutSessions).where(and(eq(tables.workoutSessions.user_id, userId), inArray(tables.workoutSessions.id, ids)))) : [];
    const byId = new Map(records.map((session) => [session.id, session]));
    const sessions = ids.map((id) => byId.get(id)!);
    const last = sessions.at(-1);
    return { revision, sessions, nextCursor: result.rows.length > input.limit && last
      ? { revision, date: last.date, updatedAt: last.updatedAt, id: last.id } : null };
  });
}
export async function exerciseChoices(db: Database, userId: string,
  raw: z.input<typeof exerciseChoicesSchema>): Promise<ExerciseChoices> {
  const input = exerciseChoicesSchema.parse(raw);
  return consistentRead(db, userId, async (connection, revision) => {
    checkCursor(input.cursor, revision);
    const pattern = '%' + input.search.replace(/[\\%_]/g, '\\$&') + '%';
    const after = input.cursor ? sql`AND e.name COLLATE "C" > ${input.cursor.name}` : sql``;
    const result = await connection.execute(sql`SELECT DISTINCT e.name COLLATE "C" AS name FROM workspace_workout_exercises e
      JOIN workspace_workout_sessions w ON w.user_id = e.user_id AND w.id = e.session_id
      WHERE w.user_id = ${userId} AND w.status = 'completed' AND e.name ilike ${pattern} ${after}
        AND EXISTS (SELECT 1 FROM workspace_workout_sets s WHERE s.user_id = e.user_id AND s.session_id = e.session_id
          AND s.exercise_id = e.id AND s.completed AND s.kind = 'working')
      ORDER BY name ASC LIMIT ${input.limit + 1}`);
    const names = result.rows.slice(0, input.limit).map((row) => String(row.name));
    return { revision, names, nextCursor: result.rows.length > input.limit
      ? { revision, name: names[names.length - 1] } : null };
  });
}
export async function prefillHistory(db: Database, userId: string,
  raw: z.input<typeof prefillSchema>): Promise<PrefillHistory> {
  const session = WorkoutSessionSchema.parse(prefillSchema.parse(raw).session);
  return consistentRead(db, userId, async (connection, revision) => {
    const ids = new Set<string>();
    if (session.status === 'planned' || session.status === 'in_progress')
      for (const exercise of session.exercises) {
        if (!exercise.sets.some((set) => set.kind === 'working' && !set.completed)) continue;
        const normalized = exercise.name.trim().replace(/\s+/g, ' ').toLowerCase();
        const result = await connection.execute(sql`SELECT w.id FROM workspace_workout_sessions w
          WHERE w.user_id = ${userId} AND w.status = 'completed' AND w.id <> ${session.id} AND w.date < ${session.date}
            AND EXISTS (SELECT 1 FROM workspace_workout_exercises e
              WHERE e.user_id = w.user_id AND e.session_id = w.id AND e.load_type = ${exercise.loadType}
                AND (CASE WHEN ${exercise.catalogId ?? null}::text IS NOT NULL AND e.catalog_id IS NOT NULL
                  THEN e.catalog_id = ${exercise.catalogId ?? null}
                  ELSE lower(regexp_replace(btrim(e.name), '\\s+', ' ', 'g')) = ${normalized} END)
                AND EXISTS (SELECT 1 FROM workspace_workout_sets s
                  WHERE s.user_id = e.user_id AND s.session_id = e.session_id AND s.exercise_id = e.id
                    AND s.completed AND s.kind = 'working' AND s.reps > 0
                    AND (e.load_type = 'bodyweight' OR s.weight IS NOT NULL)))
          ORDER BY w.date DESC, w.updated_at DESC, w.id ASC LIMIT 1`);
        if (result.rows[0]) ids.add(String(result.rows[0].id));
      }
    return { revision, sessions: ids.size ? await sessionRecords(connection, userId,
      await connection.select().from(tables.workoutSessions)
        .where(and(eq(tables.workoutSessions.user_id, userId), inArray(tables.workoutSessions.id, [...ids])))) : [] };
  });
}
