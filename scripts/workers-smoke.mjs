// Actual workerd requests, PostgreSQL transactions, and local managed-auth fixture.
// No cloud credentials, real mail, or model calls are used.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  throw new Error(
    '--preserving requires a document-v1 previous artifact and relational-v1 candidate.',
  );
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
  };
  let workerNumber = 0;
  const startWorker = async (
    config,
    candidate = true,
    { mainOverride, forbidOutbound = false } = {},
  ) => {
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
        bindings: {
          ...bindings,
          ...(options['--previous-config'] && config === options['--previous-config']
            ? {
                BETTER_AUTH_SECRET: 'synthetic-workers-session-binding-secret-over-32-characters',
                CORNER_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 42).toString('base64'),
              }
            : {}),
        },
        outboundService: async (request) => {
          if (forbidOutbound)
            assert.fail(
              `Maintenance Worker must not make outbound DB/Auth requests (${request.url}).`,
            );
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
      const response = await worker.fetch(
        new URL(`/api/rpc/workspace/${snapshotProcedure}`, origin),
        {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: priorCookie },
          body: '{}',
          signal: AbortSignal.timeout(20_000),
        },
      );
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
        await validateCutoverCandidate(
          {
            ...candidateArtifact,
            directory: dirname(options['--config']),
          },
          operationId,
          async () => ({
            ...candidateMigrator,
            // The existing disposable fixture isolates schemas through libpq options,
            // forbidden on production unpooled URLs. Keep its real pool factory here.
            createDatabase: () => candidateMigrator.createDatabase(backend.databaseUrl),
          }),
        );
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

  // Exercise new delegation on the same canonical built Worker and owned DB/Auth
  // fixture; no alternate issuer, transport, identity, or listener is introduced.
  const delegatedCookies = new Map(alice.split('; ').map((cookie) => {
    const offset = cookie.indexOf('=');
    return [cookie.slice(0, offset), cookie.slice(offset + 1)];
  }));
  const delegatedCall = async (path, body, { bearer, form = false, browser = true } = {}) => {
    const response = await call(path, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'manual',
      headers: {
        ...(browser ? { Origin: origin, Cookie: [...delegatedCookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
        ...(body === undefined ? {} : { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' }),
        ...(bearer ? { Authorization: `Bearer ${bearer}`, Accept: 'application/json, text/event-stream' } : {}),
      },
      body: body === undefined ? undefined : form ? new URLSearchParams(body) : JSON.stringify(body),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';', 1);
      const offset = pair.indexOf('=');
      const key = pair.slice(0, offset), value = pair.slice(offset + 1);
      if (value) delegatedCookies.set(key, value); else delegatedCookies.delete(key);
    }
    const text = await response.text();
    const data = text && response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(text) : text || {};
    return { status: response.status, data, headers: response.headers, location: response.headers.get('Location') };
  };
  const delegationMetadata = await delegatedCall('/.well-known/oauth-authorization-server');
  assert.equal(delegationMetadata.status, 200);
  assert.equal(delegationMetadata.data.issuer, origin);
  assert.deepEqual(delegationMetadata.data.code_challenge_methods_supported, ['S256']);
  assert.equal(delegationMetadata.data.end_session_endpoint, undefined);
  assert.equal(delegationMetadata.data.pushed_authorization_request_endpoint, undefined);
  const delegatedRegistration = await delegatedCall('/oauth/register', {
    client_name: 'Canonical Worker read client', redirect_uris: ['http://127.0.0.1/callback'],
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
  }, { browser: false });
  assert.equal(delegatedRegistration.status, 201);
  const delegatedClient = delegatedRegistration.data.client_id;
  const delegatedVerifier = 'workers-canonical-s256-verifier-'.repeat(3);
  const delegatedResource = `${origin}/mcp`;
  const authorization = await delegatedCall('/oauth/authorize?' + new URLSearchParams({
    client_id: delegatedClient, redirect_uri: 'http://127.0.0.1/callback', response_type: 'code',
    scope: 'food-logs:read recipes:read offline_access', prompt: 'consent', resource: delegatedResource,
    code_challenge: createHash('sha256').update(delegatedVerifier).digest('base64url'),
    code_challenge_method: 'S256', state: 'canonical-worker-owned-state',
  }));
  assert.equal(authorization.status, 303);
  const delegatedUid = new URL(authorization.location, origin).pathname.split('/').at(-1);
  const consentDocument = await call(`/oauth/consent/${delegatedUid}`);
  assert.equal(consentDocument.status, 200);
  assert.equal(consentDocument.headers.get('Cache-Control'), 'private, no-store, max-age=0');
  const delegatedConsent = await delegatedCall(`/api/delegation/consent/${delegatedUid}`);
  assert.equal(delegatedConsent.status, 200);
  assert.deepEqual(delegatedConsent.data.requestedScopes.sort(), ['food-logs:read', 'recipes:read']);
  const delegatedApproval = await delegatedCall(`/api/delegation/consent/${delegatedUid}`, { accepted: true, scopes: ['food-logs:read'] });
  assert.equal(delegatedApproval.status, 200);
  const delegatedResume = await delegatedCall(delegatedApproval.data.redirectTo);
  assert.equal(delegatedResume.status, 303);
  const delegatedCallback = new URL(delegatedResume.location);
  assert.equal(delegatedCallback.origin + delegatedCallback.pathname, 'http://127.0.0.1/callback');
  assert.equal(delegatedCallback.searchParams.get('state'), 'canonical-worker-owned-state');
  assert(delegatedCallback.searchParams.get('code'), 'One consent must finish authorization, including offline_access.');
  const delegatedTokens = await delegatedCall('/oauth/token', {
    grant_type: 'authorization_code', client_id: delegatedClient, redirect_uri: 'http://127.0.0.1/callback',
    code: delegatedCallback.searchParams.get('code'), code_verifier: delegatedVerifier, resource: delegatedResource,
  }, { form: true, browser: false });
  assert.equal(delegatedTokens.status, 200);
  assert.equal(delegatedTokens.headers.get('Set-Cookie'), null);
  const delegatedRead = await delegatedCall('/mcp', {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_food_logs', arguments: foodInput },
  }, { bearer: delegatedTokens.data.access_token, browser: false });
  assert.equal(delegatedRead.status, 200);
  assert.deepEqual(delegatedRead.data.result.structuredContent.entries.map((entry) => entry.id), ['workers-food-record']);
  assert.equal(delegatedRead.data.result.structuredContent.revision, foodResult.revision);
  assert.equal(delegatedRead.headers.get('Set-Cookie'), null);
  const delegatedVisible = await delegatedCall('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { bearer: delegatedTokens.data.access_token, browser: false });
  assert.deepEqual(delegatedVisible.data.result.tools.map((tool) => tool.name), ['list_food_logs']);
  const delegatedWrongResource = await delegatedCall('/oauth/token', {
    grant_type: 'refresh_token', client_id: delegatedClient, refresh_token: delegatedTokens.data.refresh_token, resource: 'https://wrong.example/mcp',
  }, { form: true, browser: false });
  assert.equal(delegatedWrongResource.status, 400);
  const delegatedRefresh = await delegatedCall('/oauth/token', {
    grant_type: 'refresh_token', client_id: delegatedClient, refresh_token: delegatedTokens.data.refresh_token, resource: delegatedResource,
  }, { form: true, browser: false });
  assert.equal(delegatedRefresh.status, 200, 'Wrong audience must roll back provisional rotation.');
  const delegatedConnections = await delegatedCall('/api/delegation/connections');
  const delegatedGrant = delegatedConnections.data.connections.find((connection) => connection.clientName === 'Canonical Worker read client');
  assert(delegatedGrant);
  const foreignRevoke = await post('/api/delegation/revoke', { id: delegatedGrant.id }, { Cookie: bob });
  assert.equal(foreignRevoke.status, 404);
  const [racedRefresh, ownerRevoke] = await Promise.all([
    delegatedCall('/oauth/token', { grant_type: 'refresh_token', client_id: delegatedClient, refresh_token: delegatedRefresh.data.refresh_token, resource: delegatedResource }, { form: true, browser: false }),
    delegatedCall('/api/delegation/revoke', { id: delegatedGrant.id }),
  ]);
  assert([200, 400].includes(racedRefresh.status));
  assert.equal(ownerRevoke.status, 200);
  for (const credential of [delegatedTokens.data.access_token, delegatedRefresh.data.access_token, ...(racedRefresh.status === 200 ? [racedRefresh.data.access_token] : [])]) {
    assert.equal((await delegatedCall('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { bearer: credential, browser: false })).status, 401);
  }

  // Worker/Neon transactions must preserve the same guarded nutrition effects as Node.
  const nutritionToken = async (scopes) => {
    const registration = await delegatedCall('/oauth/register', {
      client_name: `Canonical Worker writes ${scopes.join(' ')}`,
      redirect_uris: ['http://127.0.0.1/callback'], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none',
    }, { browser: false });
    assert.equal(registration.status, 201);
    const started = await delegatedCall('/oauth/authorize?' + new URLSearchParams({
      client_id: registration.data.client_id, redirect_uri: 'http://127.0.0.1/callback',
      response_type: 'code', scope: scopes.join(' '), prompt: 'consent', resource: delegatedResource,
      code_challenge: createHash('sha256').update(delegatedVerifier).digest('base64url'),
      code_challenge_method: 'S256', state: 'worker-nutrition-state',
    }));
    assert.equal(started.status, 303);
    const uid = new URL(started.location, origin).pathname.split('/').at(-1);
    const consent = await delegatedCall(`/api/delegation/consent/${uid}`);
    assert.equal(consent.status, 200);
    assert.deepEqual(consent.data.requestedScopes.slice().sort(), scopes.slice().sort());
    const approval = await delegatedCall(`/api/delegation/consent/${uid}`, { accepted: true, scopes });
    assert.equal(approval.status, 200);
    const resumed = await delegatedCall(approval.data.redirectTo);
    assert.equal(resumed.status, 303);
    const callback = new URL(resumed.location);
    assert.equal(callback.origin + callback.pathname, 'http://127.0.0.1/callback');
    assert.equal(callback.searchParams.get('state'), 'worker-nutrition-state');
    assert(callback.searchParams.get('code'));
    const tokens = await delegatedCall('/oauth/token', {
      grant_type: 'authorization_code', client_id: registration.data.client_id,
      redirect_uri: 'http://127.0.0.1/callback', code: callback.searchParams.get('code'),
      code_verifier: delegatedVerifier, resource: delegatedResource,
    }, { form: true, browser: false });
    assert.equal(tokens.status, 200);
    return tokens.data.access_token;
  };
  const nutritionWriter = await nutritionToken(['meal-plans:write', 'recipes:write', 'food-logs:write']);
  const nutritionDelete = await nutritionToken(['recipes:delete']);
  const nutritionCall = async (bearer, name, args) => {
    const response = await delegatedCall('/mcp', {
      jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name, arguments: args },
    }, { bearer, browser: false });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Set-Cookie'), null);
    return response.data.result;
  };
  const deleteCatalog = await delegatedCall('/mcp', { jsonrpc: '2.0', id: 5, method: 'tools/list' }, { bearer: nutritionDelete, browser: false });
  assert.deepEqual(deleteCatalog.data.result.tools.map((tool) => tool.name).sort(), ['delete_recipe', 'get_workspace_revision']);
  const nutritionBefore = await snapshot(alice);
  const nutritionMetadata = (await nutritionCall(nutritionWriter, 'get_workspace_revision', {})).structuredContent;
  assert.deepEqual(nutritionMetadata, { revision: nutritionBefore.revision });
  assert.deepEqual((await nutritionCall(nutritionDelete, 'get_workspace_revision', {})).structuredContent, nutritionMetadata);
  let nutritionRevision = nutritionMetadata.revision;
  const workerRecipe = {
    id: 'worker-mcp-recipe', name: 'Explicit Worker oats', description: '', category: 'breakfast',
    prepMinutes: 1, cookMinutes: 0, nutrition: { calories: 100, protein: 10, carbs: 10, fat: 2 },
    ingredients: [{ name: 'Oats', quantity: 100, unit: 'g', aisle: 'Grains' }], steps: ['Mix'],
    storage: '', variation: '', tags: [], color: '#234b35', source: 'manual',
    favorite: false, createdAt: '2026-10-28T12:00:00.000Z',
  };
  const workerMeal = { id: 'worker-mcp-meal', date: '2026-10-28', slot: 'breakfast', recipeId: workerRecipe.id, servings: 1 };
  const recipeApplied = await nutritionCall(nutritionWriter, 'create_recipe', {
    operationId: 'worker-mcp-create-recipe', expectedRevision: nutritionRevision, recipe: workerRecipe,
  });
  assert.deepEqual(recipeApplied.structuredContent, { revision: ++nutritionRevision });
  const mealArguments = { operationId: 'worker-mcp-create-meal', expectedRevision: nutritionRevision, changes: [{ action: 'create', entry: workerMeal }] };
  assert.deepEqual((await nutritionCall(nutritionWriter, 'edit_meal_plans', mealArguments)).structuredContent, { revision: ++nutritionRevision });
  const workerFood = {
    id: 'worker-mcp-food', date: workerMeal.date, slot: workerMeal.slot, name: 'Explicit historical snapshot',
    nutrition: { calories: 123, protein: 8, carbs: 16, fat: 3 }, servings: 2,
    recipeId: workerRecipe.id, createdAt: workerRecipe.createdAt,
  };
  assert.deepEqual((await nutritionCall(nutritionWriter, 'create_food_log', {
    operationId: 'worker-mcp-create-food', expectedRevision: nutritionRevision, entry: workerFood,
  })).structuredContent, { revision: ++nutritionRevision });
  const nutritionApplied = await snapshot(alice);
  assert.equal(nutritionApplied.revision, nutritionRevision);
  assert.deepEqual(nutritionApplied.state.plan.find((entry) => entry.id === workerMeal.id), workerMeal);
  assert.deepEqual(nutritionApplied.state.logs.find((entry) => entry.id === workerFood.id), workerFood);
  const failedBatch = await nutritionCall(nutritionWriter, 'edit_meal_plans', {
    operationId: 'worker-mcp-atomic-failure', expectedRevision: nutritionRevision,
    changes: [{ action: 'update', id: workerMeal.id, patch: { servings: 9 } }, { action: 'update', id: 'missing-worker-meal', patch: { servings: 2 } }],
  });
  assert.equal(failedBatch.isError, true);
  assert.equal(failedBatch.structuredContent.code, 'NOT_FOUND');
  assert.deepEqual(await snapshot(alice), nutritionApplied);
  assert.deepEqual((await nutritionCall(nutritionWriter, 'edit_meal_plans', mealArguments)).structuredContent, { revision: nutritionRevision - 1 });
  assert.deepEqual(await snapshot(alice), nutritionApplied);
  const deleteArguments = { operationId: 'worker-mcp-delete-recipe', expectedRevision: nutritionRevision, id: workerRecipe.id };
  assert.equal((await nutritionCall(nutritionWriter, 'delete_recipe', deleteArguments)).isError, true);
  const inUse = await nutritionCall(nutritionDelete, 'delete_recipe', deleteArguments);
  assert.equal(inUse.isError, true);
  assert.equal(inUse.structuredContent.code, 'INVALID_INPUT');
  assert.deepEqual(await snapshot(alice), nutritionApplied);
  // Plan deletion is deliberately manual-only; the delegated delete cannot cascade it.
  const removedPlan = await client(alice).workspace.mutate({
    requestId: 'worker-owner-remove-source-plan', mutation: { type: 'plan.delete', data: { id: workerMeal.id } },
  });
  assert.deepEqual(removedPlan, { revision: ++nutritionRevision });
  const deletedRecipe = await nutritionCall(nutritionDelete, 'delete_recipe', { ...deleteArguments, expectedRevision: nutritionRevision });
  assert.deepEqual(deletedRecipe.structuredContent, { revision: ++nutritionRevision });
  const nutritionAfter = await snapshot(alice);
  assert.equal(nutritionAfter.revision, nutritionRevision);
  assert.equal(nutritionAfter.state.recipes.some((entry) => entry.id === workerRecipe.id), false);
  assert.deepEqual(nutritionAfter.state.logs, [...nutritionBefore.state.logs, workerFood]);
  assert.equal((await snapshot(bob)).state.logs.some((entry) => entry.id === workerFood.id), false);

  // Training grants use the same actual Worker/OAuth path, separately from planning and nutrition.
  const trainingPlanner = await nutritionToken(['routines:write', 'workout-plans:write']);
  const trainingHistorian = await nutritionToken(['workout-history:write']);
  const historyCatalog = await delegatedCall('/mcp', { jsonrpc: '2.0', id: 6, method: 'tools/list' }, { bearer: trainingHistorian, browser: false });
  assert.deepEqual(historyCatalog.data.result.tools.map((tool) => tool.name).sort(), ['get_workout_versions', 'update_workout_history']);
  const trainingTimestamp = '2026-10-28T12:00:00.000Z';
  const workerTarget = { id: 'worker-squat', name: 'Squat', loadType: 'total', targetSets: 2,
    repMin: 6, repMax: 8, targetRir: 2, restSeconds: 120, notes: 'Keep target' };
  const workerStrength = { id: 'worker-strength-history', date: '2026-10-28', name: 'Recorded strength',
    kind: 'strength', status: 'completed', unit: 'kg', exercises: [{ ...workerTarget,
      sets: [{ id: 'worker-set', weight: 60, reps: 6, rir: 2, completed: true, kind: 'working' }] }],
    plannedMinutes: 35, durationMinutes: 32, rounds: null, sessionRpe: 7, readiness: 4,
    notes: 'Keep history notes', changeReason: '', createdAt: trainingTimestamp, updatedAt: trainingTimestamp };
  const workerSkipped = { ...workerStrength, id: 'worker-skipped-history', status: 'skipped',
    exercises: [], durationMinutes: null, sessionRpe: null, readiness: null, notes: 'Skipped due to travel' };
  for (const session of [workerStrength, workerSkipped]) {
    await client(alice).workspace.mutate({ requestId: `worker-owner-seed-${session.id}`,
      mutation: { type: 'training.session.save', data: { session, expectedUpdatedAt: null } } });
  }
  const trainingBefore = await snapshot(alice);
  let trainingRevision = trainingBefore.revision;
  const workerRoutine = { id: 'worker-routine', name: 'Worker strength routine', kind: 'strength',
    description: 'Keep description', durationMinutes: 35, exercises: [workerTarget] };
  assert.deepEqual((await nutritionCall(trainingPlanner, 'create_routine', {
    operationId: 'worker-create-routine', expectedRevision: trainingRevision, routine: workerRoutine,
  })).structuredContent, { revision: ++trainingRevision });
  const workerPlan = { id: 'worker-workout-plan', date: '2026-10-29', name: 'Worker planned strength',
    kind: 'strength', unit: 'kg', exercises: [workerTarget], plannedMinutes: 35, notes: 'Keep plan notes', changeReason: '' };
  const workoutBatch = { operationId: 'worker-create-workout-batch', expectedRevision: trainingRevision,
    changes: [{ action: 'create', entry: workerPlan }, { action: 'create', entry: { ...workerPlan, id: 'worker-workout-plan-two', date: '2026-10-30' } }] };
  assert.deepEqual((await nutritionCall(trainingPlanner, 'edit_workout_plans', workoutBatch)).structuredContent, { revision: ++trainingRevision });
  const planVersions = (await nutritionCall(trainingPlanner, 'get_workout_versions', { ids: [workerPlan.id] })).structuredContent;
  assert.equal(planVersions.revision, trainingRevision);
  assert.deepEqual(planVersions.sessions.map((entry) => Object.keys(entry).sort()), [['id', 'updatedAt']]);
  assert.equal(planVersions.sessions[0].id, workerPlan.id);
  const beforeRoutineEdit = await snapshot(alice);
  assert.deepEqual((await nutritionCall(trainingPlanner, 'update_routine', {
    operationId: 'worker-edit-routine', expectedRevision: trainingRevision, id: workerRoutine.id, patch: { durationMinutes: 40 },
  })).structuredContent, { revision: ++trainingRevision });
  const afterRoutineEdit = await snapshot(alice);
  assert.deepEqual(afterRoutineEdit.state.training.sessions, beforeRoutineEdit.state.training.sessions);
  assert.equal(afterRoutineEdit.state.training.templates.find((entry) => entry.id === workerRoutine.id).description, workerRoutine.description);
  const actualStrength = afterRoutineEdit.state.training.sessions.find((entry) => entry.id === workerStrength.id);
  const protectedBatch = await nutritionCall(trainingPlanner, 'edit_workout_plans', {
    operationId: 'worker-protected-workout-batch', expectedRevision: trainingRevision,
    changes: [{ action: 'create', entry: { ...workerPlan, id: 'worker-must-rollback' } },
      { action: 'update', id: actualStrength.id, expectedUpdatedAt: actualStrength.updatedAt, patch: { notes: 'Must not replace actuals' } }],
  });
  assert.equal(protectedBatch.structuredContent.code, 'HISTORY_PROTECTED');
  assert.deepEqual(await snapshot(alice), afterRoutineEdit);
  assert.deepEqual((await nutritionCall(trainingPlanner, 'edit_workout_plans', workoutBatch)).structuredContent, { revision: trainingRevision - 1 });
  assert.deepEqual(await snapshot(alice), afterRoutineEdit);
  const correctedExercises = actualStrength.exercises.map((exercise) => ({ ...exercise,
    sets: exercise.sets.map((set) => ({ ...set, reps: 8 })) }));
  const strengthCorrection = { operationId: 'worker-correct-strength', expectedRevision: trainingRevision,
    id: actualStrength.id, expectedUpdatedAt: actualStrength.updatedAt, patch: { exercises: correctedExercises } };
  const historyVersions = (await nutritionCall(trainingHistorian, 'get_workout_versions', { ids: [actualStrength.id] })).structuredContent;
  assert.deepEqual(historyVersions, { revision: trainingRevision, sessions: [{ id: actualStrength.id, updatedAt: actualStrength.updatedAt }] });
  strengthCorrection.expectedUpdatedAt = historyVersions.sessions[0].updatedAt;
  assert.equal((await nutritionCall(trainingPlanner, 'update_workout_history', strengthCorrection)).isError, true);
  assert.deepEqual((await nutritionCall(trainingHistorian, 'update_workout_history', strengthCorrection)).structuredContent, { revision: ++trainingRevision });
  const afterStrength = await snapshot(alice);
  const savedStrength = afterStrength.state.training.sessions.find((entry) => entry.id === actualStrength.id);
  assert.deepEqual(savedStrength, { ...actualStrength, exercises: correctedExercises, updatedAt: savedStrength.updatedAt });
  assert.notEqual(savedStrength.updatedAt, actualStrength.updatedAt);
  assert.equal((await nutritionCall(trainingHistorian, 'update_workout_history', {
    ...strengthCorrection, operationId: 'worker-stale-strength', expectedRevision: trainingRevision,
  })).structuredContent.code, 'RECORD_CONFLICT');
  const actualSkipped = afterStrength.state.training.sessions.find((entry) => entry.id === workerSkipped.id);
  assert.deepEqual((await nutritionCall(trainingHistorian, 'update_workout_history', {
    operationId: 'worker-correct-skipped', expectedRevision: trainingRevision, id: actualSkipped.id,
    expectedUpdatedAt: actualSkipped.updatedAt, patch: { notes: 'Skipped due to delayed flight' },
  })).structuredContent, { revision: ++trainingRevision });
  const trainingAfter = await snapshot(alice);
  const savedSkipped = trainingAfter.state.training.sessions.find((entry) => entry.id === actualSkipped.id);
  assert.deepEqual(savedSkipped, { ...actualSkipped, notes: 'Skipped due to delayed flight', updatedAt: savedSkipped.updatedAt });
  assert.notEqual(savedSkipped.updatedAt, actualSkipped.updatedAt);
  assert.equal(trainingAfter.revision, trainingRevision);
  assert.equal((await snapshot(bob)).state.training.sessions.some((entry) => entry.id === workerStrength.id), false);
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
  for (const path of ['ai/connection', 'ai/connect', 'agent/start']) {
    const retired = await rpc(path, {}, { Cookie: alice });
    assert.equal(retired.status, 404);
    assert.match(retired.headers.get('Cache-Control'), /no-store/);
  }
  const callback = await worker.fetch(
    new URL('/auth/callback?code=synthetic&state=synthetic', origin),
    {
      headers: { Cookie: alice },
    },
  );
  assert.equal(callback.status, 404);
  assert.match(callback.headers.get('Cache-Control'), /no-store/);
  assert.equal((await post('/api/auth/sign-out', {}, { Cookie: alice })).status, 200);
  const signedOut = await rpc('workspace/get', undefined, { Cookie: alice });
  assert.equal(signedOut.status, 401);
  assert.equal((await signedOut.json()).json.code, 'SIGN_IN_REQUIRED');
} finally {
  await cleanup.disposeAsync();
}
process.stdout.write(
  `Passed fullstack Worker assets, version identity, canonical origin, secure account cookies, isolated PostgreSQL writes/retries/rollback, clean candidate database shutdown, sign-out, and retired AI route rejection${previousMigrator ? ', including prior-schema writes and candidate/recovery compatibility' : ''}.\nNo live cloud, account email, or model requests were made.\n`,
);
