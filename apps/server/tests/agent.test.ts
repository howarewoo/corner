import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg'; import { testDatabase, closeTestDatabase, createTestAuth, neonTestConfig } from './helpers.ts'
import { WorkspaceStore } from '../src/store.js';
import { PlanningAgent, buildContext, type InferenceProvider } from '../src/planning-agent.js';
import { proposalMutations, type AgentResult, type AgentRun } from '@corner/shared/agent';
import { createInitialState } from '@corner/shared/seed';
import type { AppState, Recipe } from '@corner/shared/types';

const at = '2026-10-22T12:00:00.000Z';
const date = '2026-10-22';
const dateMs = Date.parse('2026-10-20T12:00:00.000Z');
/** What PlanningAgent.apply resolves: the workspace snapshot plus the run state. */
type ApplyResult = { state: AppState; revision: number; run: AgentRun };
function recipe(id = 'recipe-one'): Recipe {
  return {
    id, name: 'Yogurt and oats', description: 'One serving.', category: 'breakfast', prepMinutes: 5, cookMinutes: 0,
    nutrition: { calories: 400, protein: 25, carbs: 57, fat: 8 },
    ingredients: [{ name: 'Greek yogurt', quantity: 250, unit: 'g', shoppingQuantity: 250, shoppingUnit: 'g', aisle: 'Dairy' }],
    steps: ['Spoon into a bowl.'], storage: 'Keep refrigerated.', variation: 'Add berries.', tags: [], color: '#d9e8de', source: 'ai', favorite: false, createdAt: at,
  };
}
function proposal(): AgentResult {
  return {
    status: 'proposal', title: 'One breakfast', message: 'A breakfast option to review.', questions: [],
    changes: [
      { type: 'meal', label: 'Thursday breakfast', reason: 'Fits the requested date.', data: { id: 'meal-one', date, slot: 'breakfast', recipeId: 'recipe-one', servings: 1 } },
      { type: 'recipe', label: 'Yogurt and oats', reason: 'A simple option.', data: recipe() },
    ],
  };
}
const completed = (result: unknown) => ({ status: 'completed', output: [{ type: 'function_call', namespace: 'corner', name: 'submit_result', call_id: 'call-one', arguments: JSON.stringify(result) }] });
async function fixture(respond: InferenceProvider['respond']) {
  const db = await testDatabase();
  const store = new WorkspaceStore(db);
  const agent = new PlanningAgent(store, { respond });
  await agent.initialize();
  return { db, store, agent };
}

test('a completed proposal is private and changes nothing until Apply; applying twice is safe', async () => {
  let calls = 0;
  const { db, store, agent } = (await fixture(async () => { calls++; return completed(proposal()); }));
  try {
    const run = (await agent.start('alice', { requestId: 'request-one', prompt: 'Plan one breakfast.', referenceDate: date }));
    assert.equal(run.status, 'running');
    await agent.settled(run.id);
    assert.equal((await agent.get('alice', run.id)).status, 'completed');
    assert.equal((await store.read('alice')).state.recipes.length, 0);
    await assert.rejects(async () => (await agent.get('bob', run.id)), /not found/);
    assert.equal((await agent.list('bob')).length, 0);
    const saved = (await agent.apply('alice', run.id, 'apply-one'));
    assert.equal(saved.state.recipes.length, 1);
    assert.equal(saved.state.plan.length, 1);
    assert.equal(saved.state.logs.length, 0);
    assert.equal(saved.state.training.sessions.length, 0);
    assert.equal(saved.run.status, 'applied');
    assert.equal((await agent.apply('alice', run.id, 'apply-two')).revision, saved.revision);
    assert.equal((await store.read('bob')).state.recipes.length, 0);
    assert.equal(calls, 1);
  } finally { await agent.close(); await closeTestDatabase(db); }
});

test('idempotent requests replay one result and reject reuse for a different prompt', async () => {
  let calls = 0;
  const { db, agent } = (await fixture(async () => { calls++; return completed({ status: 'needs_details', title: 'Your schedule', message: 'How much time do you have?', questions: ['Which days and how many minutes can you train?'], changes: [] }); }));
  try {
    const input = { requestId: 'request-one', prompt: 'Build my training plan.', referenceDate: date };
    const first = (await agent.start('alice', input));
    const replay = (await agent.start('alice', input));
    assert.equal(replay.id, first.id);
    await agent.settled(first.id);
    assert.equal((await agent.start('alice', input)).status, 'completed');
    assert.equal(calls, 1);
    await assert.rejects(async () => (await agent.start('alice', { ...input, prompt: 'A different request' })), /different request/);
    await assert.rejects(async () => (await agent.apply('alice', first.id, 'apply-one')), /no changes/);
  } finally { await agent.close(); await closeTestDatabase(db); }
});

test('a workspace edit makes a prior proposal stale without partially applying it', async () => {
  const { db, store, agent } = (await fixture(async () => completed(proposal())));
  try {
    const run = (await agent.start('alice', { requestId: 'request-one', prompt: 'Plan breakfast.', referenceDate: date }));
    await agent.settled(run.id);
    (await store.mutate('alice', 'manual-change', { type: 'grocery.check', data: { key: 'oats|g', checked: true } }));
    await assert.rejects(async () => (await agent.apply('alice', run.id, 'apply-one')), /workspace changed/);
    assert.equal((await store.read('alice')).state.recipes.length, 0);
    assert.equal((await store.read('alice')).state.groceryChecks['oats|g'], true);
  } finally { await agent.close(); await closeTestDatabase(db); }
});

test('a concurrent Apply that commits first makes the other Apply replay instead of reporting stale', async () => {
  const { db, store, agent } = (await fixture(async () => completed(proposal())));
  // Test determinism parks one call inside the public WorkspaceStore surface.
  const parkedStore = store as unknown as { read: WorkspaceStore['read'] };
  const originalRead = store.read.bind(store);
  try {
    const run = (await agent.start('alice', { requestId: 'request-one', prompt: 'Plan breakfast.', referenceDate: date }));
    await agent.settled(run.id);
    // Park the first Apply's workspace snapshot read after its completed-run read
    // so the other Apply commits state, receipt and run status during the stall.
    let enteredStall: (() => void) | undefined;
    const entered = new Promise<void>(enter => { enteredStall = enter; });
    let releaseStall: (() => void) | undefined;
    const parked = new Promise<void>(release => { releaseStall = release; });
    let stalledOnce = false;
    parkedStore.read = (...args: Parameters<WorkspaceStore['read']>) => {
      if (!stalledOnce) { stalledOnce = true; enteredStall?.(); return parked.then(() => originalRead(...args)); }
      return originalRead(...args);
    };
    let first: Promise<ApplyResult> | undefined;
    try {
      first = agent.apply('alice', run.id, 'apply-first');
      await entered;
      const second = (await agent.apply('alice', run.id, 'apply-second'));
      releaseStall?.();
      const saved = (await first);
      assert.equal(saved.revision, second.revision);
      assert.equal(saved.revision, run.baseRevision + 1);
      assert.deepEqual(saved.state, second.state);
      assert.equal(saved.run.status, 'applied');
      assert.equal(saved.run.id, run.id);
      assert.equal((await store.read('alice')).state.recipes.length, 1);
      assert.equal((await store.read('alice')).state.plan.length, 1);
      assert.equal((await store.read('alice')).state.logs.length, 0);
    } finally {
      // Release and settle the parked continuation so teardown never races it.
      releaseStall?.();
      parkedStore.read = originalRead;
      await first?.catch(() => { /* rejection already reported above or by the test run */ });
    }
  } finally { await agent.close(); await closeTestDatabase(db); }
});

test('duplicated applies racing past one revision read share one receipt and both replay the commit', async () => {
  const { db, store, agent } = (await fixture(async () => completed(proposal())));
  // Test determinism parks one call inside the public WorkspaceStore surface.
  const parkedStore = store as unknown as { applyBatch: WorkspaceStore['applyBatch'] };
  const originalApplyBatch = store.applyBatch.bind(store);
  const timers = mock.timers;
  try {
    const run = (await agent.start('alice', { requestId: 'request-one', prompt: 'Plan breakfast.', referenceDate: date }));
    await agent.settled(run.id);
    // The first Apply saw a matching revision but parks before its commit runs;
    // the other Apply commits, and the resumed commit must replay the receipt
    // instead of rejecting the identical payload, so stamps come from the run.
    // A mocked clock keeps the two applies' (unused on the fixed build)
    // wall-clock stamps apart regardless of one-millisecond coincidence.
    let enteredStall: (() => void) | undefined;
    const entered = new Promise<void>(enter => { enteredStall = enter; });
    let releaseStall: (() => void) | undefined;
    const parked = new Promise<void>(release => { releaseStall = release; });
    let stalledOnce = false;
    timers.enable({ apis: ['Date'], now: dateMs });
    parkedStore.applyBatch = (...args: Parameters<WorkspaceStore['applyBatch']>) => {
      if (!stalledOnce) { stalledOnce = true; enteredStall?.(); return parked.then(() => originalApplyBatch(...args)); }
      return originalApplyBatch(...args);
    };
    let first: Promise<ApplyResult> | undefined;
    try {
      first = agent.apply('alice', run.id, 'apply-first');
      await entered;
      timers.tick(5); // advances the mock between the two mutation stamps
      const second = (await agent.apply('alice', run.id, 'apply-second'));
      releaseStall?.();
      const saved = (await first);
      assert.equal(saved.revision, second.revision);
      assert.equal(saved.revision, run.baseRevision + 1);
      assert.deepEqual(saved.state, second.state);
      assert.equal(saved.run.status, 'applied');
      assert.equal((await store.read('alice')).state.recipes.length, 1);
      assert.equal((await store.read('alice')).state.plan.length, 1);
    } finally {
      // Release and settle the parked commit so teardown never races it.
      releaseStall?.();
      parkedStore.applyBatch = originalApplyBatch;
      await first?.catch(() => { /* rejection already reported above or by the test run */ });
    }
  } finally { timers.reset(); await agent.close(); await closeTestDatabase(db); }
});

test('the proposal whitelist rejects actual food intake and completed workout data', () => {
  const state = createInitialState();
  assert.throws(() => proposalMutations(state, { ...proposal(), changes: [{ type: 'log', label: 'Eat', reason: 'AI said so', data: {} }] }));
  const workout = {
    id: 'workout-one', date, name: 'Run', kind: 'conditioning', status: 'completed', unit: 'lb', exercises: [], plannedMinutes: 20,
    durationMinutes: 20, rounds: null, sessionRpe: 5, readiness: null, notes: '', changeReason: '', createdAt: at, updatedAt: at,
  };
  assert.throws(() => proposalMutations(state, { ...proposal(), changes: [{ type: 'workout', label: 'Run', reason: 'A planned run.', data: workout }] }), /cannot contain completed work/);
  assert.equal(state.logs.length, 0);
  assert.equal(state.training.sessions.length, 0);
});

test('planned workouts cannot overwrite started history or use invented catalog IDs', () => {
  const state = createInitialState();
  const session = { id: 'workout-one', date, name: 'Run', kind: 'conditioning' as const, status: 'in_progress' as const, unit: 'kg' as const, exercises: [], plannedMinutes: 20, durationMinutes: 8, rounds: null, sessionRpe: null, readiness: null, notes: 'Started', changeReason: '', createdAt: at, updatedAt: at };
  state.training.sessions.push(session);
  assert.throws(() => proposalMutations(state, { ...proposal(), changes: [{ type: 'remove_workout', label: 'Remove run', reason: 'Reschedule.', data: { id: session.id } }] }), /started/);
  const routine = { id: 'routine-one', name: 'Upper', kind: 'strength', description: '', durationMinutes: 30, createdAt: at, updatedAt: at,
    exercises: [{ id: 'press', name: 'Press', catalogId: 'not-a-real-id', loadType: 'total', targetSets: 2, repMin: 8, repMax: 12, targetRir: 2, restSeconds: 90, notes: '' }] };
  assert.throws(() => proposalMutations(createInitialState(), { ...proposal(), changes: [{ type: 'routine', label: 'Upper', reason: 'Requested.', data: routine }] }), /unknown catalog/);
});

test('a bad reference prevents the whole proposal from being applied', () => {
  const state = createInitialState();
  const result = proposal();
  const meal = result.changes.find(change => change.type === 'meal')!;
  if (meal.type === 'meal') meal.data.recipeId = 'missing-recipe';
  assert.throws(() => proposalMutations(state, result), /recipe/);
  assert.equal(state.recipes.length, 0);
});

test('food estimation can ask for details and never writes a food log', async () => {
  let calls = 0;
  const { db, store, agent } = (await fixture(async (_user, input) => {
    calls++;
    assert.equal(input.tools?.[0].type, 'namespace');
    return completed({ result: { status: 'needs_details', questions: ['How large was the bowl, and what ingredients were in it?'] } });
  }));
  try {
    const input = { requestId: 'food-one', description: 'A bowl of curry' };
    const result = await agent.estimateFood('alice', input);
    assert.equal((result.estimate as any).status, 'needs_details');
    await agent.estimateFood('alice', input);
    assert.equal(calls, 1);
    assert.equal((await store.read('alice')).state.logs.length, 0);
  } finally { await agent.close(); await closeTestDatabase(db); }
});

test('recipe generation returns a draft tied to the requesting account and stays unsaved', async () => {
  const { id, color, source, favorite, createdAt, ...draft } = recipe();
  const { db, store, agent } = (await fixture(async (user, input) => {
    assert.equal(user, 'alice');
    assert.ok(input.instructions.includes('ONE serving'));
    return completed(draft);
  }));
  try {
    const result = await agent.generateRecipe('alice', { requestId: 'recipe-one', prompt: 'A quick yogurt breakfast.', calories: 400, protein: 25, maxMinutes: 10 });
    assert.equal((result.recipe as Recipe).source, 'ai');
    assert.equal(result.draft, true);
    assert.equal((await store.read('alice')).state.recipes.length, 0);
  } finally { await agent.close(); await closeTestDatabase(db); }
});

test('cancelled runs cannot complete later and another owner cannot cancel them', async () => {
  let resolve!: (value: unknown) => void;
  const response = new Promise(resolveValue => { resolve = resolveValue; });
  const { db, agent } = (await fixture(async () => response));
  try {
    const run = (await agent.start('alice', { requestId: 'request-one', prompt: 'Plan breakfast.', referenceDate: date }));
    await assert.rejects(async () => (await agent.cancel('bob', run.id)), /not found/);
    assert.equal((await agent.cancel('alice', run.id)).status, 'cancelled');
    resolve(completed(proposal()));
    await agent.settled(run.id);
    assert.equal((await agent.get('alice', run.id)).status, 'cancelled');
  } finally { await agent.close(); await closeTestDatabase(db); }
});

test('tool reads use the account snapshot and unsupported functions cannot execute', async () => {
  let calls = 0;
  const { db, store, agent } = (await fixture(async (_user, input) => {
    calls++;
    if (calls === 1) return { status: 'completed', output: [{ type: 'function_call', namespace: 'corner', name: 'shell', arguments: '{}', call_id: 'bad-call' }] };
    const result = input.input.find(item => item.type === 'function_call_output');
    assert.match(result.output, /unavailable/);
    assert.equal(JSON.stringify(input.input).includes('Bob secret preference'), false);
    return completed({ status: 'answer', title: 'Choose familiar exercises', message: 'Use the equipment and experience you have supplied.', questions: [], changes: [] });
  }));
  try {
    const bob = createInitialState('Bob');
    bob.settings.profile!.goals = 'Bob secret preference';
    (await store.mutate('bob', 'bob-settings', { type: 'settings.save', data: bob.settings }));
    const run = (await agent.start('alice', { requestId: 'request-one', prompt: 'Help with my training.', referenceDate: date }));
    await agent.settled(run.id);
    assert.equal((await agent.get('alice', run.id)).status, 'completed');
    assert.equal(calls, 2);
  } finally { await agent.close(); await closeTestDatabase(db); }
});

test('context records incomplete days honestly and includes no fabricated intake', () => {
  const state = createInitialState('Casey');
  const context = buildContext(state, date);
  assert.deepEqual(context.recentHistory.nutrition, []);
  assert.match(context.recentHistory.note, /not zero intake/);
  assert.equal(context.settings.name, 'Casey');
  assert.equal(JSON.stringify(context).includes('Adam'), false);
});
