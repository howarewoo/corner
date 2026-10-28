// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { Recipe } from '@packages/nutrition/types';
import RecipeForm from '../recipe-form';

afterEach(cleanup);

const recipe: Recipe = {
  id: 'manual-oats',
  name: 'Oats',
  description: '',
  category: 'breakfast',
  prepMinutes: 0,
  cookMinutes: 0,
  nutrition: { calories: 100, protein: 10, carbs: 12, fat: 4 },
  ingredients: [
    {
      name: 'Oats',
      quantity: 1,
      unit: 'cup',
      aisle: 'Pantry',
      shoppingQuantity: 80,
      shoppingUnit: 'g',
      optional: true,
      display: '1 cup oats',
    },
  ],
  steps: ['Mix.'],
  storage: '',
  variation: '',
  tags: ['quick'],
  color: '#e8eee1',
  source: 'manual',
  favorite: false,
  createdAt: '2026-10-24T09:00:00.000Z',
};

test('a rejected save retains the recipe draft, zero times and matching ingredient metadata', async () => {
  const user = userEvent.setup();
  const { promise, reject } = Promise.withResolvers<void>();
  const save = vi.fn((_value: Recipe) => promise);
  render(<RecipeForm recipe={recipe} busy={false} onClose={() => {}} onSave={save} />);
  const name = screen.getByRole('textbox', { name: 'Recipe name' });
  await user.clear(name);
  await user.type(name, 'Edited oats');
  const submit = screen.getByRole('button', { name: 'Save recipe' });
  await user.click(submit);
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(submit).toBeDisabled();
  expect(save.mock.calls[0]?.[0]).toMatchObject({
    id: recipe.id,
    name: 'Edited oats',
    prepMinutes: 0,
    cookMinutes: 0,
    ingredients: recipe.ingredients,
    createdAt: recipe.createdAt,
  });
  await act(async () => reject(new Error('Save failed')));
  expect(await screen.findByText('Save failed')).toBeVisible();
  expect(name).toHaveValue('Edited oats');
  expect(submit).toBeEnabled();
});

test('ingredient metadata is discarded only when quantity or unit changes', async () => {
  const user = userEvent.setup();
  const save = vi.fn(async (_value: Recipe) => {});
  render(<RecipeForm recipe={recipe} busy={false} onClose={() => {}} onSave={save} />);
  const name = screen.getByRole('textbox', { name: 'Recipe name' });
  await waitFor(() => expect(name).toHaveFocus());
  const ingredients = screen.getByRole('textbox', { name: /^Ingredients/ });
  await user.clear(ingredients);
  await user.type(ingredients, '2 | cup | Oats | Pantry');
  await user.click(screen.getByRole('button', { name: 'Save recipe' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0]?.[0].ingredients).toEqual([
    { name: 'Oats', quantity: 2, unit: 'cup', aisle: 'Pantry', note: undefined },
  ]);
});
