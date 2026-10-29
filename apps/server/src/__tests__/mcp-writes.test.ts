import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createInitialState } from '@packages/workspace/initial-state';
import type { DelegatedAccess } from '../delegation.js';
import { registerNutritionWrites } from '../mcp-writes.js';
import { WorkspaceStore } from '../store.js';
import type { Database } from '../queries.js';
import * as schema from '../schema.js';
import { testDatabase, closeTestDatabase } from '../../tests/helpers.ts';

let database: Pool;
let store: WorkspaceStore;
const resources: Array<{ client: Client; server: McpServer }> = [];
const access: DelegatedAccess = { ownerId: 'alice', clientId: 'client', grantId: 'grant', scopes: ['meal-plans:write'] };
const meal = { id: 'meal', date: '2026-10-28', slot: 'breakfast', recipeId: 'recipe', servings: 1 };

beforeEach(async () => {
  database = await testDatabase();
  store = new WorkspaceStore(drizzle({ client: database, schema }) as Database);
  const state = createInitialState();
  state.recipes = [{ id: 'recipe', name: 'Oats', description: '', category: 'breakfast', prepMinutes: 1,
    cookMinutes: 0, nutrition: { calories: 100, protein: 10, carbs: 10, fat: 2 },
    ingredients: [{ name: 'Oats', quantity: 100, unit: 'g', aisle: 'Grains' }], steps: ['Mix'],
    storage: '', variation: '', tags: [], color: '#234b35', source: 'manual', favorite: false, createdAt: '2026-10-28T12:00:00.000Z' }];
  await store.replaceImport('alice', 'alice-seed', state, 0);
});
afterEach(async () => {
  for (const { client, server } of resources.splice(0)) { await client.close(); await server.close(); }
  await closeTestDatabase(database);
});
async function connect(identity = access) {
  let original: unknown;
  const server = new McpServer({ name: 'corner-test', version: '1.0.0' });
  registerNutritionWrites(server, store, identity, () => original);
  const client = new Client({ name: 'writer', version: '1.0.0' });
  resources.push({ client, server });
  const [consumer, resource] = InMemoryTransport.createLinkedPair();
  await server.connect(resource); await client.connect(consumer);
  return async (args: Record<string, unknown>, name = 'edit_meal_plans') => {
    original = structuredClone(args);
    return client.callTool({ name, arguments: args });
  };
}
const create = (entry = meal) => ({ action: 'create', entry });
const args = (operationId: string, expectedRevision: number, changes: unknown[]) => ({ operationId, expectedRevision, changes });
function code(result: unknown) {
  assert.ok(result && typeof result === 'object' && 'structuredContent' in result);
  const content = result.structuredContent;
  return content && typeof content === 'object' && 'code' in content ? content.code : undefined;
}

test('atomic create and patch preserve fields, replay committed revision, and fingerprint original inputs', async () => {
  const write = await connect();
  const original = args('operation-one', 1, [create({ ...meal, recipeId: ' recipe ' })]);
  assert.deepEqual((await write(original)).structuredContent, { revision: 2 });
  assert.deepEqual((await write(args('operation-two', 2, [{ action: 'update', id: 'meal', patch: { servings: 2 } }]))).structuredContent, { revision: 3 });
  assert.deepEqual((await write(original)).structuredContent, { revision: 2 });
  assert.equal(code(await write(args('operation-one', 1, [create()]))), 'REQUEST_ID_REUSED');
  const snapshot = await store.exportSnapshot('alice');
  assert.deepEqual(snapshot.state.plan, [{ ...meal, servings: 2 }]);
  assert.equal(snapshot.revision, 3);
});

test('missing, duplicate, stale and invalid-reference batch members leave state, revision and receipt unchanged', async () => {
  const write = await connect();
  assert.equal(code(await write(args('rollback-one', 1, [create(), { action: 'update', id: 'missing', patch: { servings: 3 } }]))), 'NOT_FOUND');
  assert.equal((await store.exportSnapshot('alice')).revision, 1);
  assert.deepEqual((await store.exportSnapshot('alice')).state.plan, []);
  assert.deepEqual((await write(args('rollback-one', 1, [create()]))).structuredContent, { revision: 2 });
  assert.equal(code(await write(args('duplicate-one', 2, [create()]))), 'ALREADY_EXISTS');
  assert.equal(code(await write(args('stale-request', 1, [{ action: 'update', id: 'meal', patch: { servings: 4 } }]))), 'REVISION_CONFLICT');
  const invalid = await write(args('reference-one', 2, [{ action: 'update', id: 'meal', patch: { servings: 4 } }, create({ ...meal, id: 'second', recipeId: 'missing' })]));
  assert.equal(invalid.isError, true);
  assert.deepEqual((await store.exportSnapshot('alice')).state.plan, [meal]);
  assert.equal((await store.exportSnapshot('alice')).revision, 2);
});

test('guard namespaces operation IDs by grant, isolates owners, and checks scope before replay', async () => {
  const granted = ['meal-plans:write'];
  const write = await connect({ ...access, scopes: granted });
  const request = args('namespace-one', 1, [create()]);
  assert.deepEqual((await write(request)).structuredContent, { revision: 2 });
  granted.splice(0);
  assert.equal(code(await write(request)), 'INSUFFICIENT_SCOPE');
  const otherGrant = await connect({ ...access, grantId: 'another' });
  assert.equal(code(await otherGrant(request)), 'REVISION_CONFLICT');
  const outsider = await connect({ ...access, ownerId: 'bob' });
  assert.equal(code(await outsider(args('namespace-one', 0, [{ action: 'update', id: 'meal', patch: { servings: 2 } }]))), 'NOT_FOUND');
  assert.deepEqual((await store.exportSnapshot('bob')).state.plan, []);
});

test('owner lock serializes conflicting writes and concurrent exact retries apply once', async () => {
  const first = await connect(); const second = await connect();
  const request = args('concurrent-one', 1, [create()]);
  const retries = await Promise.all([first(request), second(request)]);
  assert.deepEqual(retries.map((result) => result.structuredContent), [{ revision: 2 }, { revision: 2 }]);
  const competing = await Promise.all([
    first(args('concurrent-two', 2, [{ action: 'update', id: 'meal', patch: { servings: 2 } }])),
    second(args('concurrent-three', 2, [{ action: 'update', id: 'meal', patch: { servings: 3 } }])),
  ]);
  assert.equal(competing.filter((result) => result.isError).length, 1);
  assert.equal(competing.filter((result) => code(result) === 'REVISION_CONFLICT').length, 1);
  assert.equal((await store.exportSnapshot('alice')).revision, 3);
});

const nutritionScopes = ['meal-plans:write', 'recipes:write', 'recipes:delete', 'food-logs:write', 'food-logs:delete'];
const food = {
  id: 'food', date: '2026-10-28', slot: 'breakfast', name: 'Recorded oats',
  nutrition: { calories: 150, protein: 12, carbs: 20, fat: 3 }, servings: 1,
  createdAt: '2026-10-28T12:00:00.000Z',
};

test('each nutrition write/delete scope exposes only its exact implemented operations, without reads', async () => {
  const expected = {
    'meal-plans:write': ['edit_meal_plans'],
    'recipes:write': ['create_recipe', 'update_recipe'],
    'recipes:delete': ['delete_recipe'],
    'food-logs:write': ['create_food_log', 'update_food_log'],
    'food-logs:delete': ['delete_food_log'],
  };
  for (const [scope, names] of Object.entries(expected)) {
    await connect({ ...access, scopes: [scope] });
    const client = resources.at(-1)!.client;
    assert.deepEqual((await client.listTools()).tools.map(({ name }) => name).sort(), names);
    const denied = await client.callTool({ name: scope === 'recipes:delete' ? 'create_recipe' : 'delete_recipe', arguments: {} });
    assert.equal(denied.isError, true);
    assert.equal(denied.structuredContent, undefined);
  }
});

test('recipe CRUD is explicit, preserves patch fields, clears optional values, and replays without exposing recipe data', async () => {
  const write = await connect({ ...access, scopes: ['recipes:write', 'recipes:delete'] });
  const source = (await store.exportSnapshot('alice')).state.recipes[0];
  const recipe = { ...source, id: 'new-recipe', name: ' New oats ', pdf: '/recipes/oats.pdf', nutritionNote: 'Per serving' };
  const request = { operationId: 'recipe-create', expectedRevision: 1, recipe };
  assert.deepEqual((await write(request, 'create_recipe')).structuredContent, { revision: 2 });
  assert.equal(code(await write({ ...request, operationId: 'recipe-duplicate', expectedRevision: 2 }, 'create_recipe')), 'ALREADY_EXISTS');
  assert.equal(code(await write({ operationId: 'recipe-missing', expectedRevision: 2, id: 'missing', patch: { name: 'New' } }, 'update_recipe')), 'NOT_FOUND');
  assert.deepEqual((await write({ operationId: 'recipe-update', expectedRevision: 2, id: recipe.id, patch: { favorite: true, nutrition: { protein: 25 }, pdf: null, nutritionNote: null } }, 'update_recipe')).structuredContent, { revision: 3 });
  const saved = (await store.exportSnapshot('alice')).state.recipes.find(({ id }) => id === recipe.id)!;
  assert.equal(saved.name, 'New oats');
  assert.deepEqual(saved.nutrition, { ...source.nutrition, protein: 25 });
  assert.deepEqual(saved.ingredients, source.ingredients);
  assert.equal(saved.favorite, true);
  assert.equal(saved.pdf, undefined);
  assert.equal(saved.nutritionNote, undefined);
  assert.deepEqual((await write(request, 'create_recipe')).structuredContent, { revision: 2 });
  assert.equal(code(await write({ ...request, recipe: { ...recipe, name: recipe.name.trim() } }, 'create_recipe')), 'REQUEST_ID_REUSED');
  assert.deepEqual((await write({ operationId: 'recipe-delete', expectedRevision: 3, id: recipe.id }, 'delete_recipe')).structuredContent, { revision: 4 });
  assert.equal(code(await write({ operationId: 'recipe-deleted-edit', expectedRevision: 4, id: recipe.id, patch: { name: 'Cannot recreate' } }, 'update_recipe')), 'NOT_FOUND');
  assert.equal(code(await write({ operationId: 'recipe-deleted-delete', expectedRevision: 4, id: recipe.id }, 'delete_recipe')), 'NOT_FOUND');
  assert.deepEqual((await write({ operationId: 'recipe-delete', expectedRevision: 3, id: recipe.id }, 'delete_recipe')).structuredContent, { revision: 4 });
  assert.equal((await store.exportSnapshot('alice')).state.recipes.length, 1);
});

test('food CRUD preserves snapshots and nested patch values; explicit null unlinks sources without deleting them', async () => {
  const write = await connect({ ...access, scopes: nutritionScopes });
  await write(args('food-plan-create', 1, [create()]));
  const entry = { ...food, recipeId: 'recipe', planEntryId: 'meal' };
  const request = { operationId: 'food-create', expectedRevision: 2, entry };
  assert.deepEqual((await write(request, 'create_food_log')).structuredContent, { revision: 3 });
  assert.equal(code(await write({ ...request, operationId: 'food-existing', expectedRevision: 3 }, 'create_food_log')), 'ALREADY_EXISTS');
  assert.equal(code(await write({ operationId: 'food-missing', expectedRevision: 3, id: 'missing', patch: { name: 'Missing' } }, 'update_food_log')), 'NOT_FOUND');
  assert.deepEqual((await write({ operationId: 'food-patch', expectedRevision: 3, id: food.id, patch: { servings: 2, nutrition: { protein: 30 } } }, 'update_food_log')).structuredContent, { revision: 4 });
  const saved = (await store.exportSnapshot('alice')).state.logs[0];
  assert.deepEqual(saved, { ...entry, servings: 2, nutrition: { ...food.nutrition, protein: 30 } });
  await write({ operationId: 'source-recipe-edit', expectedRevision: 4, id: 'recipe', patch: { name: 'Changed source', nutrition: { calories: 999 } } }, 'update_recipe');
  assert.deepEqual((await store.exportSnapshot('alice')).state.logs, [saved]);
  assert.deepEqual((await write({ operationId: 'food-unlink', expectedRevision: 5, id: food.id, patch: { recipeId: null, planEntryId: null } }, 'update_food_log')).structuredContent, { revision: 6 });
  const unlinked = (await store.exportSnapshot('alice')).state.logs[0];
  assert.equal(unlinked.recipeId, undefined);
  assert.equal(unlinked.planEntryId, undefined);
  const deletion = { operationId: 'food-delete', expectedRevision: 6, id: food.id };
  assert.deepEqual((await write(deletion, 'delete_food_log')).structuredContent, { revision: 7 });
  assert.deepEqual((await write(deletion, 'delete_food_log')).structuredContent, { revision: 7 });
  assert.equal(code(await write({ ...deletion, operationId: 'food-delete-missing', expectedRevision: 7 }, 'delete_food_log')), 'NOT_FOUND');
  assert.equal(code(await write({ operationId: 'food-edit-deleted', expectedRevision: 7, id: food.id, patch: { name: 'Cannot recreate' } }, 'update_food_log')), 'NOT_FOUND');
  const snapshot = await store.exportSnapshot('alice');
  assert.deepEqual(snapshot.state.logs, []);
  assert.equal(snapshot.state.recipes.length, 1);
  assert.deepEqual(snapshot.state.plan, [meal]);
});

test('recipe-in-use rejection, one-log-per-plan and historical links survive source edits/deletion without cascade', async () => {
  const write = await connect({ ...access, scopes: nutritionScopes });
  await write(args('history-plan-create', 1, [create()]));
  const entry = { ...food, recipeId: 'recipe', planEntryId: 'meal' };
  await write({ operationId: 'history-food-create', expectedRevision: 2, entry }, 'create_food_log');
  const blockedDelete = { operationId: 'history-recipe-delete', expectedRevision: 3, id: 'recipe' };
  assert.equal(code(await write(blockedDelete, 'delete_recipe')), 'INVALID_INPUT');
  assert.equal(code(await write({ operationId: 'history-duplicate-log', expectedRevision: 3, entry: { ...entry, id: 'duplicate' } }, 'create_food_log')), 'INVALID_INPUT');
  await write(args('history-move-plan', 3, [{ action: 'update', id: 'meal', patch: { date: '2026-10-29' } }]));
  assert.deepEqual((await store.exportSnapshot('alice')).state.logs, [entry]);
  assert.deepEqual((await write({ operationId: 'history-food-edit', expectedRevision: 4, id: food.id, patch: { servings: 2 } }, 'update_food_log')).structuredContent, { revision: 5 });
  // Plan deletion remains a manual-only capability; deleting a source must retain snapshots.
  await store.mutate('alice', 'manual-plan-delete', { type: 'plan.delete', data: { id: 'meal' } });
  assert.deepEqual((await write({ ...blockedDelete, expectedRevision: 6 }, 'delete_recipe')).structuredContent, { revision: 7 });
  assert.deepEqual((await write({ operationId: 'orphan-food-edit', expectedRevision: 7, id: food.id, patch: { servings: 3 } }, 'update_food_log')).structuredContent, { revision: 8 });
  const snapshot = await store.exportSnapshot('alice');
  assert.deepEqual(snapshot.state.recipes, []);
  assert.deepEqual(snapshot.state.logs, [{ ...entry, servings: 3 }]);
  assert.equal(snapshot.revision, 8);
});

test('foreign-owner records cannot be updated or deleted and write-only food input never imports recipe content', async () => {
  const write = await connect({ ...access, ownerId: 'bob', scopes: nutritionScopes });
  for (const [name, fields] of [
    ['update_recipe', { id: 'recipe', patch: { name: 'Foreign' } }],
    ['delete_recipe', { id: 'recipe' }],
    ['update_food_log', { id: 'food', patch: { name: 'Foreign' } }],
    ['delete_food_log', { id: 'food' }],
  ] as const) {
    assert.equal(code(await write({ operationId: `foreign-${name}`, expectedRevision: 0, ...fields }, name)), 'NOT_FOUND');
  }
  assert.equal(code(await write({ operationId: 'foreign-link', expectedRevision: 0, entry: { ...food, recipeId: 'recipe' } }, 'create_food_log')), 'INVALID_INPUT');
  assert.deepEqual((await write({ operationId: 'explicit-snapshot', expectedRevision: 0, entry: food }, 'create_food_log')).structuredContent, { revision: 1 });
  assert.deepEqual((await store.exportSnapshot('bob')).state.logs, [food]);
  assert.equal((await store.exportSnapshot('alice')).revision, 1);
});
