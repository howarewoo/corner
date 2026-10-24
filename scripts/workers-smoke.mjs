// Actual workerd requests, PostgreSQL transactions, and local managed-auth fixture.
// No cloud credentials, real mail, or model calls are used.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startSmokeServices } from './smoke-services.mjs';
import { publicChecks } from './release.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { experimental_readRawConfig, unstable_getMiniflareWorkerOptions } = await import(
  require.resolve('wrangler')
);
const { Agent, fetch: fixtureFetch } = await import(require.resolve('undici'));
const { createORPCClient } = await import(require.resolve('@orpc/client'));
const { RPCLink } = await import(require.resolve('@orpc/client/fetch'));
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  if (
    ![
      '--config',
      '--frontend-config',
      '--migration-entry',
      '--previous-config',
      '--previous-frontend-config',
      '--previous-migration-entry',
    ].includes(flag) ||
    !process.argv[index + 1] ||
    options[flag]
  )
    throw new Error(`Invalid smoke option: ${flag}`);
  options[flag] = resolve(process.argv[index + 1]);
}
if (
  Boolean(options['--previous-config']) !== Boolean(options['--previous-migration-entry']) ||
  Boolean(options['--previous-config']) !== Boolean(options['--previous-frontend-config'])
)
  throw new Error('Previous Worker pair and migrator must be supplied together.');
if (!options['--frontend-config'])
  throw new Error('Select the frontend configuration for the Worker pair.');
const frontendConfig = options['--frontend-config'];
if (!options['--config']) await access(join(root, 'apps/web/dist/index.html'));
const candidateMigrator = options['--migration-entry']
  ? await import(pathToFileURL(options['--migration-entry']).href)
  : undefined;
const previousMigrator = options['--previous-migration-entry']
  ? await import(pathToFileURL(options['--previous-migration-entry']).href)
  : undefined;
const directory = await mkdtemp(join(tmpdir(), 'corner-workers-smoke-'));
const origin = 'https://corner.example.test';
let backend;
let worker;
let dispatcher;
try {
  backend = await startSmokeServices(
    directory,
    origin,
    previousMigrator?.migrate ?? candidateMigrator?.migrate,
    candidateMigrator?.createDatabase,
  );
  dispatcher = new Agent({ connect: { ca: await readFile(backend.certificate) } });
  const bindings = {
    CORNER_ORIGIN: origin,
    DATABASE_URL: backend.databaseUrl,
    NEON_AUTH_BASE_URL: backend.authUrl,
    NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
    BETTER_AUTH_SECRET: 'synthetic-workers-session-binding-secret-over-32-characters',
    CORNER_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 42).toString('base64'),
  };
  let workerNumber = 0;
  const startWorker = async (serverConfig, webConfig) => {
    const miniflareRequire = createRequire(require.resolve('wrangler'));
    const { Miniflare, convertV4MiniflareOptions } = await import(
      miniflareRequire.resolve('miniflare')
    );
    const workers = [];
    for (const [config, defaultBundle, isServer] of [
      [webConfig, join(root, 'apps/web/.wrangler/worker/worker.js'), false],
      [serverConfig, join(root, 'apps/server/dist/worker/worker.js'), true],
    ]) {
      const { rawConfig: original } = experimental_readRawConfig({ config });
      const bundle = original.no_bundle ? resolve(dirname(config), original.main) : defaultBundle;
      const localConfig = join(directory, `worker-${workerNumber++}.json`);
      await writeFile(
        localConfig,
        JSON.stringify({
          ...original,
          main: bundle,
          no_bundle: true,
          assets: {
            ...original.assets,
            directory: resolve(dirname(config), original.assets.directory),
          },
        }),
      );
      const { workerOptions, externalWorkers } = unstable_getMiniflareWorkerOptions(localConfig);
      delete workerOptions.modulesRules;
      workers.push(
        {
          ...workerOptions,
          name: original.name,
          modules: true,
          modulesRoot: dirname(bundle),
          scriptPath: bundle,
          bindings: isServer ? bindings : {},
          ...(isServer
            ? {
                outboundService: async (request) => {
                  assert.equal(
                    new URL(request.url).origin,
                    new URL(backend.authUrl).origin,
                    'The smoke must never contact a real provider.',
                  );
                  return fixtureFetch(request.url, {
                    method: request.method,
                    headers: request.headers,
                    body: request.body,
                    duplex: 'half',
                    redirect: 'manual',
                    dispatcher,
                  });
                },
              }
            : {}),
        },
        ...externalWorkers,
      );
    }
    const runtime = new Miniflare(
      convertV4MiniflareOptions({ workers, host: '127.0.0.1', port: 0 }),
    );
    return {
      ready: runtime.ready,
      fetch: (...args) => runtime.dispatchFetch(...args),
      dispose: () => runtime.dispose(),
    };
  };
  let priorCookie;
  let priorState;
  if (previousMigrator) {
    // Prior schema and Worker must genuinely function before upgrading that schema.
    worker = await startWorker(options['--previous-config'], options['--previous-frontend-config']);
    await worker.ready;
    assert.deepEqual(await (await worker.fetch(new URL('/api/health', origin))).json(), {
      ok: true,
    });
    const signup = await worker.fetch(new URL('/api/auth/sign-up/email', origin), {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Prior',
        email: 'prior@example.test',
        password: 'synthetic-prior-version-password',
      }),
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(signup.status, 200, await signup.clone().text());
    priorCookie = signup.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';', 1)[0])
      .join('; ');
    const previousWrite = await worker.fetch(new URL('/api/rpc/workspace/mutate', origin), {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: priorCookie },
      body: JSON.stringify({ json: {
        requestId: 'prior-record-before-migration',
        mutation: {
          type: 'log.save',
          data: {
            id: 'prior-food-record',
            date: '2026-10-22',
            slot: 'dinner',
            name: 'Recorded before migration',
            nutrition: { calories: 600, protein: 40, carbs: 65, fat: 20 },
            servings: 1,
            createdAt: '2026-10-22T18:00:00.000Z',
          },
        },
      } }),
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(previousWrite.status, 200, await previousWrite.clone().text());
    const response = await worker.fetch(new URL('/api/rpc/workspace/get', origin), {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: priorCookie },
      body: '{}',
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(response.status, 200, await response.clone().text());
    priorState = (await response.json()).json;
    await worker.dispose();
    await candidateMigrator.migrate(backend.database);
  }
  if (previousMigrator) {
    // Backend-first deployment must work before the frontend switches.
    worker = await startWorker(options['--config'], options['--previous-frontend-config']);
    await worker.ready;
    const oldFrontend = await worker.fetch(new URL('/', origin));
    assert.equal(oldFrontend.status, 200);
    const saved = await worker.fetch(new URL('/api/rpc/workspace/get', origin), {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: priorCookie },
      body: '{}',
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(
      (await saved.json()).json,
      priorState,
      'Old frontend binding must reach the new backend without losing prior records.',
    );
    await worker.dispose();
  }
  worker = await startWorker(
    options['--config'] ?? join(root, 'apps/server/wrangler.jsonc'),
    frontendConfig,
  );
  await worker.ready;
  const call = (path, options = {}) =>
    worker.fetch(new URL(path, origin), { ...options, signal: AbortSignal.timeout(20_000) });
  const post = (path, body, headers = {}) =>
    call(path, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const rpc = (procedure, input, headers = {}) =>
    post(`/api/rpc/${procedure}`, { json: input }, headers);
  if (priorCookie) {
    const response = await rpc('workspace/get', undefined, { Cookie: priorCookie });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(
      (await response.json()).json,
      priorState,
      'Candidate schema migration must preserve the previous workspace.',
    );
  }
  const health = await call('/api/health');
  assert.deepEqual(await health.json(), { ok: true });
  const { rawConfig: workerConfig } = experimental_readRawConfig({
    config: options['--config'] ?? join(root, 'apps/server/wrangler.jsonc'),
  });
  const version = health.headers.get('X-Corner-Version');
  if (workerConfig.version_metadata?.binding === 'CF_VERSION_METADATA') {
    assert.match(version ?? '', /^[a-f0-9-]{36}$/i);
  }
  const frontendVersion = health.headers.get('X-Corner-Frontend-Version');
  assert.match(frontendVersion ?? '', /^[a-f0-9-]{36}$/i);
  await publicChecks(
    origin,
    version,
    (url, options) => worker.fetch(url, options),
    frontendVersion,
  );
  assert.equal((await call('https://wrong.example.test/api/health')).status, 400);
  assert.equal((await call('/', { method: 'POST' })).status, 405);
  const page = await call('/account/reset-password');
  assert.match(await page.text(), /<div id="root"><\/div>/);

  async function signup(name) {
    const response = await post('/api/auth/sign-up/email', {
      name,
      email: `${name.toLowerCase()}@example.test`,
      password: 'synthetic-workers-smoke-password',
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).token, undefined);
    const cookies = response.headers.getSetCookie();
    assert(
      cookies.some(
        (cookie) =>
          cookie.startsWith('__Secure-neon-auth.session_token=') &&
          cookie.includes('HttpOnly') &&
          cookie.includes('Secure'),
      ),
    );
    return cookies.map((cookie) => cookie.split(';', 1)[0]).join('; ');
  }
  const alice = await signup('Alice');
  const bob = await signup('Bob');
  assert.equal(
    (await rpc('workspace/mutate', { padding: 'x'.repeat(192 * 1024) }, { Cookie: alice })).status,
    413,
    'Native mutation envelopes must retain the procedure body limit.',
  );
  const client = (cookie) => createORPCClient(new RPCLink({
    url: `${origin}/api/rpc`,
    headers: { Origin: origin, Cookie: cookie },
    fetch: (request, init) => worker.fetch(request.url, {
      ...init,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: request.body,
      duplex: 'half',
      signal: request.signal,
    }),
  }));
  const state = async (cookie) => {
    const response = await rpc('workspace/get', undefined, { Cookie: cookie });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    const document = (await response.json()).json;
    assert.deepEqual(await client(cookie).workspace.get(), document);
    return document;
  };
  const initial = await state(alice);
  const body = {
    requestId: 'workers-manual-settings-123',
    mutation: {
      type: 'settings.save',
      data: { ...initial.state.settings, name: 'Saved on Workers' },
    },
  };
  assert.equal(
    (await rpc('workspace/mutate', body, { Cookie: alice, Origin: 'https://foreign.example.test' }))
      .status,
    403,
  );
  const writes = await Promise.all([
    rpc('workspace/mutate', body, { Cookie: alice }),
    rpc('workspace/mutate', body, { Cookie: alice }),
  ]);
  for (const response of writes) {
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).json.revision, initial.revision + 1);
  }
  assert.equal((await state(alice)).state.settings.name, 'Saved on Workers');
  assert.equal((await state(bob)).state.settings.name, 'Bob');
  if (previousMigrator) {
    const fixtures = [
      {
        type: 'log.save',
        data: {
          id: 'compatibility-food',
          date: '2026-10-23',
          slot: 'lunch',
          name: 'Candidate-written lunch',
          nutrition: { calories: 450, protein: 32, carbs: 44, fat: 16 },
          servings: 1.25,
          createdAt: '2026-10-23T12:00:00.000Z',
        },
      },
      { type: 'grocery.check', data: { key: 'compatibility:rice', checked: true } },
      {
        type: 'request.save',
        data: {
          id: 'compatibility-request',
          prompt: 'Candidate-written dinner request',
          calories: 600,
          protein: 40,
          maxMinutes: 30,
          status: 'pending',
          createdAt: '2026-10-23T12:00:00.000Z',
        },
      },
      {
        type: 'training.checkin.save',
        data: {
          id: 'compatibility-checkin',
          date: '2026-10-23',
          bodyWeight: 175.5,
          waist: null,
          sleepHours: 7.5,
          energy: 4,
          soreness: 2,
          boxingQuality: null,
          notes: 'Candidate-written training measurement',
        },
      },
    ];
    for (const [index, mutation] of fixtures.entries()) {
      const response = await rpc(
        'workspace/mutate',
        { requestId: `candidate-fixture-write-${index}`, mutation },
        { Cookie: alice },
      );
      assert.equal(response.status, 200, await response.clone().text());
    }
    const candidateWritten = await state(alice);
    await worker.dispose();
    worker = await startWorker(options['--previous-config'], frontendConfig);
    await worker.ready;
    assert.deepEqual(
      await state(alice),
      candidateWritten,
      'Previous Worker must read the entire candidate-written document losslessly.',
    );
    assert.equal(
      (await call('/')).status,
      200,
      'Recovery must support current frontend with previous backend.',
    );
    const oldWrite = await rpc(
      'workspace/mutate',
      {
        requestId: 'previous-version-write-123',
        mutation: {
          type: 'settings.save',
          data: { ...candidateWritten.state.settings, name: 'Written by previous Worker' },
        },
      },
      { Cookie: alice },
    );
    assert.equal(oldWrite.status, 200, await oldWrite.clone().text());
    const previousWritten = await state(alice);
    assert.equal(previousWritten.revision, candidateWritten.revision + 1);
    assert.deepEqual(
      previousWritten.state,
      {
        ...candidateWritten.state,
        settings: { ...candidateWritten.state.settings, name: 'Written by previous Worker' },
      },
      'Previous mutation must preserve candidate-written fields.',
    );
    await worker.dispose();
    worker = await startWorker(options['--config'], options['--previous-frontend-config']);
    await worker.ready;
    assert.deepEqual(
      await state(alice),
      previousWritten,
      'Candidate must read the previous Worker mutation without loss.',
    );
    assert.equal((await state(bob)).state.settings.name, 'Bob');
    await worker.dispose();
    worker = await startWorker(options['--previous-config'], options['--previous-frontend-config']);
    await worker.ready;
    assert.deepEqual(
      await state(alice),
      previousWritten,
      'Recovered previous pair must preserve current records.',
    );
    await worker.dispose();
    worker = await startWorker(options['--config'], frontendConfig);
    await worker.ready;
    assert.deepEqual(
      await state(alice),
      previousWritten,
      'Redeployed candidate pair must preserve recovery writes.',
    );
  }
  const connection = (await (
    await rpc('ai/connection', undefined, { Cookie: alice })
  ).json()).json;
  assert.equal(connection.enabled, false);
  assert.equal(connection.available, false);
  const disabledConnection = await rpc('ai/connect', {}, { Cookie: alice });
  assert.equal(disabledConnection.status, 409);
  const disabledError = (await disabledConnection.json()).json;
  assert.equal(disabledError.code, 'CORNER_ERROR');
  assert.equal(typeof disabledError.data.code, 'string');
  assert.equal(
    (
      await rpc(
        'agent/start',
        {
          requestId: 'workers-plan-request-123',
          prompt: 'Plan my training',
          referenceDate: '2026-10-23',
        },
        { Cookie: alice },
      )
    ).status,
    503,
  );
  assert.equal((await post('/api/auth/sign-out', {}, { Cookie: alice })).status, 200);
  const signedOut = await rpc('workspace/get', undefined, { Cookie: alice });
  assert.equal(signedOut.status, 401);
  assert.equal((await signedOut.json()).json.code, 'SIGN_IN_REQUIRED');
  process.stdout.write(
    `Passed paired Workers assets, both version identities, canonical origin, secure account cookies, isolated PostgreSQL writes/retries, sign-out, and hosted AI gate${previousMigrator ? ', including intermediate and recovery combinations' : ''}.\nNo live cloud, account email, or model requests were made.\n`,
  );
} finally {
  await worker?.dispose();
  await dispatcher?.close();
  await backend?.close();
  await rm(directory, { recursive: true, force: true });
}
