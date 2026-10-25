import { randomUUID } from 'node:crypto';
import type { WorkoutSession } from '@packages/training/types';
import { test, expect, signIn } from '../../__tests__/browser';

test('workout completion persists recorded results and leaves unrecorded sets incomplete', async ({
  page,
  account,
}) => {
  const timestamp = new Date().toISOString();
  const session: WorkoutSession = {
    id: randomUUID(),
    date: timestamp.slice(0, 10),
    name: 'Synthetic strength session',
    kind: 'strength',
    status: 'planned',
    unit: 'kg',
    plannedMinutes: 45,
    durationMinutes: null,
    rounds: null,
    sessionRpe: null,
    readiness: null,
    notes: '',
    changeReason: '',
    createdAt: timestamp,
    updatedAt: timestamp,
    exercises: [
      {
        id: randomUUID(),
        name: 'Synthetic squat',
        loadType: 'total',
        targetSets: 2,
        repMin: 8,
        repMax: 10,
        targetRir: 2,
        restSeconds: 90,
        notes: '',
        targetLoad: { weight: 40, unit: 'kg' },
        sets: [1, 2].map(() => ({
          id: randomUUID(),
          weight: null,
          reps: null,
          rir: null,
          completed: false,
          kind: 'working',
        })),
      },
    ],
  };
  await account.api.workspace.mutate({
    requestId: randomUUID(),
    mutation: { type: 'training.session.save', data: { session, expectedUpdatedAt: null } },
  });
  await signIn(page, account, '/workouts');
  await page.getByRole('button', { name: 'Start workout', exact: true }).click();
  await page.getByLabel('Synthetic squat set 1 weight kg', { exact: true }).fill('42.5');
  await page.getByLabel('Synthetic squat set 1 reps', { exact: true }).fill('9');
  await page.getByLabel('Synthetic squat set 1 completed', { exact: true }).check();
  await page.getByRole('button', { name: 'Complete workout', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Complete workout', exact: true }),
  ).not.toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'View / edit', exact: true }).click();
  await expect(page.getByLabel('Synthetic squat set 1 weight kg', { exact: true })).toHaveValue(
    '42.5',
  );
  await expect(page.getByLabel('Synthetic squat set 1 reps', { exact: true })).toHaveValue('9');
  await expect(page.getByLabel('Synthetic squat set 1 completed', { exact: true })).toBeChecked();
  await expect(
    page.getByLabel('Synthetic squat set 2 completed', { exact: true }),
  ).not.toBeChecked();
  const saved = (await account.api.workspace.get()).state.training.sessions.find(
    (item) => item.id === session.id,
  )!;
  expect(saved.status).toBe('completed');
  expect(saved.exercises[0].sets[0]).toMatchObject({ weight: 42.5, reps: 9, completed: true });
  expect(saved.exercises[0].sets[1]).toMatchObject({ weight: null, reps: null, completed: false });
});
