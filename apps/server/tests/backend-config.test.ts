import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { loadConfig, REPOSITORY_ROOT } from '../src/config.ts';

const directories: string[] = [];
const temporary = () => { const path = mkdtempSync(join(tmpdir(), 'corner-config-test-')); directories.push(path); return path; };
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

test('local startup preserves private random keys and restricts directory/file permissions', () => {
  const dataDir = temporary();
  const first = loadConfig({ CORNER_DATA_DIR: dataDir });
  const second = loadConfig({ CORNER_DATA_DIR: dataDir });
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
  const config = loadConfig({ CORNER_DATA_DIR: dataDir, CORNER_PORT: '9000', PORT: '9001', CORNER_HOST: '0.0.0.0' }, { development: true });
  assert.equal(config.origin, 'http://127.0.0.1:3000');
  assert.equal(config.port, 3001);
  assert.equal(config.host, '127.0.0.1');
  const customized = loadConfig({ CORNER_DATA_DIR: dataDir, CORNER_ORIGIN: 'http://127.0.0.1:4000', CORNER_DEV_API_PORT: '4001', CORNER_PORT: 'not-used-in-development' }, { development: true });
  assert.equal(customized.origin, 'http://127.0.0.1:4000');
  assert.equal(customized.port, 4001);
  for (const port of ['0', '65536', 'invalid', '3001.5']) assert.throws(() => loadConfig({ CORNER_DATA_DIR: dataDir, CORNER_DEV_API_PORT: port }, { development: true }), /CORNER_DEV_API_PORT/);
  assert.throws(() => loadConfig({ CORNER_DATA_DIR: dataDir, CORNER_DEV_API_PORT: '3000' }, { development: true }), /must differ/);
});

test('relative data paths resolve from the repository root even when a workspace changes cwd', () => {
  const dataDir = temporary();
  const otherWorkingDirectory = temporary();
  const previousWorkingDirectory = process.cwd();
  try {
    process.chdir(otherWorkingDirectory);
    const config = loadConfig({ CORNER_DATA_DIR: relative(REPOSITORY_ROOT, dataDir) });
    assert.equal(config.dataDir, dataDir);
    assert.equal(existsSync(join(otherWorkingDirectory, 'private-config.json')), false);
    assert.equal(existsSync(join(dataDir, 'private-config.json')), true);
  } finally { process.chdir(previousWorkingDirectory); }
});

test('supplied secrets stay out of the local config and hosted settings fail closed', () => {
  const dataDir = temporary();
  const env = { CORNER_DATA_DIR: dataDir, CORNER_DEPLOYMENT: 'hosted', CORNER_ORIGIN: 'https://corner.example', BETTER_AUTH_SECRET: 'unit-test-secret-of-more-than-thirty-two-characters', CORNER_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), RESEND_API_KEY: 're_test_only_not_a_real_key', CORNER_EMAIL_FROM: 'Corner <accounts@example.test>' };
  assert.throws(() => loadConfig({ ...env, BETTER_AUTH_SECRET: undefined }), /Hosted deployments require/);
  assert.throws(() => loadConfig({ ...env, CORNER_ORIGIN: 'http://corner.example' }), /HTTPS/);
  assert.throws(() => loadConfig({ ...env, CORNER_TOKEN_ENCRYPTION_KEY: 'not-a-key' }), /32-byte/);
  assert.throws(() => loadConfig({ ...env, RESEND_API_KEY: undefined, CORNER_EMAIL_FROM: undefined }), /Hosted deployments require.*RESEND_API_KEY/);
  assert.equal(loadConfig(env).deployment, 'hosted');
  assert.equal(existsSync(join(dataDir, 'private-config.json')), false);
  assert.throws(() => loadConfig({ CORNER_DATA_DIR: dataDir, CORNER_ORIGIN: 'http://public.example' }), /loopback/);
});

test('email configuration must be paired and valid without persisting its API key', () => {
  const dataDir = temporary();
  const env = { CORNER_DATA_DIR: dataDir, RESEND_API_KEY: 're_test_only_not_a_real_key', CORNER_EMAIL_FROM: 'Corner <accounts@example.test>' };
  assert.throws(() => loadConfig({ ...env, CORNER_EMAIL_FROM: undefined }), /both/);
  assert.throws(() => loadConfig({ ...env, RESEND_API_KEY: undefined }), /both/);
  assert.throws(() => loadConfig({ ...env, RESEND_API_KEY: 'invalid-test-key' }), /valid Resend/);
  assert.throws(() => loadConfig({ ...env, CORNER_EMAIL_FROM: 'a@example.test, b@example.test' }), /one valid sender/);
  assert.throws(() => loadConfig({ ...env, CORNER_EMAIL_FROM: 'Corner <accounts@example.test>\r\nBcc: other@example.test' }), /one valid sender/);
  assert.throws(() => loadConfig({ ...env, CORNER_EMAIL_FROM: 'Corner <not-an-address>' }), /one valid sender/);
  assert.equal(existsSync(join(dataDir, 'private-config.json')), false);
  assert.deepEqual(loadConfig(env).mail, { apiKey: env.RESEND_API_KEY, from: env.CORNER_EMAIL_FROM });
  assert(!readFileSync(join(dataDir, 'private-config.json'), 'utf8').includes(env.RESEND_API_KEY));
  assert.equal(loadConfig({ CORNER_DATA_DIR: dataDir }).mail, undefined);
});

test('proxy trust requires an explicitly supplied independent secret', () => {
  const dataDir = temporary();
  assert.equal(loadConfig({ CORNER_DATA_DIR: dataDir }).proxySecret, undefined);
  for (const value of ['', 'short', ' '.repeat(40), 'x'.repeat(32) + '\n']) assert.throws(() => loadConfig({ CORNER_DATA_DIR: dataDir, CORNER_PROXY_SECRET: value }), /CORNER_PROXY_SECRET/);
  const proxySecret = 'unit-test-proxy-secret-more-than-32-characters';
  assert.equal(loadConfig({ CORNER_DATA_DIR: dataDir, CORNER_PROXY_SECRET: proxySecret }).proxySecret, proxySecret);
  assert(!readFileSync(join(dataDir, 'private-config.json'), 'utf8').includes(proxySecret));
});

test('damaged saved secrets are never silently replaced', () => {
  const dataDir = temporary();
  const file = join(dataDir, 'private-config.json');
  writeFileSync(file, '{broken');
  assert.throws(() => loadConfig({ CORNER_DATA_DIR: dataDir }), /Restore/);
  assert.equal(readFileSync(file, 'utf8'), '{broken');
});
