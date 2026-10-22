import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createAuth } from '../src/auth.ts';
import { createApp } from '../src/app.ts';
import { createAIRouter, connectionDTO } from '../src/ai-routes.ts';
import { PlanningAgent, type InferenceProvider } from '../src/planning-agent.ts';
import { WorkspaceStore } from '../src/store.ts';
import type { Config } from '../src/config.ts';
import type { SubscriptionProvider, SubscriptionStatus } from '../src/subscription.ts';
import { createInitialState } from '@corner/shared/seed';
import type { AgentResult } from '@corner/shared/agent';
import type { Recipe } from '@corner/shared/types';
import type { WorkoutSession } from '@corner/shared/training-types';

const date = '2026-10-22';
const timestamp = `${date}T12:00:00.000Z`;
const config: Config = { origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000, dataDir: '/tmp', deployment: 'local', authSecret: 'unit-test-integration-auth-secret-more-than-32', tokenEncryptionKey: Buffer.alloc(32, 7) };
const completed = (result: unknown) => ({ status: 'completed', output: [{ type: 'function_call', namespace: 'corner', name: 'submit_result', call_id: 'test-call', arguments: JSON.stringify(result) }] });
const clarification: AgentResult = { status: 'needs_details', title: 'Your training schedule', message: 'A few details will help fit your plan.', questions: ['Which days are available for training?'], changes: [] };

function recipe(): Recipe {
  return { id: 'integration-recipe', name: 'Yogurt bowl', description: 'One serving.', category: 'breakfast', prepMinutes: 5, cookMinutes: 0, nutrition: { calories: 350, protein: 25, carbs: 42, fat: 9 }, ingredients: [{ name: 'Yogurt', quantity: 200, unit: 'g', shoppingQuantity: 200, shoppingUnit: 'g', aisle: 'Dairy' }], steps: ['Stir and serve.'], storage: 'Keep refrigerated.', variation: '', tags: [], source: 'ai', favorite: false, color: '#234b35', createdAt: timestamp };
}
function mealProposal(): AgentResult {
  return { status: 'proposal', title: 'A breakfast option', message: 'Review this recipe and planned breakfast.', questions: [], changes: [
    { type: 'recipe', label: 'Yogurt bowl', reason: 'A simple breakfast option.', data: recipe() },
    { type: 'meal', label: 'Breakfast', reason: 'Fits your requested day.', data: { id: 'integration-meal', date, slot: 'breakfast', recipeId: 'integration-recipe', servings: 1 } },
  ] };
}
function plannedWorkout(): WorkoutSession {
  return { id: 'integration-workout', date, name: 'Strength session', kind: 'strength', status: 'planned', unit: 'lb', plannedMinutes: 35, durationMinutes: null, rounds: null, sessionRpe: null, readiness: null, notes: '', changeReason: '', createdAt: timestamp, updatedAt: timestamp, exercises: [{ id: 'row-exercise', name: 'Dumbbell row', loadType: 'per_hand', targetSets: 1, repMin: 8, repMax: 12, targetRir: 2, targetLoad: { weight: 20, unit: 'lb' }, restSeconds: 90, notes: '', sets: [{ id: 'row-set', weight: null, reps: null, rir: null, completed: false, kind: 'working' }] }] };
}

describe('authenticated planning routes with fake inference only', { concurrency: false }, () => {
  let db: DatabaseSync;
  let store: WorkspaceStore;
  let agent: PlanningAgent;
  let app: ReturnType<typeof createApp>;
  let alice: { id: string; cookie: string };
  let bob: { id: string; cookie: string };
  let connected: boolean;
  let answer: InferenceProvider['respond'];
  let calls: Array<{ owner: string; input: unknown[] }>;

  async function send(path: string, options: { body?: unknown; cookie?: string; origin?: string | null; headers?: Record<string, string> } = {}) {
    const headers = new Headers({ 'x-corner-client-ip': '127.0.0.1', ...options.headers });
    if (options.cookie) headers.set('Cookie', options.cookie);
    if (options.origin !== null) headers.set('Origin', options.origin ?? config.origin);
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    return app(new Request(config.origin + path, { headers, method: options.body === undefined ? 'GET' : 'POST', ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }));
  }
  async function error(response: Response, status: number, code: string) {
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, code);
  }
  async function start(requestId: string, prompt = 'Help me plan a breakfast.') {
    const response = await send('/api/agent/runs', { cookie: alice.cookie, body: { requestId, prompt, referenceDate: date } });
    assert.equal(response.status, 202);
    return (await response.json()).run as { id: string };
  }
  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const auth = await createAuth(config, db);
    store = new WorkspaceStore(db);
    connected = true;
    calls = [];
    answer = async () => completed(clarification);
    const status = async (): Promise<SubscriptionStatus> => ({ supported: true, connected, planEnabled: connected, state: connected ? 'connected' : 'disconnected', account: null, model: connected ? 'mock-model' : null, models: [], message: connected ? 'Connected for this deterministic test.' : 'Connect your account.', manageUsageUrl: 'https://example.test/usage' });
    const provider = {
      status,
      respond: async (owner: string, request: Parameters<InferenceProvider['respond']>[1]) => {
        calls.push({ owner, input: structuredClone(request.input) });
        return answer(owner, request);
      },
    };
    agent = new PlanningAgent(store, provider);
    app = createApp({ config, auth, store, aiAvailable: async () => connectionDTO(await status()).available, extraRoute: createAIRouter(provider as unknown as SubscriptionProvider, agent) });
    async function register(name: string) {
      const response = await send('/api/auth/sign-up/email', { body: { name, email: `${name.toLowerCase()}@example.test`, password: 'unit-test-only-long-password' } });
      assert.equal(response.status, 200);
      const body = await response.json();
      return { id: body.user.id as string, cookie: response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ') };
    }
    alice = await register('Alice');
    bob = await register('Bob');
  });
  afterEach(async () => { await agent.close(); db.close(); });

  test('actual account sessions control all agent reads, writes, and provided context', async () => {
    const settings = createInitialState('Bob').settings;
    settings.profile!.goals = 'BOB_ONLY_PRIVATE_GOALS';
    store.mutate(bob.id, 'bob-profile-123', { type: 'settings.save', data: settings });
    await error(await send('/api/agent/runs', { body: { requestId: 'anonymous-run', prompt: 'Plan a week.', referenceDate: date }, headers: { 'oai-authenticated-user-id': alice.id } }), 401, 'SIGN_IN_REQUIRED');
    await error(await send('/api/agent/runs', { cookie: alice.cookie, origin: 'https://other.example', body: { requestId: 'cross-origin-run', prompt: 'Plan a week.', referenceDate: date } }), 403, 'ORIGIN_NOT_ALLOWED');
    const response = await send('/api/agent/runs', { cookie: alice.cookie, headers: { 'oai-authenticated-user-id': bob.id }, body: { requestId: 'private-run-123', prompt: 'Plan a week.', referenceDate: date } });
    assert.equal(response.status, 202);
    const run = (await response.json()).run;
    await agent.settled(run.id);
    assert.equal(calls[0].owner, alice.id);
    assert(!JSON.stringify(calls[0].input).includes('BOB_ONLY_PRIVATE_GOALS'));
    await error(await send(`/api/agent/runs/${run.id}`, { cookie: bob.cookie }), 404, 'RUN_NOT_FOUND');
    await error(await send(`/api/agent/runs/${run.id}/apply`, { cookie: bob.cookie, body: { requestId: 'wrong-owner-123' } }), 404, 'RUN_NOT_FOUND');
    await error(await send(`/api/agent/runs/${run.id}/cancel`, { cookie: bob.cookie, body: {} }), 404, 'RUN_NOT_FOUND');
    assert.deepEqual((await (await send('/api/agent/runs', { cookie: bob.cookie })).json()).runs, []);
    assert.equal(store.read(alice.id).revision, 0);
  });

  test('HTTP proposal application is atomic, explicit, and replayable across duplicate Apply IDs', async () => {
    answer = async () => completed(mealProposal());
    const run = await start('atomic-http-run');
    await agent.settled(run.id);
    assert.equal(store.read(alice.id).state.recipes.length, 0);
    const originalApply = store.applyBatch.bind(store);
    store.applyBatch = (owner, requestId, mutations, revision, onApplied) => originalApply(owner, requestId, mutations, revision, () => { onApplied?.(); throw new Error('simulated completion failure'); });
    await error(await send(`/api/agent/runs/${run.id}/apply`, { cookie: alice.cookie, body: { requestId: 'apply-failure-123' } }), 503, 'SERVICE_UNAVAILABLE');
    assert.equal(store.read(alice.id).revision, 0);
    assert.equal(agent.get(alice.id, run.id).status, 'completed');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mutation_receipts WHERE user_id = ?').get(alice.id)?.n, 0);
    store.applyBatch = originalApply;
    const applied = await send(`/api/agent/runs/${run.id}/apply`, { cookie: alice.cookie, body: { requestId: 'apply-success-123' } });
    assert.equal(applied.status, 200);
    const first = await applied.json();
    assert.equal(first.revision, 1);
    assert.equal(first.run.status, 'applied');
    assert.equal(first.state.recipes.length, 1);
    assert.equal(first.state.plan.length, 1);
    assert.equal(first.state.logs.length, 0);
    const retry = await send(`/api/agent/runs/${run.id}/apply`, { cookie: alice.cookie, body: { requestId: 'another-apply-123' } });
    assert.equal((await retry.json()).revision, 1);
    assert.equal(calls.length, 1);
    assert.equal(store.read(bob.id).state.recipes.length, 0);
  });

  test('stale proposals preserve food and workout history added after the request', async () => {
    answer = async () => completed(mealProposal());
    const run = await start('stale-http-run');
    await agent.settled(run.id);
    const log = { id: 'actual-lunch', date, slot: 'lunch', name: 'Actual lunch', nutrition: { calories: 600, protein: 30, carbs: 70, fat: 20 }, servings: 1, createdAt: timestamp };
    store.mutate(alice.id, 'actual-lunch-123', { type: 'log.save', data: log });
    await error(await send(`/api/agent/runs/${run.id}/apply`, { cookie: alice.cookie, body: { requestId: 'stale-apply-123' } }), 409, 'STALE_PROPOSAL');
    assert.deepEqual(store.read(alice.id).state.logs, [log]);
    assert.equal(store.read(alice.id).state.recipes.length, 0);
    assert.equal(agent.get(alice.id, run.id).status, 'completed');
  });

  test('cancelled requests cannot be resurrected by a late provider result', async () => {
    let finish: ((value: unknown) => void) | undefined;
    answer = async () => new Promise(resolve => { finish = resolve; });
    const run = await start('cancel-http-run');
    assert(finish);
    const cancelled = await send(`/api/agent/runs/${run.id}/cancel`, { cookie: alice.cookie, body: {} });
    assert.equal((await cancelled.json()).run.status, 'cancelled');
    finish(completed(mealProposal()));
    await agent.settled(run.id);
    assert.equal(agent.get(alice.id, run.id).status, 'cancelled');
    assert.equal(store.read(alice.id).revision, 0);
  });

  test('completed food, recipe, and planning requests replay after disconnect while new calls remain blocked', async () => {
    const foodInput = { requestId: 'cached-food-123', description: '2 boiled eggs' };
    const estimate = { status: 'estimated', name: 'Two eggs', amountSummary: '2 large boiled eggs', nutrition: { calories: 156, protein: 12.6, carbs: 1.2, fat: 10.6 }, assumptions: [] };
    answer = async () => completed({ result: estimate });
    const food = await send('/api/estimate-food', { cookie: alice.cookie, body: foodInput });
    assert.equal(food.status, 200);
    const expectedFood = await food.json();
    const { id: _id, source: _source, favorite: _favorite, color: _color, createdAt: _createdAt, ...recipeDraft } = recipe();
    answer = async () => completed(recipeDraft);
    const recipeInput = { requestId: 'cached-recipe-123', prompt: 'A quick yogurt breakfast.', calories: 350, protein: 25, maxMinutes: 15 };
    const generated = await send('/api/generate', { cookie: alice.cookie, body: recipeInput });
    assert.equal(generated.status, 200);
    const expectedRecipe = await generated.json();
    answer = async () => completed(clarification);
    const planInput = { requestId: 'cached-plan-123', prompt: 'Plan a training week.', referenceDate: date };
    const plan = await send('/api/agent/runs', { cookie: alice.cookie, body: planInput });
    const run = (await plan.json()).run;
    await agent.settled(run.id);
    connected = false;
    const cachedFood = await send('/api/estimate-food', { cookie: alice.cookie, body: foodInput });
    assert.equal(cachedFood.status, 200);
    assert.deepEqual(await cachedFood.json(), expectedFood);
    const cachedRecipe = await send('/api/generate', { cookie: alice.cookie, body: recipeInput });
    assert.equal(cachedRecipe.status, 200);
    assert.deepEqual(await cachedRecipe.json(), expectedRecipe);
    const cachedPlan = await send('/api/agent/runs', { cookie: alice.cookie, body: planInput });
    assert.equal(cachedPlan.status, 202);
    assert.equal((await cachedPlan.json()).run.id, run.id);
    await error(await send('/api/estimate-food', { cookie: alice.cookie, body: { ...foodInput, description: '3 boiled eggs' } }), 409, 'REQUEST_ID_REUSED');
    await error(await send('/api/generate', { cookie: alice.cookie, body: { ...recipeInput, requestId: 'fresh-recipe-123' } }), 503, 'AI_CONNECTION_REQUIRED');
    await error(await send('/api/agent/runs', { cookie: alice.cookie, body: { ...planInput, requestId: 'fresh-plan-123' } }), 503, 'AI_CONNECTION_REQUIRED');
    await error(await send('/api/estimate-food', { cookie: alice.cookie, body: { ...foodInput, requestId: 'fresh-food-123' } }), 503, 'AI_CONNECTION_REQUIRED');
    assert.equal(calls.length, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM corner_ai_runs WHERE user_id = ?').get(alice.id)?.n, 3);
  });

  test('proposed set results are rejected while exercise targets remain adaptable planned work', async () => {
    const invalid = plannedWorkout();
    invalid.exercises[0].sets[0].reps = 8;
    const workoutProposal = (workout: WorkoutSession): AgentResult => ({ status: 'proposal', title: 'A strength plan', message: 'Review the planned session.', questions: [], changes: [{ type: 'workout', label: 'Strength session', reason: 'Fits your available time.', data: workout }] });
    answer = async () => completed(workoutProposal(invalid));
    const rejected = await start('actual-fields-rejected');
    await agent.settled(rejected.id);
    assert.equal(agent.get(alice.id, rejected.id).status, 'failed');
    assert.equal(store.read(alice.id).state.training.sessions.length, 0);
    answer = async () => completed(workoutProposal(plannedWorkout()));
    const planned = await start('targets-only-planned');
    await agent.settled(planned.id);
    const applied = await send(`/api/agent/runs/${planned.id}/apply`, { cookie: alice.cookie, body: { requestId: 'apply-planned-targets' } });
    assert.equal(applied.status, 200);
    const session = store.read(alice.id).state.training.sessions[0];
    assert.deepEqual(session.exercises[0].targetLoad, { weight: 20, unit: 'lb' });
    assert.equal(session.exercises[0].sets[0].reps, null);
    answer = async () => completed({ status: 'proposal', title: 'Remove the planned session', message: 'This planned session has no logged work.', questions: [], changes: [{ type: 'remove_workout', label: 'Remove session', reason: 'The user requested another day.', data: { id: session.id } }] });
    const removal = await start('remove-planned-session');
    await agent.settled(removal.id);
    const removed = await send(`/api/agent/runs/${removal.id}/apply`, { cookie: alice.cookie, body: { requestId: 'apply-removal-123' } });
    assert.equal(removed.status, 200);
    assert.equal(store.read(alice.id).state.training.sessions.length, 0);
  });

  test('AI cannot overwrite actual values in an otherwise planned workout', async () => {
    const partial = plannedWorkout();
    partial.exercises[0].sets[0].weight = 20;
    partial.exercises[0].sets[0].reps = 8;
    partial.durationMinutes = 12;
    partial.readiness = 3;
    store.mutate(alice.id, 'partially-recorded-workout', { type: 'training.session.save', data: { session: partial, expectedUpdatedAt: null } });
    const recorded = store.read(alice.id);
    answer = async () => completed({ status: 'proposal', title: 'Replace the session', message: 'Review this revised workout.', questions: [], changes: [{ type: 'workout', label: 'Updated session', reason: 'A shorter workout was requested.', data: plannedWorkout() }] });
    const replacement = await start('replace-partial-workout');
    await agent.settled(replacement.id);
    assert.equal(agent.get(alice.id, replacement.id).status, 'failed');
    assert.deepEqual(store.read(alice.id), recorded);
    answer = async () => completed({ status: 'proposal', title: 'Remove the session', message: 'Review this change.', questions: [], changes: [{ type: 'remove_workout', label: 'Remove session', reason: 'A different day was requested.', data: { id: partial.id } }] });
    const removal = await start('remove-partial-workout');
    await agent.settled(removal.id);
    assert.equal(agent.get(alice.id, removal.id).status, 'failed');
    assert.deepEqual(store.read(alice.id), recorded);
  });
});
