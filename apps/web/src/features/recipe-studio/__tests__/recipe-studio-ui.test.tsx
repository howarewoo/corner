// @vitest-environment jsdom
import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';
import { createInitialState } from '@packages/workspace/initial-state';
import RecipeStudio from '../recipe-studio';
import { useRecipeStudio } from '../use-recipe-studio';
import type { Mutate, Notify } from '../../workspace/types';
import { queryClient } from '../../../rpc';
import { mockHttp } from '../../../__tests__/http';

const state = createInitialState();
function MountedStudio({
  mutate,
  notify,
  aiAvailable = false,
}: {
  mutate: Mutate;
  notify: Notify;
  aiAvailable?: boolean;
}) {
  const [visible, setVisible] = useState(true);
  const studio = useRecipeStudio({
    initialSettings: state.settings,
    settings: state.settings,
    aiAvailable,
    mutate,
    notify,
  });
  return (
    <>
      <button onClick={() => setVisible(!visible)}>Toggle studio</button>
      {visible && (
        <RecipeStudio
          state={state}
          settings={state.settings}
          aiAvailable={aiAvailable}
          disabled={false}
          studio={studio}
          navigate={() => {}}
          openAgent={() => {}}
          openRecipe={() => {}}
          saveRecipe={async () => {}}
          copyText={async () => {}}
        />
      )}
    </>
  );
}

test('Save idea accepts a short prompt and out-of-generation targets and draft survives leaving the screen', async () => {
  const mutate = vi.fn<Mutate>().mockResolvedValue(true);
  const notify = vi.fn<Notify>();
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={queryClient}>
      <MountedStudio mutate={mutate} notify={notify} />
    </QueryClientProvider>,
  );
  await user.type(screen.getByRole('textbox'), '  soup  ');
  const calories = screen.getAllByRole('spinbutton')[0];
  await user.clear(calories);
  await user.type(calories, '100');
  await user.click(screen.getByRole('button', { name: 'Toggle studio' }));
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Toggle studio' }));
  expect(screen.getByRole('textbox')).toHaveValue('  soup  ');
  expect(screen.getAllByRole('spinbutton')[0]).toHaveValue(100);
  await user.click(screen.getByRole('button', { name: 'Save recipe idea' }));
  await waitFor(() => expect(mutate).toHaveBeenCalledOnce());
  expect(mutate.mock.calls[0][0]).toEqual({
    type: 'request.save',
    data: expect.objectContaining({ prompt: 'soup', calories: 100, status: 'pending' }),
  });
  expect(notify).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox')).toHaveValue('  soup  ');
});

test('Generate keeps its stricter rules and pins retries after an ambiguous failure', async () => {
  const inputs: unknown[] = [];
  mockHttp((call) => {
    if (call.path === '/api/rpc/ai/generateRecipe') {
      inputs.push(call.body?.json);
      throw new TypeError('Synthetic connection loss');
    }
    return undefined;
  });
  const notify = vi.fn<Notify>();
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={queryClient}>
      <MountedStudio mutate={vi.fn<Mutate>().mockResolvedValue(true)} notify={notify} aiAvailable />
    </QueryClientProvider>,
  );
  await user.type(screen.getByRole('textbox'), 'soup');
  await user.click(screen.getByRole('button', { name: 'Create recipe' }));
  await waitFor(() => expect(notify.mock.lastCall?.[1]).toBe(true));
  expect(inputs).toHaveLength(0);
  await user.clear(screen.getByRole('textbox'));
  await user.type(screen.getByRole('textbox'), '  Quick tofu dinner  ');
  const calories = screen.getAllByRole('spinbutton')[0];
  const originalCalories = (calories as HTMLInputElement).value;
  await user.clear(calories);
  await user.type(calories, '100');
  notify.mockClear();
  await user.click(screen.getByRole('button', { name: 'Create recipe' }));
  await waitFor(() => expect(notify.mock.lastCall?.[1]).toBe(true));
  expect(inputs).toHaveLength(0);
  await user.clear(calories);
  await user.type(calories, originalCalories);
  await user.click(screen.getByRole('button', { name: 'Create recipe' }));
  await waitFor(() => expect(inputs).toHaveLength(1));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Create recipe' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Create recipe' }));
  await waitFor(() => expect(inputs).toHaveLength(2));
  expect(inputs[1]).toEqual(inputs[0]);
  expect(inputs[0]).toMatchObject({ prompt: 'Quick tofu dinner' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Create recipe' })).toBeEnabled());
  await user.type(screen.getByRole('textbox'), ' with rice');
  await user.click(screen.getByRole('button', { name: 'Create recipe' }));
  await waitFor(() => expect(inputs).toHaveLength(3));
  expect(inputs[2]).not.toEqual(inputs[1]);
});
