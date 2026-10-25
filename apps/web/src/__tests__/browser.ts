import { randomUUID } from 'node:crypto';
import { test as base, expect, type Page } from '@playwright/test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ApiClient } from '@packages/api/contract';

export type BrowserAccount = { email: string; password: string; api: ApiClient };
export const test = base.extend<{ account: BrowserAccount }>({
  account: async ({ context, baseURL }, use) => {
    if (baseURL !== 'http://127.0.0.1:43141')
      throw new Error('Browser tests require the owned loopback runtime.');
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort(),
    );
    const email = `browser-${randomUUID()}@corner.test`;
    const password = 'Synthetic-browser-password-2026!';
    const headers = { Origin: baseURL };
    const signup = await context.request.post(`${baseURL}/api/auth/sign-up/email`, {
      headers,
      data: { name: 'Synthetic trainee', email, password },
    });
    expect(signup.status()).toBe(200);
    const api: ApiClient = createORPCClient(
      new RPCLink({
        url: `${baseURL}/api/rpc`,
        headers,
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const response = await context.request.fetch(request.url, {
            method: request.method,
            headers: Object.fromEntries(request.headers),
            data: request.method === 'GET' ? undefined : await request.text(),
          });
          return new Response(await response.text(), {
            status: response.status(),
            headers: response.headers(),
          });
        },
      }),
    );
    await use({ email, password, api });
  },
});

export async function signIn(page: Page, account: BrowserAccount, path = '/') {
  const response = await page.request.post('/api/auth/sign-out', {
    headers: { Origin: 'http://127.0.0.1:43141' },
    data: {},
  });
  expect(response.status()).toBe(200);
  await page.goto(path);
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByLabel('Password', { exact: true }).press('Enter');
  await expect(page.getByLabel('Email', { exact: true })).not.toBeVisible();
}

export { expect };
