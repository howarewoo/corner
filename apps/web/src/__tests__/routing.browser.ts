import { test, expect, signIn } from './browser';

// These paths intentionally include legacy case/encoding/slash behavior.
test('workspace deep links and reloads preserve the existing matching rules', async ({
  page,
  account,
}) => {
  await signIn(page, account, '/recipes');
  const destinations = [
    ['/', /In your corner/],
    ['/workouts', /Your training/],
    ['/planner', 'Your meal plan.'],
    ['/recipes', 'Your recipe collection.'],
    ['/groceries', /grocery/i],
    ['/settings', 'Your starting point.'],
    ['/WORKOUTS', /Your training/],
    ['/%77orkouts', /Your training/],
    ['/workouts//', /Your training/],
  ] as const;
  for (const [path, heading] of destinations) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  }
});

test('history preserves shell dates, recipe filters and mobile Nutrition while resetting inner scroll and focus', async ({
  page,
  account,
}, testInfo) => {
  const phone = testInfo.project.name === 'webkit-phone';
  await signIn(page, account);
  await page.getByRole('button', { name: 'Next day', exact: true }).click();
  const dateHeading = await page.getByRole('heading', { level: 1 }).innerText();
  if (phone) {
    await page.getByRole('link', { name: 'Nutrition', exact: true }).click();
    await page.getByRole('button', { name: 'Recipes', exact: true }).click();
  } else await page.getByRole('link', { name: 'Recipes', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search recipes' }).fill('Retained recipe filter');
  await page.getByRole('button', { name: 'Favorites', exact: true }).click();
  await page.getByRole('link', { name: /Open settings for/ }).click();
  const scroller = page.locator('.workspace-content');
  await scroller.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const sameDestinationHistory = await page.evaluate(() => history.length);
  await page.getByRole('link', { name: /Open settings for/ }).click();
  await expect(scroller).toHaveJSProperty('scrollTop', 0);
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  expect(await page.evaluate(() => history.length)).toBe(sameDestinationHistory);
  await scroller.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await page.goBack();
  await expect(page.getByRole('textbox', { name: 'Search recipes' })).toHaveValue(
    'Retained recipe filter',
  );
  await expect(page.getByRole('button', { name: 'Favorites', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(scroller).toHaveJSProperty('scrollTop', 0);
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await page.goForward();
  await expect(page.getByText(`Signed in as ${account.email}`, { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Corner home', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(dateHeading);
  if (phone) {
    await page.getByRole('link', { name: 'Nutrition', exact: true }).click();
    await expect(page).toHaveURL(/\/recipes$/);
  } else await page.getByRole('link', { name: 'Recipes', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Search recipes' })).toHaveValue(
    'Retained recipe filter',
  );
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('unknown and strict account lookalikes wait for sign-in then replace history; OAuth lookalikes stay server 404s', async ({
  page,
  account,
}) => {
  for (const path of [
    '/agent',
    '/studio',
    '/ACCOUNT/reset-password',
    '/account/%72eset-password',
    '/account/reset-password//',
  ]) {
    const signedOut = await page.request.post('/api/auth/sign-out', {
      headers: { Origin: 'http://127.0.0.1:43141' },
      data: {},
    });
    expect(signedOut.status()).toBe(200);
    await page.goto('/settings?sentinel=previous');
    await page.goto(path);
    await page.getByLabel('Email', { exact: true }).fill(account.email);
    await expect(page).toHaveURL(path);
    const historyLength = await page.evaluate(() => history.length);
    await page.getByLabel('Password', { exact: true }).fill(account.password);
    await page.getByLabel('Password', { exact: true }).press('Enter');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('button', { name: 'Add food', exact: true })).toBeVisible();
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    await page.goBack();
    await expect(page).toHaveURL('/settings?sentinel=previous');
  }
  for (const path of ['/oauth/consent/%61bc', '/oauth/sign-in/']) {
    const response = await page.request.get(path);
    expect(response.status()).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'NOT_FOUND' });
  }
});

test.describe('raw security queries', () => {
  test.use({ serviceWorkers: 'block' });

  test('public reset captures once, scrubs with replace, retains other URL fields/state and rejects duplicate tokens', async ({
    page,
    account,
  }) => {
    let sessions = 0;
    let workspace = 0;
    await page.route('**/api/rpc/account/session', (route) => {
      sessions++;
      return route.continue();
    });
    await page.route('**/api/rpc/workspace/**', (route) => {
      workspace++;
      return route.continue();
    });
    await page.route('**/api/rpc/account/policy', (route) =>
      route.fulfill({
        json: { json: { emailVerificationRequired: true, passwordResetAvailable: true } },
      }),
    );
    const token = '1234567890123456';
    await page.goto('/account/reset-password');
    await expect(
      page.getByRole('heading', { name: 'This reset link can’t be used.' }),
    ).toBeVisible();
    const historyLength = await page.evaluate(() => history.length);
    await page.evaluate((token) => {
      history.replaceState(
        { ...history.state, ownedState: 'retained' },
        '',
        `/account/reset-password?token=${token}&account=secret&keep=001&keep=two#retained`,
      );
      location.reload();
    }, token);
    await expect(page.getByRole('heading', { name: 'Choose a new password.' })).toBeVisible();
    await expect(page).toHaveURL('/account/reset-password?keep=001&keep=two#retained');
    expect(await page.evaluate(() => history.state.ownedState)).toBe('retained');
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    await page.getByLabel('New password', { exact: true }).fill(account.password);
    await page.getByLabel('Confirm new password').fill(account.password);
    let submittedToken: string | undefined;
    await page.route('**/api/auth/reset-password', (route) => {
      submittedToken = route.request().postDataJSON().token;
      return route.fulfill({ json: { status: true } });
    });
    await page.getByRole('button', { name: 'Update password', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your password is updated.' })).toBeVisible();
    expect(submittedToken).toBe(token);
    expect(sessions).toBe(0);
    expect(workspace).toBe(0);
    await page.goto(`/account/reset-password?token=${token}&token=${token}`);
    await expect(
      page.getByRole('heading', { name: 'This reset link can’t be used.' }),
    ).toBeVisible();
    await expect(page.getByLabel('New password', { exact: true })).not.toBeVisible();
  });

  test('duplicate and JSON-looking OAuth returns cannot become authorization redirects or workspace reads', async ({
    page,
    account,
  }) => {
    // Signup authenticates the shared context without mounting a workspace page.
    expect((await account.api.account.session()).user?.email).toBe(account.email);
    let workspace = 0;
    await page.route('**/api/rpc/workspace/**', (route) => {
      workspace++;
      return route.continue();
    });
    for (const search of [
      'returnTo=%2Foauth%2Fauthorize%3Fclient_id%3Done&returnTo=%2Foauth%2Fauthorize%3Fclient_id%3Dtwo',
      'returnTo=%22%2Foauth%2Fauthorize%3Fclient_id%3Done%22',
    ]) {
      await page.goto(`/oauth/sign-in?${search}`);
      await expect(
        page.getByRole('heading', { name: 'This connection link cannot be used.' }),
      ).toBeVisible();
    }
    expect(workspace).toBe(0);
  });
});
