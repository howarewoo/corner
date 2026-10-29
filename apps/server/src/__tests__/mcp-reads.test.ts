import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { createInitialState } from '@packages/workspace/initial-state';
import type { WorkoutSession } from '@packages/training/types';
import type { DelegatedAccess } from '../delegation.js';
import { createReadMcpServer } from '../mcp-reads.js';
import { WorkspaceStore } from '../store.js';
import type { Database } from '../queries.js';
import * as schema from '../schema.js';
import { testDatabase, closeTestDatabase } from '../../tests/helpers.ts';

let database: Pool;
let store: WorkspaceStore;
const clients: Client[] = [];
const servers: McpServer[] = [];
const stamp = '2026-10-22T12:00:00.000Z';
const range = { from: '2026-10-22', through: '2026-10-22' };
const scopes = ['workouts:read', 'routines:read', 'meal-plans:read', 'food-logs:read', 'recipes:read'];

beforeEach(async () => {
  database = await testDatabase();
  store = new WorkspaceStore(drizzle({ client: database, schema }) as Database);
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
  await closeTestDatabase(database);
});

async function connect(granted = scopes, ownerId = 'alice') {
  const access: DelegatedAccess = { ownerId, clientId: 'client', grantId: 'grant', scopes: granted };
  const server = createReadMcpServer(store, access);
  const client = new Client({ name: 'read-consumer', version: '1.0.0' });
  clients.push(client);
  servers.push(server);
  const [consumer, resource] = InMemoryTransport.createLinkedPair();
  await server.connect(resource);
  await client.connect(consumer);
  return { client, access };
}

function workout(id: string): WorkoutSession {
  return {
    id, date: range.from, name: 'Strength', kind: 'strength', status: 'completed', unit: 'kg',
    plannedMinutes: 40, durationMinutes: 40, rounds: null, sessionRpe: null, readiness: null,
    notes: '', changeReason: '', createdAt: stamp, updatedAt: stamp,
    exercises: [{ id: 'exercise', name: 'Bench press', loadType: 'total', targetSets: 1,
      repMin: 6, repMax: 10, targetRir: 2, restSeconds: 90, notes: '',
      sets: [{ id: 'set', weight: 30, reps: 8, rir: 2, completed: true, kind: 'working' }] }],
  };
}
async function seed(ownerId: string) {
  const state = createInitialState();
  const nutrition = { calories: 100, protein: 10, carbs: 10, fat: 2 };
  state.recipes = ['first', 'second'].map((id) => ({
    id, name: `${ownerId} ${id}`, description: '', category: 'breakfast', prepMinutes: 1,
    cookMinutes: 0, nutrition,
    ingredients: [{ name: 'Oats', quantity: 100, unit: 'g', aisle: 'Grains' }],
    steps: ['Mix.'], storage: '', variation: '',
    tags: [], color: '#234b35', source: 'manual', favorite: false, createdAt: stamp,
  }));
  state.plan = [{ id: 'meal', date: range.from, slot: 'breakfast', recipeId: 'first', servings: 1 }];
  state.logs = [{ id: 'log', date: range.from, slot: 'breakfast', name: `${ownerId} log`,
    nutrition, servings: 1, recipeId: 'first', planEntryId: 'meal', createdAt: stamp }];
  state.training.sessions = [workout('first'), workout('second')].map((session) => ({
    ...session, name: `${ownerId} strength`,
  }));
  const { sets: _sets, ...exercise } = workout('routine').exercises[0];
  state.training.templates = [{ id: 'routine', name: `${ownerId} routine`, kind: 'strength',
    description: '', durationMinutes: 40, exercises: [exercise], createdAt: stamp, updatedAt: stamp }];
  await store.replaceImport(ownerId, `${ownerId}-seed`, state, 0);
}

async function read(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.ok(result.structuredContent);
  assert.deepEqual(JSON.parse((result.content as Array<{ text: string }>)[0].text), result.structuredContent);
  return result.structuredContent as Record<string, any>;
}
async function invalid(client: Client, name: string, args: Record<string, unknown>) {
  try {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.notEqual(error.name, 'AssertionError');
  }
}

test('read visibility is scope-specific, absent capabilities cannot be called, and closures guard scope loss', async () => {
  const granted = ['recipes:read'];
  const { client } = await connect(granted);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ['get_recipes', 'list_recipes']);
  for (const tool of listed.tools) assert.deepEqual(tool.annotations, {
    readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
  });
  await invalid(client, 'list_workouts', {});
  granted.splice(0);
  const denied = await client.callTool({ name: 'list_recipes', arguments: {} });
  assert.equal(denied.isError, true);
  assert.deepEqual(denied.structuredContent, {
    code: 'INSUFFICIENT_SCOPE', error: 'This connection does not permit this read.',
  });
  const empty = await connect([]);
  assert.equal(empty.client.getServerCapabilities()?.tools, undefined);
  await assert.rejects(empty.client.listTools(), (error: unknown) =>
    error instanceof McpError && error.code === ErrorCode.MethodNotFound);
});

test('each permission exposes exactly its implemented domain reads', async () => {
  const expected: Record<string, string[]> = {
    'workouts:read': ['exercise_history', 'get_workouts', 'list_workouts'],
    'routines:read': ['get_routines', 'list_routines'],
    'meal-plans:read': ['get_meal_plans', 'list_meal_plans'],
    'food-logs:read': ['list_food_logs'],
    'recipes:read': ['get_recipes', 'list_recipes'],
  };
  for (const [scope, names] of Object.entries(expected)) {
    const { client } = await connect([scope]);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), names);
  }
});

test('all read domains use the bearer owner, preserve versions and planned/recorded distinctions', async () => {
  await seed('alice');
  await seed('bob');
  const { client } = await connect();
  assert.equal((await client.listTools()).tools.length, 10);
  const recipes = await read(client, 'list_recipes');
  assert.deepEqual(recipes.items.map((item: { name: string }) => item.name), ['alice first', 'alice second']);
  assert.equal(recipes.revision, 1);
  const routines = await read(client, 'list_routines');
  assert.equal(routines.items[0].name, 'alice routine');
  assert.equal(routines.items[0].updatedAt, stamp);
  const workouts = await read(client, 'list_workouts', { status: 'completed', order: 'recent' });
  assert.equal(workouts.items.length, 2);
  assert.equal(workouts.items[0].status, 'completed');
  assert.equal(workouts.items[0].updatedAt, stamp);
  assert.deepEqual((await read(client, 'list_workouts', { status: 'planned' })).items, []);
  const meals = await read(client, 'list_meal_plans', range);
  assert.equal(meals.items[0].id, 'meal');
  assert.deepEqual(meals.loggedPlanIds, ['meal']);
  const food = await read(client, 'list_food_logs', range);
  assert.equal(food.entries[0].name, 'alice log');
  assert.equal(food.revision, 1);
  const history = await read(client, 'exercise_history', { name: 'bench PRESS', limit: 1 });
  assert.equal(history.sessions.length, 1);
  assert.equal(history.sessions[0].updatedAt, stamp);
  assert.equal(history.nextCursor.revision, 1);
  const following = await read(client, 'exercise_history', { name: 'Bench press', limit: 1, cursor: history.nextCursor });
  assert.notEqual(following.sessions[0].id, history.sessions[0].id);
  for (const [tool, key, id] of [
    ['get_recipes', 'recipes', 'first'], ['get_routines', 'templates', 'routine'],
    ['get_workouts', 'sessions', 'first'], ['get_meal_plans', 'plan', 'meal'],
  ]) {
    const result = await read(client, tool, { ids: [id, 'missing'] });
    assert.equal(result.revision, 1);
    assert.deepEqual(Object.keys(result).sort(), [key, 'revision'].sort());
    assert.deepEqual(result[key].map((item: { id: string }) => item.id), [id]);
  }
  assert.equal(workouts.items[0].name, 'alice strength');
  const outsider = await connect(scopes, 'nobody');
  assert.deepEqual((await read(outsider.client, 'get_recipes', { ids: ['first'] })).recipes, []);
  assert.deepEqual((await read(outsider.client, 'get_workouts', { ids: ['first'] })).sessions, []);
  assert.deepEqual((await read(outsider.client, 'get_routines', { ids: ['routine'] })).templates, []);
  assert.deepEqual((await read(outsider.client, 'get_meal_plans', { ids: ['meal'] })).plan, []);
  assert.deepEqual((await read(outsider.client, 'list_food_logs', range)).entries, []);
  assert.deepEqual((await read(outsider.client, 'exercise_history', { name: 'Bench press' })).sessions, []);
});

test('page cursors advance explicitly and reject changed revisions without leaking internal errors', async () => {
  await seed('alice');
  const { client } = await connect(['recipes:read']);
  const first = await read(client, 'list_recipes', { limit: 1 });
  assert.equal(first.items.length, 1);
  assert.equal(first.nextCursor.revision, first.revision);
  const next = await read(client, 'list_recipes', { limit: 1, cursor: first.nextCursor });
  assert.equal(next.items.length, 1);
  assert.notEqual(next.items[0].id, first.items[0].id);
  assert.equal(next.nextCursor, null);
  await store.mutate('alice', 'change-revision', { type: 'grocery.check', data: { key: 'x|g', checked: true } });
  const stale = await client.callTool({ name: 'list_recipes', arguments: { cursor: first.nextCursor } });
  assert.equal(stale.isError, true);
  assert.deepEqual(stale.structuredContent, {
    code: 'CURSOR_INVALIDATED', error: 'Your workspace changed. Restart this list.',
  });
});

test('resource, owner, ID, page, calendar and history boundaries cannot widen reads', async () => {
  const { client } = await connect();
  for (const name of ['list_workouts', 'list_routines', 'list_recipes', 'list_meal_plans']) {
    const args = name === 'list_meal_plans' ? range : {};
    await invalid(client, name, { ...args, resource: 'checkIns' });
    await invalid(client, name, { ...args, ownerId: 'bob' });
    await invalid(client, name, { ...args, limit: 101 });
    await invalid(client, name, { ...args, limit: 0 });
  }
  for (const [name, max] of [['get_workouts', 25], ['get_routines', 100], ['get_recipes', 100], ['get_meal_plans', 100]] as const) {
    await invalid(client, name, { ids: Array(max + 1).fill('id') });
    await invalid(client, name, { ids: ['x'.repeat(121)] });
    await invalid(client, name, { ids: [''] });
    await invalid(client, name, { ids: ['id'], recipeIds: ['other'] });
  }
  for (const name of ['list_meal_plans', 'list_food_logs']) {
    await invalid(client, name, {});
    await invalid(client, name, { from: '2026-01-01', through: '2026-12-31' });
    await invalid(client, name, { from: range.from, through: '2026-10-21' });
  }
  await invalid(client, 'list_workouts', { from: range.from });
  await invalid(client, 'list_food_logs', { ...range, limit: 201 });
  await invalid(client, 'exercise_history', { name: ' ', limit: 1 });
  await invalid(client, 'exercise_history', { name: 'Bench press', limit: 101 });
  await invalid(client, 'exercise_history', { name: 'Bench press', ownerId: 'bob' });
  // Inclusive 93-day windows and the exact page/detail caps remain usable.
  const longest = { from: '2026-01-01', through: '2026-04-03' };
  await read(client, 'list_meal_plans', { ...longest, limit: 100 });
  await read(client, 'list_food_logs', { ...longest, limit: 200 });
  await read(client, 'list_workouts', { ...longest, limit: 100 });
  await read(client, 'get_workouts', { ids: Array.from({ length: 25 }, (_, id) => `id-${id}`) });
  await read(client, 'get_recipes', { ids: Array.from({ length: 100 }, (_, id) => `id-${id}`) });
});
