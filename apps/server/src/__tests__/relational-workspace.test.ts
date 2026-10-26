import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { testDatabase, closeTestDatabase } from '../../tests/helpers.ts';
import { WorkspaceStore, inspectImport } from '../store.js';
import type { Database } from '../queries.js';
import * as schema from '../schema.js';
import { consistentRead, recordDetails, recordPage } from '../workspace-queries.js';
import { exerciseChoices, exerciseHistoryPage, prefillHistory, progress } from '../training-queries.js';
import { groceries } from '../grocery-queries.js';
import { planningContext, planningHistory, proposalDependencies } from '../planning-context.js';
import type { Recipe, FoodEntry } from '@packages/nutrition/types';
import type { WorkoutSession } from '@packages/training/types';
import { getWorkoutPrefill } from '@packages/training/prefill';
import { ApiError } from '../http.js';
import { createInitialState } from '@packages/workspace/initial-state';
import { exportRelational } from '../workspace-portability.js';
import { readFoodWindow } from '../food-records.js';
import { MAX_WORKSPACE_TRANSFER_BYTES } from '@packages/api/workspace-data';

let database: Pool;
let store: WorkspaceStore;
const queries: Array<{ query: string; params: unknown[] }> = [];
beforeEach(async () => {
  database = await testDatabase();
  queries.length = 0;
  const db = drizzle({ client: database, schema, logger: {
    logQuery(query, params) { queries.push({ query, params }); },
  } }) as Database;
  store = new WorkspaceStore(db);
});
afterEach(async () => closeTestDatabase(database));
const errorCode = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;
const stamp = '2026-10-22T12:00:00.000Z';
function recipe(id = 'recipe'): Recipe {
  return { id, name: 'Synthetic oats', description: '', category: 'breakfast', prepMinutes: 1,
    cookMinutes: 0, nutrition: { calories: 320, protein: 25, carbs: 40, fat: 7 },
    ingredients: [{ name: 'Oats', quantity: 100, unit: 'g', aisle: 'Grains', shoppingQuantity: 100, shoppingUnit: 'g' }],
    steps: ['Mix.'], storage: '', variation: '', tags: ['wholegrain'], color: '#234b35',
    source: 'manual', favorite: false, createdAt: stamp };
}
function food(id = 'food'): FoodEntry {
  return { id, date: '2026-10-22', slot: 'breakfast', name: 'Recorded oats',
    nutrition: { calories: 320, protein: 25, carbs: 40, fat: 7 }, servings: 1, createdAt: stamp };
}
function workout(id = 'workout', date = '2026-10-22'): WorkoutSession {
  return { id, date, name: 'Strength', kind: 'strength', status: 'planned', unit: 'kg',
    plannedMinutes: 40, durationMinutes: null, rounds: null, sessionRpe: null, readiness: null,
    notes: '', changeReason: '', createdAt: stamp, updatedAt: stamp,
    exercises: [{ id: 'exercise', name: 'Bench press', loadType: 'total', targetSets: 1,
      repMin: 6, repMax: 10, targetRir: 2, restSeconds: 90, notes: '',
      sets: [{ id: 'set', weight: null, reps: null, rir: null, completed: false, kind: 'working' }] }] };
}

test('history beyond the old byte ceiling never enters food, set, or grocery commands/responses', async () => {
  await store.mutate('alice', 'initialize-owner', { type: 'grocery.check', data: { key: 'initial|g', checked: true } });
  await database.query(`INSERT INTO workspace_food_entries
    (user_id,id,position,date,slot,name,calories,protein,carbs,fat,servings,created_at)
    SELECT 'alice','history-'||n,n,'2020-01-01','snack',repeat('x',180),100,10,10,2,1,$1
    FROM generate_series(1,12000) n`, [stamp]);
  await database.query(`UPDATE workspace_metadata SET next_position=12001 WHERE user_id='alice'`);
  const size = Number((await database.query(`SELECT sum(octet_length(row_to_json(f)::text)) AS bytes FROM workspace_food_entries f`)).rows[0].bytes);
  assert.ok(size > 1_800_000);
  queries.length = 0;
  const saved = await store.mutate('alice', 'bounded-food-save', { type: 'log.save', data: food() });
  assert.deepEqual(Object.keys(saved), ['revision']);
  assert.ok(JSON.stringify(saved).length < 100);
  assert.ok(!queries.some(({ query }) => /workspace_workout|workspace_check_ins|workspace_recipes|workspace_planned_meals/.test(query)));
  assert.ok(queries.filter(({ query }) => /select/i.test(query) && /workspace_food_entries/.test(query))
    .every(({ params }) => params.includes('food')));
  const page = await store.foodWindow('alice', { from: '2020-01-01', through: '2020-01-01', limit: 1 });
  assert.equal(page.entries.length, 1);
  assert.equal(page.totals.calories, 1_200_000);
  assert.ok(page.nextCursor);
  assert.ok(JSON.stringify(page).length < 1000);
  const next = await store.foodWindow('alice', { from: '2020-01-01', through: '2020-01-01', limit: 1, cursor: page.nextCursor! });
  assert.notEqual(next.entries[0].id, page.entries[0].id);
  assert.equal(next.totals.calories, page.totals.calories);
  await store.mutate('alice', 'create-one-workout', { type: 'training.session.save', data: { session: workout(), expectedUpdatedAt: null } });
  await database.query(`INSERT INTO workspace_workout_sessions
    (user_id,id,position,date,name,kind,status,unit,planned_minutes,duration_minutes,rounds,session_rpe,readiness,notes,change_reason,created_at,updated_at)
    SELECT user_id,'other-workout-'||n,13000+n,'2019-01-01',name,kind,'planned',unit,planned_minutes,
      null,null,null,null,repeat('x',4000),'',created_at,updated_at
    FROM workspace_workout_sessions CROSS JOIN generate_series(1,600) n WHERE id='workout' AND user_id='alice'`);
  await database.query("UPDATE workspace_metadata SET next_position=14000 WHERE user_id='alice'");
  const [session] = (await recordDetails(store.db, 'alice', { sessionIds: ['workout'] })).sessions;
  session.status = 'in_progress';
  session.exercises[0].sets[0] = { ...session.exercises[0].sets[0], weight: 20, reps: 8, completed: true };
  queries.length = 0;
  await store.mutate('alice', 'record-single-set', { type: 'training.session.save', data: { session, expectedUpdatedAt: session.updatedAt } });
  assert.ok(!queries.some(({ query }) => /workspace_food_entries|workspace_recipes|workspace_planned_meals|workspace_check_ins/.test(query)));
  assert.equal(queries.filter(({ query }) => /insert into "workspace_workout_sets"/.test(query)).length, 1);
  const workoutReads = queries.filter(({ query }) =>
    /^select/i.test(query) && /workspace_workout_(sessions|exercises|sets)/.test(query));
  assert.ok(workoutReads.length > 0);
  assert.ok(workoutReads.every(({ params }) => params.some((value) =>
    value === 'workout' || (Array.isArray(value) && value.includes('workout')))),
    'Every workout/session child read must include the addressed workout dependency, not only the owner.');
  queries.length = 0;
  const check = await store.mutate('alice', 'bounded-grocery-check', { type: 'grocery.check', data: { key: 'oats|g', checked: true } });
  assert.deepEqual(Object.keys(check), ['revision']);
  assert.ok(!queries.some(({ query }) => /workspace_food_entries|workspace_workout|workspace_recipes|workspace_planned_meals/.test(query)));
  await assert.rejects(store.foodWindow('alice', { from: '2020-01-01', through: '2020-01-01', cursor: page.nextCursor! }), errorCode('CURSOR_INVALIDATED'));
  assert.equal((await store.foodWindow('bob', { from: '2020-01-01', through: '2020-01-01' })).entries.length, 0);
});

test('live owner-aware relations reject cross-owner plans; historical food snapshots and one-plan uniqueness survive source deletion', async () => {
  await store.mutate('alice', 'save-source-recipe', { type: 'recipe.save', data: recipe() });
  await store.mutate('bob', 'initialize-bob-row', { type: 'grocery.check', data: { key: 'bob|g', checked: true } });
  await assert.rejects(database.query(`INSERT INTO workspace_planned_meals
    (user_id,id,position,date,slot,recipe_id,servings) VALUES ('bob','foreign',0,'2026-10-22','breakfast','recipe',1)`),
    (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23503'));
  await store.mutate('alice', 'save-planned-meal', { type: 'plan.save', data: { id: 'plan', date: '2026-10-22', slot: 'breakfast', recipeId: 'recipe', servings: 1 } });
  const recorded = { ...food(), recipeId: 'recipe', planEntryId: 'plan' };
  await store.mutate('alice', 'record-plan-once', { type: 'log.save', data: recorded });
  await assert.rejects(store.mutate('alice', 'record-plan-twice', { type: 'log.save', data: { ...recorded, id: 'duplicate' } }), errorCode('INVALID_INPUT'));
  await store.mutate('alice', 'edit-source-recipe', { type: 'recipe.save', data: { ...recipe(), name: 'Changed source', nutrition: { calories: 100, protein: 1, carbs: 10, fat: 2 } } });
  const planned = await recordPage(store.db, 'alice', { resource: 'plan', from: '2026-10-22', through: '2026-10-22', limit: 1 });
  assert.deepEqual(planned.loggedPlanIds, ['plan']);
  await store.mutate('alice', 'delete-source-plan', { type: 'plan.delete', data: { id: 'plan' } });
  await store.mutate('alice', 'delete-source-recipe', { type: 'recipe.delete', data: { id: 'recipe' } });
  assert.deepEqual((await store.foodWindow('alice', { from: '2026-10-22', through: '2026-10-22' })).entries, [recorded]);
  const exported = await store.exportSnapshot('alice');
  await store.replaceImport('import-owner', 'historical-import', exported.state, 0);
  assert.deepEqual((await store.exportSnapshot('import-owner')).state, exported.state);
});

test('full-range aggregates and arbitrarily old measurements/exercise prefill do not depend on calendar pages', async () => {
  const prior = workout('prior', '2020-01-01');
  prior.status = 'completed'; prior.durationMinutes = 40; prior.sessionRpe = 7;
  prior.exercises[0].sets[0] = { id: 'set', weight: 30, reps: 8, rir: 2, completed: true, kind: 'working' };
  await store.mutate('alice', 'old-completed-work', { type: 'training.session.save', data: { session: prior, expectedUpdatedAt: null } });
  await store.mutate('alice', 'old-nonnull-weight', { type: 'training.checkin.save', data: {
    id: 'old-weight', date: '2020-01-01', bodyWeight: 180, waist: null, sleepHours: null,
    energy: null, soreness: null, boxingQuality: null, notes: '',
  } });
  await store.mutate('alice', 'new-null-weight', { type: 'training.checkin.save', data: {
    id: 'new-weight', date: '2026-10-22', bodyWeight: null, waist: null, sleepHours: 8,
    energy: null, soreness: null, boxingQuality: null, notes: '',
  } });
  const result = await progress(store.db, 'alice', { from: '2026-10-19', through: '2026-10-25' });
  assert.equal(result.stats.sessions, 0);
  assert.equal(result.completedCount, 1);
  assert.equal(result.latestWeight?.id, 'old-weight');
  const names = await exerciseChoices(store.db, 'alice', {});
  assert.deepEqual(names.names, ['Bench press']);
  const history = await exerciseHistoryPage(store.db, 'alice', { name: ' bench PRESS ' });
  assert.equal(history.sessions[0].id, 'prior');
  const draft = workout('draft');
  const prefill = await prefillHistory(store.db, 'alice', { session: draft });
  assert.equal(prefill.sessions[0].id, 'prior');
  assert.equal(getWorkoutPrefill(draft, prefill.sessions).exercise.set.weight, 30);
  const recent = await recordPage(store.db, 'alice', { resource: 'checkIns', order: 'recent', limit: 1 });
  assert.equal(recent.resource, 'checkIns');
  if (recent.resource === 'checkIns') assert.equal(recent.items[0].id, 'new-weight');
});

test('grocery aggregates span every meal and preserve sorted group continuation and check ownership', async () => {
  const source = recipe();
  source.ingredients.push({ name: 'Rice', quantity: 50, unit: 'g', aisle: 'Grains' });
  await store.mutate('alice', 'grocery-recipe-save', { type: 'recipe.save', data: source });
  await store.mutate('alice', 'grocery-plan-one', { type: 'plan.save', data: { id: 'one', date: '2026-10-19', slot: 'breakfast', recipeId: 'recipe', servings: 2 } });
  await store.mutate('alice', 'grocery-plan-two', { type: 'plan.save', data: { id: 'two', date: '2026-10-25', slot: 'snack', recipeId: 'recipe', servings: 3 } });
  await store.mutate('alice', 'grocery-next-week', { type: 'plan.save', data: { id: 'next-week', date: '2026-10-26', slot: 'breakfast', recipeId: 'recipe', servings: 1 } });
  for (const [key, checked] of [
    ['2026-10-19|oats|g', true], ['2026-10-19|rice|g', false],
    ['2026-10-26|oats|g', false], ['2026-10-26|rice|g', true],
  ] as const) {
    const request = `check-${key.replaceAll('|', '-')}`;
    if (!checked) await store.mutate('alice', `${request}-before-uncheck`, { type: 'grocery.check', data: { key, checked: true } });
    await store.mutate('alice', request, { type: 'grocery.check', data: { key, checked } });
  }
  await store.mutate('bob', 'other-owner-grocery', { type: 'grocery.check', data: { key: '2026-10-19|oats|g', checked: false } });
  const result = await groceries(store.db, 'alice', { weekStart: '2026-10-19', limit: 1 });
  assert.deepEqual(result.items.map(({ key, quantity }) => ({ key, quantity })), [{ key: 'oats|g', quantity: 500 }]);
  assert.deepEqual(result.checks, { '2026-10-19|oats|g': true });
  assert.ok(result.nextCursor);
  const next = await groceries(store.db, 'alice', { weekStart: '2026-10-19', limit: 1, cursor: result.nextCursor });
  assert.deepEqual(next.items.map(({ key, quantity }) => ({ key, quantity })), [{ key: 'rice|g', quantity: 250 }]);
  assert.deepEqual(next.checks, {});
  assert.equal(next.nextCursor, null);
  const otherWeek = await groceries(store.db, 'alice', { weekStart: '2026-10-26' });
  assert.deepEqual(otherWeek.items.map(({ key, quantity }) => ({ key, quantity })), [
    { key: 'oats|g', quantity: 100 }, { key: 'rice|g', quantity: 50 },
  ]);
  assert.deepEqual(otherWeek.checks, { '2026-10-26|rice|g': true });
  assert.deepEqual((await groceries(store.db, 'bob', { weekStart: '2026-10-19' })).items, []);
});

test('planning context and follow-up tools reject revision drift without rebasing or mixed totals', async () => {
  await store.mutate('alice', 'context-food-first', { type: 'log.save', data: food() });
  const context = await planningContext(store.db, 'alice', '2026-10-22');
  assert.equal(context.context.recentHistory.nutrition[0].loggedTotals.calories, 320);
  await store.mutate('alice', 'context-food-second', { type: 'log.save', data: food('second') });
  await assert.rejects(planningHistory(store.db, 'alice', '2026-10-22', 14, context.revision), errorCode('STALE_PROPOSAL'));
  await assert.rejects(proposalDependencies(store.db, 'alice', {
    status: 'answer', title: 'Answer', message: 'Keep recording.', questions: [], changes: [],
  }, context.revision), errorCode('STALE_PROPOSAL'));
});

test('nested IDs keep session/exercise scope, optional values and ordering round-trip, and template history is independent', async () => {
  const state = createInitialState();
  state.settings.timezone = 'Pacific/Auckland';
  state.groceryChecks = { 'unchecked|g': false, 'checked|g': true };
  state.logs = [{ ...food(), recipeId: 'historical-orphan', planEntryId: 'historical-plan' }];
  const first = workout('first');
  first.templateId = 'source-template';
  first.exercises[0].catalogId = 'original-catalog';
  first.exercises[0].targetLoad = { weight: 20, unit: 'lb' };
  const second = { ...workout('second'), date: '2026-10-23' };
  state.training.sessions = [second, first];
  state.training.scheduledDates = ['2026-10-25', '2026-10-22'];
  const { sets: _sets, ...target } = first.exercises[0];
  state.training.templates = [{
    id: 'source-template', name: 'Original routine', kind: 'strength', description: '',
    durationMinutes: 40, exercises: [target],
    createdAt: stamp, updatedAt: stamp,
  }];
  await store.replaceImport('alice', 'scoped-id-import', state, 0);
  assert.deepEqual((await store.exportSnapshot('alice')).state, state);
  await store.mutate('alice', 'edit-source-template', {
    type: 'training.template.save',
    data: { ...state.training.templates[0], name: 'Changed routine', exercises: [{ ...state.training.templates[0].exercises[0], targetLoad: { weight: 99, unit: 'kg' } }] },
  });
  await database.query("DELETE FROM workspace_workout_templates WHERE user_id='alice' AND id='source-template'");
  const snapshot = await recordDetails(store.db, 'alice', { sessionIds: ['first', 'second'] });
  assert.deepEqual(snapshot.sessions.find((item) => item.id === 'first'), first);
  assert.equal(snapshot.sessions.find((item) => item.id === 'second')?.exercises[0].sets[0].id, 'set');
  await store.mutate('bob', 'owner-fk-initialize', { type: 'grocery.check', data: { key: 'bob|g', checked: true } });
  await assert.rejects(database.query(`INSERT INTO workspace_workout_exercises
    (user_id,id,session_id,position,name,load_type,target_sets,rep_min,rep_max,target_rir,rest_seconds,notes)
    VALUES ('bob','foreign','first',0,'Press','total',1,6,10,null,90,'')`),
    (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23503'));
});

test('workout versions retain millisecond precision, zero-valued actuals and completed permanence', async () => {
  await store.mutate('alice', 'create-conflict-workout', { type: 'training.session.save', data: { session: workout(), expectedUpdatedAt: null } });
  await database.query("UPDATE workspace_workout_sessions SET updated_at='2099-01-01T00:00:00.000Z' WHERE user_id='alice' AND id='workout'");
  const [current] = (await recordDetails(store.db, 'alice', { sessionIds: ['workout'] })).sessions;
  assert.equal(current.updatedAt, '2099-01-01T00:00:00.000Z');
  await assert.rejects(store.mutate('alice', 'missing-record-version', {
    type: 'training.session.save', data: { session: current, expectedUpdatedAt: null },
  }), errorCode('INVALID_INPUT'));
  await store.mutate('alice', 'future-record-version', {
    type: 'training.session.save', data: { session: { ...current, durationMinutes: 0 }, expectedUpdatedAt: current.updatedAt },
  });
  const [saved] = (await recordDetails(store.db, 'alice', { sessionIds: ['workout'] })).sessions;
  assert.equal(saved.updatedAt, '2099-01-01T00:00:00.001Z');
  await assert.rejects(store.mutate('alice', 'delete-recorded-zero', {
    type: 'training.session.delete', data: { id: saved.id, expectedUpdatedAt: saved.updatedAt },
  }), errorCode('INVALID_INPUT'));
  const completed = { ...saved, status: 'completed' as const, durationMinutes: 20 };
  await store.mutate('alice', 'complete-protected-workout', {
    type: 'training.session.save', data: { session: completed, expectedUpdatedAt: saved.updatedAt },
  });
  const [finished] = (await recordDetails(store.db, 'alice', { sessionIds: ['workout'] })).sessions;
  await assert.rejects(store.mutate('alice', 'reset-completed-history', {
    type: 'training.session.save', data: { session: { ...finished, status: 'planned', durationMinutes: null }, expectedUpdatedAt: finished.updatedAt },
  }), errorCode('INVALID_INPUT'));
});

test('export batches and multi-query food totals stay on one committed revision while a writer advances', async () => {
  await store.mutate('alice', 'snapshot-food-first', { type: 'log.save', data: food() });
  const bootstrap = await store.bootstrap('alice');
  await consistentRead(store.db, 'alice', async (connection, revision) => {
    await store.mutate('alice', 'snapshot-concurrent-write', { type: 'log.save', data: food('second') });
    const exported = await exportRelational(connection, 'alice', bootstrap.settings);
    const window = await readFoodWindow(connection, 'alice', { from: '2026-10-22', through: '2026-10-22', limit: 1 }, revision);
    assert.equal(revision, bootstrap.revision);
    assert.deepEqual(exported.logs.map((entry) => entry.id), ['food']);
    assert.equal(window.entries.length, 1);
    assert.equal(window.totals.calories, 320);
    assert.equal(window.nextCursor, null);
  });
  const current = await store.foodWindow('alice', { from: '2026-10-22', through: '2026-10-22', limit: 1 });
  assert.equal(current.revision, bootstrap.revision + 1);
  assert.equal(current.totals.calories, 640);
  assert.ok(current.nextCursor);
});

test('grocery export counts compact DTO bytes instead of raw database row metadata', async () => {
  const owner = 'u'.repeat(200);
  await store.mutate(owner, 'initialize-large-grocery-owner', { type: 'grocery.check', data: { key: 'seed|g', checked: true } });
  await database.query('DELETE FROM workspace_grocery_checks WHERE user_id = $1', [owner]);
  await database.query(`INSERT INTO workspace_grocery_checks (user_id, key, checked, position)
    SELECT $1, repeat('k', 194) || lpad(n::text, 6, '0'), true, n
    FROM generate_series(1, 100000) n`, [owner]);
  await database.query('UPDATE workspace_metadata SET next_position = 100001 WHERE user_id = $1', [owner]);
  const exported = await store.exportSnapshot(owner);
  assert.equal(Object.keys(exported.state.groceryChecks).length, 100000);
  assert.equal(exported.state.groceryChecks[`${'k'.repeat(194)}000001`], true);
  assert.equal(exported.state.groceryChecks[`${'k'.repeat(194)}100000`], true);
  assert.ok(Buffer.byteLength(JSON.stringify(exported.state)) <= MAX_WORKSPACE_TRANSFER_BYTES);
});

test('legacy import normalization rejects payloads whose normalized state exceeds the transfer cap', () => {
  const steps = Array.from({ length: 40 }, () => 's'.repeat(2000));
  const baseRecipe = {
    ...recipe(),
    description: 'd'.repeat(1600),
    storage: 't'.repeat(2000),
    variation: 'v'.repeat(1600),
    steps,
  };
  const sessions = Array.from({ length: 20 }, (_, index) =>
    workout(`session-${index}`, `2026-10-${String(index + 1).padStart(2, '0')}`));
  const { scheduledDates: _scheduled, ...legacyTraining } = {
    ...createInitialState().training,
    sessions,
  };
  const legacy = {
    ...createInitialState(),
    recipes: Array.from({ length: 389 }, (_, index) => ({ ...baseRecipe, id: `r-${index}` })),
    training: legacyTraining,
  };
  legacy.recipes[0].description = '';
  const headroom = MAX_WORKSPACE_TRANSFER_BYTES - Buffer.byteLength(JSON.stringify(legacy)) - 150;
  const count = Math.floor(headroom / 508);
  for (let index = 0; index < count; index++) {
    const key = `k${String(index).padStart(6, '0')}`;
    legacy.groceryChecks[key + 'x'.repeat(500 - key.length)] = true;
  }
  const remaining = MAX_WORKSPACE_TRANSFER_BYTES - Buffer.byteLength(JSON.stringify(legacy)) - 80;
  legacy.recipes[0].description = 'p'.repeat(remaining);
  const rawBytes = Buffer.byteLength(JSON.stringify(legacy));
  assert.ok(rawBytes <= MAX_WORKSPACE_TRANSFER_BYTES);
  assert.ok(rawBytes > MAX_WORKSPACE_TRANSFER_BYTES - 250);
  assert.throws(() => inspectImport(legacy), errorCode('STATE_TOO_LARGE'));
});
