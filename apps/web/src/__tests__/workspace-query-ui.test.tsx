// @vitest-environment jsdom
import { useRef } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { onlineManager, QueryClientProvider, useMutation } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';
import { createInitialState } from '@packages/workspace/initial-state';
import type { Bootstrap, CommandResult, RecordPage } from '@packages/api/workspace-data';
import type { FoodEntry, Recipe } from '@packages/nutrition/types';
import * as runtime from '../rpc';
import { foodDay, groceryWeek, nutritionWindow, useCursorResource, useRecordPage } from '../features/workspace/resources';
import { json, mockHttp } from './http';
import { LiveToday } from '../features/today/today';
import RecipePicker from '../features/meal-planner/recipe-picker';
import TrainingPanel from '../components/training-panel';
import type { WorkoutSession } from '@packages/training/types';
import Settings from '../features/settings/settings';
import { download } from '../features/workspace/utils';
import type * as WorkspaceUtils from '../features/workspace/utils';
import { MAX_WORKSPACE_TRANSFER_BYTES } from '@packages/api/workspace-data';
vi.mock('../features/workspace/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceUtils>();
  return { ...actual, download: vi.fn() };
});

const bootstrap = (revision: number): Bootstrap => ({
  revision, settings: createInitialState().settings, aiAvailable: false,
});

const accountUnavailable = () => json({ json: {
  defined: true, code: 'CORNER_ERROR', status: 503,
  message: 'The account service is temporarily unavailable. Try again later.',
  data: { code: 'ACCOUNT_SERVICE_UNAVAILABLE' },
} }, 503);

test('workspace and food reads recover transient account failures without retiring the session', async () => {
  const attempts = new Map<string, number>();
  const generation = runtime.sessionLifetime();
  mockHttp((call) => {
    const attempt = (attempts.get(call.path) ?? 0) + 1;
    attempts.set(call.path, attempt);
    if (attempt === 1) return accountUnavailable();
    if (call.path === '/api/rpc/workspace/get') return json({ json: bootstrap(7) });
    if (call.path === '/api/rpc/workspace/foodWindow')
      return json({ json: { revision: 7, entries: [foodEntry('recovered-oats')],
        totals: { calories: 200, protein: 20, carbs: 24, fat: 8 }, nextCursor: null } });
  });
  function Consumer() {
    const workspace = runtime.useWorkspace();
    const food = runtime.useResource('food', undefined,
      (signal) => foodDay('2026-10-24', signal));
    return <>
      <output aria-label="Workspace">{workspace.isError ? 'error' : workspace.data?.revision}</output>
      <output aria-label="Food">{food.isError ? 'error' : food.data?.entries[0]?.name}</output>
    </>;
  }
  render(<QueryClientProvider client={runtime.queryClient}><Consumer /></QueryClientProvider>);
  await waitFor(() => {
    expect(screen.getByLabelText('Workspace')).toHaveTextContent('7');
    expect(screen.getByLabelText('Food')).toHaveTextContent('Synthetic oats');
  }, { timeout: 2500 });
  expect(runtime.sessionLifetime()).toBe(generation);
  expect([...attempts.values()]).toEqual([2, 2]);
});

test('persistent account failures exhaust read retries and retain manual recovery', async () => {
  let fail = true;
  const generation = runtime.sessionLifetime();
  const calls = mockHttp(() => fail ? accountUnavailable() : json({ json: bootstrap(7) }));
  function Consumer() {
    const workspace = runtime.useWorkspace();
    return <>
      <output>{workspace.isError ? workspace.error.message : workspace.data?.revision}</output>
      <button onClick={() => void workspace.refetch()}>Retry</button>
    </>;
  }
  render(<QueryClientProvider client={runtime.queryClient}><Consumer /></QueryClientProvider>);
  await screen.findByText('The account service is temporarily unavailable. Try again later.', {}, { timeout: 3000 });
  expect(calls).toHaveLength(3);
  expect(runtime.sessionLifetime()).toBe(generation);
  fail = false;
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('7');
});

test('logout cancels account backoff before another request or private result can appear', async () => {
  vi.useFakeTimers();
  const generation = runtime.sessionLifetime();
  const calls = mockHttp(() => accountUnavailable());
  function Consumer() {
    const active = runtime.useSessionLifetime() === generation;
    const workspace = runtime.useWorkspace(active);
    return <output>{active ? workspace.data?.settings.name : 'Signed out'}</output>;
  }
  await act(async () => {
    render(<QueryClientProvider client={runtime.queryClient}><Consumer /></QueryClientProvider>);
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(calls).toHaveLength(1);
  expect(runtime.queryClient.getQueryState(['workspace', generation])?.fetchFailureCount).toBe(1);
  await act(async () => {
    runtime.clearPrivateState();
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(screen.getByText('Signed out')).toBeInTheDocument();
  expect(calls).toHaveLength(1);
  expect(runtime.queryClient.getQueryData(['workspace', generation])).toBeUndefined();
});

test.each(['SIGN_IN_REQUIRED', 'INVALID_INPUT'] as const)('%s stops workspace reads without retrying', async (code) => {
  const calls = mockHttp(() => json({ json: {
    defined: true, code: code === 'SIGN_IN_REQUIRED' ? code : 'CORNER_ERROR',
    status: code === 'SIGN_IN_REQUIRED' ? 401 : 400, message: code, data: { code },
  } }, code === 'SIGN_IN_REQUIRED' ? 401 : 400));
  const expired = vi.fn();
  window.addEventListener('corner:session-expired', expired);
  const generation = runtime.sessionLifetime();
  function Consumer() {
    const active = runtime.useSessionLifetime() === generation;
    const workspace = runtime.useWorkspace(active);
    return <output>{active ? workspace.error?.message : 'Signed out'}</output>;
  }
  try {
    render(<QueryClientProvider client={runtime.queryClient}><Consumer /></QueryClientProvider>);
    await screen.findByText(code === 'SIGN_IN_REQUIRED' ? 'Signed out' : code);
    expect(calls).toHaveLength(1);
    expect(expired).toHaveBeenCalledTimes(code === 'SIGN_IN_REQUIRED' ? 1 : 0);
  } finally {
    window.removeEventListener('corner:session-expired', expired);
  }
});

test.each(['stale', 'failed'] as const)('reconnect refreshes %s workspace resources but not provider connections', async (initial) => {
  let revision = 1;
  let fail = initial === 'failed';
  const calls = mockHttp((call) => {
    if (call.path === '/api/rpc/ai/connection') return json({ json: {} });
    if (call.path === '/api/rpc/workspace/get') {
      if (fail) throw new TypeError('Network unavailable');
      return json({ json: bootstrap(revision) });
    }
  });
  const food = vi.fn(async () => {
    if (fail) throw new TypeError('Network unavailable');
    return { revision };
  });
  function Consumer() {
    const workspace = runtime.useWorkspace();
    const resource = runtime.useResource('food', undefined, food);
    const connection = runtime.useConnection();
    return <>
      <output aria-label="Workspace">{workspace.isError ? 'error' : workspace.data?.revision}</output>
      <output aria-label="Food">{resource.isError ? 'error' : resource.data?.revision}</output>
      <output aria-label="Connection">{connection.status}</output>
    </>;
  }
  render(<QueryClientProvider client={runtime.queryClient}><Consumer /></QueryClientProvider>);
  await waitFor(() => {
    expect(screen.getByLabelText('Workspace')).toHaveTextContent(fail ? 'error' : '1');
    expect(screen.getByLabelText('Food')).toHaveTextContent(fail ? 'error' : '1');
    expect(screen.getByLabelText('Connection')).toHaveTextContent('success');
  });
  try {
    act(() => { onlineManager.setOnline(false); });
    revision = 2;
    fail = false;
    act(() => { onlineManager.setOnline(true); });
    await waitFor(() => {
      expect(screen.getByLabelText('Workspace')).toHaveTextContent('2');
      expect(screen.getByLabelText('Food')).toHaveTextContent('2');
    });
    expect(food).toHaveBeenCalledTimes(2);
    expect(calls.filter((call) => call.path === '/api/rpc/ai/connection')).toHaveLength(1);
  } finally {
    act(() => { onlineManager.setOnline(true); });
  }
});

test.each(['records', 'cursor'] as const)('%s pagination restarts after a write and refreshes without stale cursors', async (kind) => {
  let revision = 1;
  const requests: Array<{ revision: number; cursor?: { revision: number } }> = [];
  mockHttp((call) => {
    if (call.path !== '/api/rpc/workspace/page') return;
    const input = call.body?.json as { cursor?: { revision: number } };
    requests.push({ revision, cursor: input.cursor });
    if (input.cursor && input.cursor.revision !== revision)
      return json({ json: { defined: true, code: 'CORNER_ERROR', status: 409,
        message: 'Refresh this list.', data: { code: 'CURSOR_INVALIDATED' } } }, 409);
    return json({ json: { resource: 'recipes', revision, items: [{ ...savedRecipe, name: `Page ${input.cursor ? 2 : 1} revision ${revision}` }],
      loggedPlanIds: [], nextCursor: input.cursor ? null : { revision, position: 1, id: 'next' } } });
  });
  function Consumer() {
    const records = useRecordPage({ resource: 'recipes', limit: 1 }, kind === 'records');
    const cursor = useCursorResource<RecordPage<'recipes'>>('recipes', { limit: 1 },
      (next, signal) => runtime.rpc.workspace.page({ resource: 'recipes', limit: 1, cursor: next }, { signal }) as Promise<RecordPage<'recipes'>>, kind === 'cursor');
    const query = kind === 'records' ? records : cursor;
    return <>
      <output>{query.isError ? 'Pagination error' : query.data?.items.map((item) => item.name).join(',')}</output>
      <button disabled={!query.paging.hasNext} onClick={query.paging.next}>Next</button>
      <button onClick={query.reload}>Refresh</button>
    </>;
  }
  render(<QueryClientProvider client={runtime.queryClient}><Consumer /></QueryClientProvider>);
  const user = userEvent.setup();
  await screen.findByText('Page 1 revision 1');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText('Page 2 revision 1');
  await act(async () => {
    await runtime.writeWorkspace(async () => ({ revision: ++revision }), runtime.sessionLifetime(), ['recipes']);
  });
  await screen.findByText('Page 1 revision 2');
  expect(requests.filter((request) => request.revision === 2).every((request) => !request.cursor)).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText('Page 2 revision 2');
  const beforeRefresh = requests.length;
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText('Page 1 revision 2');
  await waitFor(() => expect(requests.length).toBeGreaterThan(beforeRefresh));
  expect(requests.slice(beforeRefresh).every((request) => !request.cursor)).toBe(true);
  expect(screen.queryByText('Pagination error')).not.toBeInTheDocument();
});

test('revision-only writes preserve bootstrap settings and an older refresh cannot roll back the workspace', async () => {
  let serverRevision = 3;
  mockHttp(() => json({ json: bootstrap(serverRevision) }));
  const lateWrite = Promise.withResolvers<CommandResult>();
  let attempts = 0;
  let pendingWrite!: Promise<CommandResult>;
  function Consumer() {
    runtime.useSessionLifetime();
    const generation = useRef(runtime.sessionLifetime()).current;
    const workspace = runtime.useWorkspace();
    const write = useMutation({
      mutationFn: () => runtime.writeWorkspace(() => {
        if (attempts++ === 0) {
          serverRevision = 9;
          return Promise.resolve({ revision: 9 });
        }
        return lateWrite.promise;
      }, generation, ['food']),
    });
    return <section>
      <output aria-label="Workspace revision">{workspace.data?.revision ?? 'loading'}</output>
      <output aria-label="Timezone">{workspace.data?.settings.timezone}</output>
      <button disabled={write.isPending} onClick={() => {
        pendingWrite = write.mutateAsync();
        void pendingWrite.catch(() => {});
      }}>Save</button>
    </section>;
  }
  render(<QueryClientProvider client={runtime.queryClient}><Consumer /></QueryClientProvider>);
  await waitFor(() => expect(screen.getByLabelText('Workspace revision')).toHaveTextContent('3'));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.getByLabelText('Workspace revision')).toHaveTextContent('9'));
  expect(screen.getByLabelText('Timezone')).toHaveTextContent(bootstrap(3).settings.timezone);
  serverRevision = 8;
  await act(async () => { await runtime.queryClient.refetchQueries({ queryKey: runtime.privateKey('workspace') }); });
  expect(screen.getByLabelText('Workspace revision')).toHaveTextContent('9');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  const rejected = expect(pendingWrite).rejects.toThrow('session has ended');
  await act(async () => {
    runtime.clearPrivateState();
    lateWrite.resolve({ revision: 20 });
    await rejected;
  });
  expect(runtime.queryClient.getMutationCache().getAll()).toEqual([]);
});

test('a write rejects a stale read even for an empty key without poisoning unrelated families', async () => {
  const pending = Promise.withResolvers<{ revision: number; entries: string[] }>();
  const read = runtime.readResource('food', () => pending.promise);
  const rejected = expect(read).rejects.toThrow('changed while loading');
  await runtime.invalidateWorkspace(5, ['food']);
  pending.resolve({ revision: 4, entries: ['retired food'] });
  await rejected;
  await expect(runtime.readResource('recipes', async () => ({ revision: 2, items: [] })))
    .resolves.toEqual({ revision: 2, items: [] });
  const retired = Promise.withResolvers<{ revision: number }>();
  const oldSession = runtime.readResource('recipes', () => retired.promise);
  const ended = expect(oldSession).rejects.toThrow('session has ended');
  runtime.clearPrivateState();
  retired.resolve({ revision: 100 });
  await ended;
});

test('newer resource observations never relabel old settings or discard a genuine in-flight bootstrap', async () => {
  const second = Promise.withResolvers<Response>();
  const third = Promise.withResolvers<Response>();
  let bootstrapCalls = 0;
  const payload = (revision: number, name: string) => ({
    ...bootstrap(revision), settings: { ...bootstrap(revision).settings, name },
  });
  mockHttp((call) => {
    if (call.path !== '/api/rpc/workspace/get') return;
    bootstrapCalls++;
    if (bootstrapCalls === 1) return json({ json: payload(1, 'Settings one') });
    return bootstrapCalls === 2 ? second.promise : third.promise;
  });
  function Consumer() {
    const workspace = runtime.useWorkspace();
    return <>
      <output aria-label="Authoritative settings">{workspace.data?.settings.name}</output>
      <output aria-label="Settings revision">{workspace.data?.revision}</output>
      <output aria-label="Observed revision">{workspace.observedRevision}</output>
    </>;
  }
  render(<QueryClientProvider client={runtime.queryClient}><Consumer /></QueryClientProvider>);
  await screen.findByText('Settings one');
  let refreshing!: Promise<void>;
  act(() => { refreshing = runtime.queryClient.refetchQueries({ queryKey: runtime.privateKey('workspace') }); });
  await waitFor(() => expect(bootstrapCalls).toBe(2));
  await act(async () => {
    await runtime.readResource('food', async () => ({ revision: 3, entries: [] }));
  });
  expect(screen.getByLabelText('Settings revision')).toHaveTextContent('1');
  expect(screen.getByLabelText('Authoritative settings')).toHaveTextContent('Settings one');
  expect(screen.getByLabelText('Observed revision')).toHaveTextContent('3');
  await act(async () => {
    second.resolve(json({ json: payload(2, 'Settings two') }));
    await refreshing;
  });
  await waitFor(() => expect(screen.getByLabelText('Settings revision')).toHaveTextContent('2'));
  expect(screen.getByLabelText('Authoritative settings')).toHaveTextContent('Settings two');
  await waitFor(() => expect(bootstrapCalls).toBe(3));
  await act(async () => { third.resolve(json({ json: payload(3, 'Settings three') })); });
  await waitFor(() => expect(screen.getByLabelText('Authoritative settings')).toHaveTextContent('Settings three'));
});

const foodEntry = (id: string): FoodEntry => ({
  id, date: '2026-10-24', slot: 'breakfast', name: 'Synthetic oats', servings: 2,
  nutrition: { calories: 100, protein: 10, carbs: 12, fat: 4 }, createdAt: '2026-10-24T09:00:00.000Z',
});

test('a dense day follows food continuations and retains authoritative whole-day totals', async () => {
  const entries = Array.from({ length: 201 }, (_, index) => foodEntry(`food-${index}`));
  const totals = { calories: 40200, protein: 4020, carbs: 4824, fat: 1608 };
  const calls = mockHttp((call) => {
    if (call.path !== '/api/rpc/workspace/foodWindow') return;
    const input = call.body?.json as { cursor?: unknown };
    return json({ json: { revision: 7, entries: input.cursor ? entries.slice(200) : entries.slice(0, 200), totals,
      nextCursor: input.cursor ? null : { revision: 7, date: '2026-10-24', position: 199, id: 'food-199' } } });
  });
  const day = await foodDay('2026-10-24', new AbortController().signal);
  expect(day.entries).toEqual(entries);
  expect(day.totals).toEqual(totals);
  expect(calls).toHaveLength(2);
});

test('a drifting food continuation or calendar dependency cannot become a complete calculation', async () => {
  let foodCalls = 0;
  mockHttp((call) => {
    if (call.path === '/api/rpc/workspace/foodWindow') {
      foodCalls += 1;
      return json({ json: { revision: foodCalls === 1 ? 7 : 8, entries: [foodEntry(`food-${foodCalls}`)],
        totals: { calories: 200, protein: 20, carbs: 24, fat: 8 },
        nextCursor: foodCalls === 1 ? { revision: 7, date: '2026-10-24', position: 0, id: 'food-1' } : null } });
    }
    if (call.path === '/api/rpc/workspace/get') return json({ json: bootstrap(7) });
    if (call.path === '/api/rpc/workspace/page') {
      const input = call.body?.json as { resource: string };
      return json({ json: { resource: input.resource, revision: input.resource === 'sessions' ? 8 : 7,
        items: [], loggedPlanIds: [], nextCursor: null } });
    }
  });
  await expect(foodDay('2026-10-24', new AbortController().signal)).rejects.toThrow('changed while loading');
  await expect(nutritionWindow('2026-10-19', '2026-10-25', new AbortController().signal))
    .rejects.toThrow('changed while loading');
});

const savedRecipe: Recipe = {
  id: 'saved-oats', name: 'Saved oats', description: 'Synthetic recipe', category: 'breakfast',
  prepMinutes: 5, cookMinutes: 0, nutrition: { calories: 100, protein: 10, carbs: 12, fat: 4 },
  ingredients: [{ name: 'Oats', quantity: 1, unit: 'cup', aisle: 'Pantry' }],
  steps: ['Mix.'], storage: '', variation: '', tags: ['quick'], color: 'sage',
  source: 'manual', favorite: false, createdAt: '2026-10-24T09:00:00.000Z',
};

test('Today respects logged planned-meal membership even when its food entry is on another day', async () => {
  mockHttp((call) => {
    if (call.path === '/api/rpc/workspace/get') return json({ json: bootstrap(7) });
    if (call.path === '/api/rpc/workspace/page') {
      const input = call.body?.json as { resource: string };
      const plan = input.resource === 'plan';
      return json({ json: { resource: input.resource, revision: 7,
        items: plan ? [{ id: 'planned-oats', date: '2026-10-24', slot: 'breakfast', recipeId: savedRecipe.id, servings: 1 }] : [],
        loggedPlanIds: plan ? ['planned-oats'] : [], nextCursor: null } });
    }
    if (call.path === '/api/rpc/workspace/details')
      return json({ json: { revision: 7, recipes: [savedRecipe], plan: [], sessions: [], templates: [] } });
    if (call.path === '/api/rpc/workspace/foodWindow')
      return json({ json: { revision: 7, entries: [], totals: { calories: 0, protein: 0, carbs: 0, fat: 0 }, nextCursor: null } });
  });
  render(<QueryClientProvider client={runtime.queryClient}>
    <LiveToday selectedDate="2026-10-24" setSelectedDate={() => {}} displayName="Synthetic trainee"
      disabled={false} navigate={() => {}} mutate={async () => true} notify={() => {}}
      setOverlay={() => {}} openRecipe={() => {}} />
  </QueryClientProvider>);
  expect(await screen.findByRole('button', { name: 'Logged' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Add food' })).toBeEnabled();
});

test('the selected recipe remains actionable when it is outside the current picker page', async () => {
  const add = vi.fn();
  mockHttp((call) => {
    if (call.path === '/api/rpc/workspace/page')
      return json({ json: { resource: 'recipes', revision: 7, items: [], loggedPlanIds: [],
        nextCursor: { revision: 7, position: 30, id: 'another-recipe' } } });
    if (call.path === '/api/rpc/workspace/details')
      return json({ json: { revision: 7, recipes: [savedRecipe], plan: [], sessions: [], templates: [] } });
  });
  render(<QueryClientProvider client={runtime.queryClient}>
    <RecipePicker date="2026-10-24" slot="breakfast" initialRecipeId={savedRecipe.id}
      busy={false} onClose={() => {}} onAdd={add} />
  </QueryClientProvider>);
  const submit = await screen.findByRole('button', { name: 'Add to plan' });
  await waitFor(() => expect(submit).toBeEnabled());
  await userEvent.setup().click(submit);
  expect(add).toHaveBeenCalledWith(savedRecipe, '2026-10-24', 'breakfast', 1, expect.any(String));
});

test('query ingestion checks the write floor again when its cache key is still empty', async () => {
  const parameters = { date: '2026-10-24' };
  const key = [...runtime.privateKey('food'), parameters];
  function Consumer() {
    const query = runtime.useResource('food', parameters,
      async () => ({ revision: 4, entries: ['stale'] }), false);
    return <output aria-label="Food results">{query.data?.entries.join(',') ?? 'not loaded'}</output>;
  }
  render(<QueryClientProvider client={runtime.queryClient}><Consumer /></QueryClientProvider>);
  await runtime.invalidateWorkspace(5, ['food']);
  expect(() => runtime.queryClient.setQueryData(key, { revision: 4, entries: ['stale'] }))
    .toThrow('changed while loading');
  expect(screen.getByLabelText('Food results')).toHaveTextContent('not loaded');
  await act(async () => {
    runtime.queryClient.setQueryData(key, { revision: 5, entries: ['current'] });
  });
  await waitFor(() => expect(screen.getByLabelText('Food results')).toHaveTextContent('current'));
});

const plannedSession: WorkoutSession = {
  id: 'planned-squat', date: '2026-10-24', name: 'Synthetic strength session', kind: 'strength',
  status: 'planned', unit: 'kg', plannedMinutes: 45, durationMinutes: null, rounds: null,
  sessionRpe: null, readiness: null, notes: '', changeReason: '',
  createdAt: '2026-10-24T09:00:00.000Z', updatedAt: '2026-10-24T09:00:00.000Z',
  exercises: [{ id: 'squat', name: 'Synthetic squat', loadType: 'total', targetSets: 1,
    repMin: 8, repMax: 10, targetRir: 2, restSeconds: 90, notes: '',
    targetLoad: { weight: 40, unit: 'kg' },
    sets: [{ id: 'working-set', weight: null, reps: null, rir: null, completed: false, kind: 'working' }] }],
};
const historicalSession: WorkoutSession = {
  ...plannedSession, id: 'historical-squat', date: '2010-01-02', status: 'completed', unit: 'lb',
  durationMinutes: 40, createdAt: '2010-01-02T09:00:00.000Z', updatedAt: '2010-01-02T09:00:00.000Z',
  exercises: [{ ...plannedSession.exercises[0]!, id: 'old-squat',
    sets: [{ id: 'old-set', weight: 100, reps: 9, rir: 1, completed: true, kind: 'working' }] }],
};

test('workout prefill uses the bounded historical context without recording displayed suggestions', async () => {
  const mutate = vi.fn(async () => true);
  mockHttp((call) => {
    if (call.path === '/api/rpc/workspace/page')
      return json({ json: { resource: 'sessions', revision: 7, items: [plannedSession], loggedPlanIds: [], nextCursor: null } });
    if (call.path === '/api/rpc/workspace/prefill')
      return json({ json: { revision: 7, sessions: [historicalSession] } });
  });
  render(<QueryClientProvider client={runtime.queryClient}>
    <TrainingPanel settings={bootstrap(7).settings} selectedDate={plannedSession.date}
      onDateChange={() => {}} mutate={mutate} busy={false} notify={() => {}}
      onRefresh={() => {}} onOpenAgent={() => {}} />
  </QueryClientProvider>);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Start workout' }));
  await waitFor(() => expect(screen.getByLabelText('Synthetic squat set 1 weight kg', { exact: true })).toHaveValue(45.359));
  expect(screen.getByLabelText('Synthetic squat set 1 reps', { exact: true })).toHaveValue(9);
  expect(screen.getByLabelText('Synthetic squat set 1 completed', { exact: true })).not.toBeChecked();
  await user.click(screen.getByRole('button', { name: 'Save workout' }));
  expect(mutate).toHaveBeenCalledWith({
    type: 'training.session.save',
    data: { session: expect.objectContaining({ id: plannedSession.id, status: 'in_progress', exercises: plannedSession.exercises }), expectedUpdatedAt: plannedSession.updatedAt },
  }, 'Workout saved');
});

test('progress uses lifetime counts, old measurements and explicit historical session details', async () => {
  const stats = { sessions: 0, strengthSessions: 0, boxingSessions: 0, conditioningSessions: 0,
    minutes: 0, workingSets: 0, externalVolumeLb: 0, averageRpe: null };
  const calls = mockHttp((call) => {
    if (call.path === '/api/rpc/workspace/page') {
      const input = call.body?.json as { resource: string };
      return json({ json: { resource: input.resource, revision: 7, items: [], loggedPlanIds: [], nextCursor: null } });
    }
    if (call.path === '/api/rpc/workspace/progress')
      return json({ json: { revision: 7, completedCount: 213, stats, weekly: [], latestWeight: {
        id: 'old-measurement', date: '2009-12-01', bodyWeight: 170, waist: null, sleepHours: null,
        energy: null, soreness: null, boxingQuality: null, notes: '',
      } } });
    if (call.path === '/api/rpc/workspace/exerciseChoices')
      return json({ json: { revision: 7, names: ['Synthetic squat'], nextCursor: null } });
    if (call.path === '/api/rpc/workspace/exerciseHistory')
      return json({ json: { revision: 7, sessions: [historicalSession], nextCursor: null } });
    if (call.path === '/api/rpc/workspace/details')
      return json({ json: { revision: 7, recipes: [], plan: [], sessions: [historicalSession], templates: [] } });
    if (call.path === '/api/rpc/workspace/prefill')
      return json({ json: { revision: 7, sessions: [] } });
  });
  render(<QueryClientProvider client={runtime.queryClient}>
    <TrainingPanel settings={bootstrap(7).settings} selectedDate={plannedSession.date}
      onDateChange={() => {}} mutate={async () => true} busy={false} notify={() => {}}
      onRefresh={() => {}} onOpenAgent={() => {}} />
  </QueryClientProvider>);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: 'Progress' }));
  expect(await screen.findByText('213 completed')).toBeVisible();
  expect(screen.getByText(/Latest logged weight/)).toHaveTextContent('Dec 1');
  await user.click(await screen.findByRole('button', { name: 'Jan 2' }));
  expect(await screen.findByRole('dialog', { name: 'Workout details' })).toBeVisible();
  expect(calls.some((call) => call.path === '/api/rpc/workspace/details' &&
    JSON.stringify(call.body).includes(historicalSession.id))).toBe(true);
});

test('weekly groceries collect every aggregate page and check before copy or download', async () => {
  mockHttp((call) => {
    if (call.path !== '/api/rpc/workspace/groceries') return;
    const input = call.body?.json as { cursor?: unknown };
    const key = input.cursor ? 'zucchini' : 'oats';
    return json({ json: {
      revision: 7, items: [{ key, name: key, quantity: input.cursor ? 3 : 2,
        unit: 'cup', aisle: input.cursor ? 'Produce' : 'Pantry', notes: [] }],
      checks: { [`2026-10-19|${key}`]: true },
      nextCursor: input.cursor ? null : { revision: 7, key: 'oats' },
    } });
  });
  const groceries = await groceryWeek('2026-10-19', new AbortController().signal);
  expect(groceries.items.map((item) => item.name)).toEqual(['oats', 'zucchini']);
  expect(groceries.checks).toEqual({ '2026-10-19|oats': true, '2026-10-19|zucchini': true });
  expect(groceries.nextCursor).toBeNull();
});

test('a full export above the former browser cap can be uploaded, previewed, and imported without losing records', async () => {
  const full = createInitialState();
  full.recipes = Array.from({ length: 600 }, (_, index) => ({
    ...savedRecipe, id: `export-recipe-${index}`,
    description: 'd'.repeat(1600), storage: 's'.repeat(2000), variation: 'v'.repeat(1600),
  }));
  const calls = mockHttp((call) => {
    if (call.path === '/api/rpc/workspace/export') return json({ json: { revision: 7, state: full } });
    if (call.path === '/api/rpc/workspace/previewImport') return json({ json: {
      revision: 0, canImport: true,
      summary: { recipes: full.recipes.length, bytes: JSON.stringify(full).length },
    } });
    if (call.path === '/api/rpc/workspace/import') return json({ json: { revision: 1 } });
    if (call.path === '/api/rpc/ai/connection') return json({ json: {
      available: false, connected: false, enabled: false, state: 'unavailable', model: null, models: [],
    } });
  });
  render(<QueryClientProvider client={runtime.queryClient}>
    <Settings settings={full.settings} preview={false} disabled={false} busy={false}
      accountEmail="synthetic@corner.test" notify={() => {}} readState={async () => {}}
      mutate={async () => true} />
  </QueryClientProvider>);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Export workspace' }));
  await waitFor(() => expect(download).toHaveBeenCalledWith(
    JSON.stringify(full), expect.stringMatching(/^corner-data-.*\.json$/), 'application/json',
  ));
  expect(calls.filter((call) => call.path === '/api/rpc/workspace/export')).toHaveLength(1);
  const exported = vi.mocked(download).mock.calls.at(-1)![0];
  const file = new File([exported], 'corner-large-export.json', { type: 'application/json' });
  expect(file.size).toBeGreaterThan(2 * 1024 * 1024);
  expect(file.size).toBeLessThanOrEqual(MAX_WORKSPACE_TRANSFER_BYTES);
  // jsdom File lacks the browser's Blob.text implementation.
  Object.defineProperty(file, 'text', { value: async () => exported });
  const user = userEvent.setup();
  await user.upload(screen.getByLabelText('Corner export · JSON'), file);
  await screen.findByRole('heading', { name: 'Review your import' });
  await user.type(screen.getByLabelText('Type IMPORT to confirm'), 'IMPORT');
  await user.click(screen.getByRole('button', { name: 'Import my records' }));
  await waitFor(() => expect(calls.some((call) => call.path === '/api/rpc/workspace/import')).toBe(true));
  const imported = calls.find((call) => call.path === '/api/rpc/workspace/import')!;
  expect(imported.body?.json).toEqual({
    state: full, expectedRevision: 0, requestId: expect.any(String),
  });
});
