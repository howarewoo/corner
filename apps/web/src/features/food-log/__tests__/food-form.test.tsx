// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { FoodEntry } from '@packages/nutrition/types';
import type { EstimatedFood } from '@packages/nutrition/food-estimate';
import FoodForm from '../food-form';

vi.mock('../../../components/food-estimator', () => ({
  default: ({ onApply }: { onApply: (estimate: EstimatedFood) => void }) => (
    <button
      type="button"
      onClick={() =>
        onApply({
          status: 'estimated',
          name: 'Estimated oats',
          amountSummary: 'one bowl',
          nutrition: { calories: 100, protein: 10, carbs: 12, fat: 0 },
          assumptions: [],
        })
      }
    >
      Apply synthetic estimate
    </button>
  ),
}));

afterEach(cleanup);

test('estimate application only populates review, preserves date, scales portions and awaits saving', async () => {
  const user = userEvent.setup();
  const { promise, reject } = Promise.withResolvers<void>();
  const save = vi.fn((_value: FoodEntry) => promise);
  render(<FoodForm date="2026-10-24" busy={false} aiAvailable onClose={() => {}} onSave={save} />);
  await user.click(screen.getByText('Enter manually'));
  const date = screen.getByLabelText('Date');
  await user.clear(date);
  await user.type(date, '2026-10-25');
  await user.click(screen.getByText('Describe food'));
  await user.click(screen.getByRole('button', { name: 'Apply synthetic estimate' }));
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'What did you eat?' })).toHaveValue('Estimated oats');
  expect(screen.getByLabelText('Date')).toHaveValue('2026-10-25');
  const portions = screen.getByRole('spinbutton', { name: /^Portions eaten/ });
  expect(portions).toHaveValue(1);
  await user.clear(portions);
  await user.type(portions, '2');
  const submit = screen.getByRole('button', { name: 'Save food entry' });
  await user.click(submit);
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(submit).toBeDisabled();
  expect(save.mock.calls[0]?.[0]).toMatchObject({
    name: 'Estimated oats',
    date: '2026-10-25',
    servings: 2,
    nutrition: { calories: 100, protein: 10, carbs: 12, fat: 0 },
  });
  await act(async () => reject(new Error('Food save failed')));
  expect(await screen.findByText('Food save failed')).toBeVisible();
  expect(portions).toHaveValue(2);
  expect(submit).toBeEnabled();
});
