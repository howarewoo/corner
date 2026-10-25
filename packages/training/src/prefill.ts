import type { WorkoutExercise, WorkoutSession, WorkoutSet } from './types.js';

export type SetPrefill = {
  weight: number | null;
  reps: number | null;
  rir: number | null;
  source: 'history' | 'targets';
  weightSource: 'history' | 'targets' | null;
  sourceDate?: string;
  sourceSessionId?: string;
};

export type WorkoutPrefill = Record<string, Record<string, SetPrefill>>;

type WeightUnit = WorkoutSession['unit'];
const POUNDS_PER_KILOGRAM = 2.2046226218;

/** Convert the entered load only. A per-hand load remains a per-hand load. */
export function convertTrainingWeight(weight: number, from: WeightUnit, to: WeightUnit): number {
  if (from === to) return weight;
  const converted = from === 'kg' ? weight * POUNDS_PER_KILOGRAM : weight / POUNDS_PER_KILOGRAM;
  return Math.round(converted * 1000) / 1000;
}

const normalizedName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

function matchesExercise(current: WorkoutExercise, previous: WorkoutExercise): boolean {
  if (current.loadType !== previous.loadType) return false;
  if (current.catalogId && previous.catalogId) return current.catalogId === previous.catalogId;
  // This deliberately avoids fuzzy matching across different movement variants.
  return normalizedName(current.name) === normalizedName(previous.name);
}

function completedWorkingSets(exercise: WorkoutExercise): WorkoutSet[] {
  return exercise.sets.filter(
    (set) =>
      set.kind === 'working' &&
      set.completed &&
      set.reps !== null &&
      set.reps > 0 &&
      (exercise.loadType === 'bodyweight' || set.weight !== null),
  );
}

/**
 * Suggestions are a separate view model, never recorded workout data. Callers
 * retain entered actual values and copy suggestions into actuals only when the
 * user records a set. Opening or rescheduling a plan cannot create work history.
 */
export function getWorkoutPrefill(
  session: WorkoutSession,
  history: readonly WorkoutSession[],
): WorkoutPrefill {
  const result: WorkoutPrefill = Object.create(null);
  if (session.status !== 'planned' && session.status !== 'in_progress') return result;

  const priorSessions = history
    .filter(
      (previous) =>
        previous.id !== session.id &&
        previous.status === 'completed' &&
        previous.date < session.date,
    )
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.id.localeCompare(b.id),
    );

  for (const exercise of session.exercises) {
    const workingSets = exercise.sets.filter((set) => set.kind === 'working');
    if (!workingSets.some((set) => !set.completed)) continue;

    let previousSession: WorkoutSession | undefined;
    let previousSets: WorkoutSet[] = [];
    for (const candidate of priorSessions) {
      for (const previousExercise of candidate.exercises) {
        if (!matchesExercise(exercise, previousExercise)) continue;
        const completedSets = completedWorkingSets(previousExercise);
        if (!completedSets.length) continue;
        previousSession = candidate;
        previousSets = completedSets;
        break;
      }
      if (previousSession) break;
    }

    const suggestions: Record<string, SetPrefill> = Object.create(null);
    workingSets.forEach((set, index) => {
      if (set.completed) return;
      const previousSet = previousSets[Math.min(index, previousSets.length - 1)];
      const hasPreviousWeight = previousSet?.weight !== null && previousSet?.weight !== undefined;
      const plannedLoad = exercise.targetLoad;
      const weight = hasPreviousWeight
        ? convertTrainingWeight(previousSet.weight!, previousSession!.unit, session.unit)
        : plannedLoad
          ? convertTrainingWeight(plannedLoad.weight, plannedLoad.unit, session.unit)
          : null;

      suggestions[set.id] = {
        weight,
        reps:
          previousSet?.reps === null || previousSet?.reps === undefined
            ? exercise.repMin
            : Math.min(exercise.repMax, Math.max(exercise.repMin, previousSet.reps)),
        rir: previousSet?.rir ?? exercise.targetRir,
        source: previousSet ? 'history' : 'targets',
        weightSource: hasPreviousWeight ? 'history' : plannedLoad ? 'targets' : null,
        ...(previousSession
          ? { sourceDate: previousSession.date, sourceSessionId: previousSession.id }
          : {}),
      };
    });
    result[exercise.id] = suggestions;
  }

  return result;
}
