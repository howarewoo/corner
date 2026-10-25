import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import type { Transaction } from '../src/queries.js';
import { testDatabase, closeTestDatabase } from './helpers.ts';
import { createInitialState } from '@packages/shared/seed';
import type { AppState, Recipe } from '@packages/shared/types';
import { ApiError } from '../src/http.ts';
import { inspectImport, WorkspaceStore } from '../src/store.ts';

let database: Pool;
let store: WorkspaceStore;
beforeEach(async () => {
  database = await testDatabase();
  store = new WorkspaceStore(database);
});
afterEach(async () => await closeTestDatabase(database));

function recipe(id = 'recipe-a'): Recipe {
  return {
    id,
    name: 'Yogurt and oats',
    description: '',
    category: 'breakfast',
    prepMinutes: 5,
    cookMinutes: 0,
    nutrition: { calories: 320, protein: 25, carbs: 40, fat: 7 },
    ingredients: [{ name: 'Yogurt', quantity: 200, unit: 'g', aisle: 'Dairy' }],
    steps: ['Stir together.'],
    storage: 'Refrigerate.',
    variation: '',
    tags: [],
    color: '#234b35',
    source: 'manual',
    favorite: false,
    createdAt: '2026-10-22T12:00:00.000Z',
  };
}
const code = (expected: string) => (error: unknown) =>
  error instanceof ApiError && error.code === expected;

test('new workspaces contain no personal sample plan, targets, or completed history', async () => {
  const current = await store.read('user-a', 'Alex');
  assert.equal(current.revision, 0);
  assert.equal(current.state.settings.name, 'Alex');
  assert.equal(current.state.settings.timezone, 'UTC');
  assert.deepEqual(current.state.settings.training, { calories: 0, protein: 0, carbs: 0, fat: 0 });
  assert.deepEqual(current.state.plan, []);
  assert.deepEqual(current.state.recipes, []);
  assert.deepEqual(current.state.logs, []);
  for (const collection of Object.values(current.state.training)) assert.deepEqual(collection, []);
});

test('mutations and receipts are isolated by owner and transport retries do not write twice', async () => {
  const mutation = { type: 'recipe.save' as const, data: recipe() };
  const first = await store.mutate('user-a', 'mutation-1234', mutation);
  assert.equal(first.revision, 1);
  assert.equal((await store.read('user-b')).state.recipes.length, 0);
  const replay = await store.mutate('user-a', 'mutation-1234', mutation);
  assert.deepEqual(replay, first);
  assert.equal(
    (await database.query('SELECT COUNT(*) AS n FROM mutation_receipts', [])).rows[0]?.n,
    1,
  );
  const own = await store.mutate('user-b', 'mutation-1234', {
    ...mutation,
    data: recipe('recipe-b'),
  });
  assert.equal(own.state.recipes[0].id, 'recipe-b');
  assert.equal((await store.read('user-a')).state.recipes[0].id, 'recipe-a');
  await assert.rejects(
    async () =>
      await store.mutate('user-a', 'mutation-1234', {
        type: 'recipe.delete',
        data: { id: 'recipe-a' },
      }),
    code('REQUEST_ID_REUSED'),
  );
});

test('explicit revision conflicts and invalid batch members leave the whole transaction untouched', async () => {
  await store.mutate('user-a', 'mutation-first', { type: 'recipe.save', data: recipe() });
  await assert.rejects(
    async () =>
      await store.applyBatch(
        'user-a',
        'batch-conflict',
        [{ type: 'recipe.save', data: recipe('recipe-b') }],
        0,
      ),
    code('REVISION_CONFLICT'),
  );
  await assert.rejects(
    async () =>
      await store.applyBatch(
        'user-a',
        'batch-invalid',
        [
          { type: 'recipe.save', data: recipe('recipe-b') },
          {
            type: 'plan.save',
            data: {
              id: 'meal-invalid',
              date: '2026-10-22',
              slot: 'lunch',
              recipeId: 'missing-recipe',
              servings: 1,
            },
          },
        ],
        1,
      ),
    code('INVALID_INPUT'),
  );
  assert.deepEqual(
    (await store.read('user-a')).state.recipes.map((value) => value.id),
    ['recipe-a'],
  );
  assert.equal((await store.read('user-a')).revision, 1);
  assert.equal(
    (await database.query('SELECT COUNT(*) AS n FROM mutation_receipts', [])).rows[0]?.n,
    1,
  );
  const saved = await store.applyBatch(
    'user-a',
    'batch-valid',
    [
      { type: 'recipe.save', data: recipe('recipe-b') },
      {
        type: 'plan.save',
        data: {
          id: 'meal-b',
          date: '2026-10-22',
          slot: 'lunch',
          recipeId: 'recipe-b',
          servings: 1,
        },
      },
    ],
    1,
  );
  assert.equal(saved.revision, 2);
  assert.equal(saved.state.logs.length, 0);
  assert.equal(saved.state.plan.length, 1);
});

test('batch completion bookkeeping commits or rolls back with the state and is safe on replay', async () => {
  await database.query('CREATE TABLE applied_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
  const changes = [{ type: 'recipe.save' as const, data: recipe() }];
  await assert.rejects(
    store.applyBatch('user-a', 'atomic-batch-123', changes, 0, async (connection) => {
      await connection.execute(sql`INSERT INTO applied_runs (id, status) VALUES (${'run-a'}, ${'applied'})`);
      throw new Error('simulate bookkeeping failure');
    }),
    /bookkeeping failure/,
  );
  assert.equal((await store.read('user-a')).revision, 0);
  assert.equal(
    (await database.query('SELECT COUNT(*) AS n FROM mutation_receipts', [])).rows[0]?.n,
    0,
  );
  assert.equal((await database.query('SELECT COUNT(*) AS n FROM applied_runs', [])).rows[0]?.n, 0);
  let completions = 0;
  const complete = async (connection: Transaction) => {
    completions++;
    await connection.execute(sql`INSERT INTO applied_runs (id, status) VALUES (${'run-a'}, ${'applied'})
      ON CONFLICT(id) DO UPDATE SET status = excluded.status`);
  };
  const first = await store.applyBatch('user-a', 'atomic-batch-123', changes, 0, complete);
  assert.deepEqual(
    await store.applyBatch('user-a', 'atomic-batch-123', changes, 0, complete),
    first,
  );
  assert.equal(first.revision, 1);
  assert.equal(completions, 2);
  assert.equal((await database.query('SELECT COUNT(*) AS n FROM applied_runs', [])).rows[0]?.n, 1);
});

test('import validation rejects duplicates and broken active references while retaining historical snapshots', () => {
  const state = createInitialState('Imported name');
  state.recipes = [recipe(), recipe()];
  assert.throws(() => inspectImport(state), code('INVALID_STATE'));
  state.recipes = [];
  state.plan = [
    { id: 'meal-a', date: '2026-10-22', slot: 'lunch', recipeId: 'missing', servings: 1 },
  ];
  assert.throws(() => inspectImport(state), code('INVALID_STATE'));
  state.plan = [];
  state.logs = [
    {
      id: 'historical-log',
      name: 'Past meal',
      date: '2026-01-05',
      slot: 'dinner',
      servings: 1.5,
      recipeId: 'deleted-recipe',
      planEntryId: 'deleted-plan',
      nutrition: { calories: 610, protein: 36, carbs: 75, fat: 18 },
      createdAt: '2026-01-05T18:30:00.000Z',
    },
  ];
  const { training: _training, ...legacy } = state;
  const accepted = inspectImport(legacy);
  assert.deepEqual(accepted.state.logs, state.logs);
  assert.deepEqual(accepted.state.training.sessions, []);
  assert.deepEqual(accepted.state.training.templates, []);
  assert.equal(accepted.counts.foodEntries, 1);
});

test('import is owner-bound, revision checked, empty-account only, and idempotent', async () => {
  const imported = createInitialState('Imported owner');
  imported.recipes = [recipe()];
  const saved = await store.replaceImport('user-a', 'import-12345', imported, 0);
  assert.equal(saved.revision, 1);
  assert.deepEqual(await store.replaceImport('user-a', 'import-12345', imported, 0), saved);
  assert.equal((await store.read('user-b')).state.recipes.length, 0);
  await assert.rejects(
    async () => await store.replaceImport('user-a', 'another-import', imported, 1),
    code('WORKSPACE_NOT_EMPTY'),
  );
  await assert.rejects(
    async () => await store.replaceImport('user-b', 'stale-import', imported, 1),
    code('REVISION_CONFLICT'),
  );
  const forged = { ...imported, userId: 'user-a' };
  assert.throws(() => inspectImport(forged));
  assert.equal((await store.read('user-a')).state.settings.name, 'Imported owner');
});

test('collection and byte limits reject unbounded workspaces before saving', async () => {
  const state = createInitialState();
  state.recipes = Array.from({ length: 501 }, (_, i) => recipe(`r-${i}`));
  assert.throws(() => inspectImport(state));
  const oversized = {
    ...createInitialState(),
    settings: { ...state.settings, name: 'x'.repeat(1_800_001) },
  };
  assert.throws(() => inspectImport(oversized), code('STATE_TOO_LARGE'));
  assert.equal(
    (await database.query('SELECT COUNT(*) AS n FROM workspace_state', [])).rows[0]?.n,
    0,
  );
});

test('concurrent first writes and duplicate retries serialize without losing owner state', async () => {
  const requests = Array.from({ length: 8 }, (_, index) =>
    store.mutate('concurrent-owner', `concurrent-${index}`, {
      type: 'grocery.check',
      data: { key: `item-${index}`, checked: true },
    }),
  );
  await Promise.all(requests);
  const saved = await store.read('concurrent-owner');
  assert.equal(saved.revision, 8);
  assert.deepEqual(
    saved.state.groceryChecks,
    Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`item-${index}`, true])),
  );
  const mutation = { type: 'grocery.check', data: { key: 'single-retry', checked: true } };
  const retries = await Promise.all(
    Array.from({ length: 4 }, () => store.mutate('retry-owner', 'same-retry-id', mutation, 0)),
  );
  assert.deepEqual(
    retries.map((snapshot) => snapshot.revision),
    [1, 1, 1, 1],
  );
  const competing = await Promise.allSettled([
    store.mutate(
      'retry-owner',
      'revision-race-a',
      { type: 'grocery.check', data: { key: 'a', checked: true } },
      1,
    ),
    store.mutate(
      'retry-owner',
      'revision-race-b',
      { type: 'grocery.check', data: { key: 'b', checked: true } },
      1,
    ),
  ]);
  assert.equal(competing.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(
    competing.filter(
      (result) => result.status === 'rejected' && code('REVISION_CONFLICT')(result.reason),
    ).length,
    1,
  );
  assert.equal((await store.read('retry-owner')).revision, 2);
});
