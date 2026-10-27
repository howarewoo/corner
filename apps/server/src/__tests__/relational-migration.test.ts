import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { createDatabase } from '../database.js';
import {
  cutoverRecoverySchema,
  inspectDocumentCutover,
  migrate,
  migrationCli,
  preservingDocumentCutover,
} from '../migrate.js';
import { migrationsFolder } from '../migration-inventory.js';
import { createInitialState } from '@packages/workspace/initial-state';
import type { AppState } from '@packages/workspace/types';
import { createQueries } from '../queries.js';
import { WorkspaceStore } from '../store.js';
import { applicationCatalog, quoteIdentifier as quote } from '../schema-catalog.js';
import { ApiError } from '../http.js';

async function fixture(
  run: (database: Pool, schema: string, admin: Pool) => Promise<void>,
  previous = true,
) {
  if (!process.env.CORNER_TEST_DATABASE_URL)
    throw new Error('A disposable CORNER_TEST_DATABASE_URL is required.');
  const url = new URL(process.env.CORNER_TEST_DATABASE_URL);
  const admin = createDatabase(url.href);
  const schema = 'corner_cutover_' + randomUUID().replaceAll('-', '');
  const prefix = await mkdtemp(join(tmpdir(), 'corner-relational-prefix-'));
  await admin.query(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const database = createDatabase(url.href);
  try {
    if (previous) {
      await mkdir(join(prefix, 'meta'));
      const journal = JSON.parse(
        await readFile(join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
      );
      await writeFile(
        join(prefix, 'meta/_journal.json'),
        JSON.stringify({ ...journal, entries: [journal.entries[0]] }),
      );
      await cp(join(migrationsFolder, '0000_corner.sql'), join(prefix, '0000_corner.sql'));
      await cp(
        join(migrationsFolder, 'meta/0000_snapshot.json'),
        join(prefix, 'meta/0000_snapshot.json'),
      );
      await migrate(database, prefix);
    }
    await run(database, schema, admin);
  } finally {
    await database.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quote(cutoverRecoverySchema(schema))} CASCADE`);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    await rm(prefix, { recursive: true, force: true });
  }
}
async function waitForLock(database: Pool, mode: string, count = 1) {
  // PostgreSQL lock acquisition is external real I/O; fake JS timers cannot
  // signal it. Poll the actual lock condition, not a guessed race delay.
  for (let attempt = 0; attempt < 1000; attempt++) {
    const result = await database.query(
      `SELECT count(*)::int AS count FROM pg_locks
      WHERE relation = 'workspace_state'::regclass AND mode=$1 AND NOT granted`,
      [mode],
    );
    if (result.rows[0].count >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The controlled legacy-writer race did not reach its lock boundary.');
}

test('fresh and existing-empty native schemas initialize relational storage without rewriting the native prefix', async () => {
  for (const previous of [false, true])
    await fixture(async (database) => {
      const before = previous
        ? (await database.query('SELECT hash,created_at FROM __drizzle_migrations ORDER BY id'))
            .rows
        : [];
      await migrate(database);
      const after = (
        await database.query('SELECT hash,created_at FROM __drizzle_migrations ORDER BY id')
      ).rows;
      assert.equal(after.length, 2);
      if (previous) assert.deepEqual(after.slice(0, 1), before);
      assert.equal(
        (await database.query("SELECT to_regclass('workspace_state') AS legacy")).rows[0].legacy,
        null,
      );
      assert.equal(
        (await database.query('SELECT count(*)::int AS count FROM workspace_metadata')).rows[0]
          .count,
        0,
      );
    }, previous);
});

test('any legacy workspace row, even default/settings-only, refuses the whole cutover and preserves unrelated records', async () => {
  await fixture(async (database) => {
    const data = JSON.stringify(createInitialState());
    await database.query(
      'INSERT INTO workspace_state(user_id,data,version,updated_at) VALUES ($1,$2,0,$3)',
      ['owner', data, '2026-10-22T12:00:00.000Z'],
    );
    await database.query(
      "INSERT INTO corner_subscription_meta(key,value) VALUES ('preserve','opaque-private-metadata')",
    );
    const history = (
      await database.query('SELECT hash,created_at FROM __drizzle_migrations ORDER BY id')
    ).rows;
    await assert.rejects(migrate(database), /Relational cutover refused/);
    assert.equal(
      (await database.query('SELECT data FROM workspace_state WHERE user_id=$1', ['owner'])).rows[0]
        .data,
      data,
    );
    assert.equal(
      (await database.query("SELECT to_regclass('workspace_metadata') AS metadata")).rows[0]
        .metadata,
      null,
    );
    assert.deepEqual(
      (await database.query('SELECT hash,created_at FROM __drizzle_migrations ORDER BY id')).rows,
      history,
    );
    assert.equal(
      (await database.query("SELECT value FROM corner_subscription_meta WHERE key='preserve'"))
        .rows[0].value,
      'opaque-private-metadata',
    );
  });
});

test('a legacy writer committed before the exclusive migration lock is never discarded', async () => {
  await fixture(async (database) => {
    const writer = await database.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(
        'INSERT INTO workspace_state(user_id,data,version,updated_at) VALUES ($1,$2,1,$3)',
        ['late-owner', JSON.stringify(createInitialState()), '2026-10-22T12:00:00.000Z'],
      );
      const migration = migrate(database).then(
        () => null,
        (error: unknown) => error,
      );
      await waitForLock(database, 'AccessExclusiveLock');
      await writer.query('COMMIT');
      const failure = await migration;
      assert.ok(failure instanceof Error && /Relational cutover refused/.test(failure.message));
      assert.equal(
        (
          await database.query(
            "SELECT count(*)::int AS count FROM workspace_state WHERE user_id='late-owner'",
          )
        ).rows[0].count,
        1,
      );
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
    }
  });
});

test('an old writer queued behind retirement fails rather than committing into discarded storage', async () => {
  await fixture(async (database) => {
    const reader = await database.connect();
    const writer = await database.connect();
    try {
      await reader.query('BEGIN');
      await reader.query('SELECT user_id FROM workspace_state');
      const migration = migrate(database);
      await waitForLock(database, 'AccessExclusiveLock');
      const outcome = writer
        .query('INSERT INTO workspace_state(user_id,data,version,updated_at) VALUES ($1,$2,1,$3)', [
          'late-owner',
          JSON.stringify(createInitialState()),
          '2026-10-22T12:00:00.000Z',
        ])
        .then(
          () => ({ committed: true, error: null }),
          (error: unknown) => ({ committed: false, error }),
        );
      await waitForLock(database, 'RowExclusiveLock');
      await reader.query('COMMIT');
      await migration;
      const result = await outcome;
      assert.equal(result.committed, false);
      assert.ok(result.error instanceof Error);
      assert.equal(
        (await database.query("SELECT to_regclass('workspace_state') AS legacy")).rows[0].legacy,
        null,
      );
      assert.equal(
        (await database.query('SELECT count(*)::int AS count FROM workspace_metadata')).rows[0]
          .count,
        0,
      );
    } finally {
      await reader.query('ROLLBACK');
      reader.release();
      writer.release();
    }
  });
});

const stamp = '2026-10-22T12:00:00.000Z';

function populatedWorkspace(): AppState {
  const state = createInitialState('Alice Preserved');
  state.settings.timezone = 'Pacific/Auckland';
  state.recipes = [
    {
      id: 'recipe-1',
      name: 'Oats Bowl',
      description: 'Pre-training oats',
      category: 'breakfast',
      prepMinutes: 5,
      cookMinutes: 5,
      nutrition: { calories: 420, protein: 30, carbs: 55, fat: 9 },
      ingredients: [
        {
          name: 'Rolled oats',
          quantity: 80,
          unit: 'g',
          aisle: 'Grains',
          shoppingQuantity: 80,
          shoppingUnit: 'g',
        },
      ],
      steps: ['Simmer oats.', 'Top with protein.'],
      storage: 'Fridge 2 days',
      variation: 'Add berries',
      tags: ['high-protein'],
      color: '#234b35',
      source: 'manual',
      favorite: true,
      createdAt: stamp,
    },
    {
      id: 'recipe-2',
      name: 'Recovery Bowl',
      description: '',
      category: 'main',
      prepMinutes: 10,
      cookMinutes: 15,
      nutrition: { calories: 640, protein: 48, carbs: 72, fat: 16 },
      ingredients: [{ name: 'Rice', quantity: 150, unit: 'g', aisle: 'Grains' }],
      steps: ['Cook rice.'],
      storage: '',
      variation: '',
      tags: [],
      color: '#1f3a52',
      source: 'ai',
      favorite: false,
      createdAt: stamp,
    },
  ];
  state.plan = [
    { id: 'plan-2', date: '2026-10-23', slot: 'dinner', recipeId: 'recipe-2', servings: 1.5 },
    { id: 'plan-1', date: '2026-10-22', slot: 'breakfast', recipeId: 'recipe-1', servings: 1 },
  ];
  state.logs = [
    {
      id: 'log-orphan',
      date: '2026-10-20',
      slot: 'lunch',
      name: 'Deleted historical recipe snapshot',
      nutrition: { calories: 510, protein: 38, carbs: 49, fat: 15 },
      servings: 1,
      recipeId: 'deleted-recipe-id',
      planEntryId: 'deleted-plan-id',
      createdAt: stamp,
    },
    {
      id: 'log-linked',
      date: '2026-10-22',
      slot: 'breakfast',
      name: 'Oats Bowl',
      nutrition: { calories: 420, protein: 30, carbs: 55, fat: 9 },
      servings: 1,
      recipeId: 'recipe-1',
      planEntryId: 'plan-1',
      createdAt: stamp,
    },
  ];
  state.groceryChecks = { '2026-10-19|oats|g': true, '2026-10-19|rice|g': false };
  state.requests = [
    {
      id: 'req-fulfilled',
      prompt: 'Quick breakfast',
      calories: 420,
      protein: 30,
      maxMinutes: 15,
      status: 'fulfilled',
      createdAt: stamp,
      recipeId: 'recipe-1',
    },
    {
      id: 'req-pending',
      prompt: 'Post-boxing meal',
      calories: 700,
      protein: 50,
      maxMinutes: 25,
      status: 'pending',
      createdAt: stamp,
    },
  ];
  const exercise = {
    id: 'ex-1',
    name: 'Bench press',
    loadType: 'total' as const,
    targetSets: 2,
    repMin: 6,
    repMax: 8,
    targetRir: 2,
    restSeconds: 120,
    notes: 'Pause on chest',
    catalogId: 'barbell-bench-press',
    targetLoad: { weight: 80, unit: 'kg' as const },
  };
  state.training.templates = [
    {
      id: 'tpl-1',
      name: 'Upper Strength',
      kind: 'strength',
      description: 'Main press day',
      durationMinutes: 50,
      exercises: [exercise],
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];
  state.training.sessions = [
    {
      id: 'sess-2',
      templateId: 'tpl-1',
      date: '2026-10-23',
      name: 'Upper Strength',
      kind: 'strength',
      status: 'completed',
      unit: 'kg',
      plannedMinutes: 50,
      durationMinutes: 48,
      rounds: null,
      sessionRpe: 8,
      readiness: 4,
      notes: 'Solid session',
      changeReason: '',
      createdAt: stamp,
      updatedAt: '2026-10-23T18:30:00.456Z',
      exercises: [
        {
          ...exercise,
          sets: [
            {
              id: 'set-warmup',
              weight: 40,
              reps: 8,
              rir: 4,
              completed: true,
              kind: 'warmup',
            },
            {
              id: 'set-work',
              weight: 80,
              reps: 7,
              rir: 1.5,
              completed: true,
              kind: 'working',
            },
          ],
        },
      ],
    },
    {
      id: 'sess-1',
      date: '2026-10-21',
      name: 'Recovery Mobility',
      kind: 'recovery',
      status: 'Completed'.toLowerCase() as 'completed',
      unit: 'lb',
      plannedMinutes: 20,
      durationMinutes: 0,
      rounds: 0,
      sessionRpe: null,
      readiness: null,
      notes: '',
      changeReason: 'Adjusted for travel',
      createdAt: stamp,
      updatedAt: stamp,
      exercises: [],
    },
  ];
  state.training.checkIns = [
    {
      id: 'ci-1',
      date: '2026-10-22',
      bodyWeight: 78.4,
      waist: 81,
      sleepHours: 7.5,
      energy: 4,
      soreness: 2,
      boxingQuality: 4,
      notes: 'Rested',
    },
  ];
  state.training.requests = [
    {
      id: 'treq-1',
      prompt: 'Deload check',
      date: '2026-10-22',
      sessionId: 'sess-2',
      status: 'answered',
      createdAt: stamp,
    },
    {
      id: 'treq-2',
      prompt: 'Add conditioning',
      date: '2026-10-24',
      status: 'pending',
      createdAt: stamp,
    },
  ];
  state.training.reviews = [
    {
      id: 'trev-1',
      requestId: 'treq-1',
      title: 'Maintain load',
      summary: 'Keep current progression',
      createdAt: stamp,
      status: 'applied',
      changes: [
        {
          session: { ...state.training.sessions[1]!, id: 'deleted-session', status: 'planned' },
          expectedUpdatedAt: null,
          reason: 'Historical applied review',
        },
      ],
    },
  ];
  state.training.scheduledDates = ['2026-10-25', '2026-10-21', '2026-10-23'];
  return state;
}

test('preserving cutover converts populated workspaces, preserves revisions/order/sentinels/receipts, and keeps applicationCatalog clean', async () => {
  await fixture(async (database, schema) => {
    const aliceState = populatedWorkspace();
    const bobLegacyRaw = (() => {
      const base = createInitialState('Bob Legacy Format');
      const { training: _training, ...withoutTraining } = base;
      return withoutTraining;
    })();
    await database.query(
      'INSERT INTO workspace_state(user_id,data,version,updated_at) VALUES ($1,$2,14,$3), ($4,$5,3,$3)',
      ['alice', JSON.stringify(aliceState), stamp, 'bob', JSON.stringify(bobLegacyRaw)],
    );
    await database.query(
      'CREATE TABLE auth_sentinel (id text PRIMARY KEY, email text NOT NULL)',
    );
    await database.query("INSERT INTO auth_sentinel VALUES ('alice','alice@example.test')");
    await database.query(
      "INSERT INTO corner_subscription_meta(key,value) VALUES ('sentinel','meta-value')",
    );
    await database.query(
      "INSERT INTO corner_subscription_accounts(user_id,encrypted,version,refresh_owner,refresh_until) VALUES ('alice','enc-token',2,'owner-1',99)",
    );
    await database.query(
      "INSERT INTO corner_subscription_attempts(state_hash,user_id,session_hash,encrypted,expires_at) VALUES ('hash-1','alice','sess-1','enc-attempt',12345)",
    );
    await database.query(
      "INSERT INTO corner_subscription_generations(user_id,generation) VALUES ('alice',4)",
    );
    await database.query(
      `INSERT INTO corner_ai_runs(id,user_id,request_id,payload_hash,kind,status,prompt,reference_date,base_revision,result,created_at,updated_at)
       VALUES ('run-1','alice','ai-req-1','ai-hash','plan','completed','Prompt','2026-10-22',13,'{"ok":true}',$1,$1)`,
      [stamp],
    );
    await database.query(
      `INSERT INTO mutation_receipts(user_id,request_id,payload_hash,revision,created_at)
       VALUES ('alice','hist-req-14','hist-payload-hash',14,$1)`,
      [stamp],
    );

    const beforeInspect = await inspectDocumentCutover(database, 'cutover-op-1');
    assert.equal(beforeInspect.phase, 'untouched');
    assert.equal(beforeInspect.legacyTablePresent, true);
    assert.equal(beforeInspect.legacyRowCount, 2);
    assert.equal(beforeInspect.legacyFenced, false);
    assert.equal(beforeInspect.operationId, null);

    // Plain migrate() must STILL refuse populated workspaces.
    await assert.rejects(migrate(database), /Relational cutover refused/);

    const converted = await preservingDocumentCutover(database, 'cutover-op-1');
    assert.equal(converted.phase, 'completed');
    assert.equal(converted.operationId, 'cutover-op-1');
    assert.equal(converted.newlyStagedOwners, 2);
    assert.equal(converted.newlyImportedOwners, 2);
    assert.equal(converted.skippedImportedOwners, 0);
    assert.equal(converted.archivedOwners, 2);
    assert.equal(converted.importedOwners, 2);
    assert.equal(converted.pendingOwners, 0);
    assert.equal(converted.legacyTablePresent, false);
    assert.equal(converted.relationalSchemaPresent, true);

    const store = new WorkspaceStore(createQueries(database));
    const aliceExport = await store.exportSnapshot('alice');
    assert.equal(aliceExport.revision, 14);
    assert.deepEqual(aliceExport.state, aliceState);

    const bobExport = await store.exportSnapshot('bob');
    assert.equal(bobExport.revision, 3);
    assert.deepEqual(bobExport.state, createInitialState('Bob Legacy Format'));

    // Unrelated Auth, subscription, AI run, and receipt rows remain byte-for-byte intact.
    assert.deepEqual((await database.query('SELECT * FROM auth_sentinel')).rows, [
      { id: 'alice', email: 'alice@example.test' },
    ]);
    assert.equal(
      (await database.query("SELECT value FROM corner_subscription_meta WHERE key='sentinel'"))
        .rows[0].value,
      'meta-value',
    );
    assert.equal(
      (await database.query("SELECT encrypted FROM corner_subscription_accounts WHERE user_id='alice'"))
        .rows[0].encrypted,
      'enc-token',
    );
    assert.equal(
      (await database.query("SELECT id FROM corner_ai_runs WHERE user_id='alice'")).rows[0].id,
      'run-1',
    );

    // Historical receipt semantics and post-cutover mutations work seamlessly.
    await assert.rejects(
      store.mutate(
        'alice',
        'hist-req-14',
        { type: 'grocery.check', data: { key: 'new|g', checked: true } },
        14,
      ),
      (err: unknown) => err instanceof ApiError && err.code === 'REQUEST_ID_REUSED',
    );
    const mutated = await store.mutate(
      'alice',
      'post-cutover-req-15',
      { type: 'grocery.check', data: { key: 'post-cutover|g', checked: true } },
      14,
    );
    assert.equal(mutated.revision, 15);
    const retried = await store.mutate(
      'alice',
      'post-cutover-req-15',
      { type: 'grocery.check', data: { key: 'post-cutover|g', checked: true } },
      14,
    );
    assert.equal(retried.revision, 15);

    // Re-running preservingDocumentCutover with the same operationId does not overwrite post-cutover edits.
    const rerun = await preservingDocumentCutover(database, 'cutover-op-1');
    assert.equal(rerun.phase, 'completed');
    assert.equal(rerun.newlyStagedOwners, 0);
    assert.equal(rerun.newlyImportedOwners, 0);
    assert.equal(rerun.skippedImportedOwners, 2);
    assert.equal((await store.bootstrap('alice')).revision, 15);
    assert.equal((await store.exportSnapshot('alice')).state.groceryChecks['post-cutover|g'], true);

    // Recovery archive is retained outside application schema, so applicationCatalog matches a clean reference.
    await database.query('DROP TABLE auth_sentinel');
    await fixture(async (cleanDb, cleanSchema) => {
      await migrate(cleanDb);
      const connA = await database.connect();
      const connB = await cleanDb.connect();
      try {
        await connA.query('BEGIN');
        await connB.query('BEGIN');
        assert.equal(
          await applicationCatalog(connA, schema),
          await applicationCatalog(connB, cleanSchema),
        );
      } finally {
        await connA.query('ROLLBACK');
        await connB.query('ROLLBACK');
        connA.release();
        connB.release();
      }
    }, false);
  });
});

test('preflight refuses invalid live or unimported archived rows before native 0001 DDL', async () => {
  await fixture(async (database, schema) => {
    const valid = createInitialState('Valid');
    const invalid = {
      ...createInitialState('Corrupt'),
      plan: [
        { id: 'bad-plan', date: '2026-10-22', slot: 'lunch', recipeId: 'missing-recipe', servings: 1 },
      ],
    };
    await database.query(
      'INSERT INTO workspace_state(user_id,data,version,updated_at) VALUES ($1,$2,5,$3), ($4,$5,8,$3)',
      ['valid-owner', JSON.stringify(valid), stamp, 'corrupt-owner', JSON.stringify(invalid)],
    );
    const beforeRows = (await database.query('SELECT * FROM workspace_state ORDER BY user_id')).rows;
    const beforeHistory = (await database.query('SELECT * FROM __drizzle_migrations ORDER BY id')).rows;

    await assert.rejects(
      preservingDocumentCutover(database, 'op-preflight-fail'),
      /Every planned meal must reference a recipe/,
    );

    assert.deepEqual(
      (await database.query('SELECT * FROM workspace_state ORDER BY user_id')).rows,
      beforeRows,
    );
    assert.deepEqual(
      (await database.query('SELECT * FROM __drizzle_migrations ORDER BY id')).rows,
      beforeHistory,
    );
    assert.equal(
      (await database.query("SELECT to_regclass('workspace_metadata') AS meta")).rows[0].meta,
      null,
    );
    assert.equal(
      (
        await database.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [
          cutoverRecoverySchema(schema),
        ])
      ).rowCount,
      0,
    );
    assert.equal((await inspectDocumentCutover(database)).phase, 'untouched');
  });
});

test('preflight refuses SQL-unrepresentable timestamps without staging or advancing native history', async () => {
  const fields: Array<
    [
      string,
      (state: AppState) => { createdAt: string; updatedAt?: string },
      'createdAt' | 'updatedAt',
    ]
  > = [
    ['recipe request', (state) => state.requests[0], 'createdAt'],
    ['recipe', (state) => state.recipes[0], 'createdAt'],
    ['food entry', (state) => state.logs[0], 'createdAt'],
    ['template creation', (state) => state.training.templates[0], 'createdAt'],
    ['template update', (state) => state.training.templates[0], 'updatedAt'],
    ['session creation', (state) => state.training.sessions[0], 'createdAt'],
    ['session update', (state) => state.training.sessions[0], 'updatedAt'],
    ['training request', (state) => state.training.requests[0], 'createdAt'],
    ['training review', (state) => state.training.reviews[0], 'createdAt'],
  ];
  await fixture(async (database, schema) => {
    const beforeHistory = (await database.query('SELECT * FROM __drizzle_migrations ORDER BY id'))
      .rows;
    for (const [name, record, field] of fields) {
      const state = populatedWorkspace();
      record(state)[field] =
        name.startsWith('recipe') || name === 'food entry'
          ? '2026-02-30T12:00:00Z'
          : '0000-01-01T12:00:00Z';
      await database.query(
        `INSERT INTO workspace_state(user_id,data,version,updated_at) VALUES ('owner',$1,5,$2)
         ON CONFLICT (user_id) DO UPDATE SET data=excluded.data`,
        [JSON.stringify(state), stamp],
      );
      const beforeRows = (await database.query('SELECT * FROM workspace_state')).rows;
      await assert.rejects(
        preservingDocumentCutover(database, 'op-invalid-timestamp'),
        { code: '22008' },
        name,
      );
      assert.deepEqual(
        (await database.query('SELECT * FROM workspace_state')).rows,
        beforeRows,
        name,
      );
      assert.deepEqual(
        (await database.query('SELECT * FROM __drizzle_migrations ORDER BY id')).rows,
        beforeHistory,
        name,
      );
      assert.equal(
        (
          await database.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [
            cutoverRecoverySchema(schema),
          ])
        ).rowCount,
        0,
        name,
      );
      const inspection = await inspectDocumentCutover(database);
      assert.equal(inspection.phase, 'untouched', name);
      assert.equal(inspection.legacyFenced, false, name);
    }
  });
});

test('late legacy writer queued behind Phase 1 lock is blocked by CHECK(false) fence between Phase 1 and Phase 2', async () => {
  await fixture(async (database) => {
    const initial = JSON.stringify(createInitialState('Existing Owner'));
    await database.query(
      'INSERT INTO workspace_state(user_id,data,version,updated_at) VALUES ($1,$2,4,$3)',
      ['existing', initial, stamp],
    );
    const reader = await database.connect();
    const writer = await database.connect();
    try {
      await reader.query('BEGIN');
      await reader.query('SELECT user_id FROM workspace_state');
      const cutover = preservingDocumentCutover(database, 'op-fence-race');
      await waitForLock(database, 'AccessExclusiveLock');
      const lateWrite = writer
        .query('INSERT INTO workspace_state(user_id,data,version,updated_at) VALUES ($1,$2,1,$3)', [
          'late-writer',
          initial,
          stamp,
        ])
        .then(
          () => ({ committed: true, error: null }),
          (error: unknown) => ({ committed: false, error }),
        );
      await waitForLock(database, 'RowExclusiveLock');
      await reader.query('COMMIT');
      const result = await cutover;
      assert.equal(result.phase, 'completed');
      assert.equal(result.newlyImportedOwners, 1);
      const writerResult = await lateWrite;
      assert.equal(writerResult.committed, false);
      assert.ok(writerResult.error instanceof Error);
      assert.deepEqual(
        (await database.query('SELECT user_id, revision::int AS revision FROM workspace_metadata'))
          .rows,
        [{ user_id: 'existing', revision: 4 }],
      );
    } finally {
      await reader.query('ROLLBACK');
      reader.release();
      writer.release();
    }
  });
});

async function terminateBackend(admin: Pool, client: PoolClient, pid: number) {
  client.on('error', () => {});
  await admin.query('SELECT pg_terminate_backend($1)', [pid]).catch(() => {});
  if ('connection' in client && client.connection && typeof client.connection === 'object') {
    const conn = client.connection;
    if (
      'stream' in conn &&
      conn.stream &&
      typeof conn.stream === 'object' &&
      'destroy' in conn.stream &&
      typeof conn.stream.destroy === 'function'
    ) {
      conn.stream.destroy();
    }
  }
}

test('hard connection termination after source staging, after native DDL, and during import recovers without duplicates, and foreign operationId refuses', async () => {
  // 1. Terminate connection immediately after Phase 1 staging commit (before native 0001 DDL).
  await fixture(async (database, schema, admin) => {
    const state1 = populatedWorkspace();
    const state2 = createInitialState('Owner Two');
    await database.query(
      'INSERT INTO workspace_state(user_id,data,version,updated_at) VALUES ($1,$2,11,$3), ($4,$5,6,$3)',
      ['owner-1', JSON.stringify(state1), stamp, 'owner-2', JSON.stringify(state2)],
    );
    const connect = database.connect.bind(database);
    let terminated = false;
    database.connect = (async () => {
      const client = await connect();
      const origQuery = client.query.bind(client);
      const pid = (await origQuery('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      let sawFence = false;
      client.query = (async (
        input: string | { text: string; values?: unknown[] },
        values?: unknown[],
      ) => {
        const sqlText = typeof input === 'string' ? input : input.text;
        if (
          typeof sqlText === 'string' &&
          sqlText.includes('workspace_state_cutover_fenced') &&
          sqlText.includes('ALTER TABLE')
        ) {
          sawFence = true;
        }
        const res =
          values !== undefined
            ? await origQuery(input as string, values)
            : await origQuery(input as string);
        if (sawFence && !terminated && sqlText === 'COMMIT') {
          terminated = true;
          await terminateBackend(admin, client, pid);
          throw new Error('Injected connection loss after Phase 1 staging commit');
        }
        return res;
      }) as typeof client.query;
      return client;
    }) as typeof database.connect;

    await assert.rejects(
      preservingDocumentCutover(database, 'op-stage-crash'),
      /Injected connection loss|terminat|closed/i,
    );
    database.connect = connect;

    const staged = await inspectDocumentCutover(database, 'op-stage-crash');
    assert.equal(staged.phase, 'source-staged');
    assert.equal(staged.legacyTablePresent, true);
    assert.equal(staged.legacyRowCount, 0);
    assert.equal(staged.legacyFenced, true);
    assert.equal(staged.appliedMigrations, 1);
    assert.equal(staged.archivedOwners, 2);
    assert.equal(staged.importedOwners, 0);
    assert.equal(staged.pendingOwners, 2);

    // Plain migrate() must refuse while source-staged and must NOT advance native 0001.
    await assert.rejects(migrate(database), /Ordinary migration refused.*source-staged/);
    assert.equal((await inspectDocumentCutover(database, 'op-stage-crash')).phase, 'source-staged');

    // Foreign operationId must refuse to adopt the archive.
    await assert.rejects(
      inspectDocumentCutover(database, 'foreign-op-id'),
      /different operation ID/,
    );
    await assert.rejects(
      preservingDocumentCutover(database, 'foreign-op-id'),
      /different operation ID/,
    );

    // Corrupted unimported archive row while in source-staged state stops before native 0001 DDL.
    const archiveTable = `${quote(cutoverRecoverySchema(schema))}."workspace_state_archive"`;
    await database.query(`UPDATE ${archiveTable} SET data='{"corrupt":true}' WHERE user_id='owner-2'`);
    await assert.rejects(
      preservingDocumentCutover(database, 'op-stage-crash'),
      /byte mismatch|Invalid/,
    );
    assert.equal((await inspectDocumentCutover(database, 'op-stage-crash')).phase, 'source-staged');
    await database.query(
      `UPDATE ${archiveTable} SET data=$1 WHERE user_id='owner-2'`,
      [JSON.stringify(state2)],
    );

    // Resume with matching operationId completes conversion.
    const resumed = await preservingDocumentCutover(database, 'op-stage-crash');
    assert.equal(resumed.phase, 'completed');
    assert.equal(resumed.newlyStagedOwners, 0);
    assert.equal(resumed.newlyImportedOwners, 2);
    assert.equal(resumed.skippedImportedOwners, 0);
  });

  // 2. Terminate connection after native 0001 DDL commit (before any owner imports) and mid-import after owner-1 commits.
  await fixture(async (database, _schema, admin) => {
    const state1 = populatedWorkspace();
    const state2 = createInitialState('Owner Two');
    await database.query(
      'INSERT INTO workspace_state(user_id,data,version,updated_at) VALUES ($1,$2,11,$3), ($4,$5,6,$3)',
      ['owner-1', JSON.stringify(state1), stamp, 'owner-2', JSON.stringify(state2)],
    );
    const connect = database.connect.bind(database);
    let mode: 'after-ddl' | 'mid-import' | 'none' = 'after-ddl';
    database.connect = (async () => {
      const client = await connect();
      const origQuery = client.query.bind(client);
      const pid = (await origQuery('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      let importedOwner1 = false;
      client.query = (async (
        input: string | { text: string; values?: unknown[] },
        values?: unknown[],
      ) => {
        const sqlText = typeof input === 'string' ? input : input.text;
        if (
          mode === 'after-ddl' &&
          typeof sqlText === 'string' &&
          sqlText.includes('SELECT user_id, data, data_bytes, version, updated_at, imported_at')
        ) {
          mode = 'none';
          await terminateBackend(admin, client, pid);
          throw new Error('Injected connection loss after native 0001 DDL');
        }
        if (
          mode === 'mid-import' &&
          typeof sqlText === 'string' &&
          sqlText.includes('SET imported_at=') &&
          sqlText.includes("'owner-1'")
        ) {
          importedOwner1 = true;
        }
        if (
          mode === 'mid-import' &&
          importedOwner1 &&
          typeof sqlText === 'string' &&
          /update\s+"workspace_metadata"\s+set/i.test(sqlText)
        ) {
          mode = 'none';
          await terminateBackend(admin, client, pid);
          throw new Error('Injected connection loss mid-import during owner-2 transaction');
        }
        return values !== undefined
          ? origQuery(input as string, values)
          : origQuery(input as string);
      }) as typeof client.query;
      return client;
    }) as typeof database.connect;

    await assert.rejects(
      preservingDocumentCutover(database, 'op-ddl-crash'),
      /Injected connection loss|terminat|closed|Failed query/i,
    );
    const afterDdl = await inspectDocumentCutover(database, 'op-ddl-crash');
    assert.equal(afterDdl.phase, 'native-schema-advanced');
    assert.equal(afterDdl.legacyTablePresent, false);
    assert.equal(afterDdl.relationalSchemaPresent, true);
    assert.equal(afterDdl.importedOwners, 0);
    assert.equal(afterDdl.pendingOwners, 2);

    // Plain migrate() must refuse while native-schema-advanced has pending archive owners.
    await assert.rejects(migrate(database), /Ordinary migration refused.*native-schema-advanced/);

    mode = 'mid-import';
    await assert.rejects(
      preservingDocumentCutover(database, 'op-ddl-crash'),
      /Injected connection loss|terminat|closed|Failed query/i,
    );
    database.connect = connect;

    const partial = await inspectDocumentCutover(database, 'op-ddl-crash');
    assert.equal(partial.phase, 'import-partial');
    assert.equal(partial.importedOwners, 1);
    assert.equal(partial.pendingOwners, 1);

    // Plain migrate() must refuse while import-partial has pending archive owners.
    await assert.rejects(migrate(database), /Ordinary migration refused.*import-partial/);
    assert.equal(
      (
        await database.query(
          "SELECT count(*)::int AS count FROM workspace_metadata WHERE user_id='owner-2'",
        )
      ).rows[0].count,
      0,
    );

    // Unmarked destination conflict for owner-2 must refuse without overwriting or marking imported.
    await database.query(
      "INSERT INTO workspace_metadata(user_id,revision,next_position,timezone,settings) VALUES ('owner-2',1,0,'UTC','{}')",
    );
    await assert.rejects(
      preservingDocumentCutover(database, 'op-ddl-crash'),
      /unmarked relational records/,
    );
    assert.equal((await inspectDocumentCutover(database, 'op-ddl-crash')).phase, 'import-partial');
    await database.query("DELETE FROM workspace_metadata WHERE user_id='owner-2'");

    // Removing the conflict allows clean resume: owner-1 is skipped, owner-2 is imported.
    const finalResult = await preservingDocumentCutover(database, 'op-ddl-crash');
    assert.equal(finalResult.phase, 'completed');
    assert.equal(finalResult.newlyImportedOwners, 1);
    assert.equal(finalResult.skippedImportedOwners, 1);

    const store = new WorkspaceStore(createQueries(database));
    assert.deepEqual(await store.exportSnapshot('owner-1'), { state: state1, revision: 11 });
    assert.deepEqual(await store.exportSnapshot('owner-2'), { state: state2, revision: 6 });
  });
});

test('fresh, empty-0000, and already-relational schemas complete without creating recovery schemas or replaying conversion', async () => {
  for (const previous of [false, true]) {
    await fixture(async (database, schema) => {
      const result = await preservingDocumentCutover(database, 'op-clean-schema');
      assert.equal(result.phase, 'completed');
      assert.equal(result.archivedOwners, 0);
      assert.equal(result.newlyStagedOwners, 0);
      assert.equal(result.newlyImportedOwners, 0);
      assert.equal(
        (
          await database.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [
            cutoverRecoverySchema(schema),
          ])
        ).rowCount,
        0,
      );
      const store = new WorkspaceStore(createQueries(database));
      await store.mutate('relational-user', 'rel-req-1', {
        type: 'grocery.check',
        data: { key: 'milk|l', checked: true },
      });
      const repeat = await preservingDocumentCutover(database, 'op-second-id');
      assert.equal(repeat.phase, 'completed');
      assert.equal(repeat.archivedOwners, 0);
      assert.equal((await store.bootstrap('relational-user')).revision, 1);
    }, previous);
  }
});

test('recovery catalog ownership, trigger/grant/column tampering, and Neon branch provenance mismatches refuse before mutation', async () => {
  await fixture(async (database, schema, admin) => {
    const state = createInitialState('Provenance Owner');
    await database.query(
      'INSERT INTO workspace_state(user_id,data,version,updated_at) VALUES ($1,$2,5,$3)',
      ['owner-prov', JSON.stringify(state), stamp],
    );
    const connect = database.connect.bind(database);
    let stopped = false;
    database.connect = (async () => {
      const client = await connect();
      const origQuery = client.query.bind(client);
      const pid = (await origQuery('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      let sawFence = false;
      client.query = (async (
        input: string | { text: string; values?: unknown[] },
        values?: unknown[],
      ) => {
        const sqlText = typeof input === 'string' ? input : input.text;
        if (
          typeof sqlText === 'string' &&
          sqlText.includes('workspace_state_cutover_fenced') &&
          sqlText.includes('ALTER TABLE')
        ) {
          sawFence = true;
        }
        const res =
          values !== undefined
            ? await origQuery(input as string, values)
            : await origQuery(input as string);
        if (sawFence && !stopped && sqlText === 'COMMIT') {
          stopped = true;
          await terminateBackend(admin, client, pid);
          throw new Error('Stop after Phase 1 staging');
        }
        return res;
      }) as typeof client.query;
      return client;
    }) as typeof database.connect;

    await assert.rejects(preservingDocumentCutover(database, 'op-provenance'));
    database.connect = connect;

    const recSchema = cutoverRecoverySchema(schema);
    const opTable = `${quote(recSchema)}."operation"`;
    const archiveTable = `${quote(recSchema)}."workspace_state_archive"`;

    // 1. Neon branch provenance mismatch refuses before DDL.
    await database.query(`UPDATE ${opTable} SET branch_id='br-copied-foreign-branch' WHERE id=1`);
    await assert.rejects(
      inspectDocumentCutover(database, 'op-provenance'),
      /Neon branch/,
    );
    await assert.rejects(
      preservingDocumentCutover(database, 'op-provenance'),
      /Neon branch/,
    );
    await database.query(`UPDATE ${opTable} SET branch_id=NULL WHERE id=1`);

    // 2. Trigger on recovery archive table refuses.
    await database.query(
      `CREATE FUNCTION ${quote(schema)}.noop_trg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
    );
    await database.query(
      `CREATE TRIGGER unsafe_archive_trg BEFORE UPDATE ON ${archiveTable} FOR EACH ROW EXECUTE FUNCTION ${quote(schema)}.noop_trg()`,
    );
    await assert.rejects(
      preservingDocumentCutover(database, 'op-provenance'),
      /Unsafe or foreign-owned cutover recovery catalog/,
    );
    await database.query(`DROP TRIGGER unsafe_archive_trg ON ${archiveTable}`);
    await database.query(`DROP FUNCTION ${quote(schema)}.noop_trg()`);

    // 3. Public/foreign ACL grant on recovery table refuses.
    await database.query(`GRANT SELECT ON ${archiveTable} TO PUBLIC`);
    await assert.rejects(
      preservingDocumentCutover(database, 'op-provenance'),
      /Unsafe or foreign-owned cutover recovery catalog/,
    );
    const ownerRole = (
      await database.query('SELECT pg_get_userbyid(relowner) AS role FROM pg_class WHERE oid=$1::regclass', [
        archiveTable,
      ])
    ).rows[0].role as string;
    await database.query(`UPDATE pg_class SET relacl = NULL WHERE oid = $1::regclass`, [
      archiveTable,
    ]);
    // 4. Foreign table owner on recovery table refuses.
    const foreignRole = `corner_foreign_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await database.query(`CREATE ROLE ${quote(foreignRole)}`);
    try {
      await database.query(`ALTER TABLE ${archiveTable} OWNER TO ${quote(foreignRole)}`);
      await assert.rejects(
        preservingDocumentCutover(database, 'op-provenance'),
        /Unsafe or foreign-owned cutover recovery catalog/,
      );
      await database.query(`ALTER TABLE ${archiveTable} OWNER TO ${quote(ownerRole)}`);
    } finally {
      await database.query(`DROP ROLE ${quote(foreignRole)}`);
    }
    // 5. PG15+/Neon public-shaped ownership: application schema owned by pg_database_owner
    // while native tables (__drizzle_migrations) and recovery catalog are owned by current_user.
    await admin.query(`ALTER SCHEMA ${quote(schema)} OWNER TO pg_database_owner`);
    const completed = await preservingDocumentCutover(database, 'op-provenance');
    assert.equal(completed.phase, 'completed');

    // Foreign recovery schema owner still refuses even when target schema is owned by pg_database_owner.
    const foreignSchemaRole = `corner_foreign_ns_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await admin.query(`CREATE ROLE ${quote(foreignSchemaRole)}`);
    try {
      await admin.query(`ALTER SCHEMA ${quote(recSchema)} OWNER TO ${quote(foreignSchemaRole)}`);
      await assert.rejects(
        inspectDocumentCutover(database, 'op-provenance'),
        /Unsafe or foreign-owned cutover recovery catalog/,
      );
      await admin.query(`ALTER SCHEMA ${quote(recSchema)} OWNER TO ${quote(ownerRole)}`);
    } finally {
      await admin.query(`DROP ROLE ${quote(foreignSchemaRole)}`);
    }
  });
});

test('migrationCli executes inspect-cutover and preserving-cutover with sanitized JSON output', async () => {
  await fixture(async (database, schema, admin) => {
    // Simulate PG15+/Neon public schema owned by pg_database_owner while a non-superuser
    // migrator role (like neondb_owner) owns the database/tables and executes CLI cutover.
    const baseUrl = new URL(process.env.CORNER_TEST_DATABASE_URL!);
    baseUrl.searchParams.delete('options');
    const dbName = baseUrl.pathname.slice(1);
    const role = `corner_cli_role_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await admin.query(`CREATE ROLE ${quote(role)} LOGIN PASSWORD 'synthetic-delivery-only'`);
    await admin.query(`GRANT CREATE, CONNECT ON DATABASE ${quote(dbName)} TO ${quote(role)}`);
    await admin.query(`ALTER SCHEMA ${quote(schema)} OWNER TO pg_database_owner`);
    await admin.query(`GRANT USAGE, CREATE ON SCHEMA ${quote(schema)} TO ${quote(role)}`);
    for (const row of (
      await admin.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = $1`,
        [schema],
      )
    ).rows as Array<{ tablename: string }>) {
      await admin.query(
        `ALTER TABLE ${quote(schema)}.${quote(row.tablename)} OWNER TO ${quote(role)}`,
      );
    }
    await admin.query(`ALTER ROLE ${quote(role)} SET search_path TO ${quote(schema)}`);
    const secretState = createInitialState('Private Owner Name');
    await database.query(
      'INSERT INTO workspace_state(user_id,data,version,updated_at) VALUES ($1,$2,9,$3)',
      ['private-user-id', JSON.stringify(secretState), stamp],
    );
    baseUrl.username = role;
    baseUrl.password = 'synthetic-delivery-only';
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;
    const migrateScript = fileURLToPath(new URL('../migrate.ts', import.meta.url));
    const serverRoot = fileURLToPath(new URL('../..', import.meta.url));
    try {
      await migrationCli(['--inspect-cutover'], { DATABASE_URL_UNPOOLED: baseUrl.href });
      // Seed an invalid row to trigger a CLI cutover refusal via actual subprocess execution.
      await database.query(
        'INSERT INTO workspace_state(user_id,data,version,updated_at) VALUES ($1,$2,2,$3)',
        ['private-corrupt-owner', '{"secret":"SensitiveHealthNote","plan":[{"recipeId":"missing"}]}', stamp],
      );
      const failedRun = spawnSync(
        process.execPath,
        ['--import', 'tsx', migrateScript, '--preserving-cutover', '--operation-id', 'cli-fail-op'],
        {
          cwd: serverRoot,
          env: { ...process.env, DATABASE_URL_UNPOOLED: baseUrl.href },
          encoding: 'utf8',
        },
      );
      assert.notEqual(failedRun.status, 0);
      assert.equal(failedRun.stdout, '');
      assert.equal(failedRun.stderr.trim(), 'PRESERVING_DOCUMENT_CUTOVER_REFUSED');
      for (const secret of [
        'private-user-id',
        'Private Owner Name',
        'private-corrupt-owner',
        'SensitiveHealthNote',
        'synthetic-delivery-only',
      ]) {
        assert.ok(!failedRun.stdout.includes(secret));
        assert.ok(!failedRun.stderr.includes(secret));
      }
      await database.query("DELETE FROM workspace_state WHERE user_id='private-corrupt-owner'");
      await migrationCli(['--preserving-cutover', '--operation-id', 'cli-op-1'], {
        DATABASE_URL_UNPOOLED: baseUrl.href,
      });
    } finally {
      process.stdout.write = origWrite;
      await database.query(`DROP OWNED BY ${quote(role)} CASCADE`);
      await database.query(`DROP ROLE ${quote(role)}`);
    }
    assert.equal(chunks.length, 2);
    const inspected = JSON.parse(chunks[0]!.trim());
    const converted = JSON.parse(chunks[1]!.trim());
    assert.equal(inspected.phase, 'untouched');
    assert.equal(converted.phase, 'completed');
    assert.equal(converted.operationId, 'cli-op-1');
    assert.equal(converted.newlyImportedOwners, 1);
    for (const output of chunks) {
      assert.ok(!output.includes('private-user-id'));
      assert.ok(!output.includes('Private Owner Name'));
      assert.ok(!output.includes('synthetic-delivery-only'));
    }
  });
});
