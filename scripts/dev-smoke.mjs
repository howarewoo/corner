// Exercise the real four-workspace development stack with disposable local
// data. No provider connection, account email, or external request is needed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startSmokeServices } from './smoke-services.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:43139';
const apiPort = 43140;
const password = 'synthetic-development-smoke-password-not-used-elsewhere';
const compilerTasks = [
  '@packages/nutrition',
  '@packages/training',
  '@packages/workspace',
  '@packages/agent',
  '@packages/api',
];
const tasks = [...compilerTasks, 'server', 'web'];
const seenTasks = new Set();
const compiledTasks = new Set();
const interrupted = new AbortController();
let child;
let exited;
let childFinished = false;
let apiStarted = false;
let captured = '';

if (process.platform === 'win32')
  throw new Error(
    'The development smoke check requires Unix process groups; run it on Linux or macOS.',
  );
for (const name of ['.env', '.env.local', '.env.development', '.env.development.local']) {
  const exists = await access(join(root, name)).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
  if (exists)
    throw new Error(
      'Run the development smoke check in a clean checkout without local Node or Vite environment files.',
    );
}
await Promise.all(
  [43139, apiPort].map(
    (port) =>
      new Promise((resolve, reject) => {
        const probe = createServer((socket) => socket.destroy());
        probe.once('error', (error) =>
          reject(
            new Error(
              `Development smoke port ${port} is unavailable (${error.code ?? 'listen failed'}).`,
            ),
          ),
        );
        probe.listen(port, '127.0.0.1', () => probe.close(resolve));
      }),
  ),
);

const temporary = await mkdtemp(join(tmpdir(), 'corner-development-smoke-'));
const testDatabaseUrl = process.env.CORNER_TEST_DATABASE_URL;
const backend = await startSmokeServices(temporary, origin);
const environment = { ...process.env };
for (const name of Object.keys(environment)) {
  if (
    /^(CORNER_|BETTER_AUTH_|RESEND_|OPENAI_|VITE_|TURBO_|NEON_|DATABASE_)/.test(name) ||
    name === 'NODE_OPTIONS'
  )
    delete environment[name];
}
Object.assign(environment, {
  NODE_ENV: 'development',
  CI: '1',
  NO_COLOR: '1',
  TURBO_TELEMETRY_DISABLED: '1',
  DO_NOT_TRACK: '1',
  CORNER_DEPLOYMENT: 'local',
  CORNER_ORIGIN: origin,
  CORNER_DEV_API_PORT: String(apiPort),
  CORNER_DATA_DIR: join(temporary, 'data'),
  BETTER_AUTH_SECRET: 'synthetic-development-account-secret-with-more-than-32-characters',
  CORNER_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 47).toString('base64'),
  DATABASE_URL: backend.databaseUrl,
  NEON_AUTH_BASE_URL: backend.authUrl,
  NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
  NODE_EXTRA_CA_CERTS: backend.certificate,
  CORNER_TEST_DATABASE_URL: testDatabaseUrl,
});

function capture(chunk) {
  // Never print child logs: even a failing module must not dump source or
  // response data into CI output. Only bounded readiness markers are retained.
  captured = (captured + String(chunk)).slice(-64 * 1024);
  for (const task of tasks) if (captured.includes(`${task}:dev:`)) seenTasks.add(task);
  for (const match of captured.matchAll(
    /(@packages\/[\w-]+):dev:[^\r\n]*Found 0 errors\. Watching for file changes\./g,
  ))
    if (compilerTasks.includes(match[1])) compiledTasks.add(match[1]);
  apiStarted ||= captured.includes(`Development API listens at http://127.0.0.1:${apiPort};`);
}

function call(path, options = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      new URL(path, origin),
      {
        method: options.method ?? 'GET',
        agent: false,
        signal: AbortSignal.any([
          interrupted.signal,
          AbortSignal.timeout(options.timeout ?? 10_000),
        ]),
        headers: options.headers,
      },
      (response) => {
        const chunks = [];
        let length = 0;
        response.on('data', (chunk) => {
          length += chunk.length;
          if (length > (options.maxBytes ?? 4 * 1024 * 1024)) {
            request.destroy(new Error(`The ${path} development response exceeded its size limit.`));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          const headers = new Headers();
          for (let index = 0; index < response.rawHeaders.length; index += 2)
            headers.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
          resolve({
            status: response.statusCode,
            headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.on('error', reject);
    request.end(options.body);
  });
}

function json(response, label) {
  try {
    return JSON.parse(response.body);
  } catch {
    throw new Error(`${label} did not return valid JSON.`);
  }
}

const post = (path, body, headers = {}) =>
  call(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
  });
const filesystemPath = (path) => `/@fs${join(root, path)}`;

async function ready() {
  const deadline = Date.now() + 30_000;
  // Initial compiler emissions can restart Node after its first healthy response.
  let healthySince = 0;
  while (Date.now() < deadline) {
    interrupted.signal.throwIfAborted();
    if (childFinished) throw new Error('The development stack exited before it was ready.');
    if (
      apiStarted &&
      seenTasks.size === tasks.length &&
      compiledTasks.size === compilerTasks.length
    ) {
      try {
        const response = await call('/api/health', {
          timeout: Math.max(1, Math.min(1000, deadline - Date.now())),
        });
        if (response.status === 200 && json(response, 'Development health').ok === true) {
          healthySince ||= Date.now();
          if (Date.now() - healthySince >= 1000) return;
        } else healthySince = 0;
      } catch {
        healthySince = 0;
        interrupted.signal.throwIfAborted();
      }
    }
    await delay(Math.min(100, Math.max(1, deadline - Date.now())), undefined, {
      signal: interrupted.signal,
    });
  }
  throw new Error(
    `The development stack was not ready within 30 seconds (${seenTasks.size}/${tasks.length} workspace tasks observed; ${compiledTasks.size}/${compilerTasks.length} compiler watchers ready; API listener ${apiStarted ? 'started' : 'not started'}).`,
  );
}

function groupExists() {
  if (!child?.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function signalGroup(signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function waitForGroup(milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (groupExists() && Date.now() < deadline) await delay(50);
  return !groupExists();
}

async function stop() {
  if (!child?.pid) return;
  // The detached child owns this group. Never target existing listeners or
  // discover/kill unrelated processes by executable name or port number.
  signalGroup('SIGTERM');
  if (!(await waitForGroup(8000))) {
    signalGroup('SIGKILL');
    if (!(await waitForGroup(3000)))
      throw new Error('The development smoke process group did not finish cleanup.');
  }
  await exited;
}

const onSignal = () => interrupted.abort(new Error('The development smoke check was interrupted.'));
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);
const deadline = setTimeout(
  () => interrupted.abort(new Error('The development smoke check exceeded its total deadline.')),
  90_000,
);

try {
  // GitHub Actions groups logs until a task exits; persistent tasks never flush
  // their readiness markers unless streaming task-prefixed output is explicit.
  // The independent design catalog has its own listener and is not this product smoke's target.
  child = spawn(
    'pnpm',
    [
      'exec',
      'turbo',
      'run',
      'dev',
      ...tasks.map((name) => `--filter=${name}`),
      '--ui=stream',
      '--log-order=stream',
      '--log-prefix=task',
    ],
    { cwd: root, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  exited = new Promise((resolve) => {
    child.once('error', () => {
      childFinished = true;
      resolve();
    });
    child.once('exit', () => {
      childFinished = true;
      resolve();
    });
  });
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  await ready();

  const page = await call('/');
  assert.equal(page.status, 200, 'The web workspace must serve its HTML entry.');
  assert.ok(
    page.body.includes('<div id="root"></div>'),
    'The web HTML must include the app mount point.',
  );
  const entry = await call('/src/main.tsx');
  assert.equal(entry.status, 200, 'Vite must transform the web entry module.');
  assert.ok(
    entry.headers.get('Content-Type')?.includes('javascript') && entry.body.includes('createRoot'),
    'The web entry must be served as JavaScript.',
  );

  const module = await call(filesystemPath('packages/training/dist/exercise-catalog.js'));
  assert.equal(
    module.status,
    200,
    'The shared catalog module must be inside the Vite filesystem allowlist.',
  );
  assert.ok(
    module.body.includes('data/exercises.json') &&
      module.body.includes('data/exercises-source.json'),
    'The catalog must resolve both shared JSON imports.',
  );
  for (const filename of ['exercises.json', 'exercises-source.json']) {
    const path = filesystemPath(`packages/training/dist/data/${filename}`);
    const raw = await call(path);
    assert.equal(raw.status, 200, `Vite must serve shared catalog data: ${filename}.`);
    const data = json(raw, 'Shared catalog data');
    assert.ok(
      filename === 'exercises.json'
        ? Array.isArray(data) && data.length === 1324
        : data.count === 1324,
      'The shared catalog and its provenance must agree on 1,324 exercises.',
    );
    // Vite adds development source maps to the complete catalog JSON module.
    // Allow that bounded expansion without increasing ordinary API limits.
    const imported = await call(`${path}?import`, { maxBytes: 16 * 1024 * 1024 });
    assert.equal(imported.status, 200, `Vite must transform the shared JSON import: ${filename}.`);
    assert.ok(
      imported.body.includes('export default'),
      'Shared JSON imports must be valid JavaScript modules.',
    );
  }
  assert.equal(
    (await call(filesystemPath('package.json'))).status,
    403,
    'The root project configuration must remain outside the web filesystem allowlist.',
  );

  const policy = await post('/api/rpc/account/policy', {});
  assert.equal(
    policy.status,
    200,
    'The browser origin must proxy account policy to the separate API.',
  );
  const accountPolicy = json(policy, 'Account policy').json;
  assert.ok(
    accountPolicy.emailVerificationRequired === false &&
      accountPolicy.passwordResetAvailable === true,
    'Account policy must match managed auth configuration.',
  );
  assert.equal(
    (await post('/api/rpc/workspace/get', {})).status,
    401,
    'Workspace data must require a session through the proxy.',
  );
  const callback = await call('/auth/callback');
  assert.equal(
    callback.status,
    401,
    'The callback must reach API authentication instead of the web HTML fallback.',
  );
  assert.ok(
    json(callback, 'Unauthenticated callback').code === 'SIGN_IN_REQUIRED',
    'A callback without a session must stop before provider work.',
  );

  const signup = await post('/api/auth/sign-up/email', {
    name: 'Development test',
    email: 'development-test@example.test',
    password,
  });
  assert.equal(
    signup.status,
    200,
    'A synthetic account must sign up through the development proxy.',
  );
  const cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(';', 1)[0])
    .join('; ');
  assert.ok(cookie, 'Signup must establish a browser session.');
  const state = await post('/api/rpc/workspace/get', {}, { Cookie: cookie });
  assert.equal(
    state.status,
    200,
    'The session cookie must authenticate proxied workspace requests.',
  );
  assert.ok(
    json(state, 'Workspace bootstrap').json.settings?.name === 'Development test',
    'The session must own the disposable workspace.',
  );
  assert.equal(
    (await post('/api/auth/sign-out', {}, { Cookie: cookie, Origin: 'https://other.example.test' }))
      .status,
    403,
    'The proxy must preserve foreign origins for CSRF rejection.',
  );
  assert.equal(
    (await post('/api/auth/sign-out', {}, { Cookie: cookie })).status,
    200,
    'The same-origin session must sign out through the proxy.',
  );
  assert.equal(
    (await post('/api/rpc/workspace/get', {}, { Cookie: cookie })).status,
    401,
    'Signed-out cookies must no longer grant access.',
  );
} finally {
  clearTimeout(deadline);
  try {
    await stop();
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await backend.close();
    await rm(temporary, { recursive: true, force: true });
  }
}
process.stdout.write(
  `Passed all ${tasks.length} Turbo development tasks, web/exercise catalog serving, filesystem isolation, native RPC proxy, callback authentication, and account session checks.\n`,
);
process.stdout.write(
  'The owned development process group and temporary data were cleaned up. No account email or model requests were made.\n',
);
