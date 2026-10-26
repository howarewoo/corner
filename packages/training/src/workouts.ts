import { z } from 'zod';
import type {
  ExerciseHistoryEntry,
  ExerciseTarget,
  LoadType,
  TrainingCheckIn,
  TrainingRequest,
  TrainingReview,
  TrainingMutation,
  TrainingState,
  TrainingStats,
  WorkoutSession,
  WorkoutTemplate,
} from './types.js';

const id = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_:.\-]+$/, 'Use a valid item ID.');
const text = (max: number) => z.string().trim().max(max);
const number = (max: number, min = 0) => z.number().finite().min(min).max(max);
const timestamp = z.string().datetime();
export const TrainingDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(value + 'T12:00:00Z');
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, 'Choose a valid calendar date.');
const kind = z.enum(['strength', 'boxing', 'conditioning', 'recovery']);
const loadType = z.enum(['total', 'per_hand', 'bodyweight', 'assistance']);
const unique = (values: Array<{ id: string }>) =>
  new Set(values.map((value) => value.id)).size === values.length;

export const WorkoutSetSchema = z
  .object({
    id,
    weight: number(2000).nullable(),
    reps: number(500).int().nullable(),
    rir: number(10).nullable(),
    completed: z.boolean(),
    kind: z.enum(['working', 'warmup']),
  })
  .strict();
export const ExerciseTargetSchema = z
  .object({
    id,
    name: text(160).min(1),
    loadType,
    targetSets: number(20, 1).int(),
    repMin: number(200, 1).int(),
    repMax: number(200, 1).int(),
    targetRir: number(10).nullable(),
    restSeconds: number(900).int(),
    notes: text(1200),
    catalogId: id.optional(),
    targetLoad: z
      .object({ weight: number(2000), unit: z.enum(['lb', 'kg']) })
      .strict()
      .optional(),
  })
  .strict();
export const WorkoutExerciseSchema = ExerciseTargetSchema.extend({
  sets: z.array(WorkoutSetSchema).max(30),
}).superRefine((exercise, context) => {
  if (exercise.repMin > exercise.repMax)
    context.addIssue({
      code: 'custom',
      message: 'Minimum reps must not exceed maximum reps.',
      path: ['repMin'],
    });
  if (!unique(exercise.sets))
    context.addIssue({
      code: 'custom',
      message: 'Set IDs must be unique within an exercise.',
      path: ['sets'],
    });
  for (const [index, set] of exercise.sets.entries()) {
    if (!set.completed) continue;
    if (set.reps === null || set.reps < 1)
      context.addIssue({
        code: 'custom',
        message: 'Enter reps before marking a set complete.',
        path: ['sets', index, 'reps'],
      });
    if (exercise.loadType !== 'bodyweight' && set.weight === null)
      context.addIssue({
        code: 'custom',
        message: 'Enter the load before marking a set complete.',
        path: ['sets', index, 'weight'],
      });
  }
});
export const WorkoutTemplateSchema = z
  .object({
    id,
    name: text(160).min(1),
    kind,
    description: text(2400),
    durationMinutes: number(600).int(),
    exercises: z.array(ExerciseTargetSchema).max(25),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict()
  .superRefine((template, context) => {
    if (!unique(template.exercises))
      context.addIssue({
        code: 'custom',
        message: 'Exercise IDs must be unique.',
        path: ['exercises'],
      });
    if (template.kind === 'strength' && !template.exercises.length)
      context.addIssue({
        code: 'custom',
        message: 'Include at least one strength exercise.',
        path: ['exercises'],
      });
    template.exercises.forEach((exercise, index) => {
      if (exercise.repMin > exercise.repMax)
        context.addIssue({
          code: 'custom',
          message: 'Minimum reps must not exceed maximum reps.',
          path: ['exercises', index, 'repMin'],
        });
    });
  });
export const WorkoutSessionSchema = z
  .object({
    id,
    templateId: id.optional(),
    date: TrainingDateSchema,
    name: text(160).min(1),
    kind,
    status: z.enum(['planned', 'in_progress', 'completed', 'skipped']),
    unit: z.enum(['lb', 'kg']),
    exercises: z.array(WorkoutExerciseSchema).max(25),
    plannedMinutes: number(600).int(),
    durationMinutes: number(600).nullable(),
    rounds: number(100).int().nullable(),
    sessionRpe: number(10, 1).nullable(),
    readiness: number(5, 1).int().nullable(),
    notes: text(4000),
    changeReason: text(1600),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict()
  .superRefine((session, context) => {
    if (!unique(session.exercises))
      context.addIssue({
        code: 'custom',
        message: 'Exercise IDs must be unique.',
        path: ['exercises'],
      });
    const completedSets = session.exercises
      .flatMap((exercise) => exercise.sets)
      .filter((set) => set.completed);
    if (session.status === 'skipped' && completedSets.length)
      context.addIssue({
        code: 'custom',
        message:
          'A workout with completed sets cannot be marked skipped. Keep it as a partial completed workout.',
        path: ['status'],
      });
    if (session.status === 'planned' && completedSets.length)
      context.addIssue({
        code: 'custom',
        message: 'Start the workout before saving completed sets.',
        path: ['status'],
      });
    if (
      session.status === 'completed' &&
      session.kind !== 'recovery' &&
      !completedSets.length &&
      !(session.durationMinutes && session.durationMinutes > 0)
    )
      context.addIssue({
        code: 'custom',
        message: 'Log completed sets or actual minutes before completing a workout.',
        path: ['durationMinutes'],
      });
  });
export const TrainingCheckInSchema = z
  .object({
    id,
    date: TrainingDateSchema,
    bodyWeight: number(1000, 40).nullable(),
    waist: number(100, 10).nullable(),
    sleepHours: number(24).nullable(),
    energy: number(5, 1).int().nullable(),
    soreness: number(5, 1).int().nullable(),
    boxingQuality: number(5, 1).int().nullable(),
    notes: text(2400),
  })
  .strict()
  .refine(
    (value) =>
      value.notes.length > 0 ||
      [
        value.bodyWeight,
        value.waist,
        value.sleepHours,
        value.energy,
        value.soreness,
        value.boxingQuality,
      ].some((item) => item !== null),
    'Add a measurement, rating, or note.',
  );
export const TrainingRequestSchema = z
  .object({
    id,
    prompt: text(4000).min(3),
    date: TrainingDateSchema,
    sessionId: id.optional(),
    status: z.enum(['pending', 'answered']),
    createdAt: timestamp,
  })
  .strict();
export const TrainingChangeSchema = z
  .object({
    session: WorkoutSessionSchema,
    expectedUpdatedAt: timestamp.nullable(),
    reason: text(1600).min(3),
  })
  .strict();
export const TrainingReviewSchema = z
  .object({
    id,
    requestId: id.optional(),
    title: text(160).min(1),
    summary: text(10000).min(1),
    createdAt: timestamp,
    status: z.enum(['proposed', 'applied', 'dismissed']),
    changes: z.array(TrainingChangeSchema).max(21),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.changes.map((change) => change.session.id)).size === value.changes.length,
    'Each workout can appear only once in a review.',
  );
export const TrainingMutationOptions = [
  z.object({
    type: z.literal('training.session.save'),
    data: z
      .object({ session: WorkoutSessionSchema, expectedUpdatedAt: timestamp.nullable() })
      .strict(),
  }),
  z.object({
    type: z.literal('training.session.delete'),
    data: z.object({ id, expectedUpdatedAt: timestamp }).strict(),
  }),
  z.object({
    type: z.literal('training.week'),
    data: z.object({ weekStart: TrainingDateSchema }).strict(),
  }),
  z.object({ type: z.literal('training.template.save'), data: WorkoutTemplateSchema }),
  z.object({ type: z.literal('training.checkin.save'), data: TrainingCheckInSchema }),
  z.object({ type: z.literal('training.request.save'), data: TrainingRequestSchema }),
  z.object({ type: z.literal('training.review.save'), data: TrainingReviewSchema }),
  z.object({ type: z.literal('training.review.apply'), data: z.object({ id }).strict() }),
  z.object({ type: z.literal('training.review.dismiss'), data: z.object({ id }).strict() }),
] as const;
export const TrainingMutationSchema = z.discriminatedUnion('type', TrainingMutationOptions);
export const TrainingStateSchema = z
  .object({
    templates: z.array(WorkoutTemplateSchema).max(100),
    sessions: z.array(WorkoutSessionSchema).max(2500),
    checkIns: z.array(TrainingCheckInSchema).max(2000),
    requests: z.array(TrainingRequestSchema).max(300),
    reviews: z.array(TrainingReviewSchema).max(300),
    scheduledDates: z.array(TrainingDateSchema).max(5000),
  })
  .strict();

function plusDays(date: string, days: number): string {
  TrainingDateSchema.parse(date);
  const value = new Date(date + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
function monday(date: string): string {
  TrainingDateSchema.parse(date);
  return plusDays(date, -((new Date(date + 'T12:00:00Z').getUTCDay() + 6) % 7));
}
export function createSessionFromTemplate(
  templateValue: WorkoutTemplate,
  date: string,
  options: { id?: string; now?: string; unit?: 'lb' | 'kg' } = {},
): WorkoutSession {
  const source = WorkoutTemplateSchema.parse(templateValue);
  TrainingDateSchema.parse(date);
  const now = options.now ?? new Date().toISOString();
  const sessionId = options.id ?? crypto.randomUUID();
  return WorkoutSessionSchema.parse({
    id: sessionId,
    templateId: source.id,
    date,
    name: source.name,
    kind: source.kind,
    status: 'planned',
    unit: options.unit ?? 'lb',
    plannedMinutes: source.durationMinutes,
    durationMinutes: null,
    rounds: null,
    sessionRpe: null,
    readiness: null,
    notes: '',
    changeReason: '',
    createdAt: now,
    updatedAt: now,
    exercises: source.exercises.map((exercise) => ({
      ...structuredClone(exercise),
      sets: Array.from({ length: exercise.targetSets }, (_, index) => ({
        id: exercise.id + '-set-' + (index + 1),
        weight: null,
        reps: null,
        rir: null,
        completed: false,
        kind: 'working',
      })),
    })),
  });
}
/** Only explicit routine:<id> weekday assignments schedule saved user routines. */
export function starterTrainingWeek(
  date: string,
  templates: WorkoutTemplate[] = [],
  schedule?: Record<string, string>,
): WorkoutSession[] {
  const start = monday(date);
  const sessions: WorkoutSession[] = [];
  for (let index = 0; index < 7; index += 1) {
    const sessionDate = plusDays(start, index);
    const weekday = String(new Date(sessionDate + 'T12:00:00Z').getUTCDay());
    const selection = schedule?.[weekday];
    if (!selection?.startsWith('routine:')) continue;
    const selected = templates.find((item) => item.id === selection.slice(8));
    if (selected) sessions.push(createSessionFromTemplate(selected, sessionDate));
  }
  return sessions;
}
export function createTrainingState(): TrainingState {
  return {
    templates: [],
    sessions: [],
    checkIns: [],
    requests: [],
    reviews: [],
    scheduledDates: [],
  };
}
export function ensureTrainingState<T extends { training?: TrainingState }>(
  state: T,
): T & { training: TrainingState } {
  if (!state.training) return { ...state, training: createTrainingState() };
  const training = state.training.scheduledDates
    ? state.training
    : {
        ...state.training,
        scheduledDates: [...new Set(state.training.sessions.map((session) => session.date))],
      };
  return { ...state, training };
}

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  return items.some((value) => value.id === item.id)
    ? items.map((value) => (value.id === item.id ? item : value))
    : [...items, item];
}
function checkVersion(current: WorkoutSession | undefined, expected: string | null): void {
  if ((current?.updatedAt ?? null) !== expected)
    throw new Error(
      'This workout changed since you opened it. Refresh and review the latest version before saving.',
    );
}
function nextTimestamp(previous?: string): string {
  return new Date(Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0)).toISOString();
}
export function hasRecordedData(session: WorkoutSession): boolean {
  return (
    session.exercises.some((exercise) =>
      exercise.sets.some(
        (set) => set.completed || set.weight !== null || set.reps !== null || set.rir !== null,
      ),
    ) ||
    session.durationMinutes !== null ||
    session.sessionRpe !== null ||
    session.rounds !== null
  );
}
function requireUnloggedProposal(session: WorkoutSession): void {
  if (!['planned', 'skipped'].includes(session.status) || hasRecordedData(session)) {
    throw new Error(
      'Suggested plans may change planned or skipped workouts only. Completed work must be logged separately.',
    );
  }
}
export interface TrainingCommandDependencies {
  sessions: WorkoutSession[];
  templates: WorkoutTemplate[];
  requests: TrainingRequest[];
  reviews: TrainingReview[];
  scheduledDates: string[];
  schedule?: Record<string, string>;
}
export interface PreparedTrainingCommand {
  sessions: WorkoutSession[];
  deletedSessionIds: string[];
  templates: WorkoutTemplate[];
  checkIns: TrainingCheckIn[];
  requests: TrainingRequest[];
  reviews: TrainingReview[];
  scheduledDates: string[];
}
function markDates(command: PreparedTrainingCommand, dates: string[]): void {
  command.scheduledDates = [...new Set([...command.scheduledDates, ...dates])].sort();
}
/**
 * Dependencies must include every existing record addressed by the command:
 * save/delete IDs, request session, and review request/change IDs. Absent rows
 * mean nonexistent records, never unloaded records. Week preparation needs only
 * that week's occupied/scheduled dates and schedule-selected templates.
 * Returns writes only; callers must persist the complete result atomically.
 */
export function prepareTrainingCommand(
  raw: TrainingMutation,
  dependencies: TrainingCommandDependencies,
): PreparedTrainingCommand {
  const mutation = TrainingMutationSchema.parse(raw);
  const next: PreparedTrainingCommand = {
    sessions: [], deletedSessionIds: [], templates: [], checkIns: [],
    requests: [], reviews: [], scheduledDates: [],
  };
  switch (mutation.type) {
    case 'training.session.save': {
      const { session, expectedUpdatedAt } = mutation.data;
      const existing = dependencies.sessions.find((item) => item.id === session.id);
      checkVersion(existing, expectedUpdatedAt);
      if (existing?.status === 'completed' && session.status !== 'completed')
        throw new Error(
          'Keep completed history completed. Edit its logged details instead of resetting it to a plan.',
        );
      const saved = {
        ...session,
        createdAt: existing?.createdAt ?? session.createdAt,
        updatedAt: nextTimestamp(existing?.updatedAt),
      };
      next.sessions = upsert(next.sessions, saved);
      markDates(next, [session.date, ...(existing ? [existing.date] : [])]);
      break;
    }
    case 'training.session.delete': {
      const existing = dependencies.sessions.find((item) => item.id === mutation.data.id);
      if (!existing) throw new Error('This workout no longer exists. Refresh your plan.');
      checkVersion(existing, mutation.data.expectedUpdatedAt);
      if (!['planned', 'skipped'].includes(existing.status) || hasRecordedData(existing))
        throw new Error(
          'Logged workouts cannot be removed here. Edit the recorded workout instead.',
        );
      next.deletedSessionIds.push(existing.id);
      markDates(next, [existing.date]);
      break;
    }
    case 'training.week': {
      if (monday(mutation.data.weekStart) !== mutation.data.weekStart)
        throw new Error('The week must start on a Monday.');
      const occupied = new Set([
        ...dependencies.scheduledDates,
        ...dependencies.sessions.map((session) => session.date),
      ]);
      const entries = starterTrainingWeek(mutation.data.weekStart, dependencies.templates, dependencies.schedule).filter(
        (session) => !occupied.has(session.date),
      );
      next.sessions.push(...entries);
      markDates(
        next,
        entries.map((session) => session.date),
      );
      break;
    }
    case 'training.template.save': {
      const existing = dependencies.templates.find((item) => item.id === mutation.data.id);
      next.templates = upsert(next.templates, {
        ...mutation.data,
        createdAt: existing?.createdAt ?? mutation.data.createdAt,
        updatedAt: nextTimestamp(existing?.updatedAt),
      });
      break;
    }
    case 'training.checkin.save':
      next.checkIns = upsert(next.checkIns, mutation.data);
      break;
    case 'training.request.save':
      if (mutation.data.status !== 'pending')
        throw new Error('New coaching requests must be pending.');
      if (
        mutation.data.sessionId &&
        !dependencies.sessions.some((session) => session.id === mutation.data.sessionId)
      )
        throw new Error('Choose a workout from your current plan.');
      if (
        dependencies.requests.some(
          (request) => request.id === mutation.data.id && request.status === 'answered',
        )
      )
        throw new Error(
          'This request has already been answered. Create a new request for another question.',
        );
      next.requests = upsert(next.requests, mutation.data);
      break;
    case 'training.review.save': {
      const review = mutation.data;
      if (review.status !== 'proposed')
        throw new Error('Save a review as proposed before applying it.');
      if (dependencies.reviews.some((item) => item.id === review.id))
        throw new Error('This review already exists. Use a new ID for a new review.');
      if (review.requestId && !dependencies.requests.some((item) => item.id === review.requestId))
        throw new Error('That coaching request no longer exists.');
      for (const change of review.changes) {
        const existing = dependencies.sessions.find((session) => session.id === change.session.id);
        checkVersion(existing, change.expectedUpdatedAt);
        if (
          existing &&
          (existing.status === 'completed' ||
            existing.status === 'in_progress' ||
            hasRecordedData(existing))
        )
          throw new Error(
            'A coaching proposal cannot replace completed, in-progress, or partially logged workouts.',
          );
        requireUnloggedProposal(change.session);
      }
      next.reviews.push(review);
      if (review.requestId)
        next.requests = dependencies.requests
          .filter((item) => item.id === review.requestId)
          .map((item) => ({ ...item, status: 'answered' }));
      break;
    }
    case 'training.review.apply': {
      const review = dependencies.reviews.find((item) => item.id === mutation.data.id);
      if (!review) throw new Error('This coaching review no longer exists.');
      if (review.status !== 'proposed')
        throw new Error('This review has already been applied or dismissed.');
      // Validate the complete proposal before changing any session.
      for (const change of review.changes) {
        const existing = dependencies.sessions.find((session) => session.id === change.session.id);
        checkVersion(existing, change.expectedUpdatedAt);
        if (
          existing &&
          (existing.status === 'completed' ||
            existing.status === 'in_progress' ||
            hasRecordedData(existing))
        )
          throw new Error(
            'This workout has been started or partially logged. Request a fresh review for your remaining plan.',
          );
        requireUnloggedProposal(change.session);
      }
      for (const change of review.changes) {
        const existing = dependencies.sessions.find((session) => session.id === change.session.id);
        const session = {
          ...change.session,
          changeReason: change.reason,
          createdAt: existing?.createdAt ?? change.session.createdAt,
          updatedAt: nextTimestamp(existing?.updatedAt),
        };
        next.sessions = upsert(next.sessions, session);
        markDates(next, [session.date, ...(existing ? [existing.date] : [])]);
      }
      next.reviews = [{ ...review, status: 'applied' }];
      break;
    }
    case 'training.review.dismiss': {
      const review = dependencies.reviews.find((item) => item.id === mutation.data.id);
      if (!review || review.status !== 'proposed')
        throw new Error('Only a proposed review can be dismissed.');
      next.reviews = [{ ...review, status: 'dismissed' }];
      break;
    }
  }
  return structuredClone(next);
}

export function applyTrainingMutation(
  previous: TrainingState,
  raw: TrainingMutation,
  schedule?: Record<string, string>,
): TrainingState {
  const command = prepareTrainingCommand(raw, { ...previous, schedule });
  const next = structuredClone(previous);
  next.sessions = next.sessions.filter((item) => !command.deletedSessionIds.includes(item.id));
  for (const session of command.sessions) next.sessions = upsert(next.sessions, session);
  for (const template of command.templates) next.templates = upsert(next.templates, template);
  for (const checkIn of command.checkIns) next.checkIns = upsert(next.checkIns, checkIn);
  for (const request of command.requests) next.requests = upsert(next.requests, request);
  for (const review of command.reviews) next.reviews = upsert(next.reviews, review);
  if (
    raw.type === 'training.session.save' ||
    raw.type === 'training.session.delete' ||
    raw.type === 'training.week' ||
    (raw.type === 'training.review.apply' && command.sessions.length > 0)
  )
    next.scheduledDates = [...new Set([...next.scheduledDates, ...command.scheduledDates])].sort();
  if (
    next.templates.length > 100 ||
    next.sessions.length > 2500 ||
    next.checkIns.length > 2000 ||
    next.requests.length > 300 ||
    next.reviews.length > 300 ||
    next.scheduledDates.length > 5000
  )
    throw new Error(
      'Your training workspace is full. Export a backup before archiving old records.',
    );
  return next;
}

export function trainingStats(
  sessions: WorkoutSession[],
  from?: string,
  to?: string,
): TrainingStats {
  const complete = sessions.filter(
    (session) =>
      session.status === 'completed' &&
      session.kind !== 'recovery' &&
      (!from || session.date >= from) &&
      (!to || session.date <= to),
  );
  const stats: TrainingStats = {
    sessions: complete.length,
    strengthSessions: 0,
    boxingSessions: 0,
    conditioningSessions: 0,
    minutes: 0,
    workingSets: 0,
    externalVolumeLb: 0,
    averageRpe: null,
  };
  const effort: number[] = [];
  for (const session of complete) {
    if (session.kind === 'strength') stats.strengthSessions++;
    if (session.kind === 'boxing') stats.boxingSessions++;
    if (session.kind === 'conditioning') stats.conditioningSessions++;
    stats.minutes += session.durationMinutes ?? 0;
    if (session.sessionRpe !== null) effort.push(session.sessionRpe);
    for (const exercise of session.exercises)
      for (const set of exercise.sets) {
        if (!set.completed || set.kind !== 'working') continue;
        stats.workingSets++;
        // External load only: body mass and assistance are not comparable tonnage.
        if (
          (exercise.loadType === 'total' || exercise.loadType === 'per_hand') &&
          set.weight !== null &&
          set.reps !== null
        ) {
          stats.externalVolumeLb +=
            set.weight *
            set.reps *
            (exercise.loadType === 'per_hand' ? 2 : 1) *
            (session.unit === 'kg' ? 2.2046226218 : 1);
        }
      }
  }
  stats.externalVolumeLb = Math.round(stats.externalVolumeLb);
  stats.averageRpe = effort.length
    ? Math.round((effort.reduce((a, b) => a + b, 0) / effort.length) * 10) / 10
    : null;
  return stats;
}
export function weeklyTrainingStats(
  sessions: WorkoutSession[],
  date: string,
  weeks = 4,
): Array<TrainingStats & { weekStart: string; weekEnd: string }> {
  const current = monday(date);
  return Array.from(
    { length: Math.min(52, Math.max(1, Math.floor(weeks))) },
    (_, index) => index,
  ).map((_, index, values) => {
    const weekStart = plusDays(current, -(values.length - 1 - index) * 7);
    const weekEnd = plusDays(weekStart, 6);
    return { weekStart, weekEnd, ...trainingStats(sessions, weekStart, weekEnd) };
  });
}
export function exerciseHistory(
  sessions: WorkoutSession[],
  exerciseName: string,
): ExerciseHistoryEntry[] {
  const search = exerciseName.trim().toLowerCase();
  return sessions
    .filter((session) => session.status === 'completed')
    .flatMap((session) =>
      session.exercises
        .filter((exercise) => exercise.name.trim().toLowerCase() === search)
        .map((exercise) => {
          const sets = exercise.sets.filter((set) => set.completed && set.kind === 'working');
          const weights = sets.flatMap((set) => (set.weight === null ? [] : [set.weight]));
          return {
            sessionId: session.id,
            date: session.date,
            name: exercise.name,
            unit: session.unit,
            loadType: exercise.loadType,
            sets: structuredClone(sets),
            topWeight: weights.length ? Math.max(...weights) : null,
            totalReps: sets.reduce((total, set) => total + (set.reps ?? 0), 0),
          };
        })
        .filter((item) => item.sets.length > 0),
    )
    .sort((a, b) => b.date.localeCompare(a.date));
}
