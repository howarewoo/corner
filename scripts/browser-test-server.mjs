import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSmokeServices } from './smoke-services.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:43141';
await Promise.all([
  access(join(root, 'apps/server/dist/index.js')),
  access(join(root, 'apps/web/dist/index.html')),
]);
const temporary = await mkdtemp(join(tmpdir(), 'corner-browser-'));
const stopped = Promise.withResolvers();
const stop = () => stopped.resolve();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
let backend;
let child;
let exited;
try {
  backend = await startSmokeServices(temporary, origin);
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (
      /^(CORNER_|DATABASE_|NEON_|BETTER_AUTH_|PG|VITE_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$)/.test(
        key,
      )
    )
      delete environment[key];
  }
  Object.assign(environment, {
    NODE_ENV: 'production',
    CORNER_DEPLOYMENT: 'local',
    CORNER_ORIGIN: origin,
    CORNER_LANDING_ORIGIN: 'http://localhost:43141',
    CORNER_HOST: '127.0.0.1',
    CORNER_PORT: '43141',
    CORNER_DATA_DIR: temporary,
    DATABASE_URL: backend.databaseUrl,
    NEON_AUTH_BASE_URL: backend.authUrl,
    NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
    NODE_EXTRA_CA_CERTS: backend.certificate,
  });
  child = spawn(process.execPath, [join(root, 'apps/server/dist/index.js')], {
    cwd: root,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  exited = Promise.withResolvers();
  child.once('error', stopped.reject);
  child.once('close', () => exited.resolve());
  child.once('exit', (code, signal) => {
    stopped.reject(new Error(`Browser application exited unexpectedly (${code ?? signal}).`));
  });
  await stopped.promise;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const kill = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.kill('SIGTERM');
    await exited.promise;
    clearTimeout(kill);
  }
  try {
    await backend?.close();
  } finally {
    await rm(temporary, { recursive: true, force: true });
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
