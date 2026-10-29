import {
  bigint,
  boolean,
  check,
  customType,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import type { Settings } from '@packages/workspace/types';
import type { Recipe } from '@packages/nutrition/types';
import type { ExerciseTarget, TrainingReview } from '@packages/training/types';
import { sql } from 'drizzle-orm';

const instant = customType<{ data: string; driverData: string | Date }>({
  dataType: () => 'timestamp(3) with time zone',
  fromDriver: (value) => new Date(value).toISOString(),
});

export const workspaceMetadata = pgTable('workspace_metadata', {
  user_id: text().primaryKey(),
  revision: bigint({ mode: 'number' }).notNull().default(0),
  next_position: bigint({ mode: 'number' }).notNull().default(0),
  timezone: text().notNull(),
  settings: jsonb().$type<Omit<Settings, 'timezone'>>().notNull(),
});

const owned = () => ({
  user_id: text()
    .notNull()
    .references(() => workspaceMetadata.user_id),
  id: text().notNull(),
});
const position = () => bigint({ mode: 'number' }).notNull();
const nutrition = () => ({
  calories: doublePrecision().notNull(),
  protein: doublePrecision().notNull(),
  carbs: doublePrecision().notNull(),
  fat: doublePrecision().notNull(),
});

export const recipes = pgTable(
  'workspace_recipes',
  {
    ...owned(),
    position: position(),
    name: text().notNull(),
    category: text().notNull(),
    favorite: boolean().notNull(),
    created_at: instant().notNull(),
    ...nutrition(),
    content: jsonb()
      .$type<Omit<Recipe, 'id' | 'name' | 'category' | 'favorite' | 'createdAt' | 'nutrition'>>()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.id] }),
    index('workspace_recipes_library').on(t.user_id, t.position, t.id),
    check('workspace_recipes_category', sql`${t.category} in ('breakfast', 'main', 'snack')`),
    check(
      'workspace_recipes_nutrition',
      sql`${t.calories} between 0 and 10000 and ${t.protein} between 0 and 1500 and ${t.carbs} between 0 and 2500 and ${t.fat} between 0 and 1500`,
    ),
  ],
);

export const plannedMeals = pgTable(
  'workspace_planned_meals',
  {
    ...owned(),
    position: position(),
    date: date({ mode: 'string' }).notNull(),
    slot: text().notNull(),
    recipe_id: text().notNull(),
    servings: doublePrecision().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.id] }),
    foreignKey({
      columns: [t.user_id, t.recipe_id],
      foreignColumns: [recipes.user_id, recipes.id],
    }),
    index('workspace_planned_meals_date').on(t.user_id, t.date, t.position, t.id),
    check('workspace_planned_meals_servings', sql`${t.servings} between 0.05 and 100`),
    check(
      'workspace_planned_meals_slot',
      sql`${t.slot} in ('breakfast', 'lunch', 'dinner', 'snack', 'fuel')`,
    ),
  ],
);

export const foodEntries = pgTable(
  'workspace_food_entries',
  {
    ...owned(),
    position: position(),
    date: date({ mode: 'string' }).notNull(),
    slot: text().notNull(),
    name: text().notNull(),
    ...nutrition(),
    servings: doublePrecision().notNull(),
    recipe_id: text(),
    plan_entry_id: text(),
    created_at: instant().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.id] }),
    unique('workspace_food_entries_one_plan').on(t.user_id, t.plan_entry_id),
    index('workspace_food_entries_date').on(t.user_id, t.date, t.position, t.id),
    check('workspace_food_entries_servings', sql`${t.servings} between 0.05 and 100`),
    check(
      'workspace_food_entries_slot',
      sql`${t.slot} in ('breakfast', 'lunch', 'dinner', 'snack', 'fuel')`,
    ),
    check(
      'workspace_food_entries_nutrition',
      sql`${t.calories} between 0 and 10000 and ${t.protein} between 0 and 1500 and ${t.carbs} between 0 and 2500 and ${t.fat} between 0 and 1500`,
    ),
  ],
);

export const groceryChecks = pgTable(
  'workspace_grocery_checks',
  {
    user_id: text()
      .notNull()
      .references(() => workspaceMetadata.user_id),
    key: text().notNull(),
    position: position(),
    checked: boolean().notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.key] })],
);

export const recipeRequests = pgTable(
  'workspace_recipe_requests',
  {
    ...owned(),
    position: position(),
    prompt: text().notNull(),
    calories: doublePrecision().notNull(),
    protein: doublePrecision().notNull(),
    max_minutes: doublePrecision().notNull(),
    status: text().notNull(),
    created_at: instant().notNull(),
    recipe_id: text(),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.id] })],
);

export const workoutTemplates = pgTable(
  'workspace_workout_templates',
  {
    ...owned(),
    position: position(),
    name: text().notNull(),
    kind: text().notNull(),
    description: text().notNull(),
    duration_minutes: integer().notNull(),
    exercises: jsonb().$type<ExerciseTarget[]>().notNull(),
    created_at: instant().notNull(),
    updated_at: instant().notNull(),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.id] })],
);

export const workoutSessions = pgTable(
  'workspace_workout_sessions',
  {
    ...owned(),
    position: position(),
    template_id: text(),
    date: date({ mode: 'string' }).notNull(),
    name: text().notNull(),
    kind: text().notNull(),
    status: text().notNull(),
    allows_unknown_targets: boolean().generatedAlwaysAs(sql`status = 'completed'`),
    unit: text().notNull(),
    planned_minutes: integer(),
    duration_minutes: doublePrecision(),
    rounds: integer(),
    session_rpe: doublePrecision(),
    readiness: integer(),
    notes: text().notNull(),
    change_reason: text().notNull(),
    created_at: instant().notNull(),
    updated_at: instant().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.id] }),
    unique('workspace_workout_sessions_recorded_targets').on(t.user_id, t.id, t.allows_unknown_targets),
    index('workspace_workout_sessions_date').on(t.user_id, t.date, t.position, t.id),
    check(
      'workspace_workout_sessions_status',
      sql`${t.status} in ('planned', 'in_progress', 'completed', 'skipped')`,
    ),
    check(
      'workspace_workout_sessions_planned',
      sql`${t.status} = 'completed' or ${t.planned_minutes} is not null`,
    ),
    check('workspace_workout_sessions_unit', sql`${t.unit} in ('lb', 'kg')`),
    check(
      'workspace_workout_sessions_kind',
      sql`${t.kind} in ('strength', 'boxing', 'conditioning', 'recovery')`,
    ),
  ],
);

export const workoutExercises = pgTable(
  'workspace_workout_exercises',
  {
    ...owned(),
    session_id: text().notNull(),
    position: integer().notNull(),
    name: text().notNull(),
    load_type: text().notNull(),
    target_sets: integer(),
    rep_min: integer(),
    rep_max: integer(),
    target_rir: doublePrecision(),
    rest_seconds: integer(),
    notes: text().notNull(),
    catalog_id: text(),
    target_weight: doublePrecision(),
    target_unit: text(),
    // NULL exempts complete targets from the conditional completed-parent foreign key.
    requires_completed: boolean().generatedAlwaysAs(
      sql`CASE WHEN target_sets IS NULL OR rep_min IS NULL OR rep_max IS NULL OR rest_seconds IS NULL THEN true ELSE NULL END`,
    ),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.session_id, t.id] }),
    foreignKey({
      columns: [t.user_id, t.session_id],
      foreignColumns: [workoutSessions.user_id, workoutSessions.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'workspace_workout_exercises_recorded_targets',
      columns: [t.user_id, t.session_id, t.requires_completed],
      foreignColumns: [workoutSessions.user_id, workoutSessions.id, workoutSessions.allows_unknown_targets],
    }),
    index('workspace_workout_exercises_history').on(t.user_id, t.name, t.session_id),
    check(
      'workspace_workout_exercises_target',
      sql`${t.target_sets} between 1 and 20 and ${t.rep_min} between 1 and 200 and ${t.rep_max} between ${t.rep_min} and 200 and ${t.rest_seconds} between 0 and 900 and (${t.rep_min} is null) = (${t.rep_max} is null)`,
    ),
    check(
      'workspace_workout_exercises_load',
      sql`${t.load_type} in ('total', 'per_hand', 'bodyweight', 'assistance') and (${t.target_weight} is null) = (${t.target_unit} is null) and (${t.target_unit} is null or ${t.target_unit} in ('lb', 'kg'))`,
    ),
  ],
);

export const workoutSets = pgTable(
  'workspace_workout_sets',
  {
    ...owned(),
    session_id: text().notNull(),
    exercise_id: text().notNull(),
    position: integer().notNull(),
    weight: doublePrecision(),
    reps: integer(),
    rir: doublePrecision(),
    completed: boolean().notNull(),
    kind: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.session_id, t.exercise_id, t.id] }),
    foreignKey({
      columns: [t.user_id, t.session_id, t.exercise_id],
      foreignColumns: [workoutExercises.user_id, workoutExercises.session_id, workoutExercises.id],
    }).onDelete('cascade'),
    check(
      'workspace_workout_sets_values',
      sql`(${t.weight} is null or ${t.weight} between 0 and 2000) and (${t.reps} is null or ${t.reps} between 0 and 500) and (${t.rir} is null or ${t.rir} between 0 and 10)`,
    ),
    check(
      'workspace_workout_sets_completed',
      sql`not ${t.completed} or (${t.reps} is not null and ${t.reps} >= 1)`,
    ),
    check('workspace_workout_sets_kind', sql`${t.kind} in ('working', 'warmup')`),
  ],
);

export const checkIns = pgTable(
  'workspace_check_ins',
  {
    ...owned(),
    position: position(),
    date: date({ mode: 'string' }).notNull(),
    body_weight: doublePrecision(),
    waist: doublePrecision(),
    sleep_hours: doublePrecision(),
    energy: integer(),
    soreness: integer(),
    boxing_quality: integer(),
    notes: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.id] }),
    index('workspace_check_ins_date').on(t.user_id, t.date, t.position, t.id),
  ],
);

export const trainingRequests = pgTable(
  'workspace_training_requests',
  {
    ...owned(),
    position: position(),
    prompt: text().notNull(),
    date: date({ mode: 'string' }).notNull(),
    session_id: text(),
    status: text().notNull(),
    created_at: instant().notNull(),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.id] })],
);

export const trainingReviews = pgTable(
  'workspace_training_reviews',
  {
    ...owned(),
    position: position(),
    request_id: text(),
    title: text().notNull(),
    summary: text().notNull(),
    created_at: instant().notNull(),
    status: text().notNull(),
    changes: jsonb().$type<TrainingReview['changes']>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.id] })],
);

export const scheduledDates = pgTable(
  'workspace_scheduled_dates',
  {
    user_id: text()
      .notNull()
      .references(() => workspaceMetadata.user_id),
    date: date({ mode: 'string' }).notNull(),
    position: position(),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.date] })],
);

export const importSources = pgTable(
  'workspace_import_sources',
  {
    user_id: text().notNull().references(() => workspaceMetadata.user_id, { onDelete: 'cascade' }),
    source_namespace: text().notNull(),
    record_type: text().notNull(),
    source_record_id: text().notNull(),
    source_fingerprint: text().notNull(),
    destination_id: text().notNull(),
    position: position(),
  },
  (t) => [
    primaryKey({ name: 'workspace_import_sources_identity', columns: [t.user_id, t.source_namespace, t.record_type, t.source_record_id] }),
    unique('workspace_import_sources_destination').on(t.user_id, t.record_type, t.destination_id),
    index('workspace_import_sources_export').on(t.user_id, t.position),
  ],
);

export const mutationReceipts = pgTable(
  'mutation_receipts',
  {
    user_id: text().notNull(),
    request_id: text().notNull(),
    payload_hash: text().notNull(),
    revision: bigint({ mode: 'number' }).notNull(),
    created_at: text().notNull(),
    import_outcomes: jsonb().$type<Array<{ sourceRecordId: string; destinationId: string; outcome: 'created' | 'skipped' }>>(),
  },
  (table) => [
    primaryKey({ name: 'mutation_receipts_pkey', columns: [table.user_id, table.request_id] }),
    index('mutation_receipts_user_revision').on(table.user_id, table.revision),
  ],
);

export const aiRuns = pgTable(
  'corner_ai_runs',
  {
    id: text().primaryKey(),
    user_id: text().notNull(),
    request_id: text().notNull(),
    payload_hash: text().notNull(),
    kind: text().notNull(),
    status: text().notNull(),
    prompt: text().notNull(),
    reference_date: text().notNull(),
    base_revision: bigint({ mode: 'number' }).notNull(),
    result: text(),
    error: text(),
    error_code: text(),
    error_status: integer(),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (table) => [
    unique('corner_ai_runs_user_id_kind_request_id_key').on(
      table.user_id,
      table.kind,
      table.request_id,
    ),
    index('corner_ai_runs_owner').on(table.user_id, table.created_at),
  ],
);

export const subscriptionMeta = pgTable('corner_subscription_meta', {
  key: text().primaryKey(),
  value: text().notNull(),
});

export const subscriptionAccounts = pgTable('corner_subscription_accounts', {
  user_id: text().primaryKey(),
  encrypted: text().notNull(),
  version: bigint({ mode: 'number' }).notNull().default(1),
  refresh_owner: text(),
  refresh_until: bigint({ mode: 'number' }).notNull().default(0),
});

export const subscriptionAttempts = pgTable(
  'corner_subscription_attempts',
  {
    state_hash: text().primaryKey(),
    user_id: text().notNull(),
    session_hash: text().notNull(),
    encrypted: text().notNull(),
    expires_at: bigint({ mode: 'number' }).notNull(),
  },
  (table) => [index('corner_subscription_attempt_owner').on(table.user_id)],
);

export const subscriptionGenerations = pgTable('corner_subscription_generations', {
  user_id: text().primaryKey(),
  generation: bigint({ mode: 'number' }).notNull(),
});

export * from './delegation-schema.js';
