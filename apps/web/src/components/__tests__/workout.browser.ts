import { randomUUID } from 'node:crypto';
import { WorkoutSessionSchema } from '@packages/training/workouts';
import type { TrainingCheckIn, WorkoutSession } from '@packages/training/types';
import { test, expect, signIn } from '../../__tests__/browser';

for (const status of ['planned', 'completed'] as const) {
  test(`custom exercise stays open while typing in a ${status} workout`, async ({
    page,
    account,
  }) => {
    const prefillDrafts: WorkoutSession[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/rpc/workspace/prefill')
        prefillDrafts.push(request.postDataJSON().json.session);
    });
    await signIn(page, account, '/workouts');
    await page.getByRole('button', { name: 'Add workout', exact: true }).click();
    await page.getByRole('button', { name: 'Blank workout', exact: true }).click();
    const editor = page.getByRole('dialog', { name: /^(Your workout|Workout details)$/ });
    await editor.getByLabel('Workout name', { exact: true }).fill('Synthetic custom workout');
    await editor.getByRole('combobox', { name: 'Status', exact: true }).selectOption(status);
    if (status === 'completed')
      await editor.getByLabel('Actual minutes', { exact: true }).fill('20');
    await editor.getByRole('button', { name: 'Add exercise', exact: true }).click();
    await editor.getByRole('button', { name: 'Use a custom exercise', exact: true }).click();
    const name = editor.getByLabel('Exercise name', { exact: true });
    const toggle = editor.getByRole('button', { name: 'Edit exercise or targets', exact: true });
    await name.pressSequentially('Q');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(name).toBeFocused();
    await name.pressSequentially('A custom row');
    await expect(name).toHaveValue('QA custom row');
    await expect(name).toBeFocused();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(name).not.toBeVisible();
    await toggle.click();
    await expect(name).toHaveValue('QA custom row');
    await name.fill('');
    await name.pressSequentially('Saved custom row');
    await expect(name).toBeFocused();
    await editor.getByRole('button', { name: 'Save workout', exact: true }).click();
    await expect(editor).not.toBeVisible();
    await page.reload();
    await page
      .getByRole('button', {
        name: status === 'completed' ? 'View / edit' : 'Start workout',
        exact: true,
      })
      .click();
    const reopened = page.getByRole('dialog', {
      name: status === 'planned' ? 'Synthetic custom workout' : 'Workout details',
      exact: true,
    });
    const savedToggle = reopened.getByRole('button', {
      name: 'Edit exercise or targets',
      exact: true,
    });
    await expect(savedToggle).toHaveAttribute('aria-expanded', 'false');
    await savedToggle.click();
    await expect(reopened.getByLabel('Exercise name', { exact: true })).toHaveValue(
      'Saved custom row',
    );
    const saved = (await account.api.workspace.export()).state.training.sessions;
    expect(saved[0]?.exercises[0]?.name).toBe('Saved custom row');
    if (status === 'planned') expect(prefillDrafts.length).toBeGreaterThan(0);
    for (const draft of prefillDrafts)
      expect(WorkoutSessionSchema.safeParse(draft).success).toBe(true);
  });
}

test('catalog replacements and routines retain their initial expansion defaults', async ({
  page,
  account,
}) => {
  await signIn(page, account, '/workouts');
  await page.getByRole('button', { name: 'Manage routines', exact: true }).click();
  await page.getByRole('button', { name: 'New routine', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit routine', exact: true });
  await editor.getByLabel('Workout name', { exact: true }).fill('Synthetic custom routine');
  await editor.getByRole('button', { name: 'Add exercise', exact: true }).click();
  await editor.getByRole('button', { name: /^Add / }).first().click();
  const toggle = editor.getByRole('button', { name: 'Exercise & targets', exact: true });
  const name = editor.getByLabel('Exercise name', { exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(name).toHaveAttribute('readonly');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await editor.getByRole('button', { name: 'Choose from exercise library', exact: true }).click();
  await editor.getByRole('button', { name: 'Use a custom exercise', exact: true }).click();
  await expect(name).toBeEditable();
  await name.pressSequentially('Routine custom row');
  await expect(name).toHaveValue('Routine custom row');
  await expect(name).toBeFocused();
  await editor.getByRole('button', { name: 'Save routine', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Manage routines', exact: true }).click();
  await page.getByRole('button', { name: /Synthetic custom routine/ }).click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(name).toHaveValue('Routine custom row');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Add workout', exact: true }).click();
  await page.getByRole('button', { name: 'Blank workout', exact: true }).click();
  const workout = page.getByRole('dialog', { name: 'Your workout', exact: true });
  await workout.getByRole('button', { name: 'Add exercise', exact: true }).click();
  await workout.getByRole('button', { name: /^Add / }).first().click();
  const workoutToggle = workout.getByRole('button', {
    name: 'Edit exercise or targets',
    exact: true,
  });
  await expect(workoutToggle).toHaveAttribute('aria-expanded', 'false');
  await workoutToggle.click();
  await expect(workout.getByLabel('Exercise name', { exact: true })).toHaveAttribute('readonly');
  await workout.getByRole('button', { name: 'Choose from exercise library', exact: true }).click();
  await workout.getByRole('button', { name: 'Use a custom exercise', exact: true }).click();
  await expect(workoutToggle).toHaveAttribute('aria-expanded', 'true');
  await workout.getByLabel('Exercise name', { exact: true }).pressSequentially('Replacement row');
  await expect(workout.getByLabel('Exercise name', { exact: true })).toHaveValue('Replacement row');
});

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
  await page.getByRole('button', { name: 'Finish workout', exact: true }).click();
  expect(
    await page.locator('.active-workout-overlay form :invalid').evaluateAll((fields) =>
      fields.map((field) => ({
        label: field.getAttribute('aria-label') ?? field.closest('label')?.textContent,
        value: (field as HTMLInputElement).value,
        error: (field as HTMLInputElement).validationMessage,
      })),
    ),
  ).toEqual([]);
  await expect(page.getByRole('button', { name: 'Finish workout', exact: true })).not.toBeVisible();
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

test.describe('active workout recovery', () => {
  // Network fault injection must reach the page instead of its service worker.
  test.use({ serviceWorkers: 'block' });
  test('active workout collapses, navigates, restores unsaved edits, tracks rest and ends only after a successful save', async ({
    page,
    account,
  }) => {
    const timestamp = new Date().toISOString();
    const session: WorkoutSession = {
      id: randomUUID(),
      date: timestamp.slice(0, 10),
      name: 'Morning strength',
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
          name: 'Dumbbell split squat with a deliberately long exercise name',
          loadType: 'per_hand',
          targetSets: 3,
          repMin: 8,
          repMax: 10,
          targetRir: 2,
          restSeconds: 90,
          notes: '',
          targetLoad: { weight: 16, unit: 'kg' },
          sets: [1, 2, 3].map(() => ({
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
    const second = { ...session, id: randomUUID(), name: 'Another workout' };
    for (const item of [session, second])
      await account.api.workspace.mutate({
        requestId: randomUUID(),
        mutation: {
          type: 'training.session.save',
          data: { session: item, expectedUpdatedAt: null },
        },
      });
    await signIn(page, account, '/workouts');
    await page.getByRole('button', { name: 'Start workout', exact: true }).first().click();
    const activeName = await page.locator('.active-workout-title').innerText();
    const active = [session, second].find((item) => item.name === activeName)!;
    const sheet = page.getByRole('dialog', { name: activeName, exact: true });
    const dock = page.getByRole('button', { name: `Resume ${activeName}`, exact: true });
    await expect(sheet).toBeVisible();
    if (page.viewportSize()!.width <= 760) await page.setViewportSize({ width: 360, height: 844 });
    const originalViewport = page.viewportSize()!;
    const expectSurface = async () => {
      const mobile = page.viewportSize()!.width <= 760;
      await expect(sheet).toHaveAttribute('data-slot', mobile ? 'drawer-popup' : 'dialog-content');
      await expect(page.locator('[data-slot="drawer-swipe-handle"]')).toHaveCount(mobile ? 1 : 0);
      const box = (await sheet.boundingBox())!;
      const { width, height } = page.viewportSize()!;
      if (mobile) {
        expect(Math.abs(box.y + box.height - height)).toBeLessThanOrEqual(1);
      } else {
        expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThanOrEqual(1);
        expect(Math.abs(box.y + box.height / 2 - height / 2)).toBeLessThanOrEqual(1);
        expect(box.y).toBeGreaterThanOrEqual(31);
      }
    };
    await expectSurface();
    // Both responsive primitives must collapse without losing the workout,
    // return focus to Resume, and contain keyboard focus after reopening.
    await sheet.getByRole('button', { name: 'Collapse workout', exact: true }).click();
    await expect(sheet).not.toBeVisible();
    await expect(dock).toBeFocused();
    await dock.click();
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Collapse workout', exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    await expect
      .poll(() => sheet.evaluate((element) => element.contains(document.activeElement)))
      .toBe(true);
    await sheet.getByRole('button', { name: 'Save workout', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect
      .poll(() => sheet.evaluate((element) => element.contains(document.activeElement)))
      .toBe(true);
    expect(
      await sheet.evaluate((element) => {
        const body = element.querySelector('.active-workout-body')!;
        const clock = element.querySelector('.workout-clock')!;
        const exercise = element.querySelector('h3')!;
        return {
          fits:
            element.getBoundingClientRect().width <= innerWidth &&
            body.scrollWidth <= body.clientWidth + 1,
          compactTimer:
            parseFloat(getComputedStyle(clock).fontSize) <
            parseFloat(getComputedStyle(exercise).fontSize),
        };
      }),
    ).toEqual({ fits: true, compactTimer: true });
    const startedAt = (await account.api.workspace.details({ sessionIds: [active.id] })).sessions[0]
      .timing?.startedAt;
    expect(startedAt).toBeTruthy();
    await expect(sheet.getByRole('button', { name: /Cancel|Close/, exact: true })).toHaveCount(0);
    const label = active.exercises[0].name;
    await sheet.getByLabel(`${label} set 1 weight kg per hand`, { exact: true }).fill('18');
    await sheet.getByLabel(`${label} set 1 reps`, { exact: true }).fill('9');
    await sheet.getByLabel(`${label} set 1 completed`, { exact: true }).check();
    await expect(sheet.getByRole('button', { name: 'Start next set', exact: true })).toBeVisible();
    await sheet
      .getByRole('button', { name: 'Extend rest target by 15 seconds', exact: true })
      .click();
    // Crossing the breakpoint while resting preserves checked sets and the rest interval.
    await page.setViewportSize({ width: originalViewport.width <= 760 ? 1024 : 360, height: 844 });
    await expectSurface();
    await expect(sheet.getByLabel(`${label} set 1 completed`, { exact: true })).toBeChecked();
    await expect(
      sheet.getByLabel(`${label} set 1 weight kg per hand`, { exact: true }),
    ).toHaveValue('18');
    await expect(sheet.getByRole('button', { name: 'Start next set', exact: true })).toBeVisible();
    await page.setViewportSize(originalViewport);
    await expectSurface();
    await page.keyboard.press('Escape');
    await expect(sheet).not.toBeVisible();
    await expect(dock).toBeVisible();
    await expect(dock).toContainText('Rest');
    await expect(dock).toBeFocused();
    if (page.viewportSize()!.width <= 760) {
      const bottom = await page.locator('[data-slot="bottom-navigation"]').boundingBox();
      const dockBox = await dock.boundingBox();
      expect(dockBox!.y + dockBox!.height).toBeLessThanOrEqual(bottom!.y);
    }
    // Client navigation retains the mounted editor; full reload restores the persisted clock.
    await page.locator('a[href="/"]').filter({ visible: true }).first().click();
    await expect(page).toHaveURL(/\/$/);
    await expect(dock).toBeVisible();
    await dock.click();
    await expect(
      sheet.getByLabel(`${label} set 1 weight kg per hand`, { exact: true }),
    ).toHaveValue('18');
    await sheet.getByRole('button', { name: 'Start next set', exact: true }).click();
    await expect(sheet.getByRole('button', { name: 'Start next set', exact: true })).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await account.api.workspace.details({ sessionIds: [active.id] })).sessions[0].timing
            ?.rests[0]?.endedAt,
      )
      .toBeTruthy();
    // A failed autosave leaves a browser-local recovery draft, without erasing the saved workout.
    await page.route('**/api/rpc/workspace/mutate', (route) => route.abort());
    await sheet.getByLabel(`${label} set 2 weight kg per hand`, { exact: true }).fill('19');
    await expect(sheet.getByRole('status')).toContainText('Your draft is kept');
    // A failed autosave must survive both sides of the exact mobile boundary.
    for (const width of [760, 761]) {
      await page.setViewportSize({ width, height: 844 });
      await expectSurface();
      await expect(
        sheet.getByLabel(`${label} set 2 weight kg per hand`, { exact: true }),
      ).toHaveValue('19');
    }
    await page.setViewportSize(originalViewport);
    await expectSurface();
    await page.reload();
    await expect(dock).toBeVisible();
    await dock.click();
    await expect(
      sheet.getByLabel(`${label} set 2 weight kg per hand`, { exact: true }),
    ).toHaveValue('19');
    await expect(sheet.getByLabel(`${label} set 1 completed`, { exact: true })).toBeChecked();
    await expect(sheet.getByRole('status')).toContainText('Your draft is kept');
    await sheet.getByRole('button', { name: 'Finish workout', exact: true }).click();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Finish workout', exact: true })).toBeEnabled();
    await page.unroute('**/api/rpc/workspace/mutate');
    // The server commits, but its response is lost. Read back before declaring failure.
    await page.route(
      '**/api/rpc/workspace/mutate',
      async (route) => {
        await route.fetch();
        await route.abort();
      },
      { times: 1 },
    );
    await sheet.getByRole('button', { name: 'Finish workout', exact: true }).click();
    await expect(sheet).not.toBeVisible();
    await expect(dock).toHaveCount(0);
    const saved = (await account.api.workspace.details({ sessionIds: [active.id] })).sessions[0];
    expect(saved.status).toBe('completed');
    expect(saved.timing?.endedAt).toBeTruthy();
    expect(saved.timing?.startedAt).toBe(startedAt);
    expect(saved.durationMinutes).toBeGreaterThan(0);
    expect(saved.timing?.rests[0]).toMatchObject({ targetSeconds: 105 });
    expect(saved.timing?.rests[0].endedAt).toBeTruthy();
    expect(saved.exercises[0].sets[1].weight).toBe(19);
    // Measured durations need not land on half-minute steps when history is edited.
    await page.goto('/workouts');
    await page.getByRole('button', { name: 'View / edit', exact: true }).click();
    const history = page.getByRole('dialog', { name: 'Workout details', exact: true });
    await expect(history.getByLabel('Actual minutes', { exact: true })).toHaveValue(
      String(saved.durationMinutes),
    );
    await history.getByRole('button', { name: 'Save workout', exact: true }).click();
    await expect(history).not.toBeVisible();
  });
});
