import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { loadConfig, REPOSITORY_ROOT } from '../src/config.ts';

const neonEnvironment = { DATABASE_URL: 'postgresql://test.invalid/corner', NEON_AUTH_BASE_URL: 'https://managed-auth.example.test/neondb/auth' };
const directories: string[] = [];
const temporary = () => { const path = mkdtempSync(join(tmpdir(), 'corner-config-test-')); directories.push(path); return path; };
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

test('local startup preserves private random keys and restricts directory/file permissions', () => {
  const dataDir = temporary();
  const first = loadConfig({ ...neonEnvironment, CORNER_DATA_DIR: dataDir });
  const second = loadConfig({ ...neonEnvironment, CORNER_DATA_DIR: dataDir });
  assert.equal(first.origin, 'http://127.0.0.1:3000');
  assert.equal(first.host, '127.0.0.1');
  assert.equal(first.port, 3000);
  assert.equal(first.authSecret, second.authSecret);
  assert.equal(first.tokenEncryptionKey.length, 32);
  assert.deepEqual(first.tokenEncryptionKey, second.tokenEncryptionKey);
  assert.equal(statSync(dataDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dataDir, 'private-config.json')).mode & 0o777, 0o600);
});

test('development keeps the browser origin separate from its loopback API listener', () => {
  const dataDir = temporary();
  const config = loadConfig({ ...neonEnvironment, CORNER_DATA_DIR: dataDir, CORNER_PORT: '9000', PORT: '9001', CORNER_HOST: '0.0.0.0' }, { development: true });
  assert.equal(config.origin, 'http://127.0.0.1:3000');
  assert.equal(config.port, 3001);
  assert.equal(config.host, '127.0.0.1');
  const customized = loadConfig({ ...neonEnvironment, CORNER_DATA_DIR: dataDir, CORNER_ORIGIN: 'http://127.0.0.1:4000', CORNER_DEV_API_PORT: '4001', CORNER_PORT: 'not-used-in-development' }, { development: true });
  assert.equal(customized.origin, 'http://127.0.0.1:4000');
  assert.equal(customized.port, 4001);
  for (const port of ['0', '65536', 'invalid', '3001.5']) assert.throws(() => loadConfig({ ...neonEnvironment, CORNER_DATA_DIR: dataDir, CORNER_DEV_API_PORT: port }, { development: true }), /CORNER_DEV_API_PORT/);
  assert.throws(() => loadConfig({ ...neonEnvironment, CORNER_DATA_DIR: dataDir, CORNER_DEV_API_PORT: '3000' }, { development: true }), /must differ/);
});

test('relative data paths resolve from the repository root even when a workspace changes cwd', () => {
  const dataDir = temporary();
  const otherWorkingDirectory = temporary();
  const previousWorkingDirectory = process.cwd();
  try {
    process.chdir(otherWorkingDirectory);
    const config = loadConfig({ ...neonEnvironment, CORNER_DATA_DIR: relative(REPOSITORY_ROOT, dataDir) });
    assert.equal(config.dataDir, dataDir);
    assert.equal(existsSync(join(otherWorkingDirectory, 'private-config.json')), false);
    assert.equal(existsSync(join(dataDir, 'private-config.json')), true);
  } finally { process.chdir(previousWorkingDirectory); }
});

test('supplied secrets stay out of the local config and hosted settings fail closed', () => {
  const dataDir = temporary();
  const env = { ...neonEnvironment, CORNER_DATA_DIR: dataDir, CORNER_DEPLOYMENT: 'hosted', CORNER_ORIGIN: 'https://corner.example', BETTER_AUTH_SECRET: 'unit-test-secret-of-more-than-thirty-two-characters', CORNER_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
  assert.throws(() => loadConfig({ ...neonEnvironment, ...env, BETTER_AUTH_SECRET: undefined }), /Hosted deployments require/);
  assert.throws(() => loadConfig({ ...neonEnvironment, ...env, CORNER_ORIGIN: 'http://corner.example' }), /HTTPS/);
  assert.throws(() => loadConfig({ ...neonEnvironment, ...env, CORNER_TOKEN_ENCRYPTION_KEY: 'not-a-key' }), /32-byte/);
  assert.equal(loadConfig(env).deployment, 'hosted');
  assert.equal(existsSync(join(dataDir, 'private-config.json')), false);
  assert.throws(() => loadConfig({ ...neonEnvironment, CORNER_DATA_DIR: dataDir, CORNER_ORIGIN: 'http://public.example' }), /loopback/);
});


test('proxy trust requires an explicitly supplied independent secret', () => {
  const dataDir = temporary();
  assert.equal(loadConfig({ ...neonEnvironment, CORNER_DATA_DIR: dataDir }).proxySecret, undefined);
  for (const value of ['', 'short', ' '.repeat(40), 'x'.repeat(32) + '\n']) assert.throws(() => loadConfig({ ...neonEnvironment, CORNER_DATA_DIR: dataDir, CORNER_PROXY_SECRET: value }), /CORNER_PROXY_SECRET/);
  const proxySecret = 'unit-test-proxy-secret-more-than-32-characters';
  assert.equal(loadConfig({ ...neonEnvironment, CORNER_DATA_DIR: dataDir, CORNER_PROXY_SECRET: proxySecret }).proxySecret, proxySecret);
  assert(!readFileSync(join(dataDir, 'private-config.json'), 'utf8').includes(proxySecret));
});

test('damaged saved secrets are never silently replaced', () => {
  const dataDir = temporary();
  const file = join(dataDir, 'private-config.json');
  writeFileSync(file, '{broken');
  assert.throws(() => loadConfig({ ...neonEnvironment, CORNER_DATA_DIR: dataDir }), /Restore/);
  assert.equal(readFileSync(file, 'utf8'), '{broken');
});
