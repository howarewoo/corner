import { randomUUID } from 'node:crypto';
import { test, expect, signIn } from './browser';

test('deep-link sign-in survives logout and a different account cannot see private records', async ({
  page,
  account,
}) => {
  const date = new Date().toISOString().slice(0, 10);
  const privateFood = 'Private account A breakfast';
  await account.api.workspace.mutate({
    requestId: randomUUID(),
    mutation: {
      type: 'log.save',
      data: {
        id: randomUUID(),
        date,
        slot: 'breakfast',
        name: privateFood,
        servings: 1,
        nutrition: { calories: 300, protein: 20, carbs: 30, fat: 10 },
        createdAt: new Date().toISOString(),
      },
    },
  });
  await signIn(page, account, '/workouts');
  await expect(page).toHaveURL(/\/workouts$/);
  await expect(page.getByRole('button', { name: 'Add workout', exact: true })).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: privateFood })).toBeVisible();
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: privateFood })).not.toBeVisible();
  const other = { ...account, email: `other-${randomUUID()}@corner.test` };
  const signup = await page.request.post('/api/auth/sign-up/email', {
    headers: { Origin: 'http://127.0.0.1:43141' },
    data: { name: 'Synthetic second account', email: other.email, password: other.password },
  });
  expect(signup.status()).toBe(200);
  await signIn(page, other);
  await expect(page.getByRole('button', { name: 'Add food', exact: true })).toBeVisible();
  expect((await other.api.workspace.foodWindow({ from: date, through: date, limit: 200 })).entries).toEqual([]);
  await expect(page.getByRole('heading', { name: privateFood })).not.toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Add food', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: privateFood })).not.toBeVisible();
});

test.describe('account session handoff', () => {
  test.use({ serviceWorkers: 'block' });

  test('a successful sign-in without a Corner session keeps the email and offers a retry', async ({
    page,
    account,
  }) => {
    await page.route('**/api/rpc/account/session', (route) =>
      route.fulfill({ json: { json: { user: null } } }),
    );
    await page.goto('/workouts');
    await page.getByLabel('Email', { exact: true }).fill(account.email);
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.getByLabel('Password', { exact: true }).fill(account.password);
      const response = page.waitForResponse('**/api/auth/sign-in/email');
      await page.getByLabel('Password', { exact: true }).press('Enter');
      expect((await response).status()).toBe(200);
      await expect(page.getByRole('alert')).toContainText(/session.*cookies/i);
      await expect(page.getByLabel('Email', { exact: true })).toHaveValue(account.email);
      await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
      await expect(page.getByRole('button', { name: 'Show password' })).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Add workout', exact: true })).not.toBeVisible();
    }
    await page.unroute('**/api/rpc/account/session');
    await page.getByLabel('Password', { exact: true }).fill(account.password);
    await page.getByLabel('Password', { exact: true }).press('Enter');
    await expect(page.getByRole('button', { name: 'Add workout', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/workouts$/);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Add workout', exact: true })).toBeVisible();
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
    expect((await account.api.account.session()).user).toBeNull();
  });
});

test('fresh signup without verification opens a persistent workspace without an email step', async ({
  page,
}) => {
  const email = `signup-${randomUUID()}@example.com`;
  const password = 'Synthetic-signup-password-2026!';
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Your name').fill('Synthetic signup');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create my account' }).click();
  await expect(page.getByRole('button', { name: 'Add food', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Add food', exact: true })).toBeVisible();
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Password', { exact: true }).press('Enter');
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
});
