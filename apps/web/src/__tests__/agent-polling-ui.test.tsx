// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { expect, test } from 'vitest';
import type { AgentRun } from '@packages/agent/proposals';
import type { AppState } from '@packages/workspace/types';
import AgentPanel from '../agent-panel';
import { queryClient, privateKey } from '../rpc';
import { json, mockHttp } from './http';

const state: AppState = {
  recipes: [],
  plan: [],
  logs: [],
  groceryChecks: {},
  requests: [],
  settings: {
    name: 'Test person',
    timezone: 'UTC',
    training: { calories: 2000, protein: 120, carbs: 250, fat: 60 },
    rest: { calories: 1800, protein: 120, carbs: 200, fat: 60 },
    schedule: {
      '0': 'rest',
      '1': 'training',
      '2': 'rest',
      '3': 'training',
      '4': 'rest',
      '5': 'training',
      '6': 'rest',
    },
  },
  training: {
    templates: [],
    sessions: [],
    checkIns: [],
    requests: [],
    reviews: [],
    scheduledDates: [],
  },
};
const running: AgentRun = {
  id: 'synthetic-running-request',
  status: 'running',
  prompt: 'Plan a practical training week',
  referenceDate: '2026-10-24',
  baseRevision: 3,
  createdAt: '2026-10-24T10:00:00.000Z',
  updatedAt: '2026-10-24T10:00:00.000Z',
};

test('agent retains its run through poll failure, recovers, and stops observing a terminal run', async () => {
  let mode: 'running' | 'failure' | 'terminal' = 'running';
  let detailCalls = 0;
  let connectionFailure = false;
  mockHttp((call) => {
    if (call.path === '/api/rpc/agent/list') return json({ json: { runs: [running] } });
    if (call.path === '/api/rpc/ai/connection')
      return connectionFailure
        ? json(
            {
              json: {
                defined: true,
                code: 'SERVICE_UNAVAILABLE',
                status: 503,
                message: 'Connection refresh failed.',
              },
            },
            503,
          )
        : json({
            json: {
              available: true,
              connected: true,
              enabled: true,
              state: 'connected',
              model: null,
              models: [],
            },
          });
    if (call.path === '/api/rpc/agent/get') {
      detailCalls += 1;
      if (mode === 'failure')
        return json(
          {
            json: {
              defined: true,
              code: 'SERVICE_UNAVAILABLE',
              status: 503,
              message: 'Your request could not be refreshed.',
            },
          },
          503,
        );
      return json({
        json: {
          run: {
            ...running,
            status: mode === 'terminal' ? 'cancelled' : 'running',
            updatedAt: mode === 'terminal' ? '2026-10-24T10:02:00.000Z' : running.updatedAt,
          },
        },
      });
    }
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AgentPanel
        state={state}
        revision={3}
        referenceDate={running.referenceDate}
        onRefresh={() => {}}
      />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole('button', { name: new RegExp(running.prompt) })).toBeVisible();
  const detailKey = [...privateKey('run'), running.id];
  await waitFor(() => expect(detailCalls).toBe(1));
  mode = 'failure';
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: detailKey, exact: true, type: 'active' });
  });
  expect(await screen.findByText('Your request could not be refreshed.')).toBeVisible();
  expect(screen.getByRole('button', { name: new RegExp(running.prompt) })).toBeVisible();
  mode = 'running';
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: detailKey, exact: true, type: 'active' });
  });
  await waitFor(() =>
    expect(screen.queryByText('Your request could not be refreshed.')).not.toBeInTheDocument(),
  );
  mode = 'terminal';
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: detailKey, exact: true, type: 'active' });
  });
  expect(await screen.findByText(/Request cancelled/)).toBeVisible();
  const terminalDetailCalls = detailCalls;
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: privateKey('runs'), exact: true, type: 'active' });
    await queryClient.refetchQueries({ queryKey: detailKey, exact: true, type: 'active' });
  });
  expect(detailCalls).toBe(terminalDetailCalls);
  const user = userEvent.setup();
  const connection = within(screen.getByRole('region', { name: 'Agent connection' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Refresh AI connection' })).toBeEnabled(),
  );
  connectionFailure = true;
  await user.click(screen.getByRole('button', { name: 'Refresh AI connection' }));
  expect(await connection.findByText('Connection refresh failed.')).toBeVisible();
  connectionFailure = false;
  await user.click(screen.getByRole('button', { name: 'Refresh AI connection' }));
  await waitFor(() =>
    expect(connection.queryByText('Connection refresh failed.')).not.toBeInTheDocument(),
  );
  expect(screen.getByText('Connected and ready')).toBeVisible();
});
