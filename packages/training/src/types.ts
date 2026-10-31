export type WorkoutKind = 'strength' | 'boxing' | 'conditioning' | 'recovery';
export type WorkoutStatus = 'planned' | 'in_progress' | 'completed' | 'skipped';
export type LoadType = 'total' | 'per_hand' | 'bodyweight' | 'assistance';
export type WorkoutSet = {
  id: string;
  weight: number | null;
  reps: number | null;
  rir: number | null;
  completed: boolean;
  kind: 'working' | 'warmup';
};
export type ExerciseTarget = {
  id: string;
  name: string;
  loadType: LoadType;
  targetSets: number;
  repMin: number;
  repMax: number;
  targetRir: number | null;
  restSeconds: number;
  notes: string;
  catalogId?: string;
  targetLoad?: { weight: number; unit: 'lb' | 'kg' };
};
/** Planned fields are null only on completed actual-only history; a plan always carries them. */
export type WorkoutExercise = Omit<
  ExerciseTarget,
  'targetSets' | 'repMin' | 'repMax' | 'restSeconds'
> & {
  targetSets: number | null;
  repMin: number | null;
  repMax: number | null;
  restSeconds: number | null;
  sets: WorkoutSet[];
};
export type WorkoutTemplate = {
  id: string;
  name: string;
  kind: WorkoutKind;
  description: string;
  durationMinutes: number;
  exercises: ExerciseTarget[];
  createdAt: string;
  updatedAt: string;
};
export type WorkoutSession = {
  id: string;
  templateId?: string;
  date: string;
  name: string;
  kind: WorkoutKind;
  status: WorkoutStatus;
  unit: 'lb' | 'kg';
  exercises: WorkoutExercise[];
  plannedMinutes: number | null;
  durationMinutes: number | null;
  rounds: number | null;
  sessionRpe: number | null;
  readiness: number | null;
  notes: string;
  changeReason: string;
  createdAt: string;
  updatedAt: string;
  /** Absent on older/manual records; never inferred from creation time. */
  timing?: WorkoutTiming;
};
export type WorkoutTiming = {
  startedAt: string;
  endedAt?: string;
  rests: Array<{
    exerciseId: string;
    setId: string;
    startedAt: string;
    /** Only an explicit next-set action measures the end of rest. */
    endedAt?: string;
    /** Another set or workout finish occurred without an observed next-set start. */
    interrupted?: true;
    targetSeconds: number;
  }>;
};
export type TrainingCheckIn = {
  id: string;
  date: string;
  bodyWeight: number | null;
  waist: number | null;
  sleepHours: number | null;
  energy: number | null;
  soreness: number | null;
  boxingQuality: number | null;
  notes: string;
};
export type TrainingRequest = {
  id: string;
  prompt: string;
  date: string;
  sessionId?: string;
  status: 'pending' | 'answered';
  createdAt: string;
};
export type TrainingChange = {
  session: WorkoutSession;
  expectedUpdatedAt: string | null;
  reason: string;
};
export type TrainingReview = {
  id: string;
  requestId?: string;
  title: string;
  summary: string;
  createdAt: string;
  status: 'proposed' | 'applied' | 'dismissed';
  changes: TrainingChange[];
};
export type TrainingState = {
  templates: WorkoutTemplate[];
  sessions: WorkoutSession[];
  checkIns: TrainingCheckIn[];
  requests: TrainingRequest[];
  reviews: TrainingReview[];
  scheduledDates: string[];
};
export type TrainingMutation =
  | {
      type: 'training.session.save';
      data: { session: WorkoutSession; expectedUpdatedAt: string | null };
    }
  | { type: 'training.session.delete'; data: { id: string; expectedUpdatedAt: string } }
  | { type: 'training.week'; data: { weekStart: string } }
  | { type: 'training.template.save'; data: WorkoutTemplate }
  | { type: 'training.checkin.save'; data: TrainingCheckIn };
export type TrainingStats = {
  sessions: number;
  strengthSessions: number;
  boxingSessions: number;
  conditioningSessions: number;
  minutes: number;
  workingSets: number;
  externalVolumeLb: number;
  averageRpe: number | null;
};
export type ExerciseHistoryEntry = {
  sessionId: string;
  date: string;
  name: string;
  unit: 'lb' | 'kg';
  loadType: LoadType;
  sets: WorkoutSet[];
  topWeight: number | null;
  totalReps: number;
};
