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
  return async (args: Record<string, unknown>) => {
    original = structuredClone(args);
    return client.callTool({ name: 'edit_meal_plans', arguments: args });
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
