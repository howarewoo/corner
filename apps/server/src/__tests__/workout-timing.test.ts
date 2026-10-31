import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQueries } from '../queries.js';
import { WorkspaceStore } from '../store.js';
import { testDatabase, closeTestDatabase } from '../../tests/helpers.ts';
import type { WorkoutSession } from '@packages/training/types';

test('timing survives persistence and export/reimport; concurrent starts remain owner-scoped', async () => {
  const database = await testDatabase();
  try {
    const store = new WorkspaceStore(createQueries(database));
    const startedAt = '2026-10-31T10:00:00.000Z';
    const session: WorkoutSession = {
      id: 'first',
      name: 'Walk',
      date: '2026-10-31',
      kind: 'conditioning',
      status: 'in_progress',
      unit: 'kg',
      exercises: [],
      plannedMinutes: 30,
      durationMinutes: null,
      rounds: null,
      readiness: null,
      sessionRpe: null,
      notes: '',
      changeReason: '',
      createdAt: startedAt,
      updatedAt: startedAt,
      timing: { startedAt, rests: [] },
    };
    const save = (
      owner: string,
      request: string,
      value: WorkoutSession,
      expectedUpdatedAt: string | null = null,
    ) =>
      store.mutate(owner, request, {
        type: 'training.session.save',
        data: { session: value, expectedUpdatedAt },
      });
    const starts = await Promise.allSettled([
      save('alice', 'start-first', session),
      save('alice', 'start-second', { ...session, id: 'second' }),
    ]);
    assert.equal(starts.filter((result) => result.status === 'fulfilled').length, 1);
    const original = (await store.exportSnapshot('alice')).state.training.sessions[0];
    assert.deepEqual(original.timing, session.timing);
    await save('bob', 'independent-start', session);
    await assert.rejects(
      save(
        'alice',
        'changed-clock',
        { ...original, timing: { startedAt: '2026-10-31T11:00:00.000Z', rests: [] } },
        original.updatedAt,
      ),
    );
    await assert.rejects(
      save('alice', 'lost-clock', { ...original, timing: undefined }, original.updatedAt),
    );
    const finished: WorkoutSession = {
      ...original,
      status: 'completed',
      durationMinutes: 20,
      timing: {
        ...original.timing!,
        endedAt: '2026-10-31T10:20:00.000Z',
        rests: [
          {
            exerciseId: 'former-exercise',
            setId: 'first-set',
            startedAt: '2026-10-31T10:01:00.000Z',
            endedAt: '2026-10-31T10:02:30.000Z',
            targetSeconds: 90,
          },
        ],
      },
    };
    await save('alice', 'finish-first', finished, original.updatedAt);
    const exported = await store.exportSnapshot('alice');
    await store.replaceImport('restored', 'restore-workout', exported.state, 0);
    assert.deepEqual(
      (await store.exportSnapshot('restored')).state.training.sessions[0].timing,
      finished.timing,
    );
    assert.equal(
      (await store.exportSnapshot('bob')).state.training.sessions[0].status,
      'in_progress',
    );
  } finally {
    await closeTestDatabase(database);
  }
});
