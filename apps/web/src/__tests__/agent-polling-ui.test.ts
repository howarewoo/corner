import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { act, createElement, type ComponentType } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClientProvider, notifyManager } from '@tanstack/react-query';
import type { AgentRun } from '@packages/agent/proposals';
import type { AppState } from '@packages/workspace/types';
import type * as Runtime from '../rpc.ts';

const project = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const state: AppState = {
  recipes: [], plan: [], logs: [], groceryChecks: {}, requests: [],
  settings: {
    name: 'Test person', timezone: 'UTC',
    training: { calories: 2000, protein: 120, carbs: 250, fat: 60 },
    rest: { calories: 1800, protein: 120, carbs: 200, fat: 60 },
    schedule: { '0': 'rest', '1': 'training', '2': 'rest', '3': 'training', '4': 'rest', '5': 'training', '6': 'rest' },
  },
  training: { templates: [], sessions: [], checkIns: [], requests: [], reviews: [], scheduledDates: [] },
};
const running: AgentRun = {
  id: 'synthetic-running-request', status: 'running', prompt: 'Plan a practical training week',
  referenceDate: '2026-10-24', baseRevision: 3,
  createdAt: '2026-10-24T10:00:00.000Z', updatedAt: '2026-10-24T10:00:00.000Z',
};
function text(instance: ReactTestInstance): string {
  return instance.children.map(child => typeof child === 'string' ? child : text(child)).join('');
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify({ json: value }), { status, headers: { 'Content-Type': 'application/json' } });
}

test('rendered agent recovers from poll and connection refresh failures and stops observing a terminal run', async t => {
  const generated = join(project, 'tests/.generated');
  await mkdir(generated, { recursive: true });
  const directory = await mkdtemp(join(generated, 'agent-polling-ui-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rmdir(generated).catch(() => {});
  });
  const bundle = join(directory, 'agent-polling.mjs');
  await build({
    // Export the component and its real cache from one graph, not separate bundles.
    stdin: {
      contents: "export { default as AgentPanel } from './src/agent-panel.tsx'; export { queryClient, privateKey } from './src/rpc.ts';",
      resolveDir: project, sourcefile: 'agent-polling-test-entry.ts', loader: 'ts',
    },
    outfile: bundle, bundle: true, format: 'esm', platform: 'node', target: 'node24',
    mainFields: ['module', 'main'],
    external: [
      'react', 'react/*', 'react-dom', 'react-dom/*', '@tanstack/react-query', 'lucide-react',
      '@packages/nutrition/*', '@packages/training/*', '@packages/workspace/*', '@packages/agent/*',
    ],
    loader: { '.css': 'empty' }, jsx: 'automatic',
    banner: { js: "import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire(import.meta.url);" },
    tsconfig: join(project, 'tsconfig.json'), logLevel: 'silent',
  });
  // The generated bundle path is runtime-selected and must be imported after compilation.
  const { AgentPanel, queryClient, privateKey } = await import(pathToFileURL(bundle).href) as
    Pick<typeof Runtime, 'queryClient' | 'privateKey'> & {
      AgentPanel: ComponentType<{ state: AppState; revision: number; referenceDate: string; onRefresh: () => void }>;
    };
  notifyManager.setScheduler(queueMicrotask);
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'window', {
    configurable: true, value: Object.assign(new EventTarget(), {
      location: { origin: 'https://corner.test', assign: () => assert.fail('No provider navigation is expected.') },
    }),
  });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  let renderer: ReactTestRenderer | undefined;
  t.after(async () => {
    if (renderer) await act(async () => renderer!.unmount());
    queryClient.clear();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (originalAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalAct);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  });
  const originalConsoleError = console.error;
  t.mock.method(console, 'error', (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('react-test-renderer is deprecated.')) return;
    originalConsoleError(...args);
  });
  let mode: 'running' | 'failure' | 'recovered' | 'terminal' = 'running';
  let detailCalls = 0;
  let connectionFailure = false;
  const failure = 'Your request could not be refreshed. Please try again.';
  t.mock.method(globalThis, 'fetch', async (request: string | URL | Request) => {
    const url = new URL(typeof request === 'string' ? request : request instanceof URL ? request.href : request.url);
    assert.equal(url.origin, 'https://corner.test');
    if (url.pathname === '/api/rpc/agent/list') return json({ runs: [running] });
    if (url.pathname === '/api/rpc/ai/connection') {
      if (connectionFailure) return json({ defined: true, code: 'SERVICE_UNAVAILABLE', status: 503, message: 'Connection refresh failed.' }, 503);
      return json({
        available: true, connected: true, enabled: true, state: 'connected', model: null, models: [],
      });
    }
    if (url.pathname === '/api/rpc/agent/get') {
      detailCalls += 1;
      if (mode === 'failure') return json({ defined: true, code: 'SERVICE_UNAVAILABLE', status: 503, message: failure }, 503);
      return json({ run: {
        ...running,
        status: mode === 'terminal' ? 'cancelled' : 'running',
        updatedAt: mode === 'running' ? running.updatedAt : '2026-10-24T10:02:00.000Z',
      } });
    }
    throw new Error(`Unexpected synthetic request: ${url.pathname}`);
  });
  await act(async () => {
    renderer = create(createElement(QueryClientProvider, { client: queryClient }, createElement(AgentPanel, {
      state, revision: 3, referenceDate: running.referenceDate, onRefresh: () => {},
    })));
  });
  assert.match(text(renderer!.root), /Your agent is working/);
  const detailKey = [...privateKey('run'), running.id];
  mode = 'failure';
  await act(async () => { await queryClient.refetchQueries({ queryKey: detailKey, exact: true, type: 'active' }); });
  assert.match(text(renderer!.root), /Your request could not be refreshed/);
  assert.match(text(renderer!.root), /Your agent is working/);
  assert.match(text(renderer!.root), /Plan a practical training week/);

  mode = 'recovered';
  await act(async () => { await queryClient.refetchQueries({ queryKey: detailKey, exact: true, type: 'active' }); });
  assert.doesNotMatch(text(renderer!.root), /Your request could not be refreshed/);
  assert.match(text(renderer!.root), /Your agent is working/);

  mode = 'terminal';
  await act(async () => { await queryClient.refetchQueries({ queryKey: detailKey, exact: true, type: 'active' }); });
  assert.match(text(renderer!.root), /Request cancelled\. No proposal was applied/);
  assert.doesNotMatch(text(renderer!.root), /Your agent is working/);
  const terminalDetailCalls = detailCalls;
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: privateKey('runs'), exact: true, type: 'active' });
    await queryClient.refetchQueries({ queryKey: detailKey, exact: true, type: 'active' });
  });
  assert.equal(detailCalls, terminalDetailCalls, 'Terminal detail must no longer have an active polling consumer.');
  assert.match(text(renderer!.root), /Request cancelled\. No proposal was applied/);
  const refreshConnection = () => renderer!.root.findAllByType('button')
    .find(button => button.props['aria-label'] === 'Refresh AI connection')!;
  assert.match(text(renderer!.root), /Connected and ready/);
  connectionFailure = true;
  await act(async () => { refreshConnection().props.onClick(); });
  assert.match(text(renderer!.root), /Connection refresh failed/);
  connectionFailure = false;
  assert.equal(refreshConnection().props.disabled, false);
  await act(async () => { refreshConnection().props.onClick(); });
  assert.doesNotMatch(text(renderer!.root), /Connection refresh failed/);
  assert.match(text(renderer!.root), /Connected and ready/);
});
