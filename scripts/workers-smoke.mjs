// Actual workerd requests, PostgreSQL transactions, and local managed-auth fixture.
// No cloud credentials, real mail, or model calls are used.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startSmokeServices } from './smoke-services.mjs';
import { publicChecks, maintenanceChecks, validateCutoverCandidate } from './release.mjs';
import { verifyArtifact, qualificationRecovery } from './release-artifact.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { experimental_readRawConfig, unstable_getMiniflareWorkerOptions } = await import(
  require.resolve('wrangler')
);
const { Agent, fetch: fixtureFetch } = await import(require.resolve('undici'));
const { createORPCClient } = await import(require.resolve('@orpc/client'));
const { RPCLink } = await import(require.resolve('@orpc/client/fetch'));
const options = {};
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (flag === '--preserving') {
    if (options[flag]) throw new Error(`Invalid smoke option: ${flag}`);
    options[flag] = true;
    continue;
  }
  if (
    !['--config', '--migration-entry', '--previous-config', '--previous-migration-entry'].includes(
      flag,
    ) ||
    !process.argv[index + 1] ||
    options[flag]
  )
    throw new Error(`Invalid smoke option: ${flag}`);
  options[flag] = resolve(process.argv[++index]);
}
if (Boolean(options['--previous-config']) !== Boolean(options['--previous-migration-entry']))
  throw new Error('Previous Worker and migrator must be supplied together.');
if (options['--previous-config'] && (!options['--config'] || !options['--migration-entry']))
  throw new Error('Qualification requires the candidate Worker and migrator.');
if (!options['--config']) await access(join(root, 'apps/web/dist/index.html'));
const candidateMigrator = options['--migration-entry']
  ? await import(pathToFileURL(options['--migration-entry']).href)
  : undefined;
const previousMigrator = options['--previous-migration-entry']
  ? await import(pathToFileURL(options['--previous-migration-entry']).href)
  : undefined;
const candidateArtifact = options['--config']
  ? await verifyArtifact(dirname(options['--config']))
  : undefined;
const previousArtifact = options['--previous-config']
  ? await verifyArtifact(dirname(options['--previous-config']))
  : undefined;
const recoveryMode = previousArtifact
  ? qualificationRecovery(candidateArtifact, previousArtifact, Boolean(options['--preserving']))
  : undefined;
const forwardOnly = recoveryMode === 'forward-only';
const preserving = recoveryMode === 'preserving';
if (options['--preserving'] && !preserving)
  throw new Error('--preserving requires a document-v1 previous artifact and relational-v1 candidate.');
const directory = await mkdtemp(join(tmpdir(), 'corner-workers-smoke-'));
const origin = 'https://corner.example.test';
const cleanup = new AsyncDisposableStack();
cleanup.defer(() => rm(directory, { recursive: true, force: true }));
try {
  const backend = await startSmokeServices(
    directory,
    origin,
    previousMigrator?.migrate ?? candidateMigrator?.migrate,
    candidateMigrator?.createDatabase,
  );
  cleanup.defer(() => backend.close());
  if (forwardOnly) {
    const retained = await startSmokeServices(
      directory,
      origin,
      previousMigrator.migrate,
      candidateMigrator.createDatabase,
    );
    try {
      await retained.database.query(
        "INSERT INTO workspace_state VALUES ('retained-owner','{}',0,'2026-10-22T00:00:00.000Z')",
      );
      const before = (await retained.database.query('SELECT * FROM workspace_state')).rows;
      const history = (
        await retained.database.query('SELECT * FROM __drizzle_migrations ORDER BY id')
      ).rows;
      await assert.rejects(candidateMigrator.migrate(retained.database));
      assert.deepEqual(
        (await retained.database.query('SELECT * FROM workspace_state')).rows,
        before,
      );
      assert.deepEqual(
        (await retained.database.query('SELECT * FROM __drizzle_migrations ORDER BY id')).rows,
        history,
      );
    } finally {
      await retained.close();
    }
  }
  const dispatcher = new Agent({ connect: { ca: await readFile(backend.certificate) } });
  cleanup.defer(() => dispatcher.close());
  let worker;
  cleanup.defer(() => worker?.dispose());
  const bindings = {
    CORNER_ORIGIN: origin,
    DATABASE_URL: backend.databaseUrl,
    NEON_AUTH_BASE_URL: backend.authUrl,
    NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
    BETTER_AUTH_SECRET: 'synthetic-workers-session-binding-secret-over-32-characters',
    CORNER_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 42).toString('base64'),
  };
  let workerNumber = 0;
  const startWorker = async (config, candidate = true, { mainOverride, forbidOutbound = false } = {}) => {
    const miniflareRequire = createRequire(require.resolve('wrangler'));
    const { Miniflare, convertV4MiniflareOptions, WebSocketPair, Response, Log } = await import(
      miniflareRequire.resolve('miniflare')
    );
    const databaseUrl = new URL(backend.databaseUrl);
    // Neon 1.2 defaults to wss://<database hostname>/v2, without the database port.
    // Only this exact handshake is intercepted; its binary SQL stream goes to the
    // fixture's fixed TCP address, never a destination supplied by the request.
    const proxyUrl = new URL(`https://${databaseUrl.hostname}/v2`);
    const bridges = new Set();
    const proxyErrors = [];
    const diagnostics = [];
    let disposed = false;
    class SmokeLog extends Log {
      logWithLevel(level, message) {
        if (message.includes('CORNER_DATABASE_CONNECTION_FAILED')) diagnostics.push(message);
        super.logWithLevel(level, message);
      }
    }
    const upgrade = (request) => {
      assert.equal(request.url, proxyUrl.href, 'Unexpected database WebSocket destination.');
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.get('Upgrade')?.toLowerCase(), 'websocket');
      const pair = new WebSocketPair();
      const socket = connect({
        host: databaseUrl.hostname.replace(/^\[|\]$/g, ''),
        port: Number(databaseUrl.port || 5432),
      });
      pair[1].accept();
      const close = () => {
        socket.destroy();
        if (pair[1].readyState === 1) pair[1].close(1000);
      };
      bridges.add(close);
      const fail = (error) => {
        if (!disposed) proxyErrors.push(error);
        close();
      };
      socket.setTimeout(20_000, () => fail(new Error('Database WebSocket bridge timed out.')));
      socket.on('error', fail);
      socket.on('data', (data) => {
        try {
          pair[1].send(data);
        } catch (error) {
          fail(error);
        }
      });
      socket.on('end', close);
      socket.on('close', () => {
        close();
        bridges.delete(close);
      });
      pair[1].addEventListener('message', ({ data }) => {
        try {
          assert.notEqual(typeof data, 'string', 'PostgreSQL WebSocket frames must be binary.');
          socket.write(Buffer.from(data));
        } catch (error) {
          fail(error);
        }
      });
      pair[1].addEventListener('error', (event) =>
        fail(event.error ?? new Error('Database WebSocket bridge failed.')),
      );
      pair[1].addEventListener('close', close);
      return new Response(null, { status: 101, webSocket: pair[0] });
    };
    const { rawConfig: original } = experimental_readRawConfig({ config });
    const bundle = mainOverride
      ? resolve(dirname(config), mainOverride)
      : original.no_bundle
        ? resolve(dirname(config), original.main)
        : join(root, 'apps/server/dist/worker/worker.js');
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
    const workers = [
      {
        ...workerOptions,
        name: original.name,
        modules: true,
        modulesRoot: dirname(bundle),
        scriptPath: bundle,
        bindings,
        outboundService: async (request) => {
          if (forbidOutbound)
            assert.fail(`Maintenance Worker must not make outbound DB/Auth requests (${request.url}).`);
          if (
            request.headers.get('Upgrade')?.toLowerCase() === 'websocket' ||
            new URL(request.url).origin === proxyUrl.origin
          )
            return upgrade(request);
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
      },
      ...externalWorkers,
    ];
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        workers,
        host: '127.0.0.1',
        port: 0,
        log: new SmokeLog(),
      }),
    );
    return {
      ready: runtime.ready,
      fetch: (...args) => runtime.dispatchFetch(...args),
      dispose: async () => {
        if (disposed) return;
        try {
          await runtime.dispose();
        } finally {
          disposed = true;
          for (const close of bridges) close();
          bridges.clear();
        }
        assert.deepEqual(proxyErrors, [], 'Database WebSocket bridge must not fail.');
        if (candidate) {
          assert.deepEqual(
            diagnostics,
            [],
            'Candidate database operations and shutdown must be clean.',
          );
        }
      },
    };
  };
  let priorCookie;
  let priorState;
  if (previousMigrator) {
    // Prior schema and Worker must genuinely function before upgrading that schema.
    worker = await startWorker(options['--previous-config'], false);
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
    if (!forwardOnly) {
      const previousWrite = await worker.fetch(new URL('/api/rpc/workspace/mutate', origin), {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: priorCookie },
        body: JSON.stringify({
          json: {
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
          },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      assert.equal(previousWrite.status, 200, await previousWrite.clone().text());
      // Document-generation get includes state; relational get is bootstrap-only.
      const snapshotProcedure = previousArtifact.generation === 'document-v1' ? 'get' : 'export';
      const response = await worker.fetch(new URL(`/api/rpc/workspace/${snapshotProcedure}`, origin), {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: priorCookie },
        body: '{}',
        signal: AbortSignal.timeout(20_000),
      });
      assert.equal(response.status, 200, await response.clone().text());
      const previousSnapshot = (await response.json()).json;
      priorState = { state: previousSnapshot.state, revision: previousSnapshot.revision };
    }
    await worker.dispose();
    if (preserving) {
      assert.equal(
        candidateArtifact?.manifest.maintenanceWorkerEntry,
        'worker/maintenance-worker.js',
        'Preserving cutover requires packaged worker/maintenance-worker.js.',
      );
      worker = await startWorker(options['--config'], false, {
        mainOverride: candidateArtifact.manifest.maintenanceWorkerEntry,
        forbidOutbound: true,
      });
      await worker.ready;
      const maintHealth = await worker.fetch(new URL('/api/health', origin));
      assert.equal(maintHealth.status, 503);
      const maintVersion = maintHealth.headers.get('X-Corner-Version');
      assert.match(maintVersion ?? '', /^[a-f0-9-]{36}$/i);
      await maintenanceChecks(origin, maintVersion, (url, init) => worker.fetch(url, init));
      assert.equal(
        (await worker.fetch(new URL('https://wrong.example.test/api/health'))).status,
        400,
      );
      const maintPage = await worker.fetch(new URL('/', origin));
      assert.equal(maintPage.status, 503);
      assert.match(await maintPage.text(), /Corner is updating/);
      await worker.dispose();
      assert.equal(typeof candidateMigrator.preservingDocumentCutover, 'function');
      assert.equal(typeof candidateMigrator.inspectDocumentCutover, 'function');
      const operationId = 'workers-smoke-preserving-cutover';
      assert.equal(
        (await candidateMigrator.inspectDocumentCutover(backend.database, operationId)).phase,
        'untouched',
      );
      const cutoverResult = await candidateMigrator.preservingDocumentCutover(
        backend.database,
        operationId,
      );
      assert.equal(cutoverResult.phase, 'completed');
      const replayResult = await candidateMigrator.preservingDocumentCutover(
        backend.database,
        operationId,
      );
      assert.equal(replayResult.phase, 'completed');
      const previousUnpooled = process.env.DATABASE_URL_UNPOOLED;
      const validationUrl = new URL(backend.databaseUrl);
      validationUrl.searchParams.delete('options');
      process.env.DATABASE_URL_UNPOOLED = validationUrl.href;
      try {
        await validateCutoverCandidate({
          ...candidateArtifact,
          directory: dirname(options['--config']),
        }, operationId, async () => ({
          ...candidateMigrator,
          // The existing disposable fixture isolates schemas through libpq options,
          // forbidden on production unpooled URLs. Keep its real pool factory here.
          createDatabase: () => candidateMigrator.createDatabase(backend.databaseUrl),
        }));
      } finally {
        if (previousUnpooled === undefined) delete process.env.DATABASE_URL_UNPOOLED;
        else process.env.DATABASE_URL_UNPOOLED = previousUnpooled;
      }
    } else {
      await candidateMigrator.migrate(backend.database);
    }
  }
  worker = await startWorker(options['--config'] ?? join(root, 'apps/server/wrangler.jsonc'));
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
  if (priorCookie && !forwardOnly) {
    const response = await rpc('workspace/export', undefined, { Cookie: priorCookie });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(
      (await response.json()).json,
      priorState,
      'Candidate schema migration must preserve the previous workspace.',
    );
    if (preserving) {
      const priorFollowup = {
        requestId: 'preserving-candidate-followup-write',
        mutation: {
          type: 'settings.save',
          data: { ...priorState.state.settings, name: 'Converted and updated on relational-v1' },
        },
      };
      const firstFollowup = await rpc('workspace/mutate', priorFollowup, { Cookie: priorCookie });
      assert.equal(firstFollowup.status, 200, await firstFollowup.clone().text());
      const retryFollowup = await rpc('workspace/mutate', priorFollowup, { Cookie: priorCookie });
      assert.equal(retryFollowup.status, 200, await retryFollowup.clone().text());
      const followupPayload = (await firstFollowup.json()).json;
      assert.equal(followupPayload.revision, priorState.revision + 1);
      assert.deepEqual((await retryFollowup.json()).json, followupPayload);
      const updatedPrior = await rpc('workspace/export', undefined, { Cookie: priorCookie });
      assert.equal(updatedPrior.status, 200, await updatedPrior.clone().text());
      const updatedSnapshot = (await updatedPrior.json()).json;
      assert.equal(updatedSnapshot.revision, priorState.revision + 1);
      assert.equal(updatedSnapshot.state.settings.name, 'Converted and updated on relational-v1');
      assert.deepEqual(updatedSnapshot.state.logs, priorState.state.logs);
    }
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
  await publicChecks(origin, version, (url, options) => worker.fetch(url, options));
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
  const client = (cookie) =>
    createORPCClient(
      new RPCLink({
        url: `${origin}/api/rpc`,
        headers: { Origin: origin, Cookie: cookie },
        fetch: (request, init) =>
          worker.fetch(request.url, {
            ...init,
            method: request.method,
            headers: Object.fromEntries(request.headers),
            body: request.body,
            duplex: 'half',
            signal: request.signal,
          }),
      }),
    );
  const state = async (cookie) => {
    const response = await rpc('workspace/get', undefined, { Cookie: cookie });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    const document = (await response.json()).json;
    assert.deepEqual(await client(cookie).workspace.get(), document);
    return document;
  };
  const snapshot = async (cookie) => {
    const response = await rpc('workspace/export', undefined, { Cookie: cookie });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).json;
  };
  const initial = await state(alice);
  const body = {
    requestId: 'workers-manual-settings-123',
    mutation: {
      type: 'settings.save',
      data: { ...initial.settings, name: 'Saved on Workers' },
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
  assert.equal((await state(alice)).settings.name, 'Saved on Workers');
  assert.equal((await state(bob)).settings.name, 'Bob');
  const foodMutation = {
    requestId: 'workers-food-record-write',
    mutation: {
      type: 'log.save',
      data: {
        id: 'workers-food-record',
        date: '2026-10-23',
        slot: 'lunch',
        name: 'Bounded Workers lunch',
        nutrition: { calories: 400, protein: 30, carbs: 40, fat: 12 },
        servings: 1.25,
        createdAt: '2026-10-23T12:00:00.000Z',
      },
    },
  };
  const foodResult = await client(alice).workspace.mutate(foodMutation);
  assert.deepEqual(Object.keys(foodResult), ['revision']);
  assert.deepEqual(await client(alice).workspace.mutate(foodMutation), foodResult);
  const foodInput = { from: '2026-10-23', through: '2026-10-23', limit: 1 };
  const food = await client(alice).workspace.foodWindow(foodInput);
  assert.equal(food.entries.length, 1);
  assert.equal(food.entries[0].id, 'workers-food-record');
  assert.equal(food.totals.calories, 500);
  assert.equal(food.revision, foodResult.revision);
  assert.equal(food.nextCursor, null);
  assert.deepEqual((await client(bob).workspace.foodWindow(foodInput)).entries, []);
  const validateRecords = async (migrator) => {
    const connection = await backend.database.connect();
    try {
      await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const schema = await candidateMigrator.currentSchema(connection);
      await candidateMigrator.migrationHistory(
        connection,
        schema,
        candidateArtifact.manifest.migrations,
        true,
      );
      assert.equal(migrator.storageGeneration, 'relational-v1');
      assert.equal(typeof migrator.validatePersistedRecords, 'function');
      await migrator.validatePersistedRecords(connection, schema);
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  };
  if (candidateMigrator) await validateRecords(candidateMigrator);
  const beforeRollback = await state(alice);
  const rejectedRequestId = 'workers-rollback-rejected-receipt';
  await backend.database.query(
    `ALTER TABLE mutation_receipts ADD CONSTRAINT workers_smoke_reject_receipt
     CHECK (request_id <> '${rejectedRequestId}')`,
  );
  try {
    const rejected = await rpc(
      'workspace/mutate',
      {
        requestId: rejectedRequestId,
        mutation: {
          type: 'settings.save',
          data: { ...beforeRollback.settings, name: 'Must be rolled back' },
        },
      },
      { Cookie: alice },
    );
    assert.equal(rejected.status, 503, await rejected.clone().text());
    assert.deepEqual(
      await state(alice),
      beforeRollback,
      'A receipt failure after the workspace write must roll back both state and revision.',
    );
    const receipts = await backend.database.query(
      'SELECT request_id FROM mutation_receipts WHERE request_id = $1',
      [rejectedRequestId],
    );
    assert.equal(receipts.rowCount, 0, 'A failed transaction must not leave a mutation receipt.');
    assert.equal((await state(bob)).settings.name, 'Bob');
  } finally {
    await backend.database.query(
      'ALTER TABLE mutation_receipts DROP CONSTRAINT workers_smoke_reject_receipt',
    );
  }
  if (previousMigrator && !forwardOnly && !preserving) {
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
    const candidateWritten = await snapshot(alice);
    await validateRecords(previousMigrator);
    await worker.dispose();
    worker = await startWorker(options['--previous-config'], false);
    await worker.ready;
    const recoveredFood = await client(alice).workspace.foodWindow({
      from: '2026-10-23',
      through: '2026-10-23',
      limit: 1,
    });
    assert.equal(recoveredFood.entries.length, 1);
    assert.equal(recoveredFood.totals.calories, 1062.5);
    assert.ok(recoveredFood.nextCursor);
    assert.deepEqual(
      await snapshot(alice),
      candidateWritten,
      'Previous Worker must export candidate-written records losslessly.',
    );
    assert.equal(
      (await call('/')).status,
      200,
      'Recovered previous Worker must still serve its assets.',
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
    const recoveredRetry = await rpc(
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
    assert.equal(recoveredRetry.status, 200, await recoveredRetry.clone().text());
    assert.deepEqual((await recoveredRetry.json()).json, (await oldWrite.json()).json);
    const previousWritten = await snapshot(alice);
    await validateRecords(candidateMigrator);
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
    worker = await startWorker(options['--config']);
    await worker.ready;
    assert.deepEqual(
      await snapshot(alice),
      previousWritten,
      'Candidate must read the previous Worker mutation without loss.',
    );
    assert.equal((await state(bob)).settings.name, 'Bob');
  }
  const connection = (await (await rpc('ai/connection', undefined, { Cookie: alice })).json()).json;
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
} finally {
  await cleanup.disposeAsync();
}
process.stdout.write(
  `Passed fullstack Worker assets, version identity, canonical origin, secure account cookies, isolated PostgreSQL writes/retries/rollback, clean candidate database shutdown, sign-out, and hosted AI gate${previousMigrator ? ', including prior-schema writes and candidate/recovery compatibility' : ''}.\nNo live cloud, account email, or model requests were made.\n`,
);
