// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { FoodEntry } from '@packages/nutrition/types';
import FoodForm from '../food-form';

afterEach(cleanup);

test('manual entry preserves edited values and date, scales servings and awaits saving', async () => {
  const user = userEvent.setup();
  const { promise, reject } = Promise.withResolvers<void>();
  const save = vi.fn((_value: FoodEntry) => promise);
  render(<FoodForm date="2026-10-24" busy={false} onClose={() => {}} onSave={save} />);
  await user.type(screen.getByRole('textbox', { name: 'What did you eat?' }), 'Oats');
  for (const [name, value] of [
    ['Calories', '100'],
    ['Protein', '10'],
    ['Carbs', '12'],
  ] as const) {
    const input = screen.getByRole('spinbutton', { name: new RegExp(name, 'i') });
    await user.clear(input);
    await user.type(input, value);
  }
  const date = screen.getByLabelText('Date');
  await user.clear(date);
  await user.type(date, '2026-10-25');
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'What did you eat?' })).toHaveValue('Oats');
  expect(screen.getByLabelText('Date')).toHaveValue('2026-10-25');
  const portions = screen.getByRole('spinbutton', { name: 'Servings eaten' });
  expect(portions).toHaveValue(1);
  await user.clear(portions);
  await user.type(portions, '2');
  const submit = screen.getByRole('button', { name: 'Save food entry' });
  await user.click(submit);
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(submit).toBeDisabled();
  expect(save.mock.calls[0]?.[0]).toMatchObject({
    name: 'Oats',
    date: '2026-10-25',
    servings: 2,
    nutrition: { calories: 100, protein: 10, carbs: 12, fat: 0 },
  });
  await act(async () => reject(new Error('Food save failed')));
  expect(await screen.findByText('Food save failed')).toBeVisible();
  expect(portions).toHaveValue(2);
  expect(screen.getByRole('textbox', { name: 'What did you eat?' })).toHaveValue('Oats');
  expect(screen.getByLabelText('Date')).toHaveValue('2026-10-25');
  expect(screen.getByRole('spinbutton', { name: /Calories/i })).toHaveValue(100);
  expect(submit).toBeEnabled();
});
