import { randomUUID } from 'node:crypto';
import type { WorkspaceMutationInput } from '@packages/api/schemas';
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
  for (const reload of [false, true]) {
    for (const external of [false, true]) {
      test(`delayed commit after an old-version read (${reload ? 'reload' : 'retry'}, ${external ? 'foreign edit' : 'own write'})`, async ({
        page,
        account,
      }) => {
        await exerciseAmbiguousSave(page, account, {
          lostResponse: true,
          reload,
          external,
          delayed: true,
        });
      });
    }
  }
  test('delayed pending save survives undo to the loaded content and reload', async ({
    page,
    account,
  }) => {
    await exerciseAmbiguousSave(page, account, {
      lostResponse: true,
      reload: true,
      external: false,
      delayed: true,
      undo: true,
    });
  });
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
  options: {
    lostResponse: boolean;
    reload: boolean;
    external: boolean;
    delayed?: boolean;
    undo?: boolean;
  },
) {
  const latestNotes = options.undo ? '' : 'AB';
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
  let held: WorkspaceMutationInput | undefined;
  const deliverHeld = async () => {
    const input = held;
    held = undefined;
    if (!input || input.mutation.type !== 'training.session.save')
      throw new Error('Missing held write');
    await account.api.workspace.mutate(
      options.external
        ? {
            requestId: randomUUID(),
            mutation: {
              type: 'training.session.save',
              data: {
                ...input.mutation.data,
                session: { ...input.mutation.data.session, notes: 'Changed in another tab' },
              },
            },
          }
        : input,
    );
  };
  await page.route('**/api/rpc/workspace/details', async (route) => {
    if (failReads) await route.abort();
    else if (held) {
      const response = await route.fetch(); // Capture V0 before the delayed commit.
      await deliverHeld();
      await route.fulfill({ response });
    } else await route.continue();
  });
  let firstWrite = true;
  await page.route('**/api/rpc/workspace/mutate', async (route) => {
    if (firstWrite) {
      firstWrite = false;
      if (options.delayed) {
        held = route.request().postDataJSON().json;
        await route.abort(); // The original envelope can still be delivered later.
      } else {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        if (options.lostResponse) await route.abort();
        else await route.fulfill({ response });
      }
    } else {
      // On the old implementation reload discards the pending snapshot and skips
      // reconciliation. Deliver A immediately before that newer write checks V0.
      if (held) await deliverHeld();
      await route.continue();
    }
  });
  await overlay
    .getByPlaceholder('How did your strength, conditioning, or boxing quality feel?')
    .fill('A');
  await expect(overlay.getByRole('status')).toContainText('Your draft is kept');
  const first = await read();
  expect(first.notes).toBe(options.delayed ? '' : 'A');
  if (options.delayed) expect(first.updatedAt).toBe(initial.updatedAt);
  else expect(first.updatedAt).not.toBe(initial.updatedAt);
  await overlay
    .getByPlaceholder('How did your strength, conditioning, or boxing quality feel?')
    .fill(latestNotes);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const key = Object.keys(sessionStorage).find((key) =>
          key.startsWith('corner-active-workout:'),
        );
        return key ? JSON.parse(sessionStorage.getItem(key)!).session.notes : null;
      }),
    )
    .toBe(latestNotes);
  if (options.external && !options.delayed) {
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
    ).toHaveValue(latestNotes);
  }
  if (options.external) {
    await expect(overlay.getByRole('status')).toContainText('Your draft is kept');
    await overlay.getByRole('button', { name: 'Retry save', exact: true }).click();
    await overlay.getByRole('button', { name: 'Finish workout', exact: true }).click();
    await expect(overlay).toBeVisible();
    expect(await read()).toMatchObject({ status: 'in_progress', notes: 'Changed in another tab' });
    await expect(
      overlay.getByPlaceholder('How did your strength, conditioning, or boxing quality feel?'),
    ).toHaveValue(latestNotes);
  } else {
    await expect.poll(async () => (await read()).notes).toBe(latestNotes);
    if (options.undo) {
      // The undo initially equals V0; wait for reconciliation rather than
      // accepting that stale equality before the held A has committed.
      await expect.poll(async () => (await read()).updatedAt).not.toBe(initial.updatedAt);
      await expect.poll(async () => (await read()).notes).toBe(latestNotes);
    }
    await overlay.getByRole('button', { name: 'Finish workout', exact: true }).click();
    await expect(overlay).not.toBeVisible();
    expect(await read()).toMatchObject({
      status: 'completed',
      notes: latestNotes,
      timing: { startedAt: initial.timing!.startedAt },
    });
  }
}
