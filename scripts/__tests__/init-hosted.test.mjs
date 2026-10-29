import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const initializer = fileURLToPath(new URL('../init-hosted.mjs', import.meta.url));

test('hosted initialization creates only the proxy proof and preserves existing configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corner-hosted-'));
  try {
    const initialize = () =>
      spawnSync(process.execPath, [initializer, '--domain', 'corner.example.com'], {
        cwd: directory,
        encoding: 'utf8',
      });
    const result = initialize();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /one random proxy proof/);
    const path = join(directory, '.env.hosted');
    const contents = await readFile(path, 'utf8');
    assert.match(contents, /^CORNER_PROXY_SECRET=[A-Za-z0-9_-]{64}$/m);
    assert.doesNotMatch(contents, /BETTER_AUTH_SECRET|CORNER_TOKEN_ENCRYPTION_KEY/);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const retry = initialize();
    assert.equal(retry.status, 1);
    assert.match(retry.stderr, /already exists/);
    assert.equal(await readFile(path, 'utf8'), contents);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
