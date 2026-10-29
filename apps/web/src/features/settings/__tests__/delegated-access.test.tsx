// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';
import { DELEGATED_PERMISSIONS } from '@packages/api/delegation';
import { queryClient } from '../../../rpc';
import { json, mockHttp } from '../../../__tests__/http';
import DelegatedConsentScreen, { safeAuthorizeReturn, safeAccountReturn } from '../delegated-consent';
import DelegatedConnections from '../delegated-connections';

const clientName = '<img src="https://untrusted.invalid/icon" onerror="alert(1)">';
const permissions = DELEGATED_PERMISSIONS.slice(0, 2);
const consent = {
  id: 'request-a', clientName, accountName: 'Alex', accountEmail: 'alex@example.test',
  requestedScopes: [...permissions.map(({ scope }) => scope), 'offline_access', 'settings:write'],
  permissions: [...permissions],
};

function mountConsent() {
  return render(<QueryClientProvider client={queryClient}><DelegatedConsentScreen uid="request-a" notify={vi.fn()} /></QueryClientProvider>);
}

test('consent renders untrusted client text and submits only the selected requested read permissions', async () => {
  const calls = mockHttp((call) => call.init.method === 'POST' ? json({ error: 'Request expired. Start again from your client.' }, 400) : json(consent));
  mountConsent();
  expect(await screen.findByText(clientName)).toBeVisible();
  expect(document.querySelector('img')).toBeNull();
  expect(screen.getByText(/alex@example.test/)).toBeVisible();
  expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  await userEvent.click(screen.getByRole('checkbox', { name: permissions[1].label }));
  await userEvent.click(screen.getByRole('button', { name: 'Approve access' }));
  await screen.findByText('Request expired. Start again from your client.');
  expect(calls.find((call) => call.init.method === 'POST')?.body).toEqual({ accepted: true, scopes: [permissions[0].scope] });
  for (const call of calls) {
    expect(call.init.credentials).toBe('same-origin');
    expect(call.init.cache).toBe('no-store');
  }
  expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled();
});

test('denial never sends selected permissions', async () => {
  const calls = mockHttp((call) => call.init.method === 'POST' ? json({ error: 'Request expired' }, 400) : json(consent));
  mountConsent();
  await screen.findByText(clientName);
  await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
  await screen.findByText('Request expired');
  expect(calls.find((call) => call.init.method === 'POST')?.body).toEqual({ accepted: false, scopes: [] });
});

test('meal write permission is independently selectable and discloses autonomous changes', async () => {
  const mealWrite = DELEGATED_PERMISSIONS.find(({ scope }) => scope === 'meal-plans:write')!;
  const requested = [permissions[0], mealWrite];
  const calls = mockHttp((call) => call.init.method === 'POST'
    ? json({ error: 'Request expired' }, 400)
    : json({ ...consent, requestedScopes: requested.map(({ scope }) => scope), permissions: requested }));
  mountConsent();
  await screen.findByText(clientName);
  expect(screen.getByText(/Corner will not ask you to approve each change/)).toBeVisible();
  await userEvent.click(screen.getByRole('checkbox', { name: permissions[0].label }));
  await userEvent.click(screen.getByRole('button', { name: 'Approve access' }));
  await screen.findByText('Request expired');
  expect(calls.find((call) => call.init.method === 'POST')?.body).toEqual({ accepted: true, scopes: ['meal-plans:write'] });
});

test('only the exact local authorize endpoint can resume authorization', () => {
  expect(safeAuthorizeReturn('/oauth/authorize?client_id=synthetic&state=abc')).toBe('/oauth/authorize?client_id=synthetic&state=abc');
  for (const value of [null, 'https://evil.test/oauth/authorize?x=1', '//evil.test/oauth/authorize?x=1', '/oauth/authorize/../consent?x=1', '/oauth/authorize?x=1#secret', '/oauth/authorize?x=1\\evil', '/settings', '/oauth/%61uthorize?x=1']) expect(safeAuthorizeReturn(value)).toBeNull();
  expect(safeAccountReturn('/oauth/consent/request-a')).toBe('/oauth/consent/request-a');
  expect(safeAccountReturn('/oauth/sign-in?returnTo=https%3A%2F%2Fevil.test')).toBeNull();
  expect(safeAccountReturn('/oauth/sign-in?returnTo=%2Foauth%2Fauthorize%3Fx%3D1&returnTo=%2Fsettings')).toBeNull();
});

test('failed revoke preserves connections and permits successful recovery without removing another client', async () => {
  let attempts = 0;
  const notify = vi.fn();
  mockHttp((call) => {
    if (call.init.method === 'POST') return ++attempts === 1 ? json({ error: 'Temporarily unavailable' }, 503) : json({ revoked: true });
    return json({ connections: [
      { id: 'a', clientName, scopes: [permissions[0].scope], createdAt: '2026-10-28T12:00:00Z' },
      { id: 'b', clientName: 'Second client', scopes: [permissions[1].scope], createdAt: '2026-10-28T12:00:00Z' },
    ] });
  });
  render(<QueryClientProvider client={queryClient}><DelegatedConnections preview={false} disabled={false} notify={notify} /></QueryClientProvider>);
  await screen.findByText(clientName);
  const revoke = () => screen.getByRole('button', { name: `Revoke access for ${clientName}` });
  await userEvent.click(revoke());
  await screen.findByText('Temporarily unavailable');
  expect(screen.getByText(clientName)).toBeVisible();
  await userEvent.click(revoke());
  await waitFor(() => expect(screen.queryByText(clientName)).toBeNull());
  expect(screen.getByText('Second client')).toBeVisible();
  expect(notify).toHaveBeenLastCalledWith('Client access revoked');
});

test('preview explains unavailability without requesting private connections', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  render(<QueryClientProvider client={queryClient}><DelegatedConnections preview disabled={false} notify={vi.fn()} /></QueryClientProvider>);
  expect(screen.getByText(/unavailable in preview/)).toBeVisible();
  expect(fetch).not.toHaveBeenCalled();
});
