import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/store.js';
import { PlanningAgent, buildContext, type InferenceProvider } from '../src/planning-agent.js';
import { proposalMutations, type AgentResult } from '@corner/shared/agent';
import { createInitialState } from '@corner/shared/seed';
import type { Recipe } from '@corner/shared/types';

const at = '2026-10-22T12:00:00.000Z';
const date = '2026-10-22';
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
function fixture(respond: InferenceProvider['respond']) {
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db);
  const agent = new PlanningAgent(store, { respond });
  return { db, store, agent };
}

test('a completed proposal is private and changes nothing until Apply; applying twice is safe', async () => {
  let calls = 0;
  const { db, store, agent } = fixture(async () => { calls++; return completed(proposal()); });
  try {
    const run = agent.start('alice', { requestId: 'request-one', prompt: 'Plan one breakfast.', referenceDate: date });
    assert.equal(run.status, 'running');
    await agent.settled(run.id);
    assert.equal(agent.get('alice', run.id).status, 'completed');
    assert.equal(store.read('alice').state.recipes.length, 0);
    assert.throws(() => agent.get('bob', run.id), /not found/);
    assert.equal(agent.list('bob').length, 0);
    const saved = agent.apply('alice', run.id, 'apply-one');
    assert.equal(saved.state.recipes.length, 1);
    assert.equal(saved.state.plan.length, 1);
    assert.equal(saved.state.logs.length, 0);
    assert.equal(saved.state.training.sessions.length, 0);
    assert.equal(saved.run.status, 'applied');
    assert.equal(agent.apply('alice', run.id, 'apply-two').revision, saved.revision);
    assert.equal(store.read('bob').state.recipes.length, 0);
    assert.equal(calls, 1);
  } finally { await agent.close(); db.close(); }
});

test('idempotent requests replay one result and reject reuse for a different prompt', async () => {
  let calls = 0;
  const { db, agent } = fixture(async () => { calls++; return completed({ status: 'needs_details', title: 'Your schedule', message: 'How much time do you have?', questions: ['Which days and how many minutes can you train?'], changes: [] }); });
  try {
    const input = { requestId: 'request-one', prompt: 'Build my training plan.', referenceDate: date };
    const first = agent.start('alice', input);
    const replay = agent.start('alice', input);
    assert.equal(replay.id, first.id);
    await agent.settled(first.id);
    assert.equal(agent.start('alice', input).status, 'completed');
    assert.equal(calls, 1);
    assert.throws(() => agent.start('alice', { ...input, prompt: 'A different request' }), /different request/);
    assert.throws(() => agent.apply('alice', first.id, 'apply-one'), /no changes/);
  } finally { await agent.close(); db.close(); }
});

test('a workspace edit makes a prior proposal stale without partially applying it', async () => {
  const { db, store, agent } = fixture(async () => completed(proposal()));
  try {
    const run = agent.start('alice', { requestId: 'request-one', prompt: 'Plan breakfast.', referenceDate: date });
    await agent.settled(run.id);
    store.mutate('alice', 'manual-change', { type: 'grocery.check', data: { key: 'oats|g', checked: true } });
    assert.throws(() => agent.apply('alice', run.id, 'apply-one'), /workspace changed/);
    assert.equal(store.read('alice').state.recipes.length, 0);
    assert.equal(store.read('alice').state.groceryChecks['oats|g'], true);
  } finally { await agent.close(); db.close(); }
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
  const { db, store, agent } = fixture(async (_user, input) => {
    calls++;
    assert.equal(input.tools?.[0].type, 'namespace');
    return completed({ result: { status: 'needs_details', questions: ['How large was the bowl, and what ingredients were in it?'] } });
  });
  try {
    const input = { requestId: 'food-one', description: 'A bowl of curry' };
    const result = await agent.estimateFood('alice', input);
    assert.equal((result.estimate as any).status, 'needs_details');
    await agent.estimateFood('alice', input);
    assert.equal(calls, 1);
    assert.equal(store.read('alice').state.logs.length, 0);
  } finally { await agent.close(); db.close(); }
});

test('recipe generation returns a draft tied to the requesting account and stays unsaved', async () => {
  const { id, color, source, favorite, createdAt, ...draft } = recipe();
  const { db, store, agent } = fixture(async (user, input) => {
    assert.equal(user, 'alice');
    assert.ok(input.instructions.includes('ONE serving'));
    return completed(draft);
  });
  try {
    const result = await agent.generateRecipe('alice', { requestId: 'recipe-one', prompt: 'A quick yogurt breakfast.', calories: 400, protein: 25, maxMinutes: 10 });
    assert.equal((result.recipe as Recipe).source, 'ai');
    assert.equal(result.draft, true);
    assert.equal(store.read('alice').state.recipes.length, 0);
  } finally { await agent.close(); db.close(); }
});

test('cancelled runs cannot complete later and another owner cannot cancel them', async () => {
  let resolve!: (value: unknown) => void;
  const response = new Promise(resolveValue => { resolve = resolveValue; });
  const { db, agent } = fixture(async () => response);
  try {
    const run = agent.start('alice', { requestId: 'request-one', prompt: 'Plan breakfast.', referenceDate: date });
    assert.throws(() => agent.cancel('bob', run.id), /not found/);
    assert.equal(agent.cancel('alice', run.id).status, 'cancelled');
    resolve(completed(proposal()));
    await agent.settled(run.id);
    assert.equal(agent.get('alice', run.id).status, 'cancelled');
  } finally { await agent.close(); db.close(); }
});

test('tool reads use the account snapshot and unsupported functions cannot execute', async () => {
  let calls = 0;
  const { db, store, agent } = fixture(async (_user, input) => {
    calls++;
    if (calls === 1) return { status: 'completed', output: [{ type: 'function_call', namespace: 'corner', name: 'shell', arguments: '{}', call_id: 'bad-call' }] };
    const result = input.input.find(item => item.type === 'function_call_output');
    assert.match(result.output, /unavailable/);
    assert.equal(JSON.stringify(input.input).includes('Bob secret preference'), false);
    return completed({ status: 'answer', title: 'Choose familiar exercises', message: 'Use the equipment and experience you have supplied.', questions: [], changes: [] });
  });
  try {
    const bob = createInitialState('Bob');
    bob.settings.profile!.goals = 'Bob secret preference';
    store.mutate('bob', 'bob-settings', { type: 'settings.save', data: bob.settings });
    const run = agent.start('alice', { requestId: 'request-one', prompt: 'Help with my training.', referenceDate: date });
    await agent.settled(run.id);
    assert.equal(agent.get('alice', run.id).status, 'completed');
    assert.equal(calls, 2);
  } finally { await agent.close(); db.close(); }
});

test('context records incomplete days honestly and includes no fabricated intake', () => {
  const state = createInitialState('Casey');
  const context = buildContext(state, date);
  assert.deepEqual(context.recentHistory.nutrition, []);
  assert.match(context.recentHistory.note, /not zero intake/);
  assert.equal(context.settings.name, 'Casey');
  assert.equal(JSON.stringify(context).includes('Adam'), false);
});
