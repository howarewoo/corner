import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { act, createElement, type ComponentType } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { BrowserRouter } from 'react-router';
import type { AccountPolicy, AccountRoute } from '../src/account-access.tsx';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';

// Actual rendered account screens, their effects, and event handlers. Every
// HTTP response and navigation is synthetic; no account or email is created.
const project = dirname(dirname(fileURLToPath(import.meta.url)));
const origin = 'https://corner.example.test';
const hosted: AccountPolicy = { emailVerificationRequired: true, passwordResetAvailable: true };
const local: AccountPolicy = { emailVerificationRequired: false, passwordResetAvailable: false };
const password = 'a-long-test-passphrase';
const token = 'syntheticResetToken123456';
type Props = { onSignedIn: () => Promise<void>; initialRoute?: AccountRoute };
type AccountComponent = ComponentType<Props>;
type Call = { path: string; init: RequestInit; body: Record<string, unknown> | null };
type Handler = (call: Call) => Response | undefined | Promise<Response | undefined>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
function text(instance: ReactTestInstance): string {
  return instance.children
    .map((child) => (typeof child === 'string' ? child : text(child)))
    .join('');
}
function button(renderer: ReactTestRenderer, label: string) {
  const result = renderer.root.findAllByType('button').find((item) => text(item).trim() === label);
  assert.ok(result, `Expected rendered button: ${label}`);
  return result;
}
function input(renderer: ReactTestRenderer, name: string) {
  return renderer.root.findAllByType('input').find((item) => item.props.name === name)!;
}
async function change(renderer: ReactTestRenderer, name: string, value: string) {
  const field = input(renderer, name);
  assert.ok(field, `Expected rendered input: ${name}`);
  assert.notEqual(field.props.disabled, true);
  await act(async () => {
    const target = { value };
    field.props.onChange({
      target,
      currentTarget: target,
      nativeEvent: {},
      preventDefault() {},
      stopPropagation() {},
    });
  });
}
async function click(control: ReactTestInstance) {
  assert.notEqual(control.props.disabled, true);
  await act(async () => {
    control.props.onClick({
      button: 0,
      nativeEvent: {},
      preventDefault() {},
      stopPropagation() {},
    });
  });
}
async function submit(renderer: ReactTestRenderer) {
  await act(async () => {
    void renderer.root.findByType('form').props.onSubmit({ preventDefault() {} });
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function browser(url = origin + '/') {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  let current = new URL(url);
  const replaced: string[] = [];
  const target = Object.assign(new EventTarget(), {
    location: {
      get origin() {
        return current.origin;
      },
      get href() {
        return current.href;
      },
      get pathname() {
        return current.pathname;
      },
      get search() {
        return current.search;
      },
      get hash() {
        return current.hash;
      },
    },
    history: {
      state: null as unknown,
      replaceState(state: unknown, _title: string, destination?: string) {
        this.state = state;
        if (destination) {
          replaced.push(destination);
          current = new URL(destination, current);
        }
      },
      pushState(state: unknown, _title: string, destination: string) {
        this.state = state;
        current = new URL(destination, current);
      },
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: target,
  });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  });
  return {
    replaced,
    location: target.location,
    restore() {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
      if (originalAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalAct);
      else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    },
  };
}

async function render(
  t: TestContext,
  Component: AccountComponent,
  policy: AccountPolicy,
  options: { url?: string; route?: AccountRoute; handler?: Handler } = {},
) {
  const environment = browser(options.url);
  const calls: Call[] = [];
  const state = { signedIn: 0 };
  t.mock.method(
    globalThis,
    'fetch',
    async (request: string | URL | Request, init: RequestInit = {}) => {
      if (request instanceof Request) init = { ...init, method: request.method, body: await request.clone().text() };
      const url = new URL(
        typeof request === 'string' ? request : request instanceof URL ? request.href : request.url,
        origin,
      );
      assert.equal(url.origin, origin, 'Account screens must call only this Corner installation.');
      const call = {
        path: url.pathname,
        init,
        body: init.body ? JSON.parse(String(init.body)) : null,
      };
      calls.push(call);
      const override = await options.handler?.(call);
      if (override) return override;
      if (url.pathname === '/api/rpc/account/policy') return json({ json: policy });
      throw new Error(`Unexpected synthetic account request: ${url.pathname}`);
    },
  );
  let renderer!: ReactTestRenderer;
  let unmounted = false;
  const unmount = async () => {
    if (!unmounted && renderer) {
      unmounted = true;
      await act(async () => renderer.unmount());
    }
  };
  t.after(async () => {
    try {
      await unmount();
    } finally {
      environment.restore();
    }
  });
  await act(async () => {
    renderer = create(
      createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(
        BrowserRouter,
        { window: window },
        createElement(Component, {
          initialRoute: options.route,
          onSignedIn: async () => {
            state.signedIn += 1;
          },
        }),
      ),
      ),
    );
  });
  return { renderer, calls, state, unmount, ...environment };
}

test('rendered standalone account verification and password recovery', async (t) => {
  notifyManager.setScheduler(queueMicrotask);
  const generated = join(project, 'tests', '.generated');
  await mkdir(generated, { recursive: true });
  const directory = await mkdtemp(join(generated, 'account-ui-'));
  const bundle = join(directory, 'account-access.mjs');
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rmdir(generated).catch(() => {});
  });
  await build({
    entryPoints: [join(project, 'src', 'account-access.tsx')],
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
      'react-router',
      'lucide-react',
      '@neondatabase/auth',
      '@neondatabase/auth/*',
      '@packages/shared/*',
    ],
    banner: {
      js: "import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire(import.meta.url);",
    },
    loader: { '.css': 'empty' },
    jsx: 'automatic',
    tsconfig: join(project, 'tsconfig.json'),
    logLevel: 'silent',
  });
  const { default: AccountAccess, readAccountRoute } = (await import(
    pathToFileURL(bundle).href
  )) as {
    default: AccountComponent;
    readAccountRoute: (location?: Pick<Location, 'pathname' | 'search'>) => AccountRoute;
  };
  const originalError = console.error;
  t.mock.method(console, 'error', (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('react-test-renderer is deprecated.'))
      return;
    originalError(...args);
  });

  await t.test(
    'local no-mail signup retains immediate sign-in and does not offer unavailable reset',
    async (child) => {
      const view = await render(child, AccountAccess, local, {
        handler: (call) =>
          call.path === '/api/auth/sign-up/email'
            ? json({ token: 'synthetic-session' })
            : undefined,
      });
      assert.equal(
        view.renderer.root
          .findAllByType('button')
          .some((item) => text(item).includes('Forgot password')),
        false,
      );
      assert.match(text(view.renderer.root), /Password recovery isn’t available/);
      await click(button(view.renderer, 'Create account'));
      await change(view.renderer, 'name', 'Test User');
      await change(view.renderer, 'email', 'new@example.test');
      await change(view.renderer, 'password', password);
      await submit(view.renderer);
      assert.equal(view.state.signedIn, 1);
      const request = view.calls.find((call) => call.path === '/api/auth/sign-up/email')!;
      assert.equal(request.init.credentials, 'same-origin');
      assert.equal(request.body?.name, 'Test User');
      assert.equal(
        view.calls.some((call) => call.path.includes('password-reset')),
        false,
      );
    },
  );

  await t.test(
    'verified signup requires the check-email screen and never reports a logged-in session',
    async (child) => {
      const view = await render(child, AccountAccess, hosted, {
        handler: (call) =>
          call.path === '/api/auth/sign-up/email'
            ? json({ token: null, user: { email: 'new@example.test' } })
            : undefined,
      });
      await click(button(view.renderer, 'Create account'));
      await change(view.renderer, 'name', 'Test User');
      await change(view.renderer, 'email', 'new@example.test');
      await change(view.renderer, 'password', password);
      await submit(view.renderer);
      assert.match(text(view.renderer.root), /Check your email/);
      assert.equal(view.state.signedIn, 0);
      assert.equal(
        view.renderer.root.findAllByType('input').filter((item) => item.props.type === 'password')
          .length,
        0,
      );
      await click(button(view.renderer, 'Return to sign in'));
      assert.equal(input(view.renderer, 'password').props.value, '');
      assert.equal(input(view.renderer, 'email').props.value, 'new@example.test');
    },
  );

  await t.test(
    'unverified sign-in and rejected codes cannot authenticate; a confirmed code returns to sign-in',
    async (child) => {
      let verified = false;
      const view = await render(child, AccountAccess, hosted, {
        handler: (call) => {
          if (call.path === '/api/auth/sign-in/email')
            return verified
              ? json({ user: { id: 'verified-user' } })
              : json({ code: 'EMAIL_NOT_VERIFIED', message: 'Email not verified' }, 403);
          if (call.path === '/api/auth/email-otp/send-verification-otp')
            return json({ status: true });
          if (call.path === '/api/auth/email-otp/verify-email') {
            if (call.body?.otp !== '123456')
              return json({ code: 'INVALID_OTP', message: 'The code is invalid.' }, 400);
            verified = true;
            return json({ status: true });
          }
        },
      });
      await change(view.renderer, 'email', 'person@example.test');
      await change(view.renderer, 'password', password);
      await submit(view.renderer);
      assert.equal(view.state.signedIn, 0);
      await click(button(view.renderer, 'Resend verification code'));
      assert.equal(view.state.signedIn, 0);
      await change(view.renderer, 'verificationCode', '654321');
      await submit(view.renderer);
      assert.ok(input(view.renderer, 'verificationCode'));
      assert.equal(view.state.signedIn, 0);
      await change(view.renderer, 'verificationCode', '123456');
      await submit(view.renderer);
      assert.equal(input(view.renderer, 'verificationCode'), undefined);
      assert.equal(view.state.signedIn, 0);
      await change(view.renderer, 'password', password);
      await submit(view.renderer);
      assert.equal(view.state.signedIn, 1);
    },
  );

  await t.test(
    'forgot password requests a same-origin reset and shows only a conditional confirmation',
    async (child) => {
      const view = await render(child, AccountAccess, hosted, {
        handler: (call) =>
          call.path === '/api/auth/request-password-reset'
            ? json({
                status: true,
                message: 'Synthetic response must not be displayed as account proof.',
              })
            : undefined,
      });
      await click(button(view.renderer, 'Forgot password?'));
      await change(view.renderer, 'email', 'unknown@example.test');
      await submit(view.renderer);
      assert.deepEqual(
        view.calls.find((call) => call.path === '/api/auth/request-password-reset')?.body,
        { email: 'unknown@example.test', redirectTo: `${origin}/account/reset-password` },
      );
      assert.match(text(view.renderer.root), /If there’s an account for unknown@example.test/);
      assert.doesNotMatch(text(view.renderer.root), /Synthetic response/);
      assert.equal(view.state.signedIn, 0);
    },
  );

  await t.test(
    'reset requires 12 characters and matching confirmation, keeps the token out of the URL, then returns to sign-in',
    async (child) => {
      const url = `${origin}/account/reset-password?token=${token}`;
      const view = await render(child, AccountAccess, hosted, {
        url,
        route: readAccountRoute(new URL(url)),
        handler: (call) =>
          call.path === '/api/auth/reset-password' ? json({ status: true }) : undefined,
      });
      assert.equal(view.location.search, '');
      assert.doesNotMatch(text(view.renderer.root), new RegExp(token));
      assert.equal(input(view.renderer, 'newPassword').props.minLength, 12);
      assert.equal(input(view.renderer, 'confirmPassword').props.minLength, 12);
      await change(view.renderer, 'newPassword', 'short');
      await change(view.renderer, 'confirmPassword', 'short');
      await submit(view.renderer);
      assert.match(text(view.renderer.root), /between 12 and 128 characters/);
      assert.equal(
        view.calls.some((call) => call.path === '/api/auth/reset-password'),
        false,
      );
      await change(view.renderer, 'newPassword', password);
      await change(view.renderer, 'confirmPassword', `${password}different`);
      await submit(view.renderer);
      assert.match(text(view.renderer.root), /passwords don’t match/);
      assert.equal(
        view.calls.some((call) => call.path === '/api/auth/reset-password'),
        false,
      );
      await change(view.renderer, 'confirmPassword', password);
      await submit(view.renderer);
      assert.deepEqual(view.calls.find((call) => call.path === '/api/auth/reset-password')?.body, {
        newPassword: password,
        token,
      });
      assert.match(text(view.renderer.root), /Your password has been changed/);
      assert.equal(view.state.signedIn, 0);
      await click(button(view.renderer, 'Sign in'));
      assert.equal(input(view.renderer, 'password').props.value, '');
      assert.match(text(view.renderer.root), /Use your new password to sign in/);
    },
  );

  await t.test(
    'missing, duplicate, or invalid reset query values cannot submit a reset',
    async (child) => {
      assert.deepEqual(
        readAccountRoute({
          pathname: '/account/reset-password',
          search: `?token=${token}&token=${token}`,
        }),
        { kind: 'reset', token: null },
      );
      assert.deepEqual(
        readAccountRoute({
          pathname: '/account/reset-password',
          search: `?token=${token}&error=INVALID_TOKEN`,
        }),
        { kind: 'reset', token: null },
      );
      const view = await render(child, AccountAccess, hosted, {
        url: `${origin}/account/reset-password?error=INVALID_TOKEN`,
        route: { kind: 'reset', token: null },
      });
      assert.match(text(view.renderer.root), /missing, invalid, or has expired/);
      assert.equal(view.renderer.root.findAllByType('form').length, 0);
      await click(button(view.renderer, 'Request a new reset link'));
      assert.ok(input(view.renderer, 'email'));
      assert.equal(
        view.calls.some((call) => call.path === '/api/auth/reset-password'),
        false,
      );
    },
  );

  await t.test(
    'a consumed or expired token response removes password fields and offers another request',
    async (child) => {
      const view = await render(child, AccountAccess, hosted, {
        url: `${origin}/account/reset-password?token=${token}`,
        route: { kind: 'reset', token },
        handler: (call) =>
          call.path === '/api/auth/reset-password'
            ? json({ code: 'INVALID_TOKEN', message: 'Invalid token' }, 400)
            : undefined,
      });
      await change(view.renderer, 'newPassword', password);
      await change(view.renderer, 'confirmPassword', password);
      await submit(view.renderer);
      assert.match(text(view.renderer.root), /This reset link can’t be used/);
      assert.equal(view.renderer.root.findAllByType('input').length, 0);
      assert.ok(button(view.renderer, 'Request a new reset link'));
      assert.equal(view.state.signedIn, 0);
    },
  );

  await t.test(
    'local no-mail reset routes show recovery guidance without an unusable form',
    async (child) => {
      const view = await render(child, AccountAccess, local, {
        url: `${origin}/account/reset-password?token=${token}`,
        route: { kind: 'reset', token },
      });
      assert.match(text(view.renderer.root), /Password recovery isn’t available/);
      assert.equal(view.renderer.root.findAllByType('form').length, 0);
      assert.equal(view.calls.length, 1);
    },
  );

  await t.test(
    'duplicate submit is guarded and a late reset-request response cannot replace a screen the user left',
    async (child) => {
      const pending = deferred<Response>();
      const view = await render(child, AccountAccess, hosted, {
        handler: (call) =>
          call.path === '/api/auth/request-password-reset' ? pending.promise : undefined,
      });
      await click(button(view.renderer, 'Forgot password?'));
      await change(view.renderer, 'email', 'person@example.test');
      const form = view.renderer.root.findByType('form');
      await act(async () => {
        void form.props.onSubmit({ preventDefault() {} });
        void form.props.onSubmit({ preventDefault() {} });
      });
      assert.equal(
        view.calls.filter((call) => call.path === '/api/auth/request-password-reset').length,
        1,
      );
      assert.equal(button(view.renderer, 'Please wait…').props.disabled, true);
      await click(button(view.renderer, 'Back to sign in'));
      assert.equal(
        view.calls.find((call) => call.path === '/api/auth/request-password-reset')?.init.signal
          ?.aborted,
        true,
      );
      await act(async () => {
        pending.resolve(json({ status: true }));
      });
      assert.match(text(view.renderer.root), /Welcome back/);
      assert.doesNotMatch(text(view.renderer.root), /If there’s an account for/);
      assert.ok(input(view.renderer, 'password'));
    },
  );

  await t.test(
    'a sign-in response after unmount cannot report a new account session',
    async (child) => {
      const pending = deferred<Response>();
      const view = await render(child, AccountAccess, local, {
        handler: (call) => (call.path === '/api/auth/sign-in/email' ? pending.promise : undefined),
      });
      await change(view.renderer, 'email', 'person@example.test');
      await change(view.renderer, 'password', password);
      await submit(view.renderer);
      await view.unmount();
      await act(async () => {
        pending.resolve(json({ token: 'synthetic-session' }));
      });
      assert.equal(view.state.signedIn, 0);
    },
  );

  await t.test(
    'failed account-policy loading blocks credentials until a successful retry',
    async (child) => {
      let failures = 1;
      const view = await render(child, AccountAccess, hosted, {
        handler: (call) =>
          call.path === '/api/rpc/account/policy' && failures-- > 0
            ? json({ json: { defined: true, code: 'SERVICE_UNAVAILABLE', status: 503, message: 'Temporarily unavailable' } }, 503)
            : undefined,
      });
      assert.match(text(view.renderer.root), /Account options could not be loaded/);
      assert.equal(
        view.renderer.root.findAllByType('button').find((item) => item.props.type === 'submit')
          ?.props.disabled,
        true,
      );
      await click(button(view.renderer, 'Retry account options'));
      assert.equal(
        view.renderer.root.findAllByType('button').find((item) => item.props.type === 'submit')
          ?.props.disabled,
        false,
      );
      assert.ok(button(view.renderer, 'Forgot password?'));
    },
  );
});
