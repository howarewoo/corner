import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { act, createElement, type ComponentType } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { rpc, scoped, clearPrivateState, errorCode } from '../src/rpc.ts';

// Render the actual production control. This is not a second implementation of
// its enable/disable logic. CSS is omitted only from the Node test bundle; all
// React effects, API calls, event handlers, labels, and notices remain intact.
// Every request and navigation below is synthetic and stays in this process.
const project = dirname(dirname(fileURLToPath(import.meta.url)));
const localOrigin = 'http://127.0.0.1:3000';
const authorizationURL =
  'https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&state=synthetic-ui-test-state';

type Connection = {
  available: boolean;
  connected: boolean;
  enabled: boolean;
  state: string;
  reason: string;
  model: string | null;
  models: Array<{ slug: string; displayName: string }>;
  email?: string;
  manageUsageUrl?: string;
};

const disconnected: Connection = {
  available: false,
  connected: false,
  enabled: true,
  state: 'disconnected',
  reason: 'Connect your ChatGPT plan to use the Corner agent.',
  model: null,
  models: [],
  manageUsageUrl: 'https://chatgpt.com/',
};
const connected: Connection = {
  ...disconnected,
  available: true,
  connected: true,
  state: 'connected',
  reason: 'Using your ChatGPT plan. Corner uses only the information you enter here.',
  email: 'test-person@example.test',
  model: 'test-model-a',
  models: [
    { slug: 'test-model-a', displayName: 'Test Model A' },
    { slug: 'test-model-b', displayName: 'Test Model B' },
  ],
};

type FetchCall = { path: string; init: RequestInit };
type MockHandler = (call: FetchCall) => Response | undefined | Promise<Response | undefined>;
type TestConnectionComponent = ComponentType<{ onChanged?: () => void; compact?: boolean }>;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify({ json: value }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function text(instance: ReactTestInstance): string {
  return instance.children
    .map((child) => (typeof child === 'string' ? child : text(child)))
    .join('');
}

function button(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const found = renderer.root
    .findAllByType('button')
    .find((instance) => text(instance).trim() === label);
  assert.ok(found, `Expected a rendered button labeled "${label}".`);
  return found;
}

function installBrowser() {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  const navigation: string[] = [];
  const events: string[] = [];
  const target = new EventTarget();
  const browser = Object.assign(target, {
    location: {
      origin: localOrigin,
      assign: (destination: string) => navigation.push(destination),
    },
  });
  browser.addEventListener('corner:session-expired', (event) => events.push(event.type));
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: browser,
  });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  });
  const restore = () => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (originalAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalAct);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  };
  return { navigation, events, restore };
}

async function renderConnection(
  t: TestContext,
  Component: TestConnectionComponent,
  initial: Connection,
  handler?: MockHandler,
) {
  const browser = installBrowser();
  const state = { connection: structuredClone(initial) };
  const calls: FetchCall[] = [];
  const mockFetch: typeof fetch = async (input, init = {}) => {
    if (input instanceof Request) init = { ...init, method: input.method, body: await input.clone().text() };
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      localOrigin,
    );
    assert.equal(url.origin, localOrigin, 'The UI must not directly call an external provider.');
    const call = { path: url.pathname, init };
    calls.push(call);
    const overridden = await handler?.(call);
    if (overridden) return overridden;
    if (call.path === '/api/rpc/ai/connection') return json(state.connection);
    if (call.path === '/api/rpc/ai/connect') return json({ url: authorizationURL });
    if (call.path === '/api/rpc/ai/setModel') {
      const model = JSON.parse(String(init.body)).json.model as string;
      state.connection = { ...state.connection, model };
      return json(state.connection);
    }
    throw new Error(`Unexpected synthetic UI request: ${call.path}`);
  };
  t.mock.method(globalThis, 'fetch', mockFetch);
  let renderer!: ReactTestRenderer;
  t.after(async () => {
    try {
      if (renderer) await act(async () => renderer.unmount());
    } finally {
      browser.restore();
    }
  });
  await act(async () => {
    renderer = create(
      createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        createElement(Component),
      ),
    );
  });
  return { renderer, calls, state, ...browser };
}

async function click(control: ReactTestInstance): Promise<void> {
  assert.notEqual(control.props.disabled, true, 'Only an enabled rendered control can be clicked.');
  await act(async () => {
    control.props.onClick({
      button: 0,
      nativeEvent: {},
      preventDefault() {},
      stopPropagation() {},
    });
  });
}

test('rendered ChatGPT connection controls and independent Corner session handling', async (t) => {
  notifyManager.setScheduler(queueMicrotask);
  const generated = join(project, 'tests', '.generated');
  await mkdir(generated, { recursive: true });
  const directory = await mkdtemp(join(generated, 'connection-ui-'));
  const bundle = join(directory, 'agent-panel.mjs');
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rmdir(generated).catch(() => {}); // Another test process may own a sibling.
  });
  await build({
    entryPoints: [join(project, 'src', 'agent-panel.tsx')],
    outfile: bundle,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    mainFields: ['module', 'main'],
    external: [
      '@tanstack/react-query',
      'react',
      'react/*',
      'react-dom',
      'react-dom/*',
      'lucide-react',
      '@neondatabase/auth',
      '@neondatabase/auth/*',
      '@packages/nutrition/*',
      '@packages/training/*',
      '@packages/workspace/*',
      '@packages/agent/*',
    ],
    loader: { '.css': 'empty' },
    jsx: 'automatic',
    banner: {
      js: "import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire(import.meta.url);",
    },
    tsconfig: join(project, 'tsconfig.json'),
    logLevel: 'silent',
  });
  const { AgentConnection } = (await import(pathToFileURL(bundle).href)) as {
    AgentConnection: TestConnectionComponent;
  };
  const originalConsoleError = console.error;
  t.mock.method(console, 'error', (...args: unknown[]) => {
    // React 19 emits this library-level deprecation for every create(). Preserve
    // all actual render, effect, and act warnings so regressions remain visible.
    if (typeof args[0] === 'string' && args[0].startsWith('react-test-renderer is deprecated.'))
      return;
    originalConsoleError(...args);
  });

  await t.test(
    'a first local connection is actionable before a subscription or model exists',
    async (child) => {
      const view = await renderConnection(child, AgentConnection, disconnected);
      assert.equal(button(view.renderer, 'Continue with ChatGPT').props.disabled, false);
      assert.match(text(view.renderer.root), /Connect to use the agent/);
      assert.doesNotMatch(text(view.renderer.root), /Connected and ready/);
      assert.equal(view.renderer.root.findAllByType('select').length, 0);
      assert.equal(view.calls.filter((call) => call.path === '/api/rpc/ai/connect').length, 0);
    },
  );

  await t.test(
    'a hosted integration stays disabled and explains its actual availability',
    async (child) => {
      const view = await renderConnection(child, AgentConnection, {
        ...disconnected,
        enabled: false,
        state: 'unavailable',
        reason: 'Hosted integrations require OpenAI partner approval.',
      });
      assert.equal(button(view.renderer, 'Continue with ChatGPT').props.disabled, true);
      assert.match(text(view.renderer.root), /Agent unavailable/);
      assert.match(text(view.renderer.root), /Hosted integrations require OpenAI partner approval/);
      assert.equal(view.calls.filter((call) => call.path === '/api/rpc/ai/connect').length, 0);
    },
  );

  await t.test(
    'clicking the first connection performs the real POST handler and browser navigation',
    async (child) => {
      const view = await renderConnection(child, AgentConnection, disconnected);
      await click(button(view.renderer, 'Continue with ChatGPT'));
      const request = view.calls.find((call) => call.path === '/api/rpc/ai/connect');
      assert.ok(request);
      assert.equal(request.init.method, 'POST');
      assert.equal(request.init.credentials, 'same-origin');
      assert.deepEqual(JSON.parse(String(request.init.body)), { json: {} });
      assert.deepEqual(view.navigation, [authorizationURL]);
      assert.equal(button(view.renderer, 'Opening sign-in…').props.disabled, true);
    },
  );

  await t.test(
    'a linked identity without plan permission can reconnect directly',
    async (child) => {
      const view = await renderConnection(child, AgentConnection, {
        ...connected,
        available: false,
        state: 'permission_required',
        model: null,
        models: [],
        reason:
          'Your account is connected, but permission to use your ChatGPT plan was not granted.',
      });
      const reconnect = button(view.renderer, 'Reconnect with ChatGPT');
      assert.equal(reconnect.props.disabled, false);
      assert.equal(button(view.renderer, 'Disconnect').props.disabled, false);
      assert.match(text(view.renderer.root), /Connected · action needed/);
      assert.doesNotMatch(text(view.renderer.root), /Connected and ready/);
      await click(reconnect);
      assert.deepEqual(view.navigation, [authorizationURL]);
      assert.equal(
        view.calls.some((call) => call.path === '/api/rpc/ai/disconnect'),
        false,
      );
    },
  );

  await t.test(
    'the actual model selector uses account choices and saves the selected slug',
    async (child) => {
      const view = await renderConnection(child, AgentConnection, connected);
      assert.match(text(view.renderer.root), /Connected and ready/);
      const select = view.renderer.root.findByType('select');
      assert.equal(select.props.disabled, false);
      assert.equal(select.props.value, 'test-model-a');
      assert.deepEqual(
        select.findAllByType('option').map((option) => [option.props.value, text(option)]),
        [
          ['', 'Choose a model'],
          ['test-model-a', 'Test Model A'],
          ['test-model-b', 'Test Model B'],
        ],
      );
      await act(async () => {
        select.props.onChange({ target: { value: 'test-model-b' } });
      });
      assert.deepEqual(
        JSON.parse(String(view.calls.find((call) => call.path === '/api/rpc/ai/setModel')?.init.body)),
        { json: { model: 'test-model-b' } },
      );
      assert.equal(view.renderer.root.findByType('select').props.value, 'test-model-b');
      assert.match(text(view.renderer.root), /Model selection saved/);
      assert.ok(
        view.renderer.root
          .findAllByType('a')
          .some((link) => link.props.href === 'https://chatgpt.com/'),
      );
    },
  );

  await t.test(
    'a cached model does not override a failed current readiness check',
    async (child) => {
      const view = await renderConnection(child, AgentConnection, {
        ...connected,
        available: false,
        reason: 'ChatGPT plan routing is temporarily unavailable. Please try again later.',
      });
      assert.doesNotMatch(text(view.renderer.root), /Connected and ready/);
      assert.match(text(view.renderer.root), /Connected · action needed/);
      assert.match(text(view.renderer.root), /temporarily unavailable/);
      assert.equal(button(view.renderer, 'Reconnect with ChatGPT').props.disabled, false);
    },
  );

  await t.test(
    'an unconfirmed remote revoke remains visible after status refresh',
    async (child) => {
      let view: Awaited<ReturnType<typeof renderConnection>>;
      const warning =
        'Disconnected in Corner. Remote revocation was not confirmed; you can also remove Corner in ChatGPT settings.';
      view = await renderConnection(child, AgentConnection, connected, (call) => {
        if (call.path !== '/api/rpc/ai/disconnect') return undefined;
        view.state.connection = { ...disconnected, email: connected.email };
        return json({ ...disconnected, revocationConfirmed: false, reason: warning });
      });
      await click(button(view.renderer, 'Disconnect'));
      assert.match(text(view.renderer.root), /Remote revocation was not confirmed/);
      assert.equal(button(view.renderer, 'Continue with ChatGPT').props.disabled, false);
      assert.ok(
        view.renderer.root
          .findAllByType('a')
          .some((link) => text(link).includes('Open ChatGPT settings')),
      );
      const refresh = view.renderer.root
        .findAllByType('button')
        .find((control) => control.props['aria-label'] === 'Refresh AI connection');
      assert.ok(refresh);
      await click(refresh);
      assert.match(text(view.renderer.root), /Remote revocation was not confirmed/);
      assert.match(text(view.renderer.root), /reconnecting uses the same ChatGPT identity/);
    },
  );

  await t.test(
    'a provider 401 preserves the independent Corner sign-in, while SIGN_IN_REQUIRED expires it',
    async (child) => {
      const browser = installBrowser();
      child.after(browser.restore);
      clearPrivateState();
      let code = 'CORNER_ERROR';
      child.mock.method(globalThis, 'fetch', async () =>
        json({ defined: true, code, status: 401, message: 'Reconnect the selected connection.', data: { code: 'invalid_grant' } }, 401),
      );
      await assert.rejects(
        scoped(() => rpc.ai.setModel({ model: 'test-model-a' })),
        error => errorCode(error) === 'invalid_grant',
      );
      assert.deepEqual(browser.events, []);
      code = 'SIGN_IN_REQUIRED';
      await assert.rejects(
        scoped(() => rpc.workspace.get()),
        error => errorCode(error) === 'SIGN_IN_REQUIRED',
      );
      assert.deepEqual(browser.events, ['corner:session-expired']);
    },
  );
});
