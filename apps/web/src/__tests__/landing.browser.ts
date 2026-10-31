import { test, expect, signIn } from './browser';

const landingOrigin = 'http://localhost:43141';
const docsOrigin = 'http://docs.localhost:43141';

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

test('guide search and native handoffs preserve the signed-in app without sharing its cookie or script authority', async ({
  page,
  context,
  account,
  baseURL,
}, testInfo) => {
  await signIn(page, account);
  await page.goto(landingOrigin);
  await page.getByRole('link', { name: 'Guide', exact: true }).click();
  await expect(page).toHaveURL(docsOrigin + '/');
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
  expect(await context.cookies(docsOrigin)).toEqual([]);
  expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
  expect(
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length),
  ).toBe(0);
  const blocked = await page.evaluate(async () => {
    const result = Promise.withResolvers<{ directive: string; executed: boolean }>();
    const timer = setTimeout(() => result.reject(new Error('Missing enforced CSP event')), 3000);
    document.addEventListener(
      'securitypolicyviolation',
      (event) => {
        if (event.blockedURI !== 'inline' || !event.effectiveDirective.startsWith('script-src'))
          return;
        clearTimeout(timer);
        result.resolve({
          directive: event.effectiveDirective,
          executed:
            (window as Window & { cornerUnhashedScript?: boolean }).cornerUnhashedScript === true,
        });
      },
      { once: true },
    );
    const script = document.createElement('script');
    script.textContent = 'window.cornerUnhashedScript = true';
    document.head.append(script);
    return result.promise;
  });
  expect(blocked.executed).toBe(false);
  expect(blocked.directive).toMatch(/^script-src/);
  await page
    .getByRole('button', { name: /search/i })
    .first()
    .click();
  await page.getByRole('dialog').getByRole('combobox', { name: 'Search' }).fill('servings');
  await expect(page.getByRole('option').first()).toBeVisible();
  await page.getByRole('option').first().click();
  await expect(page).toHaveURL(new RegExp('^' + docsOrigin.replaceAll('.', '\\.') + '/.+'));
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (testInfo.project.name === 'webkit-phone')
    await page.getByRole('button', { name: 'Open Sidebar', exact: true }).click();
  await page.getByRole('link', { name: 'Open Corner', exact: true }).first().click();
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
    await page.getByRole('link', { name: 'Guide', exact: true }).click();
    await expect(page).toHaveURL(docsOrigin + '/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.getByText('Browse the Corner guide', { exact: true }).click();
    await page.getByRole('link', { name: 'Nutrition', exact: true }).first().click();
    await expect(page).toHaveURL(docsOrigin + '/nutrition');
    await page.getByText('Browse the Corner guide', { exact: true }).click();
    await page.getByRole('link', { name: 'Open Corner' }).first().click();
    await expect(page).toHaveURL(baseURL! + '/');
  } finally {
    await context.close();
  }
});
