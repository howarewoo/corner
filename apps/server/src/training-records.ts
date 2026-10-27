import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Transaction } from './queries.js';
import {
  checkIns,
  trainingRequests,
  trainingReviews,
  workoutExercises,
  workoutSessions,
  workoutSets,
  workoutTemplates,
} from './schema.js';
import {
  TrainingCheckInSchema,
  TrainingRequestSchema,
  TrainingReviewSchema,
  WorkoutSessionSchema,
  WorkoutTemplateSchema,
} from '@packages/training/workouts';
import type {
  TrainingCheckIn,
  TrainingRequest,
  TrainingReview,
  WorkoutSession,
  WorkoutTemplate,
} from '@packages/training/types';

export function templateRecord(row: typeof workoutTemplates.$inferSelect): WorkoutTemplate {
  return WorkoutTemplateSchema.parse({
    id: row.id,
    name: row.name,
    kind: row.kind,
    description: row.description,
    durationMinutes: row.duration_minutes,
    exercises: row.exercises,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
export function checkInRecord(row: typeof checkIns.$inferSelect): TrainingCheckIn {
  return TrainingCheckInSchema.parse({
    id: row.id,
    date: row.date,
    bodyWeight: row.body_weight,
    waist: row.waist,
    sleepHours: row.sleep_hours,
    energy: row.energy,
    soreness: row.soreness,
    boxingQuality: row.boxing_quality,
    notes: row.notes,
  });
}
export function trainingRequestRecord(row: typeof trainingRequests.$inferSelect): TrainingRequest {
  return TrainingRequestSchema.parse({
    id: row.id,
    prompt: row.prompt,
    date: row.date,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    status: row.status,
    createdAt: row.created_at,
  });
}
export function reviewRecord(row: typeof trainingReviews.$inferSelect): TrainingReview {
  return TrainingReviewSchema.parse({
    id: row.id,
    title: row.title,
    summary: row.summary,
    ...(row.request_id === null ? {} : { requestId: row.request_id }),
    status: row.status,
    createdAt: row.created_at,
    changes: row.changes,
  });
}
export async function sessionRecords(
  connection: Transaction,
  userId: string,
  rows: Array<typeof workoutSessions.$inferSelect>,
): Promise<WorkoutSession[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const exercises = await connection
    .select()
    .from(workoutExercises)
    .where(and(eq(workoutExercises.user_id, userId), inArray(workoutExercises.session_id, ids)))
    .orderBy(asc(workoutExercises.position));
  const sets = await connection
    .select()
    .from(workoutSets)
    .where(and(eq(workoutSets.user_id, userId), inArray(workoutSets.session_id, ids)))
    .orderBy(asc(workoutSets.position));
  return rows.map((row) =>
    WorkoutSessionSchema.parse({
      id: row.id,
      ...(row.template_id === null ? {} : { templateId: row.template_id }),
      date: row.date,
      name: row.name,
      kind: row.kind,
      status: row.status,
      unit: row.unit,
      plannedMinutes: row.planned_minutes,
      durationMinutes: row.duration_minutes,
      rounds: row.rounds,
      sessionRpe: row.session_rpe,
      readiness: row.readiness,
      notes: row.notes,
      changeReason: row.change_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      exercises: exercises
        .filter((exercise) => exercise.session_id === row.id)
        .map((exercise) => ({
          id: exercise.id,
          name: exercise.name,
          loadType: exercise.load_type,
          targetSets: exercise.target_sets,
          repMin: exercise.rep_min,
          repMax: exercise.rep_max,
          targetRir: exercise.target_rir,
          restSeconds: exercise.rest_seconds,
          notes: exercise.notes,
          ...(exercise.catalog_id === null ? {} : { catalogId: exercise.catalog_id }),
          ...(exercise.target_weight === null
            ? {}
            : { targetLoad: { weight: exercise.target_weight, unit: exercise.target_unit } }),
          sets: sets
            .filter((set) => set.session_id === row.id && set.exercise_id === exercise.id)
            .map((set) => ({
              id: set.id,
              weight: set.weight,
              reps: set.reps,
              rir: set.rir,
              completed: set.completed,
              kind: set.kind,
            })),
        })),
    }),
  );
}
export async function saveSession(
  connection: Transaction,
  userId: string,
  session: WorkoutSession,
  position: number,
) {
  const existing = (
    await connection
      .select({ position: workoutSessions.position })
      .from(workoutSessions)
      .where(and(eq(workoutSessions.user_id, userId), eq(workoutSessions.id, session.id)))
      .limit(1)
  )[0];
  const values = {
    user_id: userId,
    id: session.id,
    position: existing?.position ?? position,
    template_id: session.templateId ?? null,
    date: session.date,
    name: session.name,
    kind: session.kind,
    status: session.status,
    unit: session.unit,
    planned_minutes: session.plannedMinutes,
    duration_minutes: session.durationMinutes,
    rounds: session.rounds,
    session_rpe: session.sessionRpe,
    readiness: session.readiness,
    notes: session.notes,
    change_reason: session.changeReason,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  };
  await connection
    .insert(workoutSessions)
    .values(values)
    .onConflictDoUpdate({ target: [workoutSessions.user_id, workoutSessions.id], set: values });
  // Preserve independently addressable children: a set edit updates its row only, not sibling sets.
  const oldExercises = await connection
    .select()
    .from(workoutExercises)
    .where(and(eq(workoutExercises.user_id, userId), eq(workoutExercises.session_id, session.id)));
  const oldSets = await connection
    .select()
    .from(workoutSets)
    .where(and(eq(workoutSets.user_id, userId), eq(workoutSets.session_id, session.id)));
  for (const old of oldExercises)
    if (!session.exercises.some((exercise) => exercise.id === old.id))
      await connection
        .delete(workoutExercises)
        .where(
          and(
            eq(workoutExercises.user_id, userId),
            eq(workoutExercises.session_id, session.id),
            eq(workoutExercises.id, old.id),
          ),
        );
  for (const [index, exercise] of session.exercises.entries()) {
    const exerciseValues = {
      user_id: userId,
      id: exercise.id,
      session_id: session.id,
      position: index,
      name: exercise.name,
      load_type: exercise.loadType,
      target_sets: exercise.targetSets,
      rep_min: exercise.repMin,
      rep_max: exercise.repMax,
      target_rir: exercise.targetRir,
      rest_seconds: exercise.restSeconds,
      notes: exercise.notes,
      catalog_id: exercise.catalogId ?? null,
      target_weight: exercise.targetLoad?.weight ?? null,
      target_unit: exercise.targetLoad?.unit ?? null,
    };
    const old = oldExercises.find((value) => value.id === exercise.id);
    if (
      !old ||
      Object.entries(exerciseValues).some(([key, value]) => old[key as keyof typeof old] !== value)
    )
      await connection
        .insert(workoutExercises)
        .values(exerciseValues)
        .onConflictDoUpdate({
          target: [workoutExercises.user_id, workoutExercises.session_id, workoutExercises.id],
          set: exerciseValues,
        });
    for (const oldSet of oldSets.filter((value) => value.exercise_id === exercise.id))
      if (!exercise.sets.some((set) => set.id === oldSet.id))
        await connection
          .delete(workoutSets)
          .where(
            and(
              eq(workoutSets.user_id, userId),
              eq(workoutSets.session_id, session.id),
              eq(workoutSets.exercise_id, exercise.id),
              eq(workoutSets.id, oldSet.id),
            ),
          );
    for (const [setIndex, set] of exercise.sets.entries()) {
      const setValues = {
        user_id: userId,
        id: set.id,
        session_id: session.id,
        exercise_id: exercise.id,
        position: setIndex,
        weight: set.weight,
        reps: set.reps,
        rir: set.rir,
        completed: set.completed,
        kind: set.kind,
      };
      const oldSet = oldSets.find(
        (value) => value.exercise_id === exercise.id && value.id === set.id,
      );
      if (
        !oldSet ||
        Object.entries(setValues).some(
          ([key, value]) => oldSet[key as keyof typeof oldSet] !== value,
        )
      )
        await connection
          .insert(workoutSets)
          .values(setValues)
          .onConflictDoUpdate({
            target: [
              workoutSets.user_id,
              workoutSets.session_id,
              workoutSets.exercise_id,
              workoutSets.id,
            ],
            set: setValues,
          });
    }
  }
}
export async function saveTemplate(
  connection: Transaction,
  userId: string,
  entry: WorkoutTemplate,
  position: number,
) {
  const previous = (
    await connection
      .select({ position: workoutTemplates.position })
      .from(workoutTemplates)
      .where(and(eq(workoutTemplates.user_id, userId), eq(workoutTemplates.id, entry.id)))
      .limit(1)
  )[0];
  const values = {
    user_id: userId,
    id: entry.id,
    position: previous?.position ?? position,
    name: entry.name,
    kind: entry.kind,
    description: entry.description,
    duration_minutes: entry.durationMinutes,
    exercises: entry.exercises,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
  };
  await connection
    .insert(workoutTemplates)
    .values(values)
    .onConflictDoUpdate({ target: [workoutTemplates.user_id, workoutTemplates.id], set: values });
}
export async function saveCheckIn(
  connection: Transaction,
  userId: string,
  entry: TrainingCheckIn,
  position: number,
) {
  const previous = (
    await connection
      .select({ position: checkIns.position })
      .from(checkIns)
      .where(and(eq(checkIns.user_id, userId), eq(checkIns.id, entry.id)))
      .limit(1)
  )[0];
  const values = {
    user_id: userId,
    id: entry.id,
    position: previous?.position ?? position,
    date: entry.date,
    body_weight: entry.bodyWeight,
    waist: entry.waist,
    sleep_hours: entry.sleepHours,
    energy: entry.energy,
    soreness: entry.soreness,
    boxing_quality: entry.boxingQuality,
    notes: entry.notes,
  };
  await connection
    .insert(checkIns)
    .values(values)
    .onConflictDoUpdate({ target: [checkIns.user_id, checkIns.id], set: values });
}
export async function saveTrainingRequest(
  connection: Transaction,
  userId: string,
  entry: TrainingRequest,
  position: number,
) {
  const previous = (
    await connection
      .select({ position: trainingRequests.position })
      .from(trainingRequests)
      .where(and(eq(trainingRequests.user_id, userId), eq(trainingRequests.id, entry.id)))
      .limit(1)
  )[0];
  const values = {
    user_id: userId,
    id: entry.id,
    position: previous?.position ?? position,
    prompt: entry.prompt,
    date: entry.date,
    session_id: entry.sessionId ?? null,
    status: entry.status,
    created_at: entry.createdAt,
  };
  await connection
    .insert(trainingRequests)
    .values(values)
    .onConflictDoUpdate({ target: [trainingRequests.user_id, trainingRequests.id], set: values });
}
export async function saveReview(
  connection: Transaction,
  userId: string,
  entry: TrainingReview,
  position: number,
) {
  const previous = (
    await connection
      .select({ position: trainingReviews.position })
      .from(trainingReviews)
      .where(and(eq(trainingReviews.user_id, userId), eq(trainingReviews.id, entry.id)))
      .limit(1)
  )[0];
  const values = {
    user_id: userId,
    id: entry.id,
    position: previous?.position ?? position,
    request_id: entry.requestId ?? null,
    title: entry.title,
    summary: entry.summary,
    created_at: entry.createdAt,
    status: entry.status,
    changes: entry.changes,
  };
  await connection
    .insert(trainingReviews)
    .values(values)
    .onConflictDoUpdate({ target: [trainingReviews.user_id, trainingReviews.id], set: values });
}
