import { createHash } from 'node:crypto';
import { test, expect, signIn } from './browser';

const verifier = 'browser-pkce-verifier-'.repeat(4);
const challenge = createHash('sha256').update(verifier).digest('base64url');

test('fresh sign-in returns to selectable consent, scoped client reads, and Settings revokes access', async ({ page, account, baseURL }) => {
  const redirect = `${baseURL}/oauth/client-fixture`;
  const registered = await page.request.post('/oauth/register', { data: {
    client_name: 'Browser read client', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
  } });
  expect(registered.status()).toBe(201);
  const client = await registered.json();
  await page.route('**/oauth/client-fixture?**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Owned test callback</title><p>Connection returned to the client.</p>' }));
  const authorization = '/oauth/authorize?' + new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code', scope: 'workouts:read recipes:read offline_access', prompt: 'consent', resource: `${baseURL}/mcp`, code_challenge: challenge, code_challenge_method: 'S256', state: 'browser-owned-state' });
  await signIn(page, account, authorization);
  await expect(page.getByRole('heading', { name: 'Connect a client' })).toBeVisible();
  await expect(page.getByText(`Signed in as Synthetic trainee (${account.email})`)).toBeVisible();
  await expect(page.getByText('Browser read client', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Read recipes' }).uncheck();
  await expect(page.getByText(/even after you sign out of Corner/)).toBeVisible();
  await page.getByRole('button', { name: 'Approve access', exact: true }).click();
  await page.waitForURL('**/oauth/client-fixture?**');
  const returned = new URL(page.url());
  expect(returned.searchParams.get('state')).toBe('browser-owned-state');
  const code = returned.searchParams.get('code');
  expect(code).toBeTruthy();
  const exchanged = await page.request.post('/oauth/token', { form: { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: redirect, code: code!, code_verifier: verifier, resource: `${baseURL}/mcp` } });
  expect(exchanged.status()).toBe(200);
  expect(exchanged.headers()['set-cookie']).toBeUndefined();
  const token = await exchanged.json();
  const tools = await page.request.post('/mcp', { headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json, text/event-stream' }, data: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  expect(tools.status()).toBe(200);
  const list = await tools.json();
  expect(list.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(['exercise_history', 'get_workouts', 'list_workouts']);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Connected clients', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Browser read client', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Revoke access for Browser read client' }).click();
  await expect(page.getByText('No clients have access to your account.')).toBeVisible();
  const denied = await page.request.post('/mcp', { headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json, text/event-stream' }, data: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
  expect(denied.status()).toBe(401);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('denying a real consent request returns access_denied without creating a connection', async ({ page, account, baseURL }) => {
  const redirect = `${baseURL}/oauth/client-fixture`;
  const registered = await page.request.post('/oauth/register', { data: { client_name: 'Denied browser client', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' } });
  expect(registered.status()).toBe(201);
  const client = await registered.json();
  await page.route('**/oauth/client-fixture?**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Owned test callback</title><p>Connection denied.</p>' }));
  await signIn(page, account, '/oauth/authorize?' + new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code', scope: 'recipes:read', resource: `${baseURL}/mcp`, code_challenge: challenge, code_challenge_method: 'S256', state: 'deny-state' }));
  await expect(page.getByRole('heading', { name: 'Connect a client' })).toBeVisible();
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
  await page.waitForURL('**/oauth/client-fixture?**');
  const returned = new URL(page.url());
  expect(returned.searchParams.get('error')).toBe('access_denied');
  expect(returned.searchParams.has('code')).toBe(false);
  await page.goto('/settings');
  await expect(page.getByText('No clients have access to your account.')).toBeVisible();
});
