import { test, expect, signIn } from './browser';

const landingOrigin = 'http://localhost:43141';

test('landing CTA opens the configured app without sharing account cookies or service workers', async ({
  page,
  context,
  account,
  baseURL,
}) => {
  await signIn(page, account, '/workouts');
  await expect(page).toHaveURL('/workouts');
  expect((await context.cookies(baseURL!)).some((cookie) => cookie.httpOnly)).toBe(true);
  expect(await context.cookies(landingOrigin)).toEqual([]);
  const response = await page.goto(landingOrigin);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
  expect(
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length),
  ).toBe(0);
  expect(await context.cookies(landingOrigin)).toEqual([]);
  for (const path of ['/api/health', '/api/auth/get-session', '/mcp', '/sw.js', '/workouts'])
    expect((await page.request.get(landingOrigin + path)).status()).toBe(404);
  const redirect = await page.request.get(landingOrigin + '/open-app?returnTo=https://evil.test', {
    maxRedirects: 0,
  });
  expect(redirect.status()).toBe(302);
  expect(redirect.headers().location).toBe(baseURL);
  await page.getByRole('link', { name: 'Open Corner' }).first().click();
  await expect(page).toHaveURL(baseURL! + '/');
  await expect(page.getByRole('button', { name: 'Add food', exact: true })).toBeVisible();
});

test('built landing remains useful without JavaScript and has a native fixed CTA', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(landingOrigin);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open Corner' }).first()).toHaveAttribute(
      'href',
      '/open-app',
    );
    await page.getByRole('link', { name: 'Open Corner' }).first().click();
    await expect(page).toHaveURL(baseURL! + '/');
  } finally {
    await context.close();
  }
});
