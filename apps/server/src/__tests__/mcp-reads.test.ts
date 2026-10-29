import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { createInitialState } from '@packages/workspace/initial-state';
import type { WorkoutSession } from '@packages/training/types';
import type { DelegatedAccess } from '../delegation.js';
import { createReadMcpServer } from '../mcp-reads.js';
import { WorkspaceStore } from '../store.js';
import type { Database } from '../queries.js';
import * as schema from '../schema.js';
import { testDatabase, closeTestDatabase } from '../../tests/helpers.ts';
import { MAX_RESULT_BYTES, MIN_RESULT_BYTES, resultWireBytes } from '../raw-queries.js';
import { recordPageSchema, rangeSchema } from '@packages/api/workspace-data';
import { foodWindowSchema } from '@packages/api/schemas';

let database: Pool;
let store: WorkspaceStore;
const clients: Client[] = [];
const servers: McpServer[] = [];
const stamp = '2026-10-22T12:00:00.000Z';
const range = { from: '2026-10-22', through: '2026-10-22' };
const scopes = [
  'workouts:read',
  'routines:read',
  'meal-plans:read',
  'food-logs:read',
  'recipes:read',
  'check-ins:read',
  'scheduled-dates:read',
  'grocery-checks:read',
  'settings:read',
];

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
  const access: DelegatedAccess = {
    ownerId,
    clientId: 'client',
    grantId: 'grant',
    scopes: granted,
  };
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
    id,
    date: range.from,
    name: 'Strength',
    kind: 'strength',
    status: 'completed',
    unit: 'kg',
    plannedMinutes: 40,
    durationMinutes: 40,
    rounds: null,
    sessionRpe: null,
    readiness: null,
    notes: '',
    changeReason: '',
    createdAt: stamp,
    updatedAt: stamp,
    exercises: [
      {
        id: 'exercise',
        name: 'Bench press',
        loadType: 'total',
        targetSets: 1,
        repMin: 6,
        repMax: 10,
        targetRir: 2,
        restSeconds: 90,
        notes: '',
        sets: [{ id: 'set', weight: 30, reps: 8, rir: 2, completed: true, kind: 'working' }],
      },
    ],
  };
}
async function seed(ownerId: string) {
  const state = createInitialState();
  const nutrition = { calories: 100, protein: 10, carbs: 10, fat: 2 };
  state.recipes = ['first', 'second'].map((id) => ({
    id,
    name: `${ownerId} ${id}`,
    description: '',
    category: 'breakfast',
    prepMinutes: 1,
    cookMinutes: 0,
    nutrition,
    ingredients: [{ name: 'Oats', quantity: 100, unit: 'g', aisle: 'Grains' }],
    steps: ['Mix.'],
    storage: '',
    variation: '',
    tags: [],
    color: '#234b35',
    source: 'manual',
    favorite: false,
    createdAt: stamp,
  }));
  state.plan = [
    { id: 'meal', date: range.from, slot: 'breakfast', recipeId: 'first', servings: 1 },
  ];
  state.logs = [
    {
      id: 'log',
      date: range.from,
      slot: 'breakfast',
      name: `${ownerId} log`,
      nutrition,
      servings: 1,
      recipeId: 'first',
      planEntryId: 'meal',
      createdAt: stamp,
    },
  ];
  state.training.sessions = [workout('first'), workout('second')].map((session) => ({
    ...session,
    name: `${ownerId} strength`,
  }));
  const { sets: _sets, ...exercise } = workout('routine').exercises[0];
  state.training.templates = [
    {
      id: 'routine',
      name: `${ownerId} routine`,
      kind: 'strength',
      description: '',
      durationMinutes: 40,
      exercises: [exercise],
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];
  await store.replaceImport(ownerId, `${ownerId}-seed`, state, 0);
}

async function read(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.ok(result.structuredContent);
  assert.deepEqual(
    JSON.parse((result.content as Array<{ text: string }>)[0].text),
    result.structuredContent,
  );
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

function errorPayload(value: unknown) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  assert.ok('code' in value && typeof value.code === 'string');
  assert.ok('error' in value && typeof value.error === 'string');
  return value;
}

test('read visibility is scope-specific, absent capabilities cannot be called, and closures guard scope loss', async () => {
  const granted = ['recipes:read'];
  const { client } = await connect(granted);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ['get_recipes', 'list_recipes']);
  for (const tool of listed.tools)
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  await invalid(client, 'list_workouts', {});
  granted.splice(0);
  const denied = await client.callTool({ name: 'list_recipes', arguments: {} });
  assert.equal(denied.isError, true);
  assert.deepEqual(denied.structuredContent, {
    code: 'INSUFFICIENT_SCOPE',
    error: 'This connection does not permit this read.',
  });
  const empty = await connect([]);
  assert.equal(empty.client.getServerCapabilities()?.tools, undefined);
  await assert.rejects(
    empty.client.listTools(),
    (error: unknown) => error instanceof McpError && error.code === ErrorCode.MethodNotFound,
  );
});

test('each permission exposes exactly its implemented domain reads', async () => {
  const expected: Record<string, string[]> = {
    'workouts:read': ['exercise_history', 'get_workouts', 'list_workouts'],
    'routines:read': ['get_routines', 'list_routines'],
    'meal-plans:read': ['get_meal_plans', 'list_meal_plans'],
    'food-logs:read': ['list_food_logs'],
    'recipes:read': ['get_recipes', 'list_recipes'],
    'check-ins:read': ['list_check_ins'],
    'scheduled-dates:read': ['list_scheduled_dates'],
    'grocery-checks:read': ['list_grocery_checks'],
    'settings:read': ['get_settings'],
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
  assert.equal((await client.listTools()).tools.length, 14);
  const recipes = await read(client, 'list_recipes');
  assert.deepEqual(
    recipes.items.map((item: { name: string }) => item.name),
    ['alice first', 'alice second'],
  );
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
  assert.equal(food.items[0].name, 'alice log');
  assert.equal('totals' in food, false);
  assert.equal(food.revision, 1);
  const history = await read(client, 'exercise_history', { name: 'bench PRESS', limit: 1 });
  assert.equal(history.sessions.length, 1);
  assert.equal(history.sessions[0].updatedAt, stamp);
  assert.equal(typeof history.nextCursor, 'string');
  const following = await read(client, 'exercise_history', {
    name: 'Bench press',
    limit: 1,
    cursor: history.nextCursor,
  });
  assert.notEqual(following.sessions[0].id, history.sessions[0].id);
  for (const [tool, key, id] of [
    ['get_recipes', 'recipes', 'first'],
    ['get_routines', 'templates', 'routine'],
    ['get_workouts', 'sessions', 'first'],
    ['get_meal_plans', 'plan', 'meal'],
  ]) {
    const result = await read(client, tool, { ids: [id, 'missing'] });
    assert.equal(result.revision, 1);
    assert.deepEqual(Object.keys(result).sort(), [key, 'revision'].sort());
    assert.deepEqual(
      result[key].map((item: { id: string }) => item.id),
      [id],
    );
  }
  assert.equal(workouts.items[0].name, 'alice strength');
  const outsider = await connect(scopes, 'nobody');
  assert.deepEqual((await read(outsider.client, 'get_recipes', { ids: ['first'] })).recipes, []);
  assert.deepEqual((await read(outsider.client, 'get_workouts', { ids: ['first'] })).sessions, []);
  assert.deepEqual(
    (await read(outsider.client, 'get_routines', { ids: ['routine'] })).templates,
    [],
  );
  assert.deepEqual((await read(outsider.client, 'get_meal_plans', { ids: ['meal'] })).plan, []);
  assert.deepEqual((await read(outsider.client, 'list_food_logs', range)).items, []);
  assert.deepEqual(
    (await read(outsider.client, 'exercise_history', { name: 'Bench press' })).sessions,
    [],
  );
});

test('page cursors advance explicitly and reject changed revisions without leaking internal errors', async () => {
  await seed('alice');
  const { client } = await connect(['recipes:read']);
  const first = await read(client, 'list_recipes', { limit: 1 });
  assert.equal(first.items.length, 1);
  assert.equal(typeof first.nextCursor, 'string');
  const next = await read(client, 'list_recipes', { limit: 1, cursor: first.nextCursor });
  assert.equal(next.items.length, 1);
  assert.notEqual(next.items[0].id, first.items[0].id);
  assert.equal(next.nextCursor, null);
  await store.mutate('alice', 'change-revision', {
    type: 'grocery.check',
    data: { key: 'x|g', checked: true },
  });
  const stale = await client.callTool({
    name: 'list_recipes',
    arguments: { cursor: first.nextCursor },
  });
  assert.equal(stale.isError, true);
  assert.deepEqual(stale.structuredContent, {
    code: 'CURSOR_INVALIDATED',
    error: 'Your workspace changed. Restart this list.',
  });
});

test('resource, owner, ID, page, calendar and history boundaries cannot widen reads', async () => {
  const { client } = await connect();
  for (const name of ['list_workouts', 'list_routines', 'list_recipes', 'list_meal_plans']) {
    const args = name === 'list_meal_plans' ? range : {};
    await invalid(client, name, { ...args, resource: 'checkIns' });
    await invalid(client, name, { ...args, ownerId: 'bob' });
    await invalid(client, name, { ...args, limit: 201 });
    await invalid(client, name, { ...args, limit: 0 });
  }
  for (const [name, max] of [
    ['get_workouts', 25],
    ['get_routines', 100],
    ['get_recipes', 100],
    ['get_meal_plans', 100],
  ] as const) {
    await invalid(client, name, { ids: Array(max + 1).fill('id') });
    await invalid(client, name, { ids: ['x'.repeat(121)] });
    await invalid(client, name, { ids: [''] });
    await invalid(client, name, { ids: ['id'], recipeIds: ['other'] });
  }
  for (const name of ['list_meal_plans', 'list_food_logs']) {
    await read(client, name, {});
    await read(client, name, { from: '2000-01-01', through: '2030-12-31' });
    await invalid(client, name, { from: range.from, through: '2026-10-21' });
  }
  await read(client, 'list_workouts', { from: range.from });
  await invalid(client, 'list_food_logs', { ...range, limit: 201 });
  await invalid(client, 'exercise_history', { name: ' ', limit: 1 });
  await invalid(client, 'exercise_history', { name: 'Bench press', limit: 101 });
  await invalid(client, 'exercise_history', { name: 'Bench press', ownerId: 'bob' });
  // Multi-year windows and the exact page/detail caps remain usable.
  const longest = { from: '2000-01-01', through: '2030-04-03' };
  await read(client, 'list_meal_plans', { ...longest, limit: 100 });
  await read(client, 'list_food_logs', { ...longest, limit: 200 });
  await read(client, 'list_workouts', { ...longest, limit: 100 });
  await read(client, 'get_workouts', { ids: Array.from({ length: 25 }, (_, id) => `id-${id}`) });
  await read(client, 'get_recipes', { ids: Array.from({ length: 100 }, (_, id) => `id-${id}`) });
});

test('a revision pins all domains, details and settings, and every workspace write invalidates it', async () => {
  await seed('alice');
  const { client } = await connect();
  const initial = await read(client, 'get_settings');
  const calls: Array<[string, Record<string, unknown>]> = [
    ...['list_workouts', 'list_routines', 'list_recipes', 'list_meal_plans', 'list_food_logs',
      'list_check_ins', 'list_scheduled_dates', 'list_grocery_checks', 'get_settings'].map(
      (name): [string, Record<string, unknown>] => [name, {}]),
    ['get_workouts', { ids: ['first'] }], ['get_recipes', { ids: ['first'] }],
    ['get_meal_plans', { ids: ['meal'] }], ['get_routines', { ids: ['routine'] }],
    ['exercise_history', { name: 'Bench press' }],
  ];
  for (const [name, args] of calls) {
    assert.equal((await read(client, name, { ...args, expectedRevision: initial.revision })).revision, initial.revision);
  }
  await store.mutate('alice', 'settings-change', {
    type: 'settings.save', data: { ...initial.settings, timezone: 'Asia/Tokyo' },
  });
  for (const [name, args] of calls) {
    const response = await client.callTool({ name, arguments: { ...args, expectedRevision: initial.revision } });
    assert.equal(response.isError, true);
    assert.equal(errorPayload(response.structuredContent).code, 'REVISION_CHANGED', name);
  }
  assert.equal((await read(client, 'get_settings')).settings.timezone, 'Asia/Tokyo');
});

test('cursors bind owner, resource, filters and order; page size may change', async () => {
  await seed('alice');
  await seed('bob');
  const { client } = await connect();
  const first = await read(client, 'list_workouts', { limit: 1 });
  for (const [name, arguments_] of [
    ['list_workouts', { status: 'completed' }],
    ['list_workouts', { order: 'recent' }],
    ['list_workouts', { from: '2000-01-01' }],
    ['list_routines', {}],
  ] as Array<[string, Record<string, unknown>]>) {
    const response = await client.callTool({ name, arguments: { ...arguments_, cursor: first.nextCursor } });
    assert.equal(errorPayload(response.structuredContent).code, 'CURSOR_MISMATCH');
  }
  const bob = await connect(scopes, 'bob');
  const foreign = await bob.client.callTool({ name: 'list_workouts', arguments: { cursor: first.nextCursor } });
  assert.equal(errorPayload(foreign.structuredContent).code, 'CURSOR_MISMATCH');
  assert.equal((await read(client, 'list_workouts', { cursor: first.nextCursor, limit: 200 })).items.length, 1);
  const history = await read(client, 'exercise_history', { name: 'Bench press', limit: 1 });
  const wrongExercise = await client.callTool({ name: 'exercise_history',
    arguments: { name: 'Squat', cursor: history.nextCursor } });
  assert.equal(errorPayload(wrongExercise.structuredContent).code, 'CURSOR_MISMATCH');
  const malformed = await client.callTool({ name: 'list_workouts', arguments: { cursor: 'not-a-cursor' } });
  assert.equal(errorPayload(malformed.structuredContent).code, 'INVALID_CURSOR');
});

test('sensitive configuration and check-ins are independently consented and owner scoped', async () => {
  await seed('alice');
  await store.mutate('alice', 'checkin-fixture', { type: 'training.checkin.save', data: {
    id: 'body', date: '2020-01-01', bodyWeight: 180, waist: 32, sleepHours: 8,
    energy: 4, soreness: 2, boxingQuality: null, notes: 'private recovery',
  } });
  const { client } = await connect();
  const body = await read(client, 'list_check_ins');
  assert.equal(body.items[0].notes, 'private recovery');
  assert.deepEqual(body.units, { bodyWeight: 'lb', waist: 'in', sleepHours: 'hours' });
  const outside = await connect(scopes, 'nobody');
  assert.deepEqual((await read(outside.client, 'list_check_ins')).items, []);
  for (const grants of [['workouts:read'], ['workout-history:write'], ['recipes:read'], ['routines:write']]) {
    const limited = await connect(grants);
    await invalid(limited.client, 'get_settings', {});
    await invalid(limited.client, 'list_check_ins', {});
  }
});

test('wire budgeting accounts for Unicode, escaped text, whole records and explicit continuation', async () => {
  await seed('alice');
  const { client } = await connect();
  const recipe = (await read(client, 'get_recipes', { ids: ['first'] })).recipes[0];
  for (let n = 0; n < 12; n++) {
    await store.mutate('alice', `unicode-${n}`, { type: 'recipe.save',
      data: { ...recipe, id: `unicode-${n}`, description: '🦉"\\'.repeat(400) } });
  }
  const ids: string[] = [];
  let cursor: unknown;
  let revision: number | undefined;
  let pages = 0;
  do {
    const result = await read(client, 'list_recipes', {
      maxBytes: MIN_RESULT_BYTES, limit: 200, ...(cursor ? { cursor } : {}),
      ...(revision === undefined ? {} : { expectedRevision: revision }),
    });
    revision = result.revision;
    assert.ok(resultWireBytes(JSON.stringify(result)) <= MIN_RESULT_BYTES);
    assert.ok(result.items.length > 0);
    ids.push(...result.items.map((item: { id: string }) => item.id));
    cursor = result.nextCursor;
    assert.ok(++pages < 30, 'pagination must terminate');
  } while (cursor !== null);
  assert.equal(ids.length, 14);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(pages > 1);
  for (const maxBytes of [MIN_RESULT_BYTES - 1, MAX_RESULT_BYTES + 1]) {
    await invalid(client, 'list_recipes', { maxBytes });
  }
  // One larger record cannot be silently dropped or sliced to fit a small requested budget.
  await store.mutate('alice', 'large-recipe-fixture', { type: 'recipe.save',
    data: { ...recipe, id: 'large', name: 'Large only', steps: Array(30).fill('🦉'.repeat(400)) } });
  const large = await client.callTool({ name: 'list_recipes',
    arguments: { search: 'Large only', maxBytes: MIN_RESULT_BYTES } });
  assert.equal(errorPayload(large.structuredContent).code, 'RESPONSE_TOO_LARGE');
  const whole = await read(client, 'list_recipes', { search: 'Large only', maxBytes: MAX_RESULT_BYTES });
  assert.equal(whole.items[0].steps.length, 30);
  assert.equal(whole.nextCursor, null);
  const exact = resultWireBytes(JSON.stringify(whole));
  assert.deepEqual(await read(client, 'list_recipes', { search: 'Large only', maxBytes: exact }), whole);
  const oneShort = await client.callTool({ name: 'list_recipes',
    arguments: { search: 'Large only', maxBytes: exact - 1 } });
  assert.equal(errorPayload(oneShort.structuredContent).code, 'RESPONSE_TOO_LARGE');
});

test('years of every collection page whole records exactly once without a lifetime cap', async () => {
  await seed('fixture');
  const { state } = await store.exportSnapshot('fixture');
  const count = 215;
  const dates = Array.from({ length: count }, (_, index) =>
    new Date(Date.UTC(2010, 0, 1 + index * 20)).toISOString().slice(0, 10));
  state.recipes = dates.map((_, index) => ({ ...state.recipes[0], id: `recipe-${index}` }));
  state.plan = dates.map((date, index) => ({ ...state.plan[0], id: `plan-${index}`, date, recipeId: `recipe-${index}` }));
  state.logs = dates.map((date, index) => ({
    ...state.logs[0], id: `log-${index}`, date, recipeId: `recipe-${index}`, planEntryId: `plan-${index}`,
  }));
  state.training.sessions = dates.map((date, index) => ({ ...workout(`workout-${index}`), date }));
  // Native portability limits routines to 100; read pagination must still cover every stored routine.
  state.training.templates = dates.slice(0, 100).map((_, index) => ({
    ...state.training.templates[0], id: `routine-${index}`,
  }));
  state.training.checkIns = dates.map((date, index) => ({
    id: `body-${index}`, date, bodyWeight: 180, waist: null, sleepHours: null,
    energy: null, soreness: null, boxingQuality: null, notes: `Recovery ${index}`,
  }));
  state.training.scheduledDates = dates;
  state.groceryChecks = Object.fromEntries(dates.map((date) => [`${date}|oats|g`, true]));
  await store.replaceImport('years', 'years-seed', state, 0);
  const { client } = await connect(scopes, 'years');
  for (const [tool, expected] of [
    ['list_workouts', count], ['list_routines', 100], ['list_recipes', count],
    ['list_meal_plans', count], ['list_food_logs', count], ['list_check_ins', count],
    ['list_scheduled_dates', count], ['list_grocery_checks', count],
  ] as const) {
    const identities: string[] = [];
    let cursor: unknown;
    do {
      const result = await read(client, tool, {
        limit: 31, expectedRevision: 1, ...(cursor ? { cursor } : {}),
        ...(['list_workouts', 'list_meal_plans', 'list_food_logs', 'list_check_ins', 'list_scheduled_dates'].includes(tool)
          ? { from: '2000-01-01', through: '2030-12-31' } : {}),
      });
      assert.equal(result.revision, 1);
      for (const item of result.items) {
        identities.push(typeof item === 'string' ? item : item.id ?? item.key);
        if (tool === 'list_workouts') {
          assert.deepEqual(item.exercises, workout('expected').exercises);
          assert.equal(item.unit, 'kg');
          assert.equal(item.updatedAt, stamp);
        }
      }
      cursor = result.nextCursor;
    } while (cursor !== null);
    assert.equal(identities.length, expected, tool);
    assert.equal(new Set(identities).size, expected, tool);
  }
});

test('MCP long ranges do not relax browser calendar or aggregate contracts', () => {
  const years = { from: '2010-01-01', through: '2030-12-31' };
  assert.equal(recordPageSchema.safeParse({ resource: 'plan', ...years }).success, false);
  assert.equal(rangeSchema.safeParse(years).success, false);
  assert.equal(foodWindowSchema.safeParse(years).success, false);
  const bounded = { from: '2026-01-01', through: '2026-04-03' };
  assert.equal(recordPageSchema.safeParse({ resource: 'plan', ...bounded }).success, true);
  assert.equal(rangeSchema.safeParse(bounded).success, true);
  assert.equal(foodWindowSchema.safeParse(bounded).success, true);
});

test('actual SDK HTTP response framing fits the wire budget with escaped Unicode records and IDs', async () => {
  await seed('alice');
  const { state } = await store.exportSnapshot('alice');
  const original = state.recipes[0];
  state.recipes = Array.from({ length: 20 }, (_, index) => ({
    ...original, id: `wire-${index}`, description: '🦉"\\'.repeat(400),
  }));
  state.plan = [];
  state.logs = [];
  await store.replaceImport('wire', 'wire-seed', state, 0);
  const server = createReadMcpServer(store, {
    ownerId: 'wire', clientId: 'client', grantId: 'grant', scopes: ['recipes:read'],
  });
  servers.push(server);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, enableJsonResponse: true,
  });
  await server.connect(transport);
  const body = { jsonrpc: '2.0', id: '🦉"\\'.repeat(20), method: 'tools/call',
    params: { name: 'list_recipes', arguments: { maxBytes: MIN_RESULT_BYTES, limit: 200 } } };
  const response = await transport.handleRequest(new Request('http://localhost/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  }));
  assert.equal(response.status, 200);
  const wire = await response.text();
  assert.ok(Buffer.byteLength(wire, 'utf8') <= MIN_RESULT_BYTES);
  const result = JSON.parse(wire).result;
  assert.notEqual(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.ok(result.structuredContent.nextCursor);
  assert.ok(result.structuredContent.items.length < 20);
});

test('oversized addressed details fail explicitly instead of truncating a batch', async () => {
  await seed('fixture');
  const { state } = await store.exportSnapshot('fixture');
  const original = state.recipes[0];
  state.plan = [];
  state.logs = [];
  state.recipes = Array.from({ length: 20 }, (_, index) => ({
    ...original, id: `large-${index}`, steps: Array(40).fill('x'.repeat(2000)),
  }));
  await store.replaceImport('large-details', 'large-details-seed', state, 0);
  const { client } = await connect(['recipes:read'], 'large-details');
  const result = await client.callTool({ name: 'get_recipes',
    arguments: { ids: state.recipes.map((recipe) => recipe.id) } });
  assert.equal(result.isError, true);
  const failure = errorPayload(result.structuredContent);
  assert.equal(failure.code, 'RESPONSE_TOO_LARGE');
  assert.equal('recipes' in failure, false);
  assert.equal((await read(client, 'get_recipes', { ids: ['large-0'] })).recipes.length, 1);
});
