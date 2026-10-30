import type { PoolClient } from 'pg';
import pg from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { drizzle } from 'drizzle-orm/node-postgres';
import { MutationSchema, SettingsSchema } from '@packages/workspace/mutations';
import {
  WorkoutExerciseSchema,
  TrainingDateSchema,
  WorkoutSetSchema,
} from '@packages/training/workouts';
import { foodRecord } from './food-records.js';
import { recipeRecord, planRecord, recipeRequestRecord } from './nutrition-records.js';
import {
  templateRecord,
  checkInRecord,
  trainingRequestRecord,
  reviewRecord,
  sessionRecords,
} from './training-records.js';
import type { Transaction } from './queries.js';
import { quoteIdentifier as quote } from './schema-catalog.js';
import { importSourceRecord } from './workspace-portability.js';
import { ImportOutcomesSchema } from './additive-import.js';

export const storageGeneration = 'relational-v1';

function compatible<T extends object>(decode: (row: T) => object): (row: T) => void {
  return (row) => {
    const decoded = decode(row) as Record<string, unknown>;
    for (const [column, value] of Object.entries(row)) {
      if (column === 'content') {
        for (const [key, nested] of Object.entries(value as Record<string, unknown>))
          if (!isDeepStrictEqual(decoded[key], nested)) throw new Error('Lossy stored record.');
      } else {
        const key = column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
        if (Object.hasOwn(decoded, key) && !isDeepStrictEqual(decoded[key], value))
          throw new Error('Lossy stored record.');
      }
    }
  };
}

/** The caller owns one READ ONLY REPEATABLE READ transaction and its resources. */
export async function validatePersistedRecords(
  connection: PoolClient,
  schema: string,
): Promise<void> {
  const mode = (
    await connection.query(
      "SELECT current_setting('transaction_read_only') AS readonly, current_setting('transaction_isolation') AS isolation",
    )
  ).rows[0];
  if (mode.readonly !== 'on' || mode.isolation !== 'repeatable read')
    throw new Error('A consistent read-only snapshot is required.');
  const database = drizzle(connection) as unknown as Transaction;
  const scan = async <T>(
    table: string,
    keys: string[],
    validate: (row: T) => unknown | Promise<unknown>,
  ) => {
    let after: unknown[] | null = null;
    const columns = keys.map(quote).join(',');
    for (;;) {
      const where = after
        ? `WHERE (${columns}) > (${keys.map((_, index) => `$${index + 1}`).join(',')})`
        : '';
      const rows: Array<Record<string, unknown>> = (
        await connection.query({
          text: `SELECT * FROM ${quote(schema)}.${quote(table)} ${where} ORDER BY ${columns} LIMIT 100`,
          values: after ?? [],
          // DATE is a calendar value, not local midnight converted through UTC.
          // Scope this decoder to the scan; timestamp decoding remains native.
          types: {
            getTypeParser: (oid: number) =>
              oid === 1082 ? (value: string) => value : pg.types.getTypeParser(oid),
          },
        })
      ).rows;
      for (const raw of rows) {
        const row = Object.fromEntries(
          Object.entries(raw).map(([key, value]) => [
            key,
            value instanceof Date ? value.toISOString() : value,
          ]),
        );
        await validate(row as T);
      }
      if (rows.length < 100) break;
      after = keys.map((key) => rows.at(-1)![key]);
    }
  };
  await scan<{
    settings: Record<string, unknown>;
    timezone: string;
    revision: string;
    next_position: string;
  }>('workspace_metadata', ['user_id'], (row) => {
    const settings = { ...row.settings, timezone: row.timezone };
    if (!isDeepStrictEqual(SettingsSchema.parse(settings), settings))
      throw new Error('Lossy stored settings.');
    for (const value of [row.revision, row.next_position])
      if (!Number.isSafeInteger(Number(value)) || Number(value) < 0)
        throw new Error('Invalid workspace counter.');
  });
  await scan('workspace_recipes', ['user_id', 'id'], compatible(recipeRecord));
  await scan('workspace_planned_meals', ['user_id', 'id'], compatible(planRecord));
  await scan('workspace_food_entries', ['user_id', 'id'], compatible(foodRecord));
  await scan('workspace_recipe_requests', ['user_id', 'id'], compatible(recipeRequestRecord));
  await scan('workspace_workout_templates', ['user_id', 'id'], compatible(templateRecord));
  await scan('workspace_check_ins', ['user_id', 'id'], compatible(checkInRecord));
  await scan('workspace_training_requests', ['user_id', 'id'], compatible(trainingRequestRecord));
  await scan('workspace_training_reviews', ['user_id', 'id'], compatible(reviewRecord));
  await scan('workspace_import_sources',
    ['user_id', 'source_namespace', 'record_type', 'source_record_id'],
    compatible(importSourceRecord));
  await scan<{ import_outcomes: unknown }>('mutation_receipts', ['user_id', 'request_id'], (row) => {
    if (row.import_outcomes !== null) ImportOutcomesSchema.parse(row.import_outcomes);
  });
  await scan<Parameters<typeof sessionRecords>[2][number]>(
    'workspace_workout_sessions',
    ['user_id', 'id'],
    async (row) => {
      // Guard child cardinality before the shared record adapter loads a session.
      const counts = (
        await connection.query(
          `SELECT
      (SELECT count(*) FROM ${quote(schema)}.workspace_workout_exercises WHERE user_id=$1 AND session_id=$2) AS exercises,
      (SELECT coalesce(max(n),0) FROM (SELECT count(*) AS n FROM ${quote(schema)}.workspace_workout_sets WHERE user_id=$1 AND session_id=$2 GROUP BY exercise_id) grouped) AS sets`,
          [row.user_id, row.id],
        )
      ).rows[0];
      if (Number(counts.exercises) > 25 || Number(counts.sets) > 30)
        throw new Error('Invalid workout cardinality.');
      const [session] = await sessionRecords(database, row.user_id, [row]);
      if (!session) throw new Error('Missing workout record.');
      compatible(() => session)(row);
    },
  );
  await scan<Record<string, unknown>>(
    'workspace_workout_exercises',
    ['user_id', 'session_id', 'id'],
    compatible((row) =>
      WorkoutExerciseSchema.parse({
        id: row.id,
        name: row.name,
        loadType: row.load_type,
        targetSets: row.target_sets,
        repMin: row.rep_min,
        repMax: row.rep_max,
        targetRir: row.target_rir,
        restSeconds: row.rest_seconds,
        notes: row.notes,
        ...(row.catalog_id === null ? {} : { catalogId: row.catalog_id }),
        ...(row.target_weight === null
          ? {}
          : { targetLoad: { weight: row.target_weight, unit: row.target_unit } }),
        sets: [],
      }),
    ),
  );
  await scan<Record<string, unknown>>(
    'workspace_workout_sets',
    ['user_id', 'session_id', 'exercise_id', 'id'],
    compatible((row) =>
      WorkoutSetSchema.parse({
        id: row.id,
        weight: row.weight,
        reps: row.reps,
        rir: row.rir,
        completed: row.completed,
        kind: row.kind,
      }),
    ),
  );
  await scan<{ date: string }>('workspace_scheduled_dates', ['user_id', 'date'], (row) =>
    TrainingDateSchema.parse(row.date),
  );
  await scan<{ key: string }>('workspace_grocery_checks', ['user_id', 'key'], (row) => {
    const mutation = MutationSchema.parse({
      type: 'grocery.check',
      data: { key: row.key, checked: true },
    });
    if (mutation.type !== 'grocery.check' || mutation.data.key !== row.key)
      throw new Error('Lossy grocery key.');
  });
}
