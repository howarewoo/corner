import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createInitialState } from '@packages/workspace/initial-state';
import type { WorkoutSession } from '@packages/training/types';
import type { DelegatedAccess } from '../delegation.js';
import { registerTrainingWrites } from '../mcp-training.js';
import { WorkspaceStore } from '../store.js';
import type { Database } from '../queries.js';
import * as schema from '../schema.js';
import { testDatabase, closeTestDatabase } from '../../tests/helpers.ts';

let database: Pool;
let store: WorkspaceStore;
const resources: Array<{ client: Client; server: McpServer }> = [];
const access: DelegatedAccess = { ownerId: 'alice', clientId: 'client', grantId: 'grant', scopes: ['routines:write', 'workout-plans:write', 'workout-history:write'] };
const timestamp = '2026-10-28T12:00:00.000Z';
const plan = { id: 'plan', date: '2026-10-28', name: 'Walk', kind: 'conditioning', unit: 'kg', exercises: [], plannedMinutes: 30, notes: 'Keep this', changeReason: '' };
const recorded: WorkoutSession = { ...plan, id: 'history', kind: 'conditioning', unit: 'kg', status: 'completed', durationMinutes: 28, rounds: null, sessionRpe: 5, readiness: 3, createdAt: timestamp, updatedAt: timestamp };
const routine = { id: 'routine', name: 'Walk routine', kind: 'conditioning', description: 'Keep description', durationMinutes: 30, exercises: [] };
beforeEach(async () => {
  database = await testDatabase();
  store = new WorkspaceStore(drizzle({ client: database, schema }) as Database);
  const state = createInitialState();
  state.training.sessions = [recorded];
  await store.replaceImport('alice', 'seed-alice', state, 0);
});
afterEach(async () => {
  for (const { client, server } of resources.splice(0)) { await client.close(); await server.close(); }
  await closeTestDatabase(database);
});
async function connect(identity = access) {
  let original: unknown;
  const server = new McpServer({ name: 'training-test', version: '1.0.0' });
  registerTrainingWrites(server, store, identity, () => original);
  const client = new Client({ name: 'writer', version: '1.0.0' });
  resources.push({ client, server });
  const [consumer, resource] = InMemoryTransport.createLinkedPair();
  await server.connect(resource); await client.connect(consumer);
  return async (name: string, args: Record<string, unknown>) => {
    original = structuredClone(args);
    return client.callTool({ name, arguments: args });
  };
}
function code(result: unknown) {
  assert.ok(result && typeof result === 'object' && 'structuredContent' in result);
  const content = result.structuredContent;
  return content && typeof content === 'object' && 'code' in content ? content.code : undefined;
}

test('routine creation and partial edits never rewrite workout snapshots, and raw requests replay exactly', async () => {
  const write = await connect();
  const original = { operationId: 'routine-create', expectedRevision: 1, routine: { ...routine, name: ' Walk routine ' } };
  assert.deepEqual((await write('create_routine', original)).structuredContent, { revision: 2 });
  assert.equal(code(await write('create_routine', { ...original, operationId: 'duplicate', expectedRevision: 2 })), 'ALREADY_EXISTS');
  assert.deepEqual((await write('update_routine', { operationId: 'routine-edit', expectedRevision: 2, id: 'routine', patch: { name: 'Changed' } })).structuredContent, { revision: 3 });
  assert.deepEqual((await write('create_routine', original)).structuredContent, { revision: 2 });
  assert.equal(code(await write('create_routine', { ...original, routine })), 'REQUEST_ID_REUSED');
  const snapshot = await store.exportSnapshot('alice');
  assert.equal(snapshot.state.training.templates[0]!.description, routine.description);
  assert.deepEqual(snapshot.state.training.sessions, [recorded]);
  assert.equal(code(await write('update_routine', { operationId: 'missing-routine', expectedRevision: 3, id: 'missing', patch: { name: 'Changed' } })), 'NOT_FOUND');
});

test('plans distinguish create and missing updates, retain omitted fields and enforce both revision tokens', async () => {
  const write = await connect();
  assert.deepEqual((await write('edit_workout_plans', { operationId: 'plan-create', expectedRevision: 1, changes: [{ action: 'create', entry: plan }] })).structuredContent, { revision: 2 });
  const saved = (await store.exportSnapshot('alice')).state.training.sessions.find((item) => item.id === 'plan')!;
  const edit = { operationId: 'plan-edit', expectedRevision: 2, changes: [{ action: 'update', id: 'plan', expectedUpdatedAt: saved.updatedAt, patch: { plannedMinutes: 45 } }] };
  assert.deepEqual((await write('edit_workout_plans', edit)).structuredContent, { revision: 3 });
  assert.equal(code(await write('edit_workout_plans', { ...edit, operationId: 'stale-workspace' })), 'REVISION_CONFLICT');
  assert.equal(code(await write('edit_workout_plans', { ...edit, operationId: 'stale-record', expectedRevision: 3 })), 'RECORD_CONFLICT');
  const updated = (await store.exportSnapshot('alice')).state.training.sessions.find((item) => item.id === 'plan')!;
  assert.equal(updated.notes, plan.notes); assert.equal(updated.plannedMinutes, 45);
  assert.equal(updated.status, 'planned'); assert.equal(updated.durationMinutes, null);
  assert.equal(code(await write('edit_workout_plans', { operationId: 'duplicate-plan', expectedRevision: 3, changes: [{ action: 'create', entry: plan }] })), 'ALREADY_EXISTS');
  assert.equal(code(await write('edit_workout_plans', { operationId: 'missing-plan', expectedRevision: 3, changes: [{ action: 'update', id: 'missing', expectedUpdatedAt: timestamp, patch: { notes: 'x' } }] })), 'NOT_FOUND');
});

test('atomic planning rejects authoritative started and recorded actuals and rolls back earlier members and receipts', async () => {
  const write = await connect();
  const request = { operationId: 'rollback-plans', expectedRevision: 1, changes: [{ action: 'create', entry: plan }, { action: 'update', id: 'history', expectedUpdatedAt: timestamp, patch: { notes: 'overwrite' } }] };
  assert.equal(code(await write('edit_workout_plans', request)), 'HISTORY_PROTECTED');
  assert.deepEqual((await store.exportSnapshot('alice')).state.training.sessions, [recorded]);
  assert.equal((await store.exportSnapshot('alice')).revision, 1);
  assert.deepEqual((await write('edit_workout_plans', { ...request, changes: request.changes.slice(0, 1) })).structuredContent, { revision: 2 });
  await store.mutate('alice', 'seed-started', { type: 'training.session.save', data: {
    session: { ...recorded, id: 'started', status: 'in_progress', durationMinutes: null, sessionRpe: null, readiness: null }, expectedUpdatedAt: null,
  } });
  await store.mutate('alice', 'seed-imported-actual', { type: 'training.session.save', data: {
    session: { ...recorded, id: 'imported-actual', status: 'planned', sessionRpe: null, readiness: null }, expectedUpdatedAt: null,
  } });
  const snapshot = await store.exportSnapshot('alice');
  for (const id of ['started', 'imported-actual']) {
    const saved = snapshot.state.training.sessions.find((session) => session.id === id)!;
    assert.equal(code(await write('edit_workout_plans', { operationId: 'protect-' + id, expectedRevision: snapshot.revision, changes: [{ action: 'update', id, expectedUpdatedAt: saved.updatedAt, patch: { plannedMinutes: 10 } }] })), 'HISTORY_PROTECTED');
  }
});

test('history correction preserves completed lifecycle, creation timestamps, omitted actuals and record concurrency', async () => {
  const write = await connect();
  const args = { operationId: 'history-edit', expectedRevision: 1, id: 'history', expectedUpdatedAt: timestamp, patch: { durationMinutes: 32, notes: 'Corrected' } };
  assert.deepEqual((await write('update_workout_history', args)).structuredContent, { revision: 2 });
  const saved = (await store.exportSnapshot('alice')).state.training.sessions[0]!;
  assert.equal(saved.status, 'completed'); assert.equal(saved.sessionRpe, 5); assert.equal(saved.readiness, 3);
  assert.equal(saved.createdAt, timestamp); assert.notEqual(saved.updatedAt, timestamp);
  assert.equal(code(await write('update_workout_history', { ...args, operationId: 'history-stale', expectedRevision: 2 })), 'RECORD_CONFLICT');
  assert.equal(code(await write('update_workout_history', { ...args, operationId: 'history-missing', expectedRevision: 2, id: 'missing' })), 'NOT_FOUND');
  assert.equal((await write('update_workout_history', { ...args, operationId: 'history-reset', expectedRevision: 2, expectedUpdatedAt: saved.updatedAt, patch: { status: 'planned' } })).isError, true);
  assert.equal((await store.exportSnapshot('alice')).revision, 2);
});

test('permissions remain independent, owner scoped, and revoked scope is checked before replay', async () => {
  const granted = ['workout-history:write'];
  const write = await connect({ ...access, scopes: granted });
  const args = { operationId: 'history-permission', expectedRevision: 1, id: 'history', expectedUpdatedAt: timestamp, patch: { notes: 'Corrected' } };
  assert.equal((await write('create_routine', { operationId: 'no-routine', expectedRevision: 1, routine })).isError, true);
  assert.deepEqual((await write('update_workout_history', args)).structuredContent, { revision: 2 });
  granted.splice(0);
  assert.equal(code(await write('update_workout_history', args)), 'INSUFFICIENT_SCOPE');
  const outsider = await connect({ ...access, ownerId: 'bob' });
  assert.equal(code(await outsider('update_workout_history', { ...args, expectedRevision: 0 })), 'NOT_FOUND');
  assert.equal((await store.exportSnapshot('bob')).revision, 0);
  const anotherGrant = await connect({ ...access, grantId: 'another-grant' });
  assert.equal(code(await anotherGrant('update_workout_history', args)), 'REVISION_CONFLICT');
});

test('owner lock applies concurrent exact retries once and rejects competing stale planning', async () => {
  const first = await connect(); const second = await connect();
  const args = { operationId: 'concurrent-create', expectedRevision: 1, changes: [{ action: 'create', entry: plan }] };
  const retries = await Promise.all([first('edit_workout_plans', args), second('edit_workout_plans', args)]);
  assert.deepEqual(retries.map((result) => result.structuredContent), [{ revision: 2 }, { revision: 2 }]);
  const saved = (await store.exportSnapshot('alice')).state.training.sessions.find((item) => item.id === 'plan')!;
  const edits = await Promise.all([first('edit_workout_plans', { operationId: 'competing-one', expectedRevision: 2, changes: [{ action: 'update', id: 'plan', expectedUpdatedAt: saved.updatedAt, patch: { notes: 'one' } }] }), second('edit_workout_plans', { operationId: 'competing-two', expectedRevision: 2, changes: [{ action: 'update', id: 'plan', expectedUpdatedAt: saved.updatedAt, patch: { notes: 'two' } }] })]);
  assert.equal(edits.filter((result) => code(result) === 'REVISION_CONFLICT').length, 1);
});
