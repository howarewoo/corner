import assert from 'node:assert/strict';
import test from 'node:test';
import { cutoverRecoverySchema, directDatabaseUrl, migrationCli } from '../migrate.js';

test('schema URLs allow TLS parameters but reject connection overrides', () => {
  const url =
    'postgresql://owner:secret@approved.example/production?sslmode=require&channel_binding=require';
  assert.equal(directDatabaseUrl(url), url);
  for (const query of [
    'host=different.invalid',
    'hostaddr=127.0.0.1',
    'port=5433',
    'user=other',
    'database=other',
    'dbname=other',
    'options=-c%20search_path%3Dother',
    '%68ost=different.invalid',
  ]) {
    assert.throws(
      () => directDatabaseUrl(`postgresql://owner:secret@approved.example/production?${query}`),
      /without connection overrides/,
    );
  }
});

test('migration CLI rejects a query host override before connecting', async () => {
  const before = { ...process.env };
  const argv = process.argv;
  try {
    process.argv = [process.execPath, 'migrate.js', '--apply'];
    Object.assign(process.env, {
      DATABASE_URL_UNPOOLED:
        'postgresql://owner:secret@approved.example/production?host=different.invalid',
    });
    await assert.rejects(migrationCli(), /without connection overrides/);
  } finally {
    process.argv = argv;
    process.env = before;
  }
});

test('cutover recovery schema derivation stays within PostgreSQL 63-byte identifier bounds without collision', () => {
  assert.equal(cutoverRecoverySchema('public'), 'corner_cutover_recovery');
  const longA = `corner_cutover_${'a'.repeat(80)}`;
  const longB = `corner_cutover_${'a'.repeat(79)}b`;
  const derivedA = cutoverRecoverySchema(longA);
  const derivedB = cutoverRecoverySchema(longB);
  assert.ok(Buffer.byteLength(derivedA, 'utf8') <= 63);
  assert.ok(Buffer.byteLength(derivedB, 'utf8') <= 63);
  assert.notEqual(derivedA, derivedB);
  assert.throws(() => cutoverRecoverySchema(''), /Application schema is required/);
});

test('migration CLI validates preserving-cutover and inspect-cutover arguments before connecting', async () => {
  const unsafeEnv = {
    DATABASE_URL_UNPOOLED:
      'postgresql://owner:secret@approved.example/production?host=different.invalid',
  };
  for (const args of [
    [],
    ['--unknown'],
    ['--apply', '--extra'],
    ['--preserving-cutover'],
    ['--preserving-cutover', '--operation-id'],
    ['--preserving-cutover', '--operation-id', 'invalid space'],
    ['--preserving-cutover', '--operation-id='],
    ['--inspect-cutover', '--operation-id', 'bad/id'],
    ['--inspect-cutover', '--extra'],
  ]) {
    await assert.rejects(migrationCli(args, unsafeEnv));
  }
  for (const [args, env] of [
    [['--preserving-cutover', '--operation-id', 'op-2026-10-27'], unsafeEnv],
    [['--preserving-cutover', '--operation-id=op-2026-10-27'], unsafeEnv],
    [['--preserving-cutover'], { ...unsafeEnv, CORNER_CUTOVER_OPERATION_ID: 'op-2026-10-27' }],
    [['--inspect-cutover'], unsafeEnv],
    [['--inspect-cutover', '--operation-id', 'op-2026-10-27'], unsafeEnv],
  ] as const) {
    await assert.rejects(migrationCli([...args], env), /without connection overrides/);
  }
});
