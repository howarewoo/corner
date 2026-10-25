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
  expect((await other.api.workspace.get()).state.logs).toEqual([]);
  await expect(page.getByRole('heading', { name: privateFood })).not.toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Add food', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: privateFood })).not.toBeVisible();
});
