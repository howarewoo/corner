// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { createInitialState } from '@packages/workspace/initial-state';
import type { Settings } from '@packages/workspace/types';
import ProfileForm from '../profile-form';

afterEach(cleanup);

test('unset targets save as unset and pending completion retains a failed profile draft', async () => {
  const user = userEvent.setup();
  const settings = createInitialState().settings;
  settings.name = 'Synthetic profile';
  settings.training = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  settings.rest = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  settings.setup = { completedAt: null, nutritionTargetsSet: false };
  const { promise, reject } = Promise.withResolvers<boolean | void>();
  const save = vi.fn((_value: Settings) => promise);
  const { rerender } = render(<ProfileForm settings={settings} busy={false} onSave={save} />);
  // A refreshed prop must not replace the mount-time draft, even before its first edit.
  rerender(
    <ProfileForm
      settings={{ ...settings, name: 'Refetched profile' }}
      busy={false}
      onSave={save}
    />,
  );
  expect(screen.getByRole('textbox', { name: 'Preferred name' })).toHaveValue('Synthetic profile');
  await user.type(screen.getByRole('textbox', { name: 'Preferred name' }), ' edited');
  await user.click(screen.getByRole('button', { name: 'Save profile' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  expect(save.mock.calls[0]?.[0]).toMatchObject({
    name: 'Synthetic profile edited',
    setup: { nutritionTargetsSet: false },
    training: settings.training,
    rest: settings.rest,
  });
  await act(async () => reject(new Error('Profile save failed')));
  expect(await screen.findByText('Profile save failed')).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Preferred name' })).toHaveValue(
    'Synthetic profile edited',
  );
  await user.click(screen.getByRole('checkbox', { name: 'I want to set my daily targets' }));
  await user.click(screen.getByRole('button', { name: 'Save profile' }));
  expect(
    await screen.findByText(
      'Enter calories for both training and recovery days, or leave nutrition targets unset for now.',
    ),
  ).toBeVisible();
  expect(save).toHaveBeenCalledTimes(1);
});
