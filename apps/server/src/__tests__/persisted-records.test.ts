import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { validatePersistedRecords } from '../persisted-records.js';
import { testDatabase, closeTestDatabase } from '../../tests/helpers.ts';
import { createQueries } from '../queries.js';
import { WorkspaceStore } from '../store.js';
import { createInitialState } from '@packages/workspace/initial-state';

function fixture(mode = { readonly: 'on', isolation: 'repeatable read' }) {
  const statements: Array<{ sql: string; parameters: unknown[] }> = [];
  const client = {
    query: async (input: string | { text: string; values?: unknown[] }, parameters: unknown[] = []) => {
      const sql = typeof input === 'string' ? input : input.text;
      if (typeof input !== 'string') parameters = input.values ?? [];
      statements.push({ sql, parameters });
      if (sql.includes('transaction_read_only')) return { rows: [mode] };
      if (sql.includes('workspace_grocery_checks')) {
        if (!parameters.length) return { rows: Array.from({ length: 100 }, (_, index) => ({ user_id: 'owner', key: `grocery:${String(index).padStart(3, '0')}` })) };
        return { rows: [{ user_id: 'owner', key: 'grocery:100' }] };
      }
      return { rows: [] };
    },
  } as unknown as PoolClient;
  return { client, statements };
}

test('persisted validation requires the release-owned consistent read-only snapshot', async () => {
  for (const mode of [
    { readonly: 'off', isolation: 'repeatable read' },
    { readonly: 'on', isolation: 'read committed' },
  ]) {
    const f = fixture(mode);
    await assert.rejects(validatePersistedRecords(f.client, 'public'), /read-only snapshot/);
    assert.equal(f.statements.length, 1);
  }
});

test('persisted validation scans bounded keyset pages, never exports a workspace or writes schema', async () => {
  const f = fixture();
  await validatePersistedRecords(f.client, 'public');
  const grocery = f.statements.filter(({ sql }) => sql.includes('workspace_grocery_checks'));
  assert.equal(grocery.length, 2);
  assert.deepEqual(grocery[1]!.parameters, ['owner', 'grocery:099']);
  assert.ok(grocery.every(({ sql }) => sql.includes('LIMIT 100')));
  assert.ok(f.statements.every(({ sql }) => sql.startsWith('SELECT')));
  assert.ok(f.statements.every(({ sql }) => !sql.includes('workspace_state')));
});

test('persisted validation refuses unsafe stored grocery keys instead of silently normalizing them', async () => {
  const f = fixture();
  const query = f.client.query.bind(f.client);
  f.client.query = (async (input: string | { text: string; values?: unknown[] }, parameters?: unknown[]) => {
    const sql = typeof input === 'string' ? input : input.text;
    if (sql.includes('workspace_grocery_checks')) return { rows: [{ user_id: 'owner', key: '__proto__' }] };
    return typeof input === 'string' ? query(input, parameters) : query(input);
  }) as typeof f.client.query;
  await assert.rejects(validatePersistedRecords(f.client, 'public'));
});

test('real PostgreSQL calendar records validate under a non-UTC timezone without shifting activity dates', async () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'Pacific/Auckland';
  const database = await testDatabase();
  try {
    const state = createInitialState();
    state.settings.timezone = 'Pacific/Auckland';
    state.logs = [{
      id: 'dated-food', date: '2026-10-22', slot: 'lunch', name: 'Calendar lunch',
      nutrition: { calories: 200, protein: 20, carbs: 20, fat: 8 }, servings: 1,
      createdAt: '2026-10-22T01:02:03.456Z',
    }];
    state.training.checkIns = [{
      id: 'dated-checkin', date: '2026-10-22', bodyWeight: 180, waist: null,
      sleepHours: null, energy: null, soreness: null, boxingQuality: null, notes: '',
    }];
    state.training.sessions = [{
      id: 'dated-session', date: '2026-10-22', name: 'Recovery', kind: 'recovery',
      status: 'planned', unit: 'kg', exercises: [], plannedMinutes: 20,
      durationMinutes: null, rounds: null, sessionRpe: null, readiness: null,
      notes: '', changeReason: '', createdAt: '2026-10-22T01:02:03.456Z',
      updatedAt: '2026-10-22T01:02:03.457Z',
    }];
    state.training.scheduledDates = ['2026-10-22'];
    const store = new WorkspaceStore(createQueries(database));
    await store.replaceImport('calendar-owner', 'calendar-import', state, 0);
    const connection = await database.connect();
    try {
      await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const schema = (await connection.query('SELECT current_schema() AS name')).rows[0].name;
      await validatePersistedRecords(connection, schema);
      await connection.query('COMMIT');
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
    }
    assert.deepEqual((await store.exportSnapshot('calendar-owner')).state, state);
  } finally {
    await closeTestDatabase(database);
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});
