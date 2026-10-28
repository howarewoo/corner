import { randomUUID } from 'node:crypto';
import type { TrainingCheckIn, WorkoutSession } from '@packages/training/types';
import { test, expect, signIn } from '../../__tests__/browser';

test('check-in summaries fit narrow cards and edit the selected saved record', async ({
  page,
  account,
}) => {
  const full: TrainingCheckIn = {
    id: randomUUID(),
    date: '2026-10-28',
    bodyWeight: 160.5,
    waist: 32.1,
    sleepHours: 6.25,
    energy: 4,
    soreness: 2,
    boxingQuality: 5,
    notes: 'Synthetic full check-in',
  };
  const short = {
    ...full,
    id: randomUUID(),
    date: '2026-10-27',
    waist: null,
    sleepHours: null,
    energy: null,
    notes: 'Synthetic short check-in',
  };
  const notesOnly = {
    ...short,
    id: randomUUID(),
    date: '2026-10-26',
    bodyWeight: null,
    soreness: null,
    boxingQuality: null,
    notes: 'Synthetic notes-only check-in',
  };
  for (const checkIn of [full, short, notesOnly]) {
    await account.api.workspace.mutate({
      requestId: randomUUID(),
      mutation: { type: 'training.checkin.save', data: checkIn },
    });
  }
  await signIn(page, account, '/workouts');
  await page.getByRole('tab', { name: 'Progress', exact: true }).click();
  const rows = page.locator('.training-checkin-button');
  await expect(rows).toHaveCount(3);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    for (const row of await rows.all()) {
      await row.scrollIntoViewIfNeeded();
      const layout = await row.evaluate((button) => {
        const box = button.getBoundingClientRect();
        const card = button.closest('.training-checkin-summary')!;
        const cardBox = card.getBoundingClientRect();
        const style = getComputedStyle(card);
        const left = cardBox.left + parseFloat(style.paddingLeft);
        const right = cardBox.right - parseFloat(style.paddingRight);
        const range = document.createRange();
        range.selectNodeContents(button.querySelector('span')!);
        const icon = button.querySelector('svg')!.getBoundingClientRect();
        return {
          rowFitsCard: box.left >= left - 1 && box.right <= right + 1,
          textFitsRow: [...range.getClientRects()].every(
            (rect) =>
              rect.left >= box.left &&
              rect.right <= icon.left &&
              rect.top >= box.top &&
              rect.bottom <= box.bottom,
          ),
          iconFitsRow:
            icon.left >= box.left &&
            icon.right <= box.right &&
            icon.top >= box.top &&
            icon.bottom <= box.bottom &&
            icon.width >= 14,
        };
      });
      expect(layout, `check-in layout at ${width}px`).toEqual({
        rowFitsCard: true,
        textFitsRow: true,
        iconFitsRow: true,
      });
    }
  }
  await page.setViewportSize({ width: 320, height: 844 });
  const fullRow = rows.filter({ hasText: 'Oct 28' });
  await expect(fullRow).toContainText('160.5 lb · 32.1 in waist · Energy 4/5 · 6.25h sleep');
  await fullRow.click();
  const editor = page.getByRole('dialog', { name: 'Edit check-in' });
  await expect(editor.getByLabel('Date', { exact: true })).toHaveValue(full.date);
  await expect(editor.getByLabel('Body weight · lb', { exact: true })).toHaveValue('160.5');
  await expect(editor.getByLabel('Waist at navel · in', { exact: true })).toHaveValue('32.1');
  await expect(editor.getByLabel('Sleep · hours', { exact: true })).toHaveValue('6.25');
  for (const [label, value] of [
    ['Energy', '4'],
    ['Soreness', '2'],
    ['Sport / skill quality', '5'],
  ]) {
    await expect(editor.getByRole('combobox', { name: label, exact: true })).toHaveValue(value);
  }
  await expect(editor.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue(full.notes);
  await editor.getByLabel('Body weight · lb', { exact: true }).fill('999');
  await page.keyboard.press('Escape');
  await expect(editor).not.toBeVisible();
  await fullRow.focus();
  await page.keyboard.press('Enter');
  await expect(editor.getByLabel('Body weight · lb', { exact: true })).toHaveValue('160.5');
  await editor
    .getByRole('textbox', { name: 'Notes', exact: true })
    .fill('Synthetic edited check-in');
  await editor.getByRole('button', { name: 'Save check-in', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: 'Progress', exact: true }).click();
  const saved = (await account.api.workspace.export()).state.training.checkIns;
  expect(saved.find((item) => item.id === full.id)).toEqual({
    ...full,
    notes: 'Synthetic edited check-in',
  });
  expect(saved.find((item) => item.id === short.id)).toEqual(short);
  expect(saved.find((item) => item.id === notesOnly.id)).toEqual(notesOnly);
  await rows.filter({ hasText: 'Oct 26' }).focus();
  await page.keyboard.press('Space');
  await expect(editor.getByLabel('Date', { exact: true })).toHaveValue(notesOnly.date);
  await expect(editor.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue(
    notesOnly.notes,
  );
  await expect(editor.getByLabel('Body weight · lb', { exact: true })).toHaveValue('');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
});

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
  await expect(page.getByRole('tab', { name: 'Coach', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Adapt', exact: true })).toHaveCount(0);
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
  const saved = (await account.api.workspace.details({ sessionIds: [session.id] })).sessions.find(
    (item) => item.id === session.id,
  )!;
  expect(saved.status).toBe('completed');
  expect(saved.exercises[0].sets[0]).toMatchObject({ weight: 42.5, reps: 9, completed: true });
  expect(saved.exercises[0].sets[1]).toMatchObject({ weight: null, reps: null, completed: false });
});

test('retired agent navigation redirects home and settings keeps manual account tools', async ({
  page,
  account,
}) => {
  await signIn(page, account, '/agent');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('button', { name: 'My agent', exact: true })).toHaveCount(0);
  await page.goto('/settings');
  await expect(page.getByRole('button', { name: 'Export workspace', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Continue with ChatGPT|Reconnect with ChatGPT/ }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Export workspace', exact: true })).toBeVisible();
});
