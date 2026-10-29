import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { loadConfig, REPOSITORY_ROOT } from '../src/config.ts';

const neonEnvironment = {
  DATABASE_URL: 'postgresql://test.invalid/corner',
  NEON_AUTH_BASE_URL: 'https://managed-auth.example.test/neondb/auth',
};
const developmentEnvironment = {
  DATABASE_URL: 'postgresql://local:synthetic@127.0.0.1:5432/corner',
  NEON_AUTH_BASE_URL: 'https://127.0.0.1:45901/neondb/auth',
};
const directories: string[] = [];
const temporary = () => {
  const path = mkdtempSync(join(tmpdir(), 'corner-config-test-'));
  directories.push(path);
  return path;
};
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

test('local startup creates no AI keys and preserves existing private configuration bytes and permissions', () => {
  const dataDir = temporary();
  const file = join(dataDir, 'private-config.json');
  const first = loadConfig({ ...neonEnvironment, CORNER_DATA_DIR: dataDir });
  assert.equal(first.origin, 'http://127.0.0.1:3000');
  assert.equal(first.host, '127.0.0.1');
  assert.equal(first.port, 3000);
  assert.equal(existsSync(file), false);
  const retained = JSON.stringify({
    authSecret: 'retained-session-binding-key',
    tokenEncryptionKey: 'retained-encryption-key',
    extra: 'preserved',
  });
  writeFileSync(file, retained, { mode: 0o640 });
  const mode = statSync(file).mode;
  loadConfig({ ...neonEnvironment, CORNER_DATA_DIR: dataDir });
  assert.equal(readFileSync(file, 'utf8'), retained);
  assert.equal(statSync(file).mode, mode);
});

test('development keeps the browser origin separate from its loopback API listener', () => {
  const dataDir = temporary();
  const config = loadConfig(
    {
      ...developmentEnvironment,
      CORNER_DATA_DIR: dataDir,
      CORNER_PORT: '9000',
      PORT: '9001',
      CORNER_HOST: '0.0.0.0',
    },
    { development: true },
  );
  assert.equal(config.origin, 'http://127.0.0.1:3000');
  assert.equal(config.port, 3001);
  assert.equal(config.host, '127.0.0.1');
  const customized = loadConfig(
    {
      ...developmentEnvironment,
      CORNER_DATA_DIR: dataDir,
      CORNER_ORIGIN: 'http://127.0.0.1:4000',
      CORNER_DEV_API_PORT: '4001',
      CORNER_PORT: 'not-used-in-development',
    },
    { development: true },
  );
  assert.equal(customized.origin, 'http://127.0.0.1:4000');
  assert.equal(customized.port, 4001);
  for (const port of ['0', '65536', 'invalid', '3001.5'])
    assert.throws(
      () =>
        loadConfig(
          { ...developmentEnvironment, CORNER_DATA_DIR: dataDir, CORNER_DEV_API_PORT: port },
          { development: true },
        ),
      /CORNER_DEV_API_PORT/,
    );
  assert.throws(
    () =>
      loadConfig(
        { ...developmentEnvironment, CORNER_DATA_DIR: dataDir, CORNER_DEV_API_PORT: '3000' },
        { development: true },
      ),
    /must differ/,
  );
});

test('development refuses cloud database/Auth endpoints and routing overrides before creating private keys', () => {
  const dataDir = temporary();
  for (const override of [
    { DATABASE_URL: neonEnvironment.DATABASE_URL },
    { NEON_AUTH_BASE_URL: neonEnvironment.NEON_AUTH_BASE_URL },
    { DATABASE_URL: `${developmentEnvironment.DATABASE_URL}?host=cloud.example.test` },
    { DATABASE_URL: `${developmentEnvironment.DATABASE_URL}?hostaddr=198.51.100.1` },
    { CORNER_DEPLOYMENT: 'hosted' },
    { DATABASE_URL: undefined },
    { NEON_AUTH_BASE_URL: undefined },
  ]) {
    assert.throws(
      () =>
        loadConfig(
          { ...developmentEnvironment, CORNER_DATA_DIR: dataDir, ...override },
          { development: true },
        ),
      /Development requires loopback PostgreSQL and Auth/,
    );
  }
  assert.equal(existsSync(join(dataDir, 'private-config.json')), false);
});

test('relative data paths resolve from the repository root even when a workspace changes cwd', () => {
  const dataDir = temporary();
  const otherWorkingDirectory = temporary();
  const previousWorkingDirectory = process.cwd();
  try {
    process.chdir(otherWorkingDirectory);
    const config = loadConfig({
      ...neonEnvironment,
      CORNER_DATA_DIR: relative(REPOSITORY_ROOT, dataDir),
    });
    assert.equal(config.dataDir, dataDir);
    assert.equal(existsSync(join(otherWorkingDirectory, 'private-config.json')), false);
    assert.equal(existsSync(join(dataDir, 'private-config.json')), false);
  } finally {
    process.chdir(previousWorkingDirectory);
  }
});

test('hosted startup needs no retired AI secrets and still rejects insecure origins', () => {
  const dataDir = join(temporary(), 'no-filesystem-required');
  const env = {
    ...neonEnvironment,
    CORNER_DATA_DIR: dataDir,
    CORNER_DEPLOYMENT: 'hosted',
    CORNER_ORIGIN: 'https://corner.example',
  };
  assert.throws(
    () => loadConfig({ ...neonEnvironment, ...env, CORNER_ORIGIN: 'http://corner.example' }),
    /HTTPS/,
  );
  assert.equal(loadConfig(env).deployment, 'hosted');
  assert.equal(existsSync(dataDir), false);
  assert.throws(
    () =>
      loadConfig({
        ...neonEnvironment,
        CORNER_DATA_DIR: dataDir,
        CORNER_ORIGIN: 'http://public.example',
      }),
    /loopback/,
  );
});

test('proxy trust requires an explicitly supplied independent secret', () => {
  const dataDir = temporary();
  assert.equal(loadConfig({ ...neonEnvironment, CORNER_DATA_DIR: dataDir }).proxySecret, undefined);
  for (const value of ['', 'short', ' '.repeat(40), 'x'.repeat(32) + '\n'])
    assert.throws(
      () =>
        loadConfig({ ...neonEnvironment, CORNER_DATA_DIR: dataDir, CORNER_PROXY_SECRET: value }),
      /CORNER_PROXY_SECRET/,
    );
  const proxySecret = 'unit-test-proxy-secret-more-than-32-characters';
  assert.equal(
    loadConfig({ ...neonEnvironment, CORNER_DATA_DIR: dataDir, CORNER_PROXY_SECRET: proxySecret })
      .proxySecret,
    proxySecret,
  );
  assert.equal(existsSync(join(dataDir, 'private-config.json')), false);
});

test('unused damaged saved secrets are neither read nor replaced', () => {
  const dataDir = temporary();
  const file = join(dataDir, 'private-config.json');
  writeFileSync(file, '{broken');
  loadConfig({ ...neonEnvironment, CORNER_DATA_DIR: dataDir });
  assert.equal(readFileSync(file, 'utf8'), '{broken');
});
