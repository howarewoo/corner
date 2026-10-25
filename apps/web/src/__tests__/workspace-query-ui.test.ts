import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { act, createElement, useRef } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClientProvider, notifyManager, useMutation } from '@tanstack/react-query';
import type * as Runtime from '../rpc.ts';
import type { StateResponse } from '@packages/workspace/types';
const project = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// Render the production query consumer with controlled native RPC responses.
// A revision is enough here: the consumer never inspects the workspace records.
const snapshot = (revision: number) =>
  ({ revision, state: {}, aiAvailable: false }) as StateResponse;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test('workspace consumer never rolls back and a same-owner new session rejects old writes', async (t) => {
  const generated = join(project, 'tests/.generated');
  await mkdir(generated, { recursive: true });
  const directory = await mkdtemp(join(generated, 'workspace-query-ui-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rmdir(generated).catch(() => {});
  });
  const bundle = join(directory, 'rpc.mjs');
  await build({
    entryPoints: [join(project, 'src/rpc.ts')],
    outfile: bundle,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    external: ['react', '@tanstack/react-query'],
    tsconfig: join(project, 'tsconfig.json'),
    logLevel: 'silent',
  });
  // The compiled module path is generated at runtime, so static imports cannot load it.
  const runtime = (await import(pathToFileURL(bundle).href)) as typeof Runtime;
  notifyManager.setScheduler(queueMicrotask);
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: Object.assign(new EventTarget(), { location: { origin: 'https://corner.test' } }),
  });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  let renderer: ReactTestRenderer | undefined;
  t.after(async () => {
    if (renderer) await act(async () => renderer!.unmount());
    runtime.queryClient.clear();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  });
  const response = deferred<Response>();
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (requests++ === 0) return response.promise;
    return new Response(JSON.stringify({ json: snapshot(2) }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const oldWrite = deferred<StateResponse>();
  const completedWrite = deferred<StateResponse>();
  let writeAttempts = 0;
  let pendingWrite!: Promise<StateResponse>;
  function Consumer() {
    runtime.useSessionLifetime();
    const generation = useRef(runtime.sessionLifetime()).current;
    const workspace = runtime.useWorkspace();
    const write = useMutation({
      mutationFn: () => {
        const result = writeAttempts++ === 0 ? completedWrite : oldWrite;
        return runtime.writeWorkspace(() => result.promise, generation);
      },
      retry: false,
    });
    return createElement(
      'section',
      null,
      createElement('output', null, String(workspace.data?.revision ?? 'loading')),
      createElement(
        'button',
        {
          disabled: write.isPending,
          onClick: () => {
            pendingWrite = write.mutateAsync();
            void pendingWrite.catch(() => {});
          },
        },
        'Save',
      ),
    );
  }
  await act(async () => {
    renderer = create(
      createElement(QueryClientProvider, { client: runtime.queryClient }, createElement(Consumer)),
    );
  });
  await act(async () => {
    runtime.acceptWorkspace(snapshot(9));
    response.resolve(
      new Response(JSON.stringify({ json: snapshot(8) }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await runtime.queryClient.getQueryCache().find({ queryKey: runtime.privateKey('workspace') })
      ?.promise;
  });
  assert.deepEqual(renderer!.root.findByType('output').children, ['9']);
  await act(async () => {
    renderer!.root.findByType('button').props.onClick();
    completedWrite.resolve(snapshot(10));
    await pendingWrite;
  });
  assert.deepEqual(renderer!.root.findByType('output').children, ['10']);
  assert.deepEqual(runtime.queryClient.getMutationCache().getAll()[0]?.state.data, snapshot(10));
  const workspaceQuery = runtime.queryClient.getQueryCache().find<StateResponse>({
    queryKey: runtime.privateKey('workspace'),
  })!;
  const readWorkspace = workspaceQuery.options.queryFn;
  assert.ok(typeof readWorkspace === 'function');
  await act(async () => {
    await workspaceQuery.fetch({
      ...workspaceQuery.options,
      queryFn: async (context) => {
        const read = await readWorkspace(context);
        // A mutation wins after transport resolution but before Query ingests the read.
        runtime.acceptWorkspace(snapshot(11));
        return read;
      },
    });
  });
  assert.deepEqual(renderer!.root.findByType('output').children, ['11']);
  await act(async () => {
    renderer!.root.findByType('button').props.onClick();
  });
  assert.equal(renderer!.root.findByType('button').props.disabled, true);
  const rejectedWrite = assert.rejects(pendingWrite, /session has ended/);
  await act(async () => {
    runtime.clearPrivateState();
    runtime.acceptWorkspace(snapshot(2));
    oldWrite.resolve(snapshot(20));
    await rejectedWrite;
    await Promise.resolve();
  });
  assert.deepEqual(renderer!.root.findByType('output').children, ['2']);
  assert.equal(runtime.queryClient.getMutationCache().getAll().length, 0);
});
