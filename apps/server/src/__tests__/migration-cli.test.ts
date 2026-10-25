import assert from 'node:assert/strict';
import test from 'node:test';
import { directDatabaseUrl, migrationCli } from '../migrate.js';

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
