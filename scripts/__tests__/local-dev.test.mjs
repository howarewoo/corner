import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import { createServer, get } from 'node:https';
import { createServer as createHTTPServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isolatedEnvironment, localArguments, localCertificate, ownedPostgres, validateLocalConfig } from '../local-dev.mjs';
import { loadRuntimeConfig } from '../../apps/server/src/runtime-config.ts';

const config = {
  format: 1, workspace: 'test-workspace', instance: 'a'.repeat(32),
  password: 'b'.repeat(43), authSecret: 'c'.repeat(64), controlSecret: 'd'.repeat(64),
};
const container = () => ({
  Config: { Labels: {
    'com.docker.compose.project': 'test-project', 'com.docker.compose.service': 'postgres',
    'corner.local.instance': config.instance,
  } },
  Mounts: [{ Type: 'volume', Name: 'test-project_postgres-data', Destination: '/var/lib/postgresql/data' }],
  NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '45499' }] } },
});

test('local children cannot inherit cloud, database, Compose, TLS bypass, or browser environment settings', () => {
  const environment = isolatedEnvironment({
    PATH: '/usr/bin', HOME: '/home/test', DATABASE_URL: 'postgresql://production.invalid/private',
    DATABASE_URL_UNPOOLED: 'postgresql://staging.invalid/private', NEON_AUTH_BASE_URL: 'https://production.invalid/auth',
    COMPOSE_FILE: 'compose.hosted.yaml', COMPOSE_PROJECT_NAME: 'production', DOCKER_HOST: 'tcp://remote.invalid',
    PGHOST: 'production.invalid', PGOPTIONS: '-c search_path=production', NODE_OPTIONS: '--env-file=.env',
    NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_EXTRA_CA_CERTS: '/private/other.crt',
    VITE_PRIVATE_KEY: 'private', CORNER_DATA_DIR: '/private/other-data', CORNER_DEPLOYMENT: 'hosted',
  });
  assert.deepEqual(Object.keys(environment).sort(), ['HOME', 'PATH']);
  assert.equal(environment.HOME, '/home/test');
});

test('only an owned container, owned volume, and loopback binding can become a seed database', () => {
  assert.equal(ownedPostgres(container(), config, 'test-project'), 45499);
  for (const alter of [
    (value) => { value.Config.Labels['com.docker.compose.project'] = 'staging'; },
    (value) => { value.Config.Labels['corner.local.instance'] = 'production'; },
    (value) => { value.Mounts[0].Name = 'production-data'; },
    (value) => { value.NetworkSettings.Ports['5432/tcp'][0].HostIp = '0.0.0.0'; },
    (value) => { value.NetworkSettings.Ports['5432/tcp'].push({ HostIp: '127.0.0.1', HostPort: '45500' }); },
    (value) => { value.NetworkSettings.Ports['5432/tcp'][0].HostPort = '65536'; },
  ]) {
    const value = container();
    alter(value);
    assert.throws(() => ownedPostgres(value, config, 'test-project'));
  }
  const stopped = container();
  stopped.NetworkSettings.Ports = {};
  assert.equal(ownedPostgres(stopped, config, 'test-project', false), undefined);
});

test('local configuration cannot be adopted by another workspace or installation identity', () => {
  assert.equal(validateLocalConfig(config, 'test-workspace'), config);
  assert.throws(() => validateLocalConfig(config, 'other-workspace'));
  assert.throws(() => validateLocalConfig({ ...config, instance: 'production' }, 'test-workspace'));
  assert.throws(() => validateLocalConfig({ ...config, authSecret: '' }, 'test-workspace'));
});

test('CLI permits loopback port selection but requires explicit destructive confirmation and rejects target URLs', () => {
  assert.deepEqual(localArguments(['up', '--port=45100']), { action: 'up', port: 45100 });
  assert.deepEqual(localArguments(['reset', '--confirm-delete-local-data']), { action: 'reset', port: 3000 });
  for (const args of [
    ['reset'], ['reset', '--yes'], ['up', '--port=65534'], ['up', '--port=443'],
    ['seed', '--database-url=postgresql://production.invalid/private'], ['up', '--origin=https://staging.invalid'],
    ['down', '--project=production'], ['seed', '--port=45100'],
  ]) assert.throws(() => localArguments(args));
});

test('browser port 3001 uses API port 3002 in local services and development children', async () => {
  const { port } = localArguments(['up', '--port=3001']);
  const controller = await readFile(new URL('../local-dev.mjs', import.meta.url), 'utf8');
  const runtime = await readFile(new URL('../../apps/server/scripts/local-runtime.mjs', import.meta.url), 'utf8');
  assert.match(controller, /startLocalServices\(\{[^\n]*apiPort: port \+ 1/);
  assert.match(controller, /CORNER_DEV_API_PORT: String\(port \+ 1\)/);
  assert.match(runtime, /startLocalServices\(\{[^\n]*apiPort/);
  assert.match(runtime, /CORNER_DEV_API_PORT: String\(apiPort\)/);
  const configuration = loadRuntimeConfig({
    DATABASE_URL: 'postgresql://127.0.0.1/corner_test',
    NEON_AUTH_BASE_URL: 'https://127.0.0.1:45901/neondb/auth',
    CORNER_ORIGIN: `http://127.0.0.1:${port}`,
    CORNER_DEV_API_PORT: String(port + 1),
    CORNER_DEPLOYMENT: 'local',
    BETTER_AUTH_SECRET: config.authSecret,
    CORNER_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  }, { development: true, dataDir: '/unused' });
  assert.equal(configuration.origin, 'http://127.0.0.1:3001');
  assert.equal(configuration.port, 3002);
});

test('local Auth certificates survive restart and renew before expiry without disabling TLS validation', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'corner-local-certificate-'));
  let server;
  try {
    const paths = await localCertificate(directory);
    const originalKey = await readFile(paths.key);
    const originalCertificate = new X509Certificate(await readFile(paths.certificate));
    await localCertificate(directory);
    assert.deepEqual(await readFile(paths.key), originalKey);
    const clock = context.mock.method(Date, 'now', () => Date.parse(originalCertificate.validTo) - 3_600_000);
    await localCertificate(directory);
    clock.mock.restore();
    const certificate = await readFile(paths.certificate);
    assert.notEqual(new X509Certificate(certificate).fingerprint256, originalCertificate.fingerprint256);
    server = createServer({ key: await readFile(paths.key), cert: certificate }, (_request, response) => response.end('local-auth-ready'));
    await new Promise((accept) => server.listen(0, '127.0.0.1', accept));
    const body = await new Promise((accept, reject) => {
      get(`https://127.0.0.1:${server.address().port}`, { ca: certificate }, (response) => {
        let text = '';
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => accept(text));
      }).on('error', reject);
    });
    assert.equal(body, 'local-auth-ready');
  } finally {
    if (server?.listening) await new Promise((accept) => server.close(accept));
    await rm(directory, { recursive: true, force: true });
  }
});

test('repeated startup preserves the owned controller without Docker and rejects a foreign controller', {
  skip: process.platform === 'win32',
}, async () => {
  const directory = await mkdtemp('/tmp/corner-reuse-');
  const root = await realpath(directory);
  const state = join(root, '.corner-local');
  const local = { ...config, workspace: createHash('sha256').update(root).digest('hex').slice(0, 12) };
  let reportedInstance = local.instance;
  let unexpectedRequest = false;
  const server = createHTTPServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/status' ||
        request.headers.authorization !== `Bearer ${local.controlSecret}`) {
      unexpectedRequest = true;
      response.writeHead(403); response.end(); return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ instance: reportedInstance, origin: 'http://127.0.0.1:45400' }));
  });
  try {
    await mkdir(join(root, 'scripts'));
    await mkdir(state, { mode: 0o700 });
    await copyFile(new URL('../local-dev.mjs', import.meta.url), join(root, 'scripts/local-dev.mjs'));
    const saved = JSON.stringify(local);
    const pid = String(process.pid);
    await writeFile(join(state, 'config.json'), saved, { mode: 0o600 });
    await writeFile(join(state, 'controller.pid'), pid, { mode: 0o600 });
    await new Promise((accept) => server.listen(join(state, 'control.sock'), accept));
    const run = () => promisify(execFile)(process.execPath, ['scripts/local-dev.mjs', 'up'], {
      cwd: root, env: { PATH: dirname(process.execPath) }, timeout: 10_000,
    });
    await run();
    await run();
    assert.equal(server.listening, true);
    assert.equal(unexpectedRequest, false);
    assert.equal(await readFile(join(state, 'controller.pid'), 'utf8'), pid);
    assert.equal(await readFile(join(state, 'config.json'), 'utf8'), saved);
    reportedInstance = 'foreign-installation';
    await assert.rejects(run(), (error) => /Wrong local controller identity/.test(error.stderr));
    assert.equal(server.listening, true);
    assert.equal(await readFile(join(state, 'controller.pid'), 'utf8'), pid);
  } finally {
    if (server.listening) await new Promise((accept) => server.close(accept));
    await rm(directory, { recursive: true, force: true });
  }
});
