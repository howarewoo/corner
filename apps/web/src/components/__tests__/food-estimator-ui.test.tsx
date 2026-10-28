// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';
import FoodEstimator from '../food-estimator';
import { queryClient } from '../../rpc';
import { json, mockHttp } from '../../__tests__/http';

const estimate = (name: string) => ({
  status: 'estimated' as const,
  name,
  amountSummary: 'The entire portion',
  nutrition: { calories: 200, protein: 12, carbs: 20, fat: 8 },
  assumptions: [],
});

test('editing cancels an estimate and a late completion cannot clear a newer pending request', async () => {
  const requests: {
    resolve: (response: Response) => void;
    signal: AbortSignal | null | undefined;
  }[] = [];
  mockHttp((call) => {
    if (call.path === '/api/rpc/ai/estimateFood')
      return new Promise<Response>((resolve) => {
        requests.push({ resolve, signal: call.init.signal });
      });
  });
  const onApply = vi.fn();
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={queryClient}>
      <FoodEstimator disabled={false} aiAvailable onApply={onApply} />
    </QueryClientProvider>,
  );
  const description = screen.getByRole('textbox', { name: 'Food and portions' });
  await user.type(description, '2 boiled eggs');
  await user.click(screen.getByRole('button', { name: 'Estimate nutrition' }));
  await waitFor(() => expect(requests).toHaveLength(1));
  await user.clear(description);
  await user.type(description, '200 g cooked rice');
  expect(requests[0].signal?.aborted).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Estimate nutrition' }));
  await waitFor(() => expect(requests).toHaveLength(2));
  await act(async () => {
    requests[0].resolve(json({ json: { estimate: estimate('Old eggs') } }));
  });
  expect(screen.getByRole('button', { name: 'Estimating…' })).toBeDisabled();
  expect(screen.queryByText('Old eggs')).not.toBeInTheDocument();
  const rice = estimate('Cooked rice');
  await act(async () => {
    requests[1].resolve(json({ json: { estimate: rice } }));
  });
  expect(await screen.findByText('Cooked rice')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Use estimate' }));
  expect(onApply).toHaveBeenCalledExactlyOnceWith(rice);
  expect(screen.getByRole('button', { name: 'Estimate applied' })).toBeDisabled();
});

test('an ambiguous failure retries the same normalized request until the description changes', async () => {
  const inputs: unknown[] = [];
  mockHttp((call) => {
    if (call.path === '/api/rpc/ai/estimateFood') {
      inputs.push(call.body?.json);
      if (inputs.length === 1) throw new TypeError('Synthetic connection loss');
      return json({
        json: { estimate: { status: 'needs_details', questions: ['How much did you eat?'] } },
      });
    }
  });
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={queryClient}>
      <FoodEstimator disabled={false} aiAvailable onApply={() => {}} />
    </QueryClientProvider>,
  );
  const description = screen.getByRole('textbox', { name: 'Food and portions' });
  await user.type(description, '  rice with vegetables  ');
  await user.click(screen.getByRole('button', { name: 'Estimate nutrition' }));
  expect(await screen.findByText(/Could not connect to the estimator/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Estimate nutrition' }));
  expect(await screen.findByText('How much did you eat?')).toBeVisible();
  expect(inputs[1]).toEqual(inputs[0]);
  expect(inputs[0]).toMatchObject({ description: 'rice with vegetables' });
  await user.type(description, ' and tofu');
  expect(screen.queryByText('How much did you eat?')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Estimate nutrition' }));
  await waitFor(() => expect(inputs).toHaveLength(3));
  expect(inputs[2]).not.toEqual(inputs[1]);
});
