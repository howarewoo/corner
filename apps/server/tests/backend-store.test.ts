import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createInitialState } from '@corner/shared/seed';
import type { AppState, Recipe } from '@corner/shared/types';
import { ApiError } from '../src/http.ts';
import { inspectImport, WorkspaceStore } from '../src/store.ts';

let database: DatabaseSync;
let store: WorkspaceStore;
beforeEach(() => { database = new DatabaseSync(':memory:'); store = new WorkspaceStore(database); });
afterEach(() => database.close());

function recipe(id = 'recipe-a'): Recipe {
  return { id, name: 'Yogurt and oats', description: '', category: 'breakfast', prepMinutes: 5, cookMinutes: 0, nutrition: { calories: 320, protein: 25, carbs: 40, fat: 7 }, ingredients: [{ name: 'Yogurt', quantity: 200, unit: 'g', aisle: 'Dairy' }], steps: ['Stir together.'], storage: 'Refrigerate.', variation: '', tags: [], color: '#234b35', source: 'manual', favorite: false, createdAt: '2026-10-22T12:00:00.000Z' };
}
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;

test('new workspaces contain no personal sample plan, targets, or completed history', () => {
  const current = store.read('user-a', 'Alex');
  assert.equal(current.revision, 0);
  assert.equal(current.state.settings.name, 'Alex');
  assert.equal(current.state.settings.timezone, 'UTC');
  assert.deepEqual(current.state.settings.training, { calories: 0, protein: 0, carbs: 0, fat: 0 });
  assert.deepEqual(current.state.plan, []);
  assert.deepEqual(current.state.recipes, []);
  assert.deepEqual(current.state.logs, []);
  for (const collection of Object.values(current.state.training)) assert.deepEqual(collection, []);
});

test('mutations and receipts are isolated by owner and transport retries do not write twice', () => {
  const mutation = { type: 'recipe.save' as const, data: recipe() };
  const first = store.mutate('user-a', 'mutation-1234', mutation);
  assert.equal(first.revision, 1);
  assert.equal(store.read('user-b').state.recipes.length, 0);
  const replay = store.mutate('user-a', 'mutation-1234', mutation);
  assert.deepEqual(replay, first);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM mutation_receipts').get()?.n, 1);
  const own = store.mutate('user-b', 'mutation-1234', { ...mutation, data: recipe('recipe-b') });
  assert.equal(own.state.recipes[0].id, 'recipe-b');
  assert.equal(store.read('user-a').state.recipes[0].id, 'recipe-a');
  assert.throws(() => store.mutate('user-a', 'mutation-1234', { type: 'recipe.delete', data: { id: 'recipe-a' } }), code('REQUEST_ID_REUSED'));
});

test('explicit revision conflicts and invalid batch members leave the whole transaction untouched', () => {
  store.mutate('user-a', 'mutation-first', { type: 'recipe.save', data: recipe() });
  assert.throws(() => store.applyBatch('user-a', 'batch-conflict', [{ type: 'recipe.save', data: recipe('recipe-b') }], 0), code('REVISION_CONFLICT'));
  assert.throws(() => store.applyBatch('user-a', 'batch-invalid', [
    { type: 'recipe.save', data: recipe('recipe-b') },
    { type: 'plan.save', data: { id: 'meal-invalid', date: '2026-10-22', slot: 'lunch', recipeId: 'missing-recipe', servings: 1 } },
  ], 1), code('INVALID_INPUT'));
  assert.deepEqual(store.read('user-a').state.recipes.map(value => value.id), ['recipe-a']);
  assert.equal(store.read('user-a').revision, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM mutation_receipts').get()?.n, 1);
  const saved = store.applyBatch('user-a', 'batch-valid', [
    { type: 'recipe.save', data: recipe('recipe-b') },
    { type: 'plan.save', data: { id: 'meal-b', date: '2026-10-22', slot: 'lunch', recipeId: 'recipe-b', servings: 1 } },
  ], 1);
  assert.equal(saved.revision, 2);
  assert.equal(saved.state.logs.length, 0);
  assert.equal(saved.state.plan.length, 1);
});

test('batch completion bookkeeping commits or rolls back with the state and is safe on replay', () => {
  database.exec('CREATE TABLE applied_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
  const changes = [{ type: 'recipe.save' as const, data: recipe() }];
  assert.throws(() => store.applyBatch('user-a', 'atomic-batch-123', changes, 0, () => {
    database.prepare('INSERT INTO applied_runs (id, status) VALUES (?, ?)').run('run-a', 'applied');
    throw new Error('simulate bookkeeping failure');
  }), /bookkeeping failure/);
  assert.equal(store.read('user-a').revision, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM mutation_receipts').get()?.n, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM applied_runs').get()?.n, 0);
  let completions = 0;
  const complete = () => {
    completions++;
    database.prepare('INSERT INTO applied_runs (id, status) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status').run('run-a', 'applied');
  };
  const first = store.applyBatch('user-a', 'atomic-batch-123', changes, 0, complete);
  assert.deepEqual(store.applyBatch('user-a', 'atomic-batch-123', changes, 0, complete), first);
  assert.equal(first.revision, 1);
  assert.equal(completions, 2);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM applied_runs').get()?.n, 1);
});

test('import validation rejects duplicates and broken active references while retaining historical snapshots', () => {
  const state = createInitialState('Imported name');
  state.recipes = [recipe(), recipe()];
  assert.throws(() => inspectImport(state), code('INVALID_STATE'));
  state.recipes = [];
  state.plan = [{ id: 'meal-a', date: '2026-10-22', slot: 'lunch', recipeId: 'missing', servings: 1 }];
  assert.throws(() => inspectImport(state), code('INVALID_STATE'));
  state.plan = [];
  state.logs = [{ id: 'historical-log', name: 'Past meal', date: '2026-01-05', slot: 'dinner', servings: 1.5, recipeId: 'deleted-recipe', planEntryId: 'deleted-plan', nutrition: { calories: 610, protein: 36, carbs: 75, fat: 18 }, createdAt: '2026-01-05T18:30:00.000Z' }];
  const { training: _training, ...legacy } = state;
  const accepted = inspectImport(legacy);
  assert.deepEqual(accepted.state.logs, state.logs);
  assert.deepEqual(accepted.state.training.sessions, []);
  assert.deepEqual(accepted.state.training.templates, []);
  assert.equal(accepted.counts.foodEntries, 1);
});

test('import is owner-bound, revision checked, empty-account only, and idempotent', () => {
  const imported = createInitialState('Imported owner');
  imported.recipes = [recipe()];
  const saved = store.replaceImport('user-a', 'import-12345', imported, 0);
  assert.equal(saved.revision, 1);
  assert.deepEqual(store.replaceImport('user-a', 'import-12345', imported, 0), saved);
  assert.equal(store.read('user-b').state.recipes.length, 0);
  assert.throws(() => store.replaceImport('user-a', 'another-import', imported, 1), code('WORKSPACE_NOT_EMPTY'));
  assert.throws(() => store.replaceImport('user-b', 'stale-import', imported, 1), code('REVISION_CONFLICT'));
  const forged = { ...imported, userId: 'user-a' };
  assert.throws(() => inspectImport(forged));
  assert.equal(store.read('user-a').state.settings.name, 'Imported owner');
});

test('collection and byte limits reject unbounded workspaces before saving', () => {
  const state = createInitialState();
  state.recipes = Array.from({ length: 501 }, (_, i) => recipe(`r-${i}`));
  assert.throws(() => inspectImport(state));
  const oversized = { ...createInitialState(), settings: { ...state.settings, name: 'x'.repeat(1_800_001) } };
  assert.throws(() => inspectImport(oversized), code('STATE_TOO_LARGE'));
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM workspace_state').get()?.n, 0);
});
