import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { Pool } from 'pg';
import { createDatabase } from '../database.js';
import { migrate } from '../migrate.js';
import { baselineStaging, stagingBaselineCli } from '../staging-baseline.js';

async function fixture() {
  assert.ok(
    process.env.CORNER_TEST_DATABASE_URL,
    'CORNER_TEST_DATABASE_URL must name disposable PostgreSQL; never use DATABASE_URL',
  );
  const url = new URL(process.env.CORNER_TEST_DATABASE_URL);
  const admin = createDatabase(url.href);
  const schemas = [0, 1].map(() => `corner_test_${randomUUID().replaceAll('-', '')}`);
  const pools: Pool[] = [];
  try {
    for (const schema of schemas) {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const scoped = new URL(url);
      scoped.searchParams.set('options', `-c search_path=${schema}`);
      pools.push(createDatabase(scoped.href));
    }
    const source = pools[0]!;
    const target = pools[1]!;
    await migrate(source);
    const sql = await readFile(new URL('../../migrations/001_corner.sql', import.meta.url), 'utf8');
    await target.query(sql);
    await target.query(
      'CREATE TABLE corner_schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL)',
    );
    // Source data must neither be copied nor inspected by the operation.
    await source.query(
      "INSERT INTO workspace_state VALUES ('private-owner','private-workspace',9,'private-time')",
    );
    const before = (await source.query('SELECT * FROM workspace_state')).rows;
    const history = (await source.query('SELECT * FROM corner_schema_migrations ORDER BY name'))
      .rows;
    return {
      source,
      target,
      admin,
      schemas,
      options: {
        source,
        target,
        reference: admin,
        sourceSchema: schemas[0]!,
        targetSchema: schemas[1]!,
      },
      async close() {
        await Promise.all(pools.map((pool) => pool.end()));
        try {
          for (const schema of schemas) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          await admin.end();
        }
      },
      async unchanged() {
        assert.deepEqual((await source.query('SELECT * FROM workspace_state')).rows, before);
        assert.deepEqual(
          (await source.query('SELECT * FROM corner_schema_migrations ORDER BY name')).rows,
          history,
        );
      },
    };
  } catch (error) {
    await Promise.all(pools.map((pool) => pool.end()));
    try {
      for (const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
    throw error;
  }
}

test('bootstrap smoke: schema-only staging baselines once, ordinary migrate succeeds, and source is unchanged', async () => {
  const f = await fixture();
  try {
    const referenceBefore = (
      await f.admin.query(
        "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'corner_baseline_%' ORDER BY nspname",
      )
    ).rows;
    await baselineStaging(f.options);
    assert.deepEqual(
      (await f.target.query('SELECT * FROM corner_schema_migrations')).rows,
      (await f.source.query('SELECT * FROM corner_schema_migrations')).rows,
    );
    await migrate(f.target);
    assert.equal(
      (await f.target.query('SELECT count(*)::int AS count FROM workspace_state')).rows[0].count,
      0,
    );
    await assert.rejects(baselineStaging(f.options), { message: 'STAGING_BASELINE_REFUSED' });
    assert.deepEqual(
      (
        await f.admin.query(
          "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'corner_baseline_%' ORDER BY nspname",
        )
      ).rows,
      referenceBefore,
    );
    await f.unchanged();
  } finally {
    await f.close();
  }
});

test('schema drift and unsupported objects refuse atomically without ledger writes', async () => {
  for (const sql of [
    'ALTER TABLE workspace_state ALTER COLUMN version SET DEFAULT 7',
    'DROP INDEX mutation_receipts_user_revision',
    'CREATE VIEW unexpected_view AS SELECT 1 AS value',
    'ALTER TABLE workspace_state ENABLE ROW LEVEL SECURITY',
    "CREATE TYPE unexpected_enum AS ENUM ('value')",
    'ALTER TABLE corner_schema_migrations ADD COLUMN unexpected TEXT',
    `CREATE TABLE "user" (id TEXT PRIMARY KEY); INSERT INTO "user" VALUES ('copied-private-user')`,
    `CREATE TABLE session (id TEXT PRIMARY KEY); INSERT INTO session VALUES ('copied-private-session')`,
  ]) {
    const f = await fixture();
    try {
      await f.target.query(sql);
      await assert.rejects(baselineStaging(f.options), { message: 'STAGING_BASELINE_REFUSED' });
      assert.equal(
        (await f.target.query('SELECT count(*)::int AS count FROM corner_schema_migrations'))
          .rows[0].count,
        0,
      );
      await f.unchanged();
    } finally {
      await f.close();
    }
  }
});

test('nonempty application tables, missing history, and edited source checksums refuse', async () => {
  for (const change of ['rows', 'checksum', 'missing', 'unknown', 'source-drift']) {
    const f = await fixture();
    try {
      if (change === 'rows')
        await f.target.query(
          "INSERT INTO corner_subscription_meta VALUES ('private-key','private-value')",
        );
      if (change === 'checksum')
        await f.source.query("UPDATE corner_schema_migrations SET checksum='edited'");
      if (change === 'missing') await f.source.query('DELETE FROM corner_schema_migrations');
      if (change === 'unknown')
        await f.source.query("UPDATE corner_schema_migrations SET name='000_unknown.sql'");
      if (change === 'source-drift')
        await f.source.query('ALTER TABLE workspace_state ALTER COLUMN version SET DEFAULT 7');
      const before = (await f.source.query('SELECT * FROM corner_schema_migrations')).rows;
      await assert.rejects(baselineStaging(f.options), { message: 'STAGING_BASELINE_REFUSED' });
      assert.equal(
        (await f.target.query('SELECT count(*)::int AS count FROM corner_schema_migrations'))
          .rows[0].count,
        0,
      );
      assert.deepEqual(
        (await f.source.query('SELECT * FROM corner_schema_migrations')).rows,
        before,
      );
      if (change === 'rows' || change === 'source-drift') await f.unchanged();
    } finally {
      await f.close();
    }
  }
});

test('a missing copied ledger can be created, but identical source and target identity cannot be baselined', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      baselineStaging({ ...f.options, target: f.source, targetSchema: f.schemas[0] }),
      { message: 'STAGING_BASELINE_REFUSED' },
    );
    await f.target.query('DROP TABLE corner_schema_migrations');
    await baselineStaging(f.options);
    await migrate(f.target);
    await f.unchanged();
  } finally {
    await f.close();
  }
});

test('CLI fails privately before connecting for wrong host, same endpoint, pooler aliases, and unsafe options', async () => {
  const environment = {
    STAGING_BASELINE_SOURCE_URL: 'postgresql://private:secret@ep-source.invalid/db',
    DATABASE_URL_UNPOOLED: 'postgresql://private:secret@ep-staging.invalid/db',
    STAGING_DATABASE_HOST: 'ep-staging.invalid',
    CORNER_TEST_DATABASE_URL: 'postgresql://private:secret@reference.invalid/db',
  };
  for (const overrides of [
    { STAGING_DATABASE_HOST: 'wrong.invalid' },
    { STAGING_BASELINE_SOURCE_URL: environment.DATABASE_URL_UNPOOLED },
    { STAGING_BASELINE_SOURCE_URL: 'postgresql://private:secret@ep-staging-pooler.invalid/db' },
    { DATABASE_URL_UNPOOLED: `${environment.DATABASE_URL_UNPOOLED}?options=-csearch_path=other` },
    { STAGING_BASELINE_SOURCE_URL: 'private-secret-invalid-url' },
  ])
    await assert.rejects(stagingBaselineCli({ ...environment, ...overrides }), {
      message: 'STAGING_BASELINE_REFUSED',
    });
});
