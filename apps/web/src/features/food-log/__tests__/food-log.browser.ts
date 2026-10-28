import { test, expect, signIn } from '../../../__tests__/browser';
import { dateKey } from '@packages/nutrition/dates';

test('manual food entries persist their servings and nutrition after reload without AI', async ({
  page,
  account,
}) => {
  await signIn(page, account, '/studio');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('button', { name: 'Recipe studio', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add food', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add to your food log' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Describe food', exact: true })).toHaveCount(0);
  await dialog.getByLabel('What did you eat?').fill('Synthetic oats');
  await dialog.getByLabel('Servings eaten').fill('2');
  await dialog.getByLabel('Calories (kcal)').fill('100');
  await dialog.getByLabel('Protein (g)').fill('10');
  await dialog.getByLabel('Carbs (g)').fill('12');
  await dialog.getByLabel('Fat (g)').fill('4');
  await dialog.getByRole('button', { name: 'Save food entry' }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Synthetic oats' })).toBeVisible();
  const date = dateKey(new Date(), (await account.api.workspace.get()).settings.timezone);
  const saved = (await account.api.workspace.foodWindow({ from: date, through: date, limit: 200 }))
    .entries;
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({
    name: 'Synthetic oats',
    servings: 2,
    nutrition: { calories: 100, protein: 10, carbs: 12, fat: 4 },
  });
  await page.getByRole('button', { name: 'Edit Synthetic oats', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit food entry' });
  await expect(edit.getByLabel('Servings eaten')).toHaveValue('2');
  await expect(edit.getByLabel('Calories (kcal)')).toHaveValue('100');
  await expect(edit.getByText('200 kcal', { exact: true })).toBeVisible();
  await expect(edit.getByText('20g P', { exact: true })).toBeVisible();
  await expect(edit.getByText('24g C', { exact: true })).toBeVisible();
  await expect(edit.getByText('8g F', { exact: true })).toBeVisible();
});
