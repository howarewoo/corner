import { randomUUID } from 'node:crypto';
import type { WorkoutSession } from '@packages/training/types';
import { test, expect, signIn } from '../../__tests__/browser';

test.describe('ambiguous workout saves', () => {
  test.use({ serviceWorkers: 'block' });
  for (const lostResponse of [true, false]) {
    for (const reload of [false, true]) {
      const mode = lostResponse ? 'lost response' : 'successful response';
      test(`ambiguous ${mode} then ${reload ? 'reload' : 'retry'} preserves newer edits and finishes`, async ({
        page,
        account,
      }) => {
        await exerciseAmbiguousSave(page, account, { lostResponse, reload, external: false });
      });
    }
  }
  test('ambiguous save never adopts an unrelated concurrent edit after reload', async ({
    page,
    account,
  }) => {
    await exerciseAmbiguousSave(page, account, {
      lostResponse: true,
      reload: true,
      external: true,
    });
  });
});

async function exerciseAmbiguousSave(
  page: Parameters<typeof signIn>[0],
  account: Parameters<typeof signIn>[1],
  options: { lostResponse: boolean; reload: boolean; external: boolean },
) {
  const now = new Date().toISOString();
  const session: WorkoutSession = {
    id: randomUUID(),
    date: now.slice(0, 10),
    name: 'Ambiguous save regression',
    kind: 'conditioning',
    status: 'planned',
    unit: 'kg',
    exercises: [],
    plannedMinutes: 30,
    durationMinutes: null,
    rounds: null,
    sessionRpe: null,
    readiness: null,
    notes: '',
    changeReason: '',
    createdAt: now,
    updatedAt: now,
  };
  await account.api.workspace.mutate({
    requestId: randomUUID(),
    mutation: {
      type: 'training.session.save',
      data: { session, expectedUpdatedAt: null },
    },
  });
  const read = async () =>
    (await account.api.workspace.details({ sessionIds: [session.id] })).sessions[0]!;
  await signIn(page, account, '/workouts');
  await page.getByRole('button', { name: 'Start workout', exact: true }).click();
  const overlay = page.locator('.active-workout-overlay');
  await expect(overlay).toBeVisible();
  const initial = await read();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const key = Object.keys(sessionStorage).find((key) =>
          key.startsWith('corner-active-workout:'),
        );
        return key ? JSON.parse(sessionStorage.getItem(key)!).expectedUpdatedAt : null;
      }),
    )
    .toBe(initial.updatedAt);
  await overlay.getByRole('button', { name: 'Workout details', exact: true }).click();
  let failReads = true;
  await page.route('**/api/rpc/workspace/details', (route) =>
    failReads ? route.abort() : route.continue(),
  );
  await page.route(
    '**/api/rpc/workspace/mutate',
    async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      if (options.lostResponse) await route.abort();
      else await route.fulfill({ response });
    },
    { times: 1 },
  );
  await overlay
    .getByPlaceholder('How did your strength, conditioning, or boxing quality feel?')
    .fill('A');
  await expect(overlay.getByRole('status')).toContainText('Your draft is kept');
  const first = await read();
  expect(first.notes).toBe('A');
  expect(first.updatedAt).not.toBe(initial.updatedAt);
  await overlay
    .getByPlaceholder('How did your strength, conditioning, or boxing quality feel?')
    .fill('AB');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const key = Object.keys(sessionStorage).find((key) =>
          key.startsWith('corner-active-workout:'),
        );
        return key ? JSON.parse(sessionStorage.getItem(key)!).session.notes : null;
      }),
    )
    .toBe('AB');
  if (options.external) {
    await account.api.workspace.mutate({
      requestId: randomUUID(),
      mutation: {
        type: 'training.session.save',
        data: {
          session: { ...first, notes: 'Changed in another tab' },
          expectedUpdatedAt: first.updatedAt,
        },
      },
    });
  }
  failReads = false;
  if (options.reload) {
    await page.reload();
    await page.getByRole('button', { name: `Resume ${session.name}`, exact: true }).click();
    await overlay.getByRole('button', { name: 'Workout details', exact: true }).click();
    await expect(
      overlay.getByPlaceholder('How did your strength, conditioning, or boxing quality feel?'),
    ).toHaveValue('AB');
  }
  if (options.external) {
    await expect(overlay.getByRole('status')).toContainText('Your draft is kept');
    await overlay.getByRole('button', { name: 'Retry save', exact: true }).click();
    await overlay.getByRole('button', { name: 'Finish workout', exact: true }).click();
    await expect(overlay).toBeVisible();
    expect(await read()).toMatchObject({ status: 'in_progress', notes: 'Changed in another tab' });
    await expect(
      overlay.getByPlaceholder('How did your strength, conditioning, or boxing quality feel?'),
    ).toHaveValue('AB');
  } else {
    await expect.poll(async () => (await read()).notes).toBe('AB');
    await overlay.getByRole('button', { name: 'Finish workout', exact: true }).click();
    await expect(overlay).not.toBeVisible();
    expect(await read()).toMatchObject({
      status: 'completed',
      notes: 'AB',
      timing: { startedAt: initial.timing!.startedAt },
    });
  }
}
