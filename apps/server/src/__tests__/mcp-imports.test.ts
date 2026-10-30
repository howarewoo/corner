import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { Pool } from 'pg';
import { z } from 'zod';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createInitialState } from '@packages/workspace/initial-state';
import { WorkoutSessionSchema } from '@packages/training/workouts';
import { MAX_WORKSPACE_TRANSFER_BYTES } from '@packages/api/workspace-data';
import { DELEGATED_PERMISSIONS } from '@packages/api/delegation';
import { testDatabase, closeTestDatabase } from '../../tests/helpers.ts';
import { WorkspaceStore, inspectImport } from '../store.js';
import type { Database } from '../queries.js';
import type { DelegatedAccess, DelegationService } from '../delegation.js';
import * as schema from '../schema.js';
import { createReadMcpServer } from '../mcp-reads.js';
import { registerNutritionWrites } from '../mcp-writes.js';
import { registerTrainingWrites } from '../mcp-training.js';
import { registerImports, workoutImportSchema, type WorkoutImportInput } from '../mcp-imports.js';
import { workoutImportAdapter, MAX_MCP_REQUEST_BYTES, type WorkoutSource } from '../additive-import.js';
import { routineImportAdapter, recipeImportAdapter, mealPlanImportAdapter, foodLogImportAdapter,
  checkInImportAdapter, scheduledDateImportAdapter, groceryCheckImportAdapter, type ImportAdapter } from '../additive-import.js';
import { handleMcp } from '../mcp.js';
import { ApiError, readJson } from '../http.js';
import { validatePersistedRecords } from '../persisted-records.js';
import { fingerprint } from '../fingerprint.js';

let database: Pool;
let store: WorkspaceStore;
const resources: Array<{ client: Client; server: McpServer }> = [];
const access: DelegatedAccess = { ownerId: 'alice', clientId: 'importer', grantId: 'grant', scopes: ['workouts:import'] };
const timestamp = '2026-10-28T12:00:00.000Z';
function workout(id = 'history'): WorkoutSource {
  return { id, templateId: 'historical-routine-not-present', date: '2026-10-28', name: 'Recorded lifting',
    kind: 'strength', status: 'completed', unit: 'kg', plannedMinutes: null,
    durationMinutes: null, rounds: null, sessionRpe: null, readiness: null, notes: '', changeReason: '',
    exercises: [{ id: 'press', name: 'Press', loadType: 'total', targetSets: null, repMin: null,
      repMax: null, targetRir: null, restSeconds: null, notes: '',
      sets: [{ id: 'set', weight: 40, reps: 8, rir: null, completed: true, kind: 'working' }] }],
  };
}
function args(operationLabel = 'import-first', expectedRevision = 0, records = [workout()]) {
  return { operationId: `import-test-${operationLabel}`, expectedRevision, sourceNamespace: 'source-workouts',
    records: records.map((record) => ({ sourceRecordId: `source-${record.id}`, workout: record })) };
}
function errorCode(code: string) { return (error: unknown) => error instanceof ApiError && error.code === code; }
async function direct(input = args(), identity = access) {
  return store.delegatedImport(identity, 'workouts:import', 'import_workouts', input,
    input.operationId, input.expectedRevision, input.sourceNamespace,
    input.records.map(({ sourceRecordId, workout: record }) => ({ sourceRecordId, record })), workoutImportAdapter);
}
async function connect(identity = access) {
  let original: unknown;
  const server = createReadMcpServer(store, identity);
  registerNutritionWrites(server, store, identity, () => original);
  registerTrainingWrites(server, store, identity, () => original);
  registerImports(server, store, identity, () => original);
  const client = new Client({ name: 'importer', version: '1.0.0' });
  resources.push({ client, server });
  const [consumer, resource] = InMemoryTransport.createLinkedPair();
  await server.connect(resource);
  await client.connect(consumer);
  return { client, call: async (input: WorkoutImportInput) => {
    original = structuredClone(input);
    return client.callTool({ name: 'import_workouts', arguments: input });
  } };
}
beforeEach(async () => {
  database = await testDatabase();
  store = new WorkspaceStore(drizzle({ client: database, schema }) as Database);
});
afterEach(async () => {
  for (const { client, server } of resources.splice(0)) { await client.close(); await server.close(); }
  await closeTestDatabase(database);
});

test('import-only consent exposes no records or edits and creates actual-only native history atomically', async () => {
  assert.ok(DELEGATED_PERMISSIONS.some(({ scope }) => scope === 'workouts:import'));
  const { client, call } = await connect();
  assert.deepEqual((await client.listTools()).tools.map(({ name }) => name).sort(), ['get_workspace_revision', 'import_workouts']);
  const result = await call(args());
  assert.deepEqual(result.structuredContent, { revision: 1, outcomes: [{ sourceRecordId: 'source-history', destinationId: 'history', outcome: 'created' }] });
  const snapshot = await store.exportSnapshot('alice');
  const saved = snapshot.state.training.sessions[0];
  assert.equal(saved.plannedMinutes, null);
  assert.equal(saved.exercises[0].targetSets, null);
  assert.deepEqual(saved.exercises[0].sets, workout().exercises[0].sets);
  assert.equal(saved.templateId, workout().templateId);
  assert.deepEqual(snapshot.state.training.templates, []);
  assert.equal(snapshot.state.importSources?.[0].sourceFingerprint, fingerprint(workout()));
  assert.equal((await client.callTool({ name: 'get_workouts', arguments: { ids: ['history'] } })).isError, true);
  await assert.rejects(direct(args('denied', 1), { ...access, scopes: ['workouts:read', 'workout-history:write'] }), errorCode('INSUFFICIENT_SCOPE'));
  assert.equal((await store.bootstrap('alice')).revision, 1);
});

test('historical workout imports preserve explicit scheduled-date markers without inventing any', async () => {
  const initial = createInitialState();
  initial.training.scheduledDates = ['2026-10-25', '2026-10-29'];
  await store.replaceImport('alice', 'explicit-calendar-markers', initial, 0);
  const historical = workout('historical-workout');
  historical.date = '2014-06-15';
  const result = await direct(args('historical-import', 1, [historical]));
  assert.equal(result.outcomes[0].outcome, 'created');
  const after = (await store.exportSnapshot('alice')).state;
  assert.deepEqual(after.training.scheduledDates, initial.training.scheduledDates);
  assert.equal(after.training.sessions[0].date, historical.date);
  assert.equal(after.training.sessions[0].plannedMinutes, null);
});

test('retained retry preserves original outcomes and raw argument identity while normalized-source skip preserves manual edits', async () => {
  const { call } = await connect();
  const input = args();
  input.records[0].workout.name = ' Recorded lifting ';
  const initial = await call(input);
  const saved = (await store.exportSnapshot('alice')).state.training.sessions[0];
  await store.mutate('alice', 'manual-history-edit', { type: 'training.session.save', data: {
    session: { ...saved, name: 'Owner correction', notes: 'Private destination details' }, expectedUpdatedAt: saved.updatedAt,
  } });
  assert.deepEqual((await call(input)).structuredContent, initial.structuredContent);
  const changedOriginal = structuredClone(input);
  changedOriginal.records[0].workout.name = 'Recorded lifting';
  const changedResult = await call(changedOriginal);
  const changedContent = changedResult.structuredContent;
  assert.ok(changedContent && typeof changedContent === 'object' && 'code' in changedContent);
  assert.equal(changedContent.code, 'REQUEST_ID_REUSED');
  const renewed = await direct(args('fresh-operation', 2), { ...access, clientId: 'new-client', grantId: 'new-grant' });
  assert.equal(renewed.outcomes[0].outcome, 'skipped');
  const state = (await store.exportSnapshot('alice')).state;
  assert.equal(state.training.sessions[0].name, 'Owner correction');
  assert.equal(state.training.sessions[0].notes, 'Private destination details');
  assert.equal(state.training.sessions.length, 1);
  assert.equal(JSON.stringify(renewed).includes('Private destination'), false);
});

test('source changes, destination collisions, duplicate identities and invalid final members roll back every row and receipt', async () => {
  await direct();
  const before = await store.exportSnapshot('alice');
  const conflicting = args('conflict', 1, [workout('new-history'), { ...workout(), notes: 'Changed source' }]);
  await assert.rejects(direct(conflicting), errorCode('SOURCE_CONFLICT'));
  const collision = args('occupied', 1);
  collision.records[0].sourceRecordId = 'another-source';
  await assert.rejects(direct(collision), errorCode('DESTINATION_CONFLICT'));
  await assert.rejects(direct({ ...args('namespace-collision', 1), sourceNamespace: 'another-namespace' }), errorCode('DESTINATION_CONFLICT'));
  const duplicate = args('duplicate', 1, [workout('new-one'), workout('new-two')]);
  duplicate.records[1].sourceRecordId = duplicate.records[0].sourceRecordId;
  await assert.rejects(direct(duplicate), errorCode('INVALID_INPUT'));
  const invalid = args('invalid-final', 1, [workout('new-one'), workout('new-two')]);
  invalid.records[1].workout.exercises[0].sets[0].weight = null;
  await assert.rejects(direct(invalid), (error: unknown) =>
    error instanceof z.ZodError && error.issues.some(
      (issue) => issue.path.join('.') === 'exercises.0.sets.0.weight',
    ));
  assert.deepEqual(await store.exportSnapshot('alice'), before);
  assert.equal((await database.query('SELECT count(*)::int AS n FROM mutation_receipts')).rows[0].n, 1);
});

test('bulk workouts accept every native-valid status without implicit scheduling or routines', async () => {
  const records = (['planned', 'in_progress', 'completed', 'skipped'] as const).map((status) => ({
    ...workout(status), status, plannedMinutes: 30, durationMinutes: status === 'completed' ? 10 : null,
    exercises: workout(status).exercises.map((exercise) => ({
      ...exercise, targetSets: 1, repMin: 8, repMax: 8, restSeconds: 60, sets: [],
    })),
  }));
  for (const record of records) assert.equal(WorkoutSessionSchema.safeParse({
    ...record, createdAt: timestamp, updatedAt: timestamp,
  }).success, true);
  await direct(args('all-statuses', 0, records));
  const state = (await store.exportSnapshot('alice')).state;
  assert.deepEqual(state.training.sessions.map(({ status }) => status).sort(), records.map(({ status }) => status).sort());
  assert.deepEqual(state.training.scheduledDates, []);
  assert.deepEqual(state.training.templates, []);
});

test('owner lock serializes concurrent retries, competing sources and isolated owners', async () => {
  const input = args();
  const [first, retry] = await Promise.all([direct(input), direct(input)]);
  assert.deepEqual(first, retry);
  const racing = await Promise.allSettled([
    direct(args('race-a', 1, [workout('race')])),
    direct(args('race-b', 1, [workout('race')]), { ...access, grantId: 'another-grant' }),
  ]);
  assert.equal(racing.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(racing.filter(({ status }) => status === 'rejected').length, 1);
  const bob = await direct(args(), { ...access, ownerId: 'bob' });
  assert.equal(bob.outcomes[0].outcome, 'created');
  assert.equal((await store.exportSnapshot('alice')).state.training.sessions.length, 2);
  assert.equal((await store.exportSnapshot('bob')).state.training.sessions.length, 1);
});

test('source identity survives 1000-receipt pruning and never reapplies records', async () => {
  await direct();
  await database.query(`INSERT INTO mutation_receipts(user_id,request_id,payload_hash,revision,created_at)
    SELECT 'alice','filler-'||n,'hash',n+1,$1 FROM generate_series(1,1000) n`, [timestamp]);
  await database.query("UPDATE workspace_metadata SET revision=1001 WHERE user_id='alice'");
  const skipped = await direct(args('after-pruning', 1001));
  assert.equal(skipped.outcomes[0].outcome, 'skipped');
  assert.equal((await database.query('SELECT count(*)::int AS n FROM mutation_receipts')).rows[0].n, 1000);
  assert.equal((await database.query('SELECT count(*)::int AS n FROM workspace_import_sources')).rows[0].n, 1);
  assert.equal((await store.exportSnapshot('alice')).state.training.sessions.length, 1);
  await assert.rejects(direct(args()), errorCode('REVISION_CONFLICT'));
  const again = await direct(args('import-first', 1002));
  assert.equal(again.outcomes[0].outcome, 'skipped');
});

test('workspace preview, recovery and persisted validation retain source fingerprints independently of edited destinations', async () => {
  await direct();
  const saved = (await store.exportSnapshot('alice')).state.training.sessions[0];
  await store.mutate('alice', 'manual-portability-edit', { type: 'training.session.save', data: {
    session: { ...saved, notes: 'Keep correction' }, expectedUpdatedAt: saved.updatedAt,
  } });
  const exported = await store.exportSnapshot('alice');
  const preview = await store.importPreview('bob', exported.state);
  assert.equal(preview.summary.importSources, 1);
  assert.equal(preview.summary.bytes, Buffer.byteLength(JSON.stringify(exported.state)));
  await store.replaceImport('bob', 'recovery', exported.state, 0);
  assert.deepEqual((await store.exportSnapshot('bob')).state, exported.state);
  assert.equal((await direct(args('after-recovery', 1), { ...access, ownerId: 'bob' })).outcomes[0].outcome, 'skipped');
  assert.equal((await store.exportSnapshot('bob')).state.training.sessions[0].notes, 'Keep correction');
  const invalid = structuredClone(exported.state);
  invalid.importSources.push(invalid.importSources[0]);
  assert.throws(() => inspectImport(invalid), errorCode('INVALID_STATE'));
  const { importSources: _sources, ...legacy } = createInitialState();
  assert.equal(inspectImport(legacy).counts.importSources, 0);
  assert.deepEqual(inspectImport(legacy).state.importSources, []);
  const ledgerOnly = createInitialState();
  const sourceFingerprint = fingerprint(workout());
  ledgerOnly.importSources = Array.from({ length: 100001 }, (_, index) => ({
    sourceNamespace: 'archive', recordType: 'workouts' as const,
    sourceRecordId: `source-${index}`, destinationId: `history-${index}`, sourceFingerprint,
  }));
  const portableBytes = Buffer.byteLength(JSON.stringify(ledgerOnly));
  assert.ok(portableBytes < MAX_WORKSPACE_TRANSFER_BYTES);
  const inspectedLedger = inspectImport(ledgerOnly);
  assert.equal(inspectedLedger.counts.importSources, 100001);
  assert.equal(inspectedLedger.bytes, portableBytes);
  assert.deepEqual(inspectedLedger.state.importSources, ledgerOnly.importSources);
  assert.ok(inspectImport(exported.state).bytes < MAX_WORKSPACE_TRANSFER_BYTES);
  const connection = await database.connect();
  try {
    await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await validatePersistedRecords(connection, (await connection.query('SELECT current_schema() AS schema')).rows[0].schema);
    await connection.query('ROLLBACK');
  } finally { connection.release(); }
});

test('count and UTF-8 limits reject without truncation; MCP arrays and oversized encoded request IDs fail before dispatch', async () => {
  const hundred = args('hundred', 0, Array.from({ length: 100 }, (_, index) => workout(`history-${index}`)));
  assert.equal(workoutImportSchema.safeParse(hundred).success, true);
  assert.equal((await direct(hundred)).outcomes.length, 100);
  const persisted = (await store.exportSnapshot('alice')).state.training.sessions;
  assert.deepEqual(persisted.map((session) => session.id).sort(),
    hundred.records.map(({ workout: record }) => record.id).sort());
  const excessive = args('too-many', 1, Array.from({ length: 101 }, (_, index) => workout(`next-${index}`)));
  assert.equal(workoutImportSchema.safeParse(excessive).success, false);
  await assert.rejects(direct(excessive), errorCode('INVALID_INPUT'));
  const request = (body: string) => new Request('https://corner.test/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body,
  });
  const oversized = JSON.stringify({ text: '界'.repeat(Math.ceil(MAX_MCP_REQUEST_BYTES / 3)) });
  assert.ok(Buffer.byteLength(oversized) > MAX_MCP_REQUEST_BYTES);
  await assert.rejects(readJson(request(oversized), MAX_MCP_REQUEST_BYTES), errorCode('REQUEST_TOO_LARGE'));
  const delegation = { authenticate: async () => access } as unknown as DelegationService;
  for (const body of [JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]),
    JSON.stringify({ jsonrpc: '2.0', id: '界'.repeat(85), method: 'tools/list' })]) {
    await assert.rejects(handleMcp(request(body), store, delegation, 'https://corner.test'), errorCode('INVALID_INPUT'));
  }
  await assert.rejects(handleMcp(request(oversized), store, delegation, 'https://corner.test'), errorCode('REQUEST_TOO_LARGE'));
  const padded = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'import_workouts', arguments: args('after-large', 1, [workout('after-large')]),
  } }) + ' '.repeat(200 * 1024);
  const response = await handleMcp(request(padded), store, delegation, 'https://corner.test');
  const result = z.object({ result: z.object({ structuredContent: z.object({
    outcomes: z.array(z.object({ outcome: z.enum(['created', 'skipped']) })),
  }) }) }).parse(await response.json());
  assert.equal(result.result.structuredContent.outcomes[0].outcome, 'created');
  assert.equal((await store.exportSnapshot('alice')).state.training.sessions.length, 101);
  const exactBase = JSON.stringify({ jsonrpc: '2.0', id: 'x'.repeat(254), method: 'tools/list' });
  const exact = exactBase + ' '.repeat(MAX_MCP_REQUEST_BYTES - Buffer.byteLength(exactBase));
  assert.equal((await handleMcp(request(exact), store, delegation, 'https://corner.test')).status, 200);
  await assert.rejects(handleMcp(request(exact + ' '), store, delegation, 'https://corner.test'), errorCode('REQUEST_TOO_LARGE'));
});

test('one maximum-cardinality native workout fits the byte cap; a count-valid oversized batch is refused whole', async () => {
  const large = workout('w'.repeat(120));
  Object.assign(large, {
    templateId: 't'.repeat(120), name: '界'.repeat(160), plannedMinutes: 600,
    durationMinutes: 600, rounds: 100, sessionRpe: 10, readiness: 5,
    notes: '界'.repeat(4000), changeReason: '界'.repeat(1600),
  });
  const exercise = large.exercises[0];
  large.exercises = Array.from({ length: 25 }, (_, index) => ({
    ...exercise, id: `exercise-${index}`.padEnd(120, 'x'), name: '界'.repeat(160),
    notes: '界'.repeat(1200), catalogId: 'c'.repeat(120),
    targetSets: 20, repMin: 200, repMax: 200, restSeconds: 900, targetRir: 10,
    targetLoad: { weight: 2000, unit: 'kg' as const },
    sets: Array.from({ length: 30 }, (_, setIndex) => ({
      id: `set-${setIndex}`.padEnd(120, 's'), weight: 2000, reps: 500, rir: 10,
      completed: true, kind: 'working' as const,
    })),
  }));
  const input = args('large-native', 0, [large]);
  input.sourceNamespace = 'n'.repeat(120);
  input.records[0].sourceRecordId = '界'.repeat(240);
  const completeRequest = { jsonrpc: '2.0', id: 'x'.repeat(254), method: 'tools/call',
    params: { name: 'import_workouts', arguments: input } };
  assert.equal(workoutImportSchema.safeParse(input).success, true);
  assert.ok(Buffer.byteLength(JSON.stringify(completeRequest)) < MAX_MCP_REQUEST_BYTES);
  assert.equal((await direct(input)).outcomes[0].outcome, 'created');
  const tooLarge = args('too-large-native-batch', 1,
    Array.from({ length: 100 }, (_, index) => ({ ...large, id: `large-${index}` })));
  assert.equal(workoutImportSchema.safeParse(tooLarge).success, true);
  assert.ok(Buffer.byteLength(JSON.stringify(tooLarge)) > MAX_MCP_REQUEST_BYTES);
  await assert.rejects(direct(tooLarge), errorCode('REQUEST_TOO_LARGE'));
  const saved = (await store.exportSnapshot('alice')).state.training.sessions;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].exercises.length, 25);
  assert.equal(saved[0].exercises.flatMap((item) => item.sets).length, 750);
});

test('provenance-only recovery remains nonempty and owner deletion cascades only its provenance', async () => {
  const provenanceOnly = createInitialState();
  provenanceOnly.importSources.push({
    sourceNamespace: 'archive', recordType: 'workouts', sourceRecordId: 'deleted-native-history',
    sourceFingerprint: fingerprint(workout()), destinationId: 'history',
  });
  await store.replaceImport('alice', 'source-tombstone-recovery', provenanceOnly, 0);
  assert.equal(await store.isEmpty('alice'), false);
  assert.equal((await store.importPreview('alice', createInitialState())).canImport, false);
  await assert.rejects(store.replaceImport('alice', 'cannot-replace', createInitialState(), 1),
    errorCode('WORKSPACE_NOT_EMPTY'));
  const skipped = await direct({
    ...args('retained-identity', 1), sourceNamespace: 'archive',
    records: [{ sourceRecordId: 'deleted-native-history', workout: workout() }],
  });
  assert.equal(skipped.outcomes[0].outcome, 'skipped');
  assert.equal((await store.exportSnapshot('alice')).state.training.sessions.length, 0);
  await store.replaceImport('bob', 'bob-source-recovery', provenanceOnly, 0);
  await database.query("DELETE FROM workspace_metadata WHERE user_id='alice'");
  const rows = (await database.query('SELECT user_id FROM workspace_import_sources')).rows;
  assert.deepEqual(rows, [{ user_id: 'bob' }]);
});

test('each native collection has independent import-only visibility and revision discovery', async () => {
  for (const domain of ['routines', 'recipes', 'meal-plans', 'food-logs', 'check-ins', 'scheduled-dates', 'grocery-checks']) {
    const { client } = await connect({ ...access, scopes: [`${domain}:import`] });
    assert.deepEqual((await client.listTools()).tools.map(({ name }) => name).sort(),
      ['get_workspace_revision', `import_${domain.replaceAll('-', '_')}`].sort());
    assert.deepEqual((await client.callTool({ name: 'get_workspace_revision', arguments: {} })).structuredContent, { revision: 0 });
  }
});

async function nativeImport<T>(adapter: ImportAdapter<T>, records: T[], operationId: string, ownerId = 'alice') {
  const revision = (await store.exportSnapshot(ownerId)).revision;
  const scope = `${adapter.recordType}:import`;
  const input = { operationId, expectedRevision: revision, sourceNamespace: 'native-archive',
    records: records.map((record) => ({ sourceRecordId: adapter.destinationId(record).length <= 240
      ? adapter.destinationId(record) : 'long-native-key', record })) };
  return store.delegatedImport({ ...access, ownerId, scopes: [scope] }, scope,
    `import_${adapter.recordType.replaceAll('-', '_')}`, input, operationId, revision,
    input.sourceNamespace, input.records, adapter);
}

const nativeRecipe = {
  id: 'soup', name: 'Original soup', description: '', category: 'main' as const,
  prepMinutes: 0, cookMinutes: 0, nutrition: { calories: 0, protein: 0, carbs: 0, fat: 0 },
  ingredients: [{ name: 'Water', quantity: 0, unit: 'ml', aisle: 'Other', optional: false }],
  steps: ['Serve'], storage: '', variation: '', tags: [], color: '#112233',
  source: 'manual' as const, favorite: false, pdf: '/recipes/soup.pdf',
};

test('routine and recipe imports retain native zero/false metadata without changing settings or snapshots', async () => {
  const configured = createInitialState();
  configured.settings.name = 'Configured owner';
  configured.settings.timezone = 'Pacific/Auckland';
  await store.replaceImport('alice', 'configured', configured, 0);
  const { sets: _sets, ...exercise } = workout().exercises[0];
  const routine = { id: 'routine', name: 'Native routine', kind: 'strength' as const,
    description: '', durationMinutes: 0, exercises: [{ ...exercise, targetSets: 1, repMin: 1, repMax: 1, restSeconds: 0 }] };
  await nativeImport(routineImportAdapter, [routine], 'routine-import');
  await nativeImport(recipeImportAdapter, [nativeRecipe], 'recipe-import');
  const state = (await store.exportSnapshot('alice')).state;
  assert.deepEqual(state.settings, configured.settings);
  assert.equal(state.training.templates[0].durationMinutes, 0);
  assert.equal(state.training.templates[0].exercises[0].restSeconds, 0);
  assert.deepEqual(state.training.sessions, []);
  assert.deepEqual(state.training.scheduledDates, []);
  const { createdAt, ...recipe } = state.recipes[0];
  assert.ok(createdAt);
  assert.deepEqual(recipe, nativeRecipe);
  await assert.rejects(nativeImport(routineImportAdapter, [{ ...routine, id: 'invalid',
    exercises: [{ ...routine.exercises[0], repMin: 5, repMax: 1 }] }], 'bad-routine'), z.ZodError);
});

test('active meal plans require an existing owner recipe and roll back earlier batch members', async () => {
  await nativeImport(recipeImportAdapter, [nativeRecipe], 'recipe-for-plan', 'bob');
  const plan = { id: 'plan', date: '2010-01-01', slot: 'lunch' as const, recipeId: nativeRecipe.id, servings: 2 };
  await assert.rejects(nativeImport(mealPlanImportAdapter, [plan], 'foreign-recipe-plan'), errorCode('INVALID_INPUT'));
  await nativeImport(recipeImportAdapter, [nativeRecipe], 'owner-recipe');
  const before = await store.exportSnapshot('alice');
  await assert.rejects(nativeImport(mealPlanImportAdapter, [plan, { ...plan, id: 'missing-plan', recipeId: 'missing' }],
    'atomic-plan'), errorCode('INVALID_INPUT'));
  assert.deepEqual(await store.exportSnapshot('alice'), before);
  await nativeImport(mealPlanImportAdapter, [plan], 'valid-plan');
  assert.deepEqual((await store.exportSnapshot('alice')).state.plan, [plan]);
  assert.deepEqual((await store.exportSnapshot('alice')).state.training.scheduledDates, []);
});

test('food logs preserve orphan snapshot links and per-serving values while enforcing one log per plan atomically', async () => {
  const food = { id: 'food', date: '2001-01-01', slot: 'dinner' as const, name: 'Historical soup',
    recipeId: 'deleted-recipe', planEntryId: 'deleted-plan', servings: 3,
    nutrition: { calories: 100, protein: 0, carbs: 20, fat: 0 } };
  await nativeImport(foodLogImportAdapter, [food], 'historical-food');
  const before = await store.exportSnapshot('alice');
  const { createdAt, ...saved } = before.state.logs[0];
  assert.ok(createdAt);
  assert.deepEqual(saved, food);
  const window = await store.foodWindow('alice', { from: food.date, through: food.date, limit: 50 });
  assert.equal(window.totals.calories, 300);
  assert.equal(window.totals.protein, 0);
  await assert.rejects(nativeImport(foodLogImportAdapter, [
    { ...food, id: 'unlinked-food', planEntryId: undefined },
    { ...food, id: 'duplicate-food' },
  ], 'duplicate-plan-food'), errorCode('DESTINATION_CONFLICT'));
  assert.deepEqual(await store.exportSnapshot('alice'), before);
  assert.deepEqual(inspectImport(before.state).state, before.state);
});

test('check-ins, explicit dates and exact grocery natural keys survive recovery and tombstones', async () => {
  const checkIn = { id: 'recovery', date: '2000-01-01', bodyWeight: null, waist: null,
    sleepHours: 0, energy: null, soreness: null, boxingQuality: null, notes: '' };
  await nativeImport(checkInImportAdapter, [checkIn], 'check-in-zero');
  await nativeImport(scheduledDateImportAdapter, [{ date: '1999-12-31' }], 'explicit-date');
  const key = ' Épicerie | 豆腐 '.padEnd(500, ' ');
  await nativeImport(groceryCheckImportAdapter, [{ key, checked: false }], 'grocery-false');
  const snapshot = await store.exportSnapshot('alice');
  assert.deepEqual(snapshot.state.training.checkIns, [checkIn]);
  assert.deepEqual(snapshot.state.training.scheduledDates, ['1999-12-31']);
  assert.equal(Object.keys(snapshot.state.groceryChecks)[0], key);
  assert.equal(snapshot.state.groceryChecks[key], false);
  const connection = await database.connect();
  try {
    await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await validatePersistedRecords(connection, (await connection.query('SELECT current_schema() AS schema')).rows[0].schema);
    await connection.query('ROLLBACK');
  } finally { connection.release(); }
  await store.replaceImport('bob', 'recover-native', snapshot.state, 0);
  assert.deepEqual((await store.exportSnapshot('bob')).state, snapshot.state);
  assert.equal((await nativeImport(groceryCheckImportAdapter, [{ key, checked: false }], 'recovered-retry', 'bob')).outcomes[0].outcome, 'skipped');
  await database.query('DELETE FROM workspace_grocery_checks WHERE user_id = $1', ['bob']);
  assert.equal((await nativeImport(groceryCheckImportAdapter, [{ key, checked: false }], 'deleted-retry', 'bob')).outcomes[0].outcome, 'skipped');
  await assert.rejects(nativeImport(groceryCheckImportAdapter, [{ key, checked: true }], 'changed-grocery', 'bob'), errorCode('SOURCE_CONFLICT'));
  const otherSource = { operationId: 'other-source', expectedRevision: (await store.exportSnapshot('alice')).revision,
    sourceNamespace: 'other', records: [{ sourceRecordId: 'another', record: { key, checked: false } }] };
  await assert.rejects(store.delegatedImport({ ...access, scopes: ['grocery-checks:import'] }, 'grocery-checks:import',
    'import_grocery_checks', otherSource, otherSource.operationId, otherSource.expectedRevision,
    otherSource.sourceNamespace, otherSource.records, groceryCheckImportAdapter), errorCode('DESTINATION_CONFLICT'));
});

test('native natural-key occupancy conflicts without normalization, implicit dates or source claims', async () => {
  const state = createInitialState();
  const key = ' native | café ';
  state.groceryChecks[key] = false;
  state.training.scheduledDates = ['2000-01-01'];
  await store.replaceImport('alice', 'native-occupancy', state, 0);
  const before = await store.exportSnapshot('alice');
  await assert.rejects(nativeImport(groceryCheckImportAdapter, [
    { key: 'new-checkbox', checked: true }, { key, checked: false },
  ], 'occupied-grocery'), errorCode('DESTINATION_CONFLICT'));
  await assert.rejects(nativeImport(scheduledDateImportAdapter, [
    { date: '2000-01-02' }, { date: '2000-01-01' },
  ], 'occupied-date'), errorCode('DESTINATION_CONFLICT'));
  assert.deepEqual(await store.exportSnapshot('alice'), before);
  for (const key of ['__proto__', 'prototype', 'constructor', 'x'.repeat(501)]) {
    await assert.rejects(nativeImport(groceryCheckImportAdapter, [{ key, checked: true }], `bad-${key.slice(0, 20)}`), z.ZodError);
  }
  const invalidPlan = { ...workout('unknown-plan'), status: 'planned' as const };
  await assert.rejects(direct(args('unknown-plan', 1, [invalidPlan])), z.ZodError);
  assert.deepEqual(await store.exportSnapshot('alice'), before);
});

test('new import boundaries reject unsupported nested nutrition and ingredient facts before create or skip', async () => {
  const unsupportedRecipes = [
    { ...nativeRecipe, nutrition: { ...nativeRecipe.nutrition, sodium: 42 } },
    { ...nativeRecipe, ingredients: [{ ...nativeRecipe.ingredients[0], brand: 'Source fact' }] },
  ];
  const food = { id: 'food-strict', date: '2001-01-01', slot: 'dinner' as const,
    name: 'Recorded soup', servings: 2, nutrition: { calories: 100, protein: 0, carbs: 20, fat: 0 } };
  const unsupportedFood = { ...food, nutrition: { ...food.nutrition, sodium: 42 } };
  const empty = await store.exportSnapshot('alice');
  for (const [index, recipe] of unsupportedRecipes.entries())
    await assert.rejects(nativeImport(recipeImportAdapter, [recipe], `unsupported-recipe-first-${index}`), z.ZodError);
  await assert.rejects(nativeImport(foodLogImportAdapter, [unsupportedFood], 'unsupported-food-first'), z.ZodError);
  assert.deepEqual(await store.exportSnapshot('alice'), empty);
  await nativeImport(recipeImportAdapter, [nativeRecipe], 'strict-recipe-valid');
  await nativeImport(foodLogImportAdapter, [food], 'strict-food-valid');
  const beforeChangedFacts = await store.exportSnapshot('alice');
  for (const [index, recipe] of unsupportedRecipes.entries())
    await assert.rejects(nativeImport(recipeImportAdapter, [recipe], `unsupported-recipe-later-${index}`), z.ZodError);
  await assert.rejects(nativeImport(foodLogImportAdapter, [unsupportedFood], 'unsupported-food-later'), z.ZodError);
  assert.deepEqual(await store.exportSnapshot('alice'), beforeChangedFacts);
});

test('recovered native-ID tombstones cannot reserve a whitespace alias and cannot be reused by another source', async () => {
  const tombstone = {
    sourceNamespace: 'archive', recordType: 'workouts' as const, sourceRecordId: 'deleted-history',
    sourceFingerprint: fingerprint(workout()), destinationId: ' history ',
  };
  const recovery = createInitialState();
  recovery.importSources = [tombstone];
  await assert.rejects(store.replaceImport('alice', 'reject-padded-tombstone', recovery, 0), z.ZodError);
  assert.equal((await store.exportSnapshot('alice')).revision, 0);
  assert.equal(await store.isEmpty('alice'), true);
  recovery.importSources = [{ ...tombstone, destinationId: 'history' }];
  await store.replaceImport('alice', 'recover-canonical-tombstone', recovery, 0);
  const recovered = await store.exportSnapshot('alice');
  assert.equal(recovered.state.importSources[0].destinationId, 'history');
  assert.deepEqual(recovered.state.training.sessions, []);
  await assert.rejects(direct(args('different-source-after-recovery', recovered.revision)), errorCode('DESTINATION_CONFLICT'));
  assert.deepEqual(await store.exportSnapshot('alice'), recovered);
});
