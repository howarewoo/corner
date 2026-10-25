// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';
import type { Connection } from '@packages/api/contract';
import { AgentConnection } from '../agent-panel';
import { rpc, scoped, clearPrivateState, errorCode, queryClient } from '../rpc';
import { json, mockHttp, type Handler } from './http';

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
const connected = {
  ...disconnected,
  available: true,
  connected: true,
  state: 'connected',
  email: 'test-person@example.test',
  model: 'test-model-a',
  models: [
    { slug: 'test-model-a', displayName: 'Test Model A' },
    { slug: 'test-model-b', displayName: 'Test Model B' },
  ],
};

async function connection(initial = disconnected, handler?: Handler) {
  const state = { connection: structuredClone(initial) };
  const calls = mockHttp(async (call) => {
    const response = await handler?.(call);
    if (response) return response;
    if (call.path === '/api/rpc/ai/connection') return json({ json: state.connection });
    if (call.path === '/api/rpc/ai/setModel') {
      const input = call.body?.json;
      if (
        !input ||
        typeof input !== 'object' ||
        !('model' in input) ||
        typeof input.model !== 'string'
      )
        throw new Error('Expected a model selection.');
      state.connection.model = input.model;
      return json({ json: state.connection });
    }
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AgentConnection />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.queryByText('Checking connection…')).not.toBeInTheDocument());
  return { state, calls, user: userEvent.setup() };
}

test('first local connection is actionable without a model or subscription', async () => {
  const view = await connection();
  expect(screen.getByRole('button', { name: 'Continue with ChatGPT' })).toBeEnabled();
  expect(screen.queryByRole('combobox', { name: 'Model' })).not.toBeInTheDocument();
  expect(view.calls.some((call) => call.path === '/api/rpc/ai/connect')).toBe(false);
});

test('hosted connection is disabled rather than pretending AI is available', async () => {
  const view = await connection({
    ...disconnected,
    enabled: false,
    state: 'unavailable',
    reason: 'Hosted integrations require OpenAI partner approval.',
  });
  const control = screen.getByRole('button', { name: 'Continue with ChatGPT' });
  expect(control).toBeDisabled();
  await view.user.click(control);
  expect(view.calls.some((call) => call.path === '/api/rpc/ai/connect')).toBe(false);
});

test('linked identity without permission offers reconnect without disconnecting', async () => {
  const view = await connection({
    ...connected,
    available: false,
    state: 'permission_required',
    model: null,
    models: [],
  });
  expect(screen.getByRole('button', { name: 'Reconnect with ChatGPT' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled();
  expect(view.calls.some((call) => call.path === '/api/rpc/ai/disconnect')).toBe(false);
});

test('model selection saves the account choice and displays the refreshed selection', async () => {
  const view = await connection(connected);
  await view.user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'test-model-b');
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Model' })).toBeEnabled());
  expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('test-model-b');
  expect(view.calls.find((call) => call.path === '/api/rpc/ai/setModel')?.body).toEqual({
    json: { model: 'test-model-b' },
  });
  expect(screen.getByRole('link', { name: /manage ai usage/i })).toHaveAttribute(
    'href',
    'https://chatgpt.com/',
  );
});

test('a cached model cannot override current failed readiness', async () => {
  await connection({
    ...connected,
    available: false,
    reason: 'ChatGPT plan routing is temporarily unavailable.',
  });
  expect(screen.getByRole('button', { name: 'Reconnect with ChatGPT' })).toBeEnabled();
  expect(screen.getByRole('status')).not.toHaveTextContent('Connected and ready');
  expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('test-model-a');
});

test('unconfirmed remote revocation remains actionable after status refresh', async () => {
  const warning = 'Remote revocation was not confirmed.';
  const view = await connection(connected, (call) =>
    call.path === '/api/rpc/ai/disconnect'
      ? json({ json: { ...disconnected, revocationConfirmed: false, reason: warning } })
      : undefined,
  );
  view.state.connection = { ...disconnected };
  await view.user.click(screen.getByRole('button', { name: 'Disconnect' }));
  expect(await screen.findByRole('link', { name: /open chatgpt settings/i })).toHaveAttribute(
    'href',
    'https://chatgpt.com/#settings',
  );
  await view.user.click(screen.getByRole('button', { name: 'Refresh AI connection' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Refresh AI connection' })).toBeEnabled(),
  );
  expect(screen.getByRole('link', { name: /open chatgpt settings/i })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Continue with ChatGPT' })).toBeEnabled();
});

test('provider failure preserves Corner sign-in; SIGN_IN_REQUIRED expires it', async () => {
  clearPrivateState();
  let code = 'CORNER_ERROR';
  const expired = vi.fn();
  window.addEventListener('corner:session-expired', expired);
  try {
    mockHttp(() =>
      json(
        {
          json: {
            defined: true,
            code,
            status: 401,
            message: 'Reconnect the selected connection.',
            data: { code: 'invalid_grant' },
          },
        },
        401,
      ),
    );
    await expect(scoped(() => rpc.ai.setModel({ model: 'test-model-a' }))).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === 'invalid_grant',
    );
    expect(expired).not.toHaveBeenCalled();
    code = 'SIGN_IN_REQUIRED';
    await expect(scoped(() => rpc.workspace.get())).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === 'SIGN_IN_REQUIRED',
    );
    expect(expired).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener('corner:session-expired', expired);
  }
});
