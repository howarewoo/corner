import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import {
  verifyRun,
  validateConfiguration,
  validateReceipt,
  validateMaintenanceReceipt,
  assertBaseline,
  rollbackEligible,
  GitHub,
  plan,
  promote,
  resume,
  complete,
  deploy,
  publicChecks,
  publicCheckOptions,
  verifyPublic,
  PublicCheckError,
  maintenanceChecks,
  validateLiveRollback,
} from '../release.mjs';
import { loadCiArtifact } from '../ci-artifact.mjs';
import { releaseTarget } from '../release-target.mjs';

const source = 'a'.repeat(40),
  previousSource = 'b'.repeat(40),
  candidateDigest = 'c'.repeat(64),
  previousDigest = 'd'.repeat(64),
  configurationSha256 = 'e'.repeat(64);
const versionId = '12345678-1234-1234-1234-123456789012',
  oldVersion = 'abcdefab-abcd-abcd-abcd-abcdefabcdef',
  maintenanceVersionId = '22222222-3333-4444-8555-666666666666';
const configuration = JSON.stringify({
  CORNER_ORIGIN: 'https://corner.example.com',
  NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
});
const saved = { ...process.env };
process.env.CORNER_PRODUCTION_BINDINGS_REVISION = 'test-config-1';
process.env.DATABASE_URL_UNPOOLED = 'postgresql://synthetic.invalid/unused';
process.env.GITHUB_RUN_ATTEMPT = '1';
process.env.GITHUB_RUN_ID = '90';
delete process.env.CORNER_PRODUCTION_ORIGIN;
const config = validateConfiguration(configuration);
const report = {
  format: 1,
  sourceSha: source,
  candidateDigest,
  previousDigest,
  bootstrap: false,
  generation: 'relational-v1',
  previousGeneration: 'relational-v1',
  recovery: 'compatible',
  passed: true,
};
const receipt = {
  format: 4,
  kind: 'corner-production',
  workerName: 'corner',
  phase: 'complete',
  runId: '1',
  artifactId: '2',
  sourceSha: previousSource,
  candidateDigest: previousDigest,
  configurationSha256,
  runtimeConfigurationDigest: config.digest,
  versionId: oldVersion,
  qualification: { ...report, sourceSha: previousSource, candidateDigest: previousDigest },
};
const manifest = {
  sourceSha: source,
  configurationSha256,
  configurationEntry: 'wrangler.json',
  workerEntry: 'worker/worker.js',
  migrationEntry: 'migration/dist/migrate.mjs',
  workerName: 'corner',
  migrations: [{ name: '0000_corner.sql', sha256: 'f'.repeat(64), when: 1 }],
};
manifest.wranglerVersion = JSON.parse(
  await readFile(
    new URL('../../apps/server/node_modules/wrangler/package.json', import.meta.url),
    'utf8',
  ),
).version;
const work = await mkdtemp(join(tmpdir(), 'corner-release-tests-'));
const packagedConfig = {
  name: 'corner',
  main: manifest.workerEntry,
  no_bundle: true,
  assets: { directory: 'assets', binding: 'ASSETS' },
  workers_dev: false,
  preview_urls: true,
};
for (const revision of [source, previousSource]) {
  await mkdir(join(work, revision));
  await writeFile(join(work, revision, 'wrangler.json'), JSON.stringify(packagedConfig));
}
after(async () => {
  await rm(work, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});
const run = {
  id: 1,
  event: 'push',
  head_branch: 'main',
  status: 'completed',
  conclusion: 'success',
  path: '.github/workflows/ci.yml',
  head_sha: source,
  head_repository: { full_name: 'owner/corner' },
};
function fixture(overrides = {}) {
  const effects = [],
    records = [];
  const states = new Map();
  const payload = {
    ...receipt,
    phase: 'planned',
    sourceSha: source,
    candidateDigest,
    baselineId: '10',
    schemaId: null,
    executionRunId: '90',
    bootstrap: false,
    automatic: false,
    rollback: false,
    rollbackVersionId: null,
    qualification: report,
    origin: config.origin,
  };
  payload.executionRunAttempt = '1';
  const github = {
    repository: 'owner/corner',
    baseline: async () => ({ id: 10, payload: receipt }),
    schema: async () => null,
    api: async (path) => {
      if (path === 'git/ref/heads/main') return { object: { sha: source } };
      const recorded = records[Number(path.match(/^deployments\/(\d+)$/)?.[1]) - 21];
      if (recorded)
        return {
          id: Number(path.split('/')[1]),
          environment: 'production-plan',
          payload: recorded,
        };
      if (path.startsWith('deployments/'))
        return { id: 11, environment: 'production-plan', payload };
      if (path.includes('/artifacts?'))
        return { artifacts: [{ id: 2, name: `corner-release-${source}`, expired: false }] };
      if (path.startsWith('actions/runs/')) return run;
      if (path.startsWith('compare/'))
        return { status: 'ahead', files: [{ filename: 'apps/web/src/main.tsx' }] };
      throw new Error(`Unexpected API ${path}`);
    },
    artifact: async (reference) => ({
      generation: 'relational-v1',
      directory: join(work, reference.sourceSha),
      manifest: { ...manifest, sourceSha: reference.sourceSha },
      digest: reference.sourceSha === source ? candidateDigest : previousDigest,
      qualification: {
        ...report,
        sourceSha: reference.sourceSha,
        candidateDigest: reference.sourceSha === source ? candidateDigest : previousDigest,
      },
    }),
    record: async (payload, state = 'in_progress') => {
      effects.push(payload.phase);
      records.push(payload);
      const record = { id: 20 + records.length, payload };
      await github.status(record, state);
      return record;
    },
    status: async (record, state) => {
      states.set(String(record.id), state);
    },
  };
  const execute = (binary, args) => {
    effects.push(
      args.includes('upload') ? 'upload' : args.includes('--apply') ? 'migrate' : 'deploy',
    );
    return `Worker Version ID: ${versionId}\n`;
  };
  const cf = async (path, { missing = false } = {}) => {
    if (missing) return null;
    if (path.endsWith('/settings'))
      return {
        bindings: ['DATABASE_URL', 'NEON_AUTH_BASE_URL'].map((name) => ({
          name,
          type: 'secret_text',
        })),
      };
    return {
      deployments: [
        {
          versions: [
            {
              version_id: effects.includes('deploy') ? versionId : oldVersion,
              percentage: 100,
            },
          ],
        },
      ],
    };
  };
  return {
    github,
    payload,
    effects,
    records,
    state: (phase) => states.get(String(21 + records.findLastIndex((row) => row.phase === phase))),
    options: {
      github,
      planId: '11',
      configuration,
      work,
      execute,
      cf,
      verify: async () => ({ digest: candidateDigest }),
      checkPublic: async () => {
        effects.push('public');
      },
      ...overrides,
    },
  };
}

test('candidate provenance is exact successful push-to-main workflow, not PR or rerun failure', () => {
  verifyRun(run, source);
  for (const mutation of [
    { event: 'pull_request' },
    { head_branch: 'feature' },
    { conclusion: 'failure' },
    { status: 'in_progress' },
    { head_sha: previousSource },
    { path: '.github/workflows/other.yml' },
  ])
    assert.throws(() => verifyRun({ ...run, ...mutation }, source), /successful exact/);
});
test('configuration excludes secrets and binds explicit public settings plus operator binding revision', () => {
  assert.notEqual(config.digest, validateConfiguration(configuration, 'rotated-bindings').digest);
  assert.throws(
    () =>
      validateConfiguration(
        JSON.stringify({ ...JSON.parse(configuration), DATABASE_URL: 'private' }),
      ),
    /public runtime/,
  );
  assert.throws(() => validateConfiguration(configuration, ''), /revision/);
  assert.throws(
    () => validateConfiguration(configuration.replace('corner.example.com', 'corner.workers.dev')),
    /custom-domain/,
  );
  assert.throws(
    () =>
      validateConfiguration(
        JSON.stringify({
          ...JSON.parse(configuration),
          NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
        }),
      ),
    /Release requires/,
  );
});
test('production rejects native Worker hosts and the obsolete staging release environment', () => {
  for (const origin of [
    'https://corner-web.account.workers.dev',
    'https://staging-corner-web.account.workers.dev',
    'https://preview.example.workers-preview.com',
  ])
    assert.throws(
      () =>
        validateConfiguration(
          JSON.stringify({
            CORNER_ORIGIN: origin,
            NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
          }),
        ),
      /Release requires/,
    );
  assert.throws(() => releaseTarget('staging'), /production only/);
});
test('receipt and rollback require real qualified identities and CURRENT compatibility/configuration', () => {
  validateReceipt(receipt);
  assert.throws(() => validateReceipt({ ...receipt, phase: 'operational-validated' }));
  assert.throws(() => validateReceipt({ ...receipt, artifactId: 'invented' }), /numeric/);
  assert.throws(
    () => validateReceipt({ ...receipt, qualification: { passed: false } }),
    /Unqualified/,
  );
  const current = { ...receipt, candidateDigest, qualification: report };
  rollbackEligible(receipt, current, report, config.digest);
  for (const qualification of [
    { ...report, previousDigest: candidateDigest },
    { ...report, bootstrap: true },
    { ...report, passed: false },
    { ...report, recovery: 'forward-only', previousGeneration: 'document-v1' },
    { ...report, recovery: 'forward-only' },
    { ...report, recovery: undefined },
    { ...report, previousGeneration: 'document-v1' },
    { ...report, generation: 'document-v1' },
  ])
    assert.throws(
      () => rollbackEligible(receipt, current, qualification, config.digest),
      /CURRENT/,
    );
  assert.throws(
    () =>
      rollbackEligible(
        { ...receipt, runtimeConfigurationDigest: 'f'.repeat(64) },
        current,
        report,
        config.digest,
      ),
    /configuration/,
  );
});
test('explicit backend and configuration releases complete after automated public checks', async () => {
  for (const changedConfiguration of [false, true]) {
    const f = fixture();
    if (changedConfiguration)
      f.github.baseline = async () => ({
        id: 10,
        payload: { ...receipt, runtimeConfigurationDigest: 'f'.repeat(64) },
      });
    const api = f.github.api;
    let prepared;
    f.github.api = async (path) => {
      if (prepared && path === `deployments/${prepared.id}`)
        return JSON.parse(JSON.stringify({ ...prepared, environment: 'production-plan' }));
      return api(path);
    };
    prepared = await plan({
      ...f.options,
      runId: '1',
      sourceSha: source,
      qualify: async () => report,
    });
    const result = await promote({ ...f.options, planId: String(prepared.id) });
    assert.equal(result.payload.phase, 'complete');
    assert(f.effects.indexOf('public') < f.effects.indexOf('complete'));
  }
});
test('stale approved baseline fails before artifact execution or effects', async () => {
  assert.throws(() => assertBaseline('10', '12'), /Stale plan/);
  const f = fixture();
  f.github.baseline = async () => ({ id: 12, payload: receipt });
  await assert.rejects(promote(f.options), /Stale plan/);
  assert.deepEqual(f.effects, []);
});
test('stale schema journal or cross-run plan fails before effects', async () => {
  const f = fixture();
  f.github.schema = async () => ({ id: 99 });
  await assert.rejects(promote(f.options), /Stale plan/);
  assert.deepEqual(f.effects, []);
  f.github.schema = async () => null;
  f.payload.executionRunId = 'other-run';
  await assert.rejects(promote(f.options), /different execution/);
  assert.deepEqual(f.effects, []);
  f.payload.executionRunId = '90';
  f.payload.executionRunAttempt = '2';
  await assert.rejects(promote(f.options), /different execution/);
  assert.deepEqual(f.effects, []);
});
test('missing baseline never silently bootstraps', async () => {
  const f = fixture();
  f.github.baseline = async () => null;
  await assert.rejects(plan({ ...f.options, runId: '1', sourceSha: source }), /explicit bootstrap/);
  assert.deepEqual(f.effects, []);
});

test('provisioned Worker version pins cannot be used for an ordinary release', async () => {
  const f = fixture();
  await assert.rejects(
    plan({
      ...f.options,
      runId: '1',
      sourceSha: source,
      provisionedVersionId: oldVersion,
    }),
    /valid only for explicit bootstrap/,
  );
  assert.deepEqual(f.effects, []);
});
test('qualification failure occurs before plan persistence', async () => {
  const f = fixture();
  await assert.rejects(
    plan({
      ...f.options,
      runId: '1',
      sourceSha: source,
      qualify: async () => {
        throw new Error('incompatible documents');
      },
    }),
    /incompatible/,
  );
  assert.deepEqual(f.records, []);
});
test('plan persists exact real artifact and baseline qualification', async () => {
  const f = fixture();
  const result = await plan({
    ...f.options,
    runId: '1',
    sourceSha: source,
    qualify: async () => report,
  });
  assert.equal(result.payload.artifactId, '2');
  assert.equal(result.payload.baselineId, '10');
  assert.equal(result.payload.qualification.previousDigest, previousDigest);
  assert.equal(result.payload.phase, 'planned');
});
test('production requires declared forward-only qualification across relational recovery epochs', async () => {
  for (const recovery of ['compatible', 'forward-only']) {
    const f = fixture();
    const artifact = f.github.artifact;
    f.github.artifact = async (reference, ...args) => {
      const loaded = await artifact(reference, ...args);
      if (reference.sourceSha === source) loaded.manifest.recoveryEpoch = 1;
      return loaded;
    };
    const options = {
      ...f.options,
      runId: '1',
      sourceSha: source,
      qualify: async () => ({ ...report, recovery }),
    };
    if (recovery === 'compatible') {
      await assert.rejects(plan(options), /generation mismatch/);
      assert.deepEqual(f.effects, []);
    } else {
      await plan(options);
      assert.deepEqual(f.effects, ['planned']);
    }
  }
});

test('successful promotion closes stage statuses without changing recovery journals', async () => {
  const f = fixture();
  const prepared = await plan({
    ...f.options,
    runId: '1',
    sourceSha: source,
    qualify: async () => report,
  });
  assert.equal(f.state('planned'), 'success');
  let schemaPayload;
  const execute = f.options.execute;
  f.options.execute = (...args) => {
    if (args[1].includes('--apply')) {
      assert.equal(f.state('schema-attempted'), 'in_progress');
      schemaPayload = structuredClone(f.records.at(-1));
    }
    return execute(...args);
  };
  f.options.checkPublic = async () => {
    assert.equal(f.state('schema-attempted'), 'success');
    assert.equal(f.state('deployed'), 'in_progress');
  };
  const completed = await promote({ ...f.options, planId: String(prepared.id) });
  assert.equal(completed.payload.phase, 'complete');
  assert.deepEqual(
    f.records.map((row) => [row.phase, f.state(row.phase)]),
    [
      ['planned', 'inactive'],
      ['schema-attempted', 'success'],
      ['deployed', 'inactive'],
      ['public-passed', 'inactive'],
      ['complete', 'success'],
    ],
  );
  assert.deepEqual(
    f.records.find((row) => row.phase === 'schema-attempted'),
    schemaPayload,
  );
});

test('migration and status failures remain visible without discarding the attempted schema', async () => {
  const f = fixture();
  const migrationError = new Error('migration failed');
  const statusError = new Error('GitHub unavailable');
  f.options.execute = (binary, args) => {
    if (args.includes('--apply')) throw migrationError;
    return `Worker Version ID: ${versionId}`;
  };
  const status = f.github.status;
  f.github.status = async (record, state) => {
    if (state === 'failure') throw statusError;
    return status(record, state);
  };
  await assert.rejects(promote(f.options), (error) => {
    assert(error instanceof AggregateError);
    assert.deepEqual(error.errors, [migrationError, statusError]);
    return true;
  });
  assert.equal(f.records.at(-1).phase, 'schema-attempted');
  assert(!f.records.some((row) => row.phase === 'deployed'));
});

test('successful current main CI deploys backend changes without a second human gate and reruns do not redeploy', async () => {
  const f = fixture();
  const api = f.github.api;
  f.github.api = async (path) =>
    path.startsWith('compare/')
      ? { status: 'ahead', files: [{ filename: 'apps/server/src/worker.ts' }] }
      : api(path);
  const options = {
    ...f.options,
    runId: '1',
    sourceSha: source,
    qualify: async () => report,
  };
  const result = await deploy(options);
  assert.equal(result.payload.phase, 'complete');
  assert.equal(result.payload.sourceSha, source);
  assert.equal(result.payload.versionId, versionId);
  assert(f.effects.indexOf('migrate') < f.effects.indexOf('deploy'));
  assert(f.effects.indexOf('public') < f.effects.indexOf('complete'));
  f.github.baseline = async () => result;
  f.effects.length = 0;
  await deploy(options);
  assert.deepEqual(f.effects, ['public']);
});

test('dual-origin same-source reruns verify landing and propagate failures without release effects', async () => {
  const configuration = JSON.stringify({
    CORNER_ORIGIN: 'https://app.example.com',
    CORNER_LANDING_ORIGIN: 'https://example.com',
    NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
  });
  const config = validateConfiguration(configuration);
  const f = fixture({ configuration });
  const completed = {
    id: 10,
    payload: {
      ...receipt,
      sourceSha: source,
      candidateDigest,
      origin: config.origin,
      runtimeConfigurationDigest: config.digest,
      versionId,
    },
  };
  f.github.baseline = async () => completed;
  const artifact = f.github.artifact;
  f.github.artifact = async (reference, ...args) => {
    assert.deepEqual(reference, completed.payload);
    const loaded = await artifact(reference, ...args);
    loaded.manifest.files = { 'assets/landing/index.html': 'f'.repeat(64) };
    return loaded;
  };
  let landingFailure = false;
  f.options.checkPublic = async (origin, version, options) => {
    f.effects.push('public');
    assert.equal(origin, config.origin);
    assert.equal(version, versionId);
    assert.deepEqual(options, { landingOrigin: config.landingOrigin });
    if (landingFailure) throw new Error('Landing unavailable');
  };
  const options = { ...f.options, runId: '1', sourceSha: source };
  assert.equal(await deploy(options), completed);
  assert.deepEqual(f.effects, ['public']);
  f.effects.length = 0;
  landingFailure = true;
  await assert.rejects(deploy(options), /Landing unavailable/);
  assert.deepEqual(f.effects, ['public']);
  assert.deepEqual(f.records, []);
});

test('automatic production independently downloads and verifies real archives for planning and promotion', async (t) => {
  const { createHash } = await import('node:crypto');
  const { spawnSync } = await import('node:child_process');
  const { verifyArtifact } = await import('../release-artifact.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'corner-auto-archive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archiveRoot = join(directory, 'archive');
  const candidateRoot = join(archiveRoot, 'candidate');
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const migration = 'CREATE TABLE example (id int);';
  const files = {
    'worker/worker.js': 'export default { fetch() { return new Response("archive fixture"); } };',
    'assets/index.html': '<html>archive fixture</html>',
    'migration/dist/migrate.mjs': 'throw new Error("Archive fixture must not execute SQL");',
    'migration/migrations/0000_corner.sql': migration,
    'migration/migrations/meta/_journal.json': JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: [{ idx: 0, version: '7', when: 1, tag: '0000_corner', breakpoints: true }],
    }),
    'migration/migrations/meta/0000_snapshot.json': JSON.stringify({
      id: '11111111-1111-4111-8111-111111111111',
      prevId: '00000000-0000-0000-0000-000000000000',
      version: '7',
      dialect: 'postgresql',
      tables: { 'public.workspace_metadata': {} },
    }),
    'wrangler.json': JSON.stringify({
      ...packagedConfig,
      compatibility_date: '2026-10-19',
      compatibility_flags: ['nodejs_compat'],
      assets: {
        ...packagedConfig.assets,
        run_worker_first: true,
        html_handling: 'none',
        not_found_handling: 'none',
      },
      observability: { enabled: true, logs: { invocation_logs: false } },
      version_metadata: { binding: 'CF_VERSION_METADATA' },
    }),
  };
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(candidateRoot, name)), { recursive: true });
    await writeFile(join(candidateRoot, name), bytes);
  }
  await writeFile(
    join(candidateRoot, 'manifest.json'),
    JSON.stringify({
      ...manifest,
      format: 4,
      lockfileSha256: 'b'.repeat(64),
      nodeVersion: process.version,
      configurationSha256: hash(files['wrangler.json']),
      files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, hash(bytes)])),
      migrations: [
        {
          name: '0000_corner.sql',
          sha256: hash(migration),
          when: 1,
          journalSha256: hash(
            JSON.stringify(JSON.parse(files['migration/migrations/meta/_journal.json']).entries[0]),
          ),
          snapshotSha256: hash(files['migration/migrations/meta/0000_snapshot.json']),
        },
      ],
    }),
  );
  const verified = await verifyArtifact(candidateRoot);
  await writeFile(
    join(archiveRoot, 'qualification.json'),
    JSON.stringify({
      ...report,
      candidateDigest: verified.digest,
      bootstrap: true,
      previousDigest: null,
      previousGeneration: null,
      recovery: 'bootstrap',
    }),
  );
  const zip = join(directory, 'release.zip');
  const zipped = spawnSync('zip', ['-q', '-r', zip, 'candidate', 'qualification.json'], {
    cwd: archiveRoot,
    encoding: 'utf8',
  });
  assert.equal(zipped.status, 0, zipped.stderr);
  const archive = await readFile(zip);
  const f = fixture();
  const api = f.github.api;
  f.github.api = async (path) => {
    if (path === 'actions/artifacts/2/zip') return archive;
    if (path === 'actions/artifacts/2')
      return {
        id: 2,
        expired: false,
        name: `corner-release-${source}`,
        workflow_run: { id: 1, head_sha: source },
        digest: `sha256:${hash(archive)}`,
      };
    return api(path);
  };
  const artifact = f.github.artifact;
  f.github.artifact = async (reference, destination) =>
    reference.sourceSha === source
      ? loadCiArtifact({
          api: f.github.api,
          repository: f.github.repository,
          branch: 'main',
          reference,
          destination,
        })
      : artifact(reference, destination);
  const result = await deploy({
    ...f.options,
    work: directory,
    runId: '1',
    sourceSha: source,
    verify: verifyArtifact,
    qualify: async () => ({ ...report, candidateDigest: verified.digest }),
  });
  assert.equal(result.payload.phase, 'complete');
  assert.equal(result.payload.candidateDigest, verified.digest);
  assert.equal(result.payload.versionId, versionId);
});

test('automatic production rejects failed or foreign CI before release effects', async () => {
  for (const mutation of [
    { conclusion: 'failure' },
    { head_repository: { full_name: 'foreign/corner' } },
  ]) {
    const f = fixture();
    const api = f.github.api;
    f.github.api = async (path) =>
      path === 'actions/runs/1' ? { ...run, ...mutation } : api(path);
    await assert.rejects(
      deploy({ ...f.options, runId: '1', sourceSha: source }),
      /successful exact|this repository/,
    );
    assert.deepEqual(f.effects, []);
  }
});

test('automatic production refuses superseded main before planning, SQL, and traffic changes', async () => {
  for (const boundary of ['plan', 'upload', 'migrate']) {
    const f = fixture();
    const api = f.github.api;
    f.github.api = async (path) =>
      path === 'git/ref/heads/main'
        ? {
            object: {
              sha: boundary === 'plan' || f.effects.includes(boundary) ? previousSource : source,
            },
          }
        : api(path);
    await assert.rejects(
      deploy({ ...f.options, runId: '1', sourceSha: source, qualify: async () => report }),
      /superseded/,
    );
    assert(!f.effects.includes('deploy'));
    assert.equal(f.effects.includes('migrate'), boundary === 'migrate');
    if (boundary === 'migrate') assert.equal(f.records.at(-1).phase, 'schema-attempted');
    else assert(!f.records.some((record) => record.phase === 'schema-attempted'));
  }
});

test('automatic production cannot bootstrap or recover an unvalidated release', async () => {
  for (const inputs of [{ bootstrap: true }, { rollbackId: '10' }]) {
    const f = fixture();
    await assert.rejects(
      deploy({ ...f.options, runId: '1', sourceSha: source, ...inputs }),
      /cannot bootstrap, adopt, or roll back/,
    );
    assert.deepEqual(f.effects, []);
  }
  const f = fixture();
  f.github.baseline = async () => ({ id: 10, payload: { ...receipt, phase: 'public-passed' } });
  await assert.rejects(
    deploy({ ...f.options, runId: '1', sourceSha: source }),
    /Current release is incomplete/,
  );
  assert.deepEqual(f.effects, []);
});

test('automatic production waits for propagation without repeating effects or retrying a security failure', async (t) => {
  const f = fixture();
  let healthRequests = 0;
  let securityRequests = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (new URL(url).pathname === '/api/health')
      return Response.json(
        { ok: true },
        { headers: { 'X-Corner-Version': ++healthRequests === 1 ? oldVersion : versionId } },
      );
    securityRequests++;
    return Response.json({ code: 'WRONG_SECURITY_BOUNDARY' }, { status: 200 });
  });
  await assert.rejects(
    deploy({
      ...f.options,
      runId: '1',
      sourceSha: source,
      qualify: async () => report,
      checkPublic: undefined,
    }),
    (error) => error instanceof PublicCheckError && !error.retryable,
  );
  assert.equal(healthRequests, 2);
  assert.equal(securityRequests, 1);
  for (const effect of ['upload', 'migrate', 'deploy'])
    assert.equal(f.effects.filter((value) => value === effect).length, 1);
  assert.equal(f.records.at(-1).phase, 'deployed');
  assert.equal(f.state('schema-attempted'), 'success');
  assert.equal(f.state('deployed'), 'failure');
  assert(!f.records.some((record) => record.phase === 'complete'));
});
test('migration failure journals schema attempt and prevents traffic/public checks', async () => {
  const f = fixture();
  const execute = f.options.execute;
  f.options.execute = (binary, args, options) => {
    if (args.includes('--apply')) {
      assert.equal(f.records.at(-1)?.phase, 'schema-attempted');
      throw new Error('migration failed');
    }
    assert(!args.includes('deploy'), 'Traffic must not switch before migration succeeds');
    return execute(binary, args, options);
  };
  await assert.rejects(promote(f.options), /migration failed/);
  assert.equal(f.records.at(-1)?.phase, 'schema-attempted');
  assert.equal(f.state('schema-attempted'), 'failure');
  assert(!f.effects.includes('deploy'));
  assert(!f.effects.includes('public'));
});
test('upload failure cannot migrate or deploy', async () => {
  const f = fixture();
  f.options.execute = () => {
    throw new Error('upload failed');
  };
  await assert.rejects(promote(f.options), /upload failed/);
  assert.deepEqual(f.effects, []);
});
test('routine promotion uploads exact prebuilt config, migrates once, deploys exact ID and completes after public evidence', async () => {
  const f = fixture();
  const commands = [];
  const execute = f.options.execute;
  f.options.execute = (binary, args, options) => {
    commands.push([binary, args]);
    return execute(binary, args, options);
  };
  const result = await promote(f.options);
  assert.deepEqual(f.effects, [
    'upload',
    'schema-attempted',
    'migrate',
    'deploy',
    'deployed',
    'public',
    'public-passed',
    'complete',
  ]);
  assert.equal(result.payload.versionId, versionId);
  assert(commands[0][1].includes('--no-bundle'));
  assert(commands[2][1].includes(`${versionId}@100%`));
  assert(!commands.some(([, args]) => args.includes('build') || args.includes('triggers')));
  const configurationPath = commands[0][1][commands[0][1].indexOf('--config') + 1];
  assert.notEqual(
    dirname(configurationPath),
    join(work, source),
    'Wrangler metadata must remain outside the payload.',
  );
  const relocated = JSON.parse(await readFile(configurationPath, 'utf8'));
  assert.deepEqual(relocated, {
    ...packagedConfig,
    workers_dev: false,
    preview_urls: true,
    main: join(work, source, manifest.workerEntry),
    assets: { ...packagedConfig.assets, directory: join(work, source, 'assets') },
  });
  assert.equal(relocated.preview_urls, true);
  assert.equal(relocated.workers_dev, false);
  assert.equal(
    await readFile(join(work, source, 'wrangler.json'), 'utf8'),
    JSON.stringify(packagedConfig),
  );
});
test('a changed deployment toolchain blocks before migration or traffic', async () => {
  const f = fixture();
  const artifact = f.github.artifact;
  f.github.artifact = async (...args) => {
    const candidate = await artifact(...args);
    return { ...candidate, manifest: { ...candidate.manifest, wranglerVersion: '0.0.0' } };
  };
  await assert.rejects(promote(f.options), /deployment tool differs/);
  assert.deepEqual(f.effects, []);
});
test('public failure preserves deployed state and cannot claim completion', async () => {
  const f = fixture();
  f.options.checkPublic = async () => {
    throw new Error('wrong deployed version');
  };
  await assert.rejects(promote(f.options), /wrong deployed version/);
  assert.equal(f.records.at(-1).phase, 'deployed');
  assert(!f.records.some((row) => row.phase === 'complete'));
});
test('artifact identity is rechecked against the qualified plan', async () => {
  const f = fixture();
  f.github.artifact = async () => ({ manifest, directory: work, digest: previousDigest });
  await assert.rejects(promote(f.options), /Approved candidate changed/);
  assert.deepEqual(f.effects, []);
});
test('GitHub download rejects foreign repository and expired/mismatched artifact before archive execution', async () => {
  const github = new GitHub({
    repository: 'owner/corner',
    token: 'synthetic',
    fetcher: async () => {
      throw new Error('No network permitted');
    },
  });
  github.api = async (path) =>
    path.startsWith('actions/runs')
      ? { ...run, head_repository: { full_name: 'attacker/corner' } }
      : {};
  await assert.rejects(
    github.artifact({ runId: '1', artifactId: '2', sourceSha: source }, work),
    /Foreign/,
  );
  github.api = async (path) =>
    path.startsWith('actions/runs')
      ? run
      : {
          expired: true,
          name: `corner-release-${source}`,
          workflow_run: { id: 1, head_sha: source },
        };
  await assert.rejects(
    github.artifact({ runId: '1', artifactId: '2', sourceSha: source }, work),
    /expired/,
  );
});
test('public readiness exhausts its bound when HTTP 200 never serves the deployed version', async () => {
  let healthRequests = 0;
  let waits = 0;
  const fetcher = async (url) => {
    assert.equal(new URL(url).pathname, '/api/health');
    healthRequests++;
    return Response.json({ ok: true }, { headers: { 'X-Corner-Version': oldVersion } });
  };
  await assert.rejects(
    verifyPublic(
      config.origin,
      versionId,
      {},
      (origin, version) => publicChecks(origin, version, fetcher),
      async (milliseconds) => {
        assert.equal(milliseconds, 5000);
        waits++;
      },
    ),
    (error) =>
      error instanceof PublicCheckError &&
      error.retryable &&
      error.message.includes(`expected ${versionId}; observed ${oldVersion}`),
  );
  assert.equal(healthRequests, 12);
  assert.equal(waits, 11);
});
test('live rollback validates relational records read-only and withholds private failures without reversing SQL', async () => {
  const statements = [];
  let released = false,
    ended = false;
  const connection = {
    query: async (sql) => {
      statements.push(sql);
      if (sql.startsWith('SELECT user_id')) throw new Error('Unexpected document scan.');
      return { rows: [] };
    },
    release: () => {
      released = true;
    },
  };
  const load = async () => ({
    currentSchema: async () => 'public',
    migrationHistory: async () => manifest.migrations,
    createDatabase: () => ({
      connect: async () => connection,
      end: async () => {
        ended = true;
      },
    }),
    storageGeneration: 'relational-v1',
    validatePersistedRecords: async (client, schema) => {
      assert.equal(client, connection);
      assert.equal(schema, 'public');
      throw new Error('private incompatible record content');
    },
  });
  await assert.rejects(
    validateLiveRollback({ directory: work, manifest }, { directory: work, manifest }, load),
    /private details withheld/,
  );
  assert(statements[0].includes('READ ONLY'));
  assert(statements.includes('ROLLBACK'));
  assert(released && ended);
  assert(!statements.some((sql) => /INSERT|UPDATE|DELETE|ALTER/.test(sql)));
});
test('bootstrap validates all required bindings before any production mutation', async () => {
  const f = fixture();
  f.github.baseline = async () => null;
  Object.assign(f.payload, {
    bootstrap: true,
    baselineId: null,
    qualification: {
      ...report,
      bootstrap: true,
      previousDigest: null,
      previousGeneration: null,
      recovery: 'bootstrap',
    },
  });
  const before = process.env.CORNER_WORKER_SECRETS_JSON;
  delete process.env.CORNER_WORKER_SECRETS_JSON;
  try {
    await assert.rejects(promote(f.options), /Bootstrap requires/);
    assert.deepEqual(f.effects, []);
  } finally {
    if (before === undefined) delete process.env.CORNER_WORKER_SECRETS_JSON;
    else process.env.CORNER_WORKER_SECRETS_JSON = before;
  }
});
test('first bootstrap recovers from transient public failure without migrating or deploying again', async () => {
  const f = fixture();
  f.github.baseline = async () => null;
  Object.assign(f.payload, {
    bootstrap: true,
    baselineId: null,
    qualification: {
      ...report,
      bootstrap: true,
      previousDigest: null,
      previousGeneration: null,
      recovery: 'bootstrap',
    },
  });
  const before = {
    database: process.env.DATABASE_URL,
    worker: process.env.CORNER_WORKER_SECRETS_JSON,
  };
  process.env.DATABASE_URL = 'postgresql://synthetic.invalid/unused';
  process.env.CORNER_WORKER_SECRETS_JSON = JSON.stringify({
    DATABASE_URL: process.env.DATABASE_URL,
    NEON_AUTH_BASE_URL: 'https://auth.example.invalid/neondb/auth',
    retainedOpaqueConfiguration: { encrypted: 'synthetic-preserved-bytes' },
  });
  const retainedSecretsJson = process.env.CORNER_WORKER_SECRETS_JSON;
  const invocations = [];
  f.options.execute = (binary, args) => {
    invocations.push(args);
    if (args.includes('--secrets-file')) {
      assert.deepEqual(JSON.parse(readFileSync(args[args.indexOf('--secrets-file') + 1], 'utf8')), {
        DATABASE_URL: process.env.DATABASE_URL,
        NEON_AUTH_BASE_URL: 'https://auth.example.invalid/neondb/auth',
      });
      assert.equal(process.env.CORNER_WORKER_SECRETS_JSON, retainedSecretsJson);
    }
    f.effects.push(args.includes('--apply') ? 'migrate' : 'deploy');
    return `Current Version ID: ${versionId}`;
  };
  try {
    const cf = f.options.cf;
    f.options.cf = async () => ({ bindings: [] });
    await assert.rejects(promote(f.options), /Bootstrap Worker already exists/);
    assert.deepEqual(f.effects, []);
    f.options.cf = cf;
    f.options.checkPublic = async () => {
      throw new Error('transient public failure');
    };
    await assert.rejects(promote(f.options), /transient public failure/);
    const deployed = { id: 22, payload: f.records.at(-1) };
    assert.equal(deployed.payload.phase, 'deployed');
    assert.equal(f.state('schema-attempted'), 'success');
    assert.equal(f.state('deployed'), 'failure');
    f.github.baseline = async () => deployed;
    f.github.schema = async () => ({ id: 21, payload: f.records[0] });
    const retry = { ...f.options, deploymentId: String(deployed.id) };
    const invocationCount = invocations.length;
    await assert.rejects(complete(retry), /transient public failure/);
    assert.equal(f.records.at(-1).phase, 'deployed');
    retry.checkPublic = async (origin, version) => {
      assert.equal(origin, config.origin);
      assert.equal(version, versionId);
      f.effects.push('public');
    };
    const result = await complete(retry);
    assert.equal(result.payload.phase, 'complete');
    assert.equal(f.state('deployed'), 'inactive');
    assert.equal(f.state('public-passed'), 'inactive');
    assert.equal(f.state('complete'), 'success');
    assert.equal(invocations.length, invocationCount);
    f.github.baseline = async () => result;
    await plan({
      github: f.github,
      runId: '1',
      sourceSha: source,
      configuration,
      work,
      qualify: async () => ({ ...report, previousDigest: candidateDigest }),
    });
    assert(f.effects.indexOf('migrate') < f.effects.indexOf('deploy'));
    assert(invocations[1].includes('--secrets-file'));
    assert(invocations[1].includes('--no-bundle'));
    assert(!invocations.some((args) => args.includes('upload')));
    assert(f.effects.indexOf('public') < f.effects.indexOf('complete'));
  } finally {
    if (before.database === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = before.database;
    if (before.worker === undefined) delete process.env.CORNER_WORKER_SECRETS_JSON;
    else process.env.CORNER_WORKER_SECRETS_JSON = before.worker;
  }
});

test('completion retries support public-passed receipts and rollback schema journals', async () => {
  for (const rollback of [false, true]) {
    const f = fixture();
    const p = {
      ...f.payload,
      phase: 'public-passed',
      versionId,
      planId: '11',
      rollback,
      schemaId: '21',
    };
    f.github.baseline = async () => ({ id: 22, payload: p });
    f.github.schema = async () => ({
      id: 21,
      payload: rollback ? receipt : { ...p, phase: 'schema-attempted' },
    });
    f.effects.push('deploy');
    const result = await complete({ ...f.options, deploymentId: '22' });
    assert.equal(result.payload.phase, 'complete');
    assert.deepEqual(f.effects, ['deploy', 'public', 'public-passed', 'complete']);
  }
});

test('completion retry rejects stale identities, changed artifacts, schema/configuration and live drift', async (t) => {
  for (const scenario of [
    'receipt',
    'phase',
    'artifact',
    'configuration',
    'schema',
    'live',
    'probe-drift',
    'schema-drift',
    'rollback-schema',
  ]) {
    await t.test(scenario, async () => {
      const f = fixture();
      const p = { ...f.payload, phase: 'deployed', versionId, planId: '11' };
      f.github.baseline = async () => ({ id: 22, payload: p });
      f.github.schema = async () => ({ id: 21, payload: { ...p, phase: 'schema-attempted' } });
      f.effects.push('deploy');
      const options = { ...f.options, deploymentId: '22' };
      if (scenario === 'receipt') options.deploymentId = '23';
      if (scenario === 'phase') p.phase = 'complete';
      if (scenario === 'artifact') p.configurationSha256 = 'f'.repeat(64);
      if (scenario === 'configuration') p.runtimeConfigurationDigest = 'f'.repeat(64);
      if (scenario === 'schema')
        f.github.schema = async () => ({ id: 23, payload: { ...p, planId: '12' } });
      if (scenario === 'live') options.cf = async () => ({ deployments: [] });
      if (scenario === 'probe-drift')
        options.checkPublic = async () => {
          f.github.baseline = async () => ({ id: 23, payload: p });
        };
      if (scenario === 'schema-drift')
        options.checkPublic = async () => {
          f.github.schema = async () => ({ id: 23, payload: p });
        };
      if (scenario === 'rollback-schema') Object.assign(p, { rollback: true, schemaId: '20' });
      await assert.rejects(
        complete(options),
        /exact current|artifact changed|configuration differs|schema journal|traffic does not match|Stale plan/,
      );
      assert.deepEqual(f.records, []);
    });
  }
});

test('explicit adoption pins the existing Worker before migration and again before deployment', async (t) => {
  const before = {
    database: process.env.DATABASE_URL,
    worker: process.env.CORNER_WORKER_SECRETS_JSON,
  };
  process.env.DATABASE_URL = 'postgresql://synthetic.invalid/unused';
  process.env.CORNER_WORKER_SECRETS_JSON = JSON.stringify({
    DATABASE_URL: process.env.DATABASE_URL,
    NEON_AUTH_BASE_URL: 'https://auth.example.invalid/neondb/auth',
  });
  try {
    for (const scenario of ['changed-before-migration', 'changed-during-migration', 'stable']) {
      await t.test(scenario, async () => {
        const f = fixture();
        f.github.baseline = async () => null;
        Object.assign(f.payload, {
          bootstrap: true,
          provisionedVersionId: oldVersion,
          baselineId: null,
          qualification: {
            ...report,
            bootstrap: true,
            previousDigest: null,
            previousGeneration: null,
            recovery: 'bootstrap',
          },
        });
        f.options.cf = async (path) => {
          if (path.endsWith('/settings')) return { bindings: [] };
          const drift =
            scenario === 'changed-before-migration' ||
            (scenario === 'changed-during-migration' && f.effects.includes('migrate'));
          return {
            deployments: [
              {
                versions: [
                  {
                    version_id: f.effects.includes('deploy') || drift ? versionId : oldVersion,
                    percentage: 100,
                  },
                ],
              },
            ],
          };
        };
        f.options.execute = (_binary, args) => {
          f.effects.push(args.includes('--apply') ? 'migrate' : 'deploy');
          return `Current Version ID: ${versionId}`;
        };
        if (scenario === 'stable') {
          const result = await promote(f.options);
          assert.equal(result.payload.versionId, versionId);
          assert.equal(result.payload.phase, 'complete');
          assert(f.effects.indexOf('migrate') < f.effects.indexOf('deploy'));
          assert(f.effects.indexOf('public') < f.effects.indexOf('complete'));
        } else {
          await assert.rejects(promote(f.options), /Provisioned Worker changed/);
          assert(!f.effects.includes('deploy'));
          assert(!f.effects.includes('public'));
          if (scenario === 'changed-before-migration') assert.deepEqual(f.records, []);
          else assert.equal(f.records.at(-1)?.phase, 'schema-attempted');
        }
      });
    }
  } finally {
    if (before.database === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = before.database;
    if (before.worker === undefined) delete process.env.CORNER_WORKER_SECRETS_JSON;
    else process.env.CORNER_WORKER_SECRETS_JSON = before.worker;
  }
});
test('missing inherited secret bindings and live version drift block before migration', async () => {
  const f = fixture();
  f.options.cf = async (path) =>
    path.endsWith('/settings')
      ? { bindings: [] }
      : {
          deployments: [
            {
              versions: [
                {
                  version_id: oldVersion,
                  percentage: 100,
                },
              ],
            },
          ],
        };
  await assert.rejects(promote(f.options), /missing required/);
  assert.deepEqual(f.effects, []);
  f.options.cf = async () => ({
    deployments: [{ versions: [{ version_id: versionId, percentage: 100 }] }],
  });
  await assert.rejects(promote(f.options), /drifted/);
  assert.deepEqual(f.effects, []);
});
test('explicit rollback qualifies completed target against current attempted schema artifact, not invented baseline', async () => {
  const f = fixture();
  f.github.baseline = async () => ({
    id: 10,
    payload: { ...receipt, sourceSha: source, candidateDigest, qualification: report },
  });
  f.github.schema = async () => ({ id: 30, payload: { ...f.payload, phase: 'schema-attempted' } });
  f.github.api = async () => ({
    id: 9,
    environment: 'production',
    task: 'corner-release',
    payload: receipt,
  });
  let qualified;
  const result = await plan({
    ...f.options,
    rollbackId: '9',
    qualify: async (options) => {
      qualified = options;
      return report;
    },
  });
  assert.equal(qualified.candidate, join(work, source));
  assert.equal(qualified.previous, join(work, previousSource));
  assert.equal(result.payload.schemaId, '30');
  assert.equal(result.payload.rollbackVersionId, oldVersion);
  assert.equal(result.payload.candidateDigest, previousDigest);
  assert.equal(result.payload.qualification.candidateDigest, candidateDigest);
  assert.equal(result.payload.targetQualification.candidateDigest, previousDigest);
  f.github.api = async () => ({
    id: 9,
    environment: 'production',
    task: 'corner-release',
    payload: { ...receipt, phase: 'public-passed' },
  });
  await assert.rejects(plan({ ...f.options, rollbackId: '9' }), /completed qualification/);
});
test('explicit rollback completes only after live data validation and public checks', async () => {
  for (const failPublic of [false, true]) {
    const f = fixture();
    const current = { ...receipt, sourceSha: source, candidateDigest, qualification: report };
    f.github.baseline = async () => ({ id: 10, payload: current });
    Object.assign(f.payload, {
      sourceSha: previousSource,
      candidateDigest: previousDigest,
      rollback: true,
      rollbackVersionId: oldVersion,
      targetQualification: receipt.qualification,
    });
    const directory = await mkdtemp(join(work, 'rollback-'));
    const migrationEntry = 'migrate.mjs';
    await writeFile(
      join(directory, migrationEntry),
      `
      export const currentSchema = async () => 'public';
      export const migrationHistory = async () => {};
      export const storageGeneration = 'relational-v1';
      export const validatePersistedRecords = async () => {};
      export const createDatabase = () => ({
        connect: async () => ({
          query: async () => ({ rows: [{ user_id: 'owner', data: '{"saved":true}' }] }),
          release() {},
        }),
        async end() {},
      });
    `,
    );
    await writeFile(join(directory, manifest.configurationEntry), JSON.stringify(packagedConfig));
    const artifact = f.github.artifact;
    f.github.artifact = async (...args) => {
      const result = await artifact(...args);
      return { ...result, directory, manifest: { ...result.manifest, migrationEntry } };
    };
    f.options.verify = async () => ({ digest: previousDigest });
    f.options.qualify = async () => report;
    f.options.cf = async (path) =>
      path.endsWith('/settings')
        ? {
            bindings: ['DATABASE_URL', 'NEON_AUTH_BASE_URL'].map((name) => ({
              name,
              type: 'secret_text',
            })),
          }
        : { deployments: [{ versions: [{ version_id: oldVersion, percentage: 100 }] }] };
    if (failPublic) {
      f.options.checkPublic = async () => {
        throw new Error('public probe failed');
      };
      await assert.rejects(promote(f.options), /public probe failed/);
      assert.equal(f.records.at(-1).phase, 'deployed');
      assert(!f.effects.includes('complete'));
    } else {
      const result = await promote(f.options);
      assert.equal(result.payload.phase, 'complete');
      assert.equal(result.payload.versionId, oldVersion);
      assert(f.effects.indexOf('public') < f.effects.indexOf('complete'));
    }
    assert(!f.effects.includes('migrate'));
    assert(!f.effects.includes('upload'));
  }
});

test('normal promotion preserves fixed-SHA forward-only comparison without per-file classification', async () => {
  for (const status of ['ahead', 'behind', 'diverged', 'identical']) {
    const f = fixture();
    const api = f.github.api;
    f.github.api = async (path) => {
      if (path.startsWith('compare/')) {
        assert.equal(path, `compare/${previousSource}...${source}`);
        return { status };
      }
      return api(path);
    };
    const options = { ...f.options, runId: '1', sourceSha: source, qualify: async () => report };
    if (status === 'ahead') assert.equal((await plan(options)).payload.phase, 'planned');
    else {
      await assert.rejects(plan(options), /forward source change/);
      assert.deepEqual(f.records, []);
    }
  }
});
test('archive digest mismatch fails before unpacking or executing artifacts', async () => {
  const github = new GitHub({ repository: 'owner/corner', token: 'synthetic' });
  github.api = async (path) => {
    if (path.startsWith('actions/runs')) return run;
    if (path.endsWith('/zip')) return Buffer.from('not an archive and must never reach unzip');
    return {
      id: 2,
      expired: false,
      name: `corner-release-${source}`,
      workflow_run: { id: 1, head_sha: source },
      digest: `sha256:${'0'.repeat(64)}`,
    };
  };
  await assert.rejects(
    github.artifact({ runId: '1', artifactId: '2', sourceSha: source }, work),
    /archive digest/,
  );
});
test('post-upload payload changes block before migrations or traffic changes', async () => {
  const f = fixture();
  f.options.verify = async () => ({ digest: previousDigest });
  await assert.rejects(promote(f.options), /Immutable payload changed/);
  assert.deepEqual(f.effects, ['upload']);
});

test('public readiness reaches the candidate before security probes and rejects obsolete REST errors without retry', async () => {
  const requests = [];
  let native = true;
  let waits = 0;
  const fetcher = async (url, options = {}) => {
    const path = new URL(url).pathname;
    requests.push(path);
    if (path === '/api/health')
      return Response.json(
        { ok: true },
        { headers: { 'X-Corner-Version': waits ? versionId : oldVersion } },
      );
    if (path.includes('sign-up'))
      return Response.json({ code: 'ORIGIN_NOT_ALLOWED' }, { status: 403 });
    if (path === '/api/rpc/workspace/get') {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Origin, config.origin);
      assert.deepEqual(JSON.parse(options.body), {});
      return Response.json(
        native
          ? {
              json: {
                defined: true,
                code: 'SIGN_IN_REQUIRED',
                status: 401,
                message: 'Sign in required',
              },
            }
          : { code: 'SIGN_IN_REQUIRED' },
        { status: 401 },
      );
    }
    if (path === '/.env' || path === '/assets/not-found.js')
      return new Response(null, { status: 404 });
    if (path === '/assets/app.js')
      return new Response('export {};', { headers: { 'Cache-Control': 'public, immutable' } });
    return new Response('<script src="/assets/app.js"></script>', {
      headers: { 'Content-Security-Policy': "frame-ancestors 'none'" },
    });
  };
  const check = (origin, version) => publicChecks(origin, version, fetcher);
  const wait = async () => {
    waits++;
  };
  await verifyPublic(config.origin, versionId, {}, check, wait);
  assert.deepEqual(requests.slice(0, 3), ['/api/health', '/api/health', '/api/auth/sign-up/email']);
  assert.equal(waits, 1);
  assert.equal(requests.includes('/api/state'), false);
  native = false;
  await assert.rejects(
    verifyPublic(config.origin, versionId, {}, check, wait),
    /RPC authentication/,
  );
  assert.equal(waits, 1);
});

test('shared CI loader binds branch, repository, run and retained artifact before unpacking', async () => {
  for (const branch of ['main', 'staging']) {
    const validRun = { ...run, head_branch: branch };
    const reference = { runId: '1', artifactId: '2', sourceSha: source };
    const invoke = (candidateRun, artifact = {}) =>
      loadCiArtifact({
        api: async (path) => (path.startsWith('actions/runs/') ? candidateRun : artifact),
        repository: 'owner/corner',
        branch,
        reference,
        destination: work,
      });
    for (const mutation of [
      { event: 'pull_request' },
      { head_branch: 'feature' },
      { conclusion: 'failure' },
      { status: 'in_progress' },
      { head_sha: previousSource },
      { id: 9 },
      { path: '.github/workflows/other.yml' },
    ])
      await assert.rejects(invoke({ ...validRun, ...mutation }), /successful exact/);
    await assert.rejects(
      invoke({
        ...validRun,
        head_repository: { full_name: 'foreign/corner' },
      }),
      /Foreign/,
    );
    await assert.rejects(
      invoke(validRun, {
        id: 2,
        expired: false,
        name: `corner-release-${source}`,
        workflow_run: { id: 9, head_sha: source },
      }),
      /provenance/,
    );
    await assert.rejects(
      invoke(validRun, {
        id: 2,
        expired: true,
        name: `corner-release-${source}`,
        workflow_run: { id: 1, head_sha: source },
      }),
      /expired/,
    );
  }
});

test('pre-Drizzle production receipts are never recovery targets', () => {
  for (const format of [1, 2, 3]) {
    assert.throws(() => validateReceipt({ ...receipt, format }));
    assert.throws(() => rollbackEligible({ ...receipt, format }, receipt, report, config.digest));
  }
});

test('production permits only the exact stable corner Worker hostname and binds configured origin', () => {
  const settings = JSON.stringify({
    CORNER_ORIGIN: 'https://corner.account.workers.dev',
    NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
  });
  const before = process.env.CORNER_PRODUCTION_ORIGIN;
  try {
    delete process.env.CORNER_PRODUCTION_ORIGIN;
    assert.equal(validateConfiguration(settings).workersDev, true);
    process.env.CORNER_PRODUCTION_ORIGIN = 'https://corner.other.workers.dev';
    assert.throws(() => validateConfiguration(settings), /canonical release origin/);
    delete process.env.CORNER_PRODUCTION_ORIGIN;
    for (const hostname of [
      'staging-corner.account.workers.dev',
      'abc-corner.account.workers.dev',
      'corner.other.account.workers.dev',
    ]) {
      assert.throws(
        () => validateConfiguration(settings.replace('corner.account.workers.dev', hostname)),
        /Release requires/,
      );
    }
  } finally {
    if (before === undefined) delete process.env.CORNER_PRODUCTION_ORIGIN;
    else process.env.CORNER_PRODUCTION_ORIGIN = before;
  }
});

test('dual-origin configuration requires an exact HTTPS root/app pair without changing historical digests', async () => {
  const settings = {
    CORNER_ORIGIN: 'https://app.example.com',
    CORNER_LANDING_ORIGIN: 'https://example.com',
    NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
  };
  const configured = validateConfiguration(JSON.stringify(settings));
  assert.equal(configured.landingOrigin, settings.CORNER_LANDING_ORIGIN);
  for (const landing of [
    'https://app.example.com',
    'http://example.com',
    'https://example.com:444',
    'https://other.example.com',
    'https://example.com/',
    'https://user@example.com',
    'https://corner.account.workers.dev',
  ])
    assert.throws(() =>
      validateConfiguration(JSON.stringify({ ...settings, CORNER_LANDING_ORIGIN: landing })),
    );
  const f = fixture();
  const artifact = f.github.artifact;
  f.github.artifact = async (...args) => {
    const candidate = await artifact(...args);
    return {
      ...candidate,
      manifest: { ...candidate.manifest, files: { 'assets/landing/index.html': 'a'.repeat(64) } },
    };
  };
  await assert.rejects(promote(f.options), /requires CORNER_LANDING_ORIGIN/);
  assert.deepEqual(f.effects, []);
  assert.deepEqual(publicCheckOptions({ manifest }, config), {});
});

test('single-site artifacts cannot qualify dual-origin release plans', async () => {
  const f = fixture({
    configuration: JSON.stringify({
      CORNER_ORIGIN: 'https://app.example.com',
      CORNER_LANDING_ORIGIN: 'https://example.com',
      NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
    }),
  });
  let qualifications = 0;
  await assert.rejects(
    plan({
      ...f.options,
      runId: '1',
      sourceSha: source,
      qualify: async () => {
        qualifications++;
        return report;
      },
    }),
  );
  assert.equal(qualifications, 0);
  assert.deepEqual(f.effects, []);
});

test('same-generation single-site to dual-origin plans remain supported', async () => {
  const f = fixture({
    configuration: JSON.stringify({
      CORNER_ORIGIN: 'https://app.example.com',
      CORNER_LANDING_ORIGIN: 'https://example.com',
      NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
    }),
    qualify: async () => report,
  });
  const artifact = f.github.artifact;
  f.github.artifact = async (reference) => {
    const result = await artifact(reference);
    if (reference.sourceSha === source)
      result.manifest.files = { 'assets/landing/index.html': 'a'.repeat(64) };
    return result;
  };
  await plan({ ...f.options, runId: '1', sourceSha: source });
  assert.deepEqual(f.effects, ['planned']);
  assert.equal(f.records[0].qualification.recovery, 'compatible');
});

test('dual-origin public and maintenance probes exercise fixed redirects and root isolation over HTTP', async (t) => {
  let maintenance = false;
  let defect;
  let appOrigin;
  let landingVersion = versionId;
  let landingCookies = [];
  const independentLandingVersion = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    requests.push({ origin: url.origin, path: url.pathname, headers: request.headers });
    response.setHeader('X-Corner-Version', versionId);
    response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    response.setHeader('Cache-Control', 'no-store');
    const send = (status, body = '') => {
      response.statusCode = status;
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (url.hostname === 'localhost') {
      response.setHeader('X-Corner-Version', landingVersion);
      if (landingCookies.length) response.setHeader('Set-Cookie', landingCookies);
      if (defect === 'cookie') response.setHeader('Set-Cookie', 'session=unexpected');
      if (url.pathname === '/') {
        if (defect === 'unavailable') return send(503);
        if (defect === 'page-redirect') {
          response.setHeader('Location', 'https://external.invalid');
          return send(302);
        }
        if (defect === 'csp') response.removeHeader('Content-Security-Policy');
        const asset =
          defect === 'external-asset'
            ? 'https://external.invalid/_astro/landing.css'
            : '/_astro/landing.css';
        return send(200, `<a href="/open-app">Open</a><link href="${asset}" rel="stylesheet">`);
      }
      if (url.pathname === '/_astro/landing.css') {
        response.setHeader('Cache-Control', 'public, immutable');
        return send(200, 'body{}');
      }
      if (url.pathname === '/open-app') {
        response.setHeader(
          'Location',
          defect === 'redirect' ? 'https://external.invalid' : appOrigin,
        );
        return send(302);
      }
      return send(defect === 'root-api' && url.pathname === '/api/health' ? 200 : 404);
    }
    if (maintenance) {
      response.setHeader('Retry-After', '60');
      return send(
        503,
        url.pathname.startsWith('/api/rpc/')
          ? {
              json: {
                defined: true,
                code: 'SERVICE_UNAVAILABLE',
                status: 503,
                data: { code: 'MAINTENANCE_ACTIVE' },
              },
            }
          : { ok: false, maintenance: true, code: 'MAINTENANCE_ACTIVE' },
      );
    }
    if (url.pathname === '/api/health') return send(200, { ok: true });
    if (url.pathname === '/api/auth/sign-up/email')
      return send(403, { code: 'ORIGIN_NOT_ALLOWED' });
    if (url.pathname === '/api/rpc/workspace/get')
      return send(401, { json: { defined: true, code: 'SIGN_IN_REQUIRED', status: 401 } });
    if (url.pathname === '/assets/app.js') {
      response.setHeader('Cache-Control', 'public, immutable');
      return send(200, 'export {};');
    }
    if (['/', '/account/reset-password'].includes(url.pathname))
      return send(200, '<script src="/assets/app.js"></script>');
    return send(404);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  appOrigin = `http://127.0.0.1:${port}`;
  const options = {
    landingOrigin: `http://localhost:${port}`,
    'CF-Access-Client-Id': 'synthetic-id',
    'CF-Access-Client-Secret': 'synthetic-secret',
  };
  await publicChecks(appOrigin, versionId, fetch, options);
  assert.equal(requests.filter((r) => r.origin === appOrigin && r.path === '/').length, 1);
  assert.equal(requests.filter((r) => r.path === '/open-app').length, 2);
  for (const request of requests) {
    assert([appOrigin, options.landingOrigin].includes(request.origin));
    assert.equal(request.headers['cf-access-client-id'], options['CF-Access-Client-Id']);
    assert.equal(request.headers['cf-access-client-secret'], options['CF-Access-Client-Secret']);
  }
  const accessCookie = 'CF_Authorization=synthetic-access-session; Path=/; Secure; HttpOnly';
  landingCookies = [accessCookie];
  await publicChecks(appOrigin, versionId, fetch, options);
  const cookieRejected = (error) => error instanceof PublicCheckError && !error.retryable;
  for (const credentials of [
    {},
    { 'CF-Access-Client-Id': options['CF-Access-Client-Id'] },
    { 'CF-Access-Client-Secret': options['CF-Access-Client-Secret'] },
  ])
    await assert.rejects(
      publicChecks(appOrigin, versionId, fetch, {
        landingOrigin: options.landingOrigin,
        ...credentials,
      }),
      cookieRejected,
    );
  landingCookies = [accessCookie, 'session=unexpected; Path=/; Secure; HttpOnly'];
  await assert.rejects(publicChecks(appOrigin, versionId, fetch, options), cookieRejected);
  landingCookies = [];
  landingVersion = independentLandingVersion;
  const retryableIdentity = (error) =>
    error instanceof PublicCheckError && error.retryable && /version identity/.test(error.message);
  // Without an override, production must still require the app's identity on the landing page.
  await assert.rejects(publicChecks(appOrigin, versionId, fetch, options), retryableIdentity);
  options.landingVersionId = independentLandingVersion;
  await publicChecks(appOrigin, versionId, fetch, options);
  landingVersion = versionId;
  await assert.rejects(publicChecks(appOrigin, versionId, fetch, options), retryableIdentity);
  const check = (origin, version, fetcher, access) => publicChecks(origin, version, fetch, access);
  let waits = 0;
  await verifyPublic(appOrigin, versionId, options, check, async (milliseconds) => {
    assert.equal(milliseconds, 5000);
    waits++;
    landingVersion = independentLandingVersion;
  });
  assert.equal(waits, 1);
  defect = 'unavailable';
  await verifyPublic(appOrigin, versionId, options, check, async () => {
    waits++;
    defect = undefined;
  });
  assert.equal(waits, 2);
  landingVersion = versionId;
  await assert.rejects(
    verifyPublic(appOrigin, versionId, options, check, async () => {
      waits++;
    }),
    retryableIdentity,
  );
  assert.equal(waits, 13);
  landingVersion = independentLandingVersion;
  for (const [failure, expected] of [
    ['external-asset', /remain same-origin/],
    ['redirect', /configured app origin/],
    ['cookie', /must not set application cookies/],
    ['root-api', /dynamic\/private path boundary/],
    ['csp', /security boundary/],
    ['page-redirect', /page unavailable/],
  ]) {
    defect = failure;
    const before = waits;
    await assert.rejects(
      verifyPublic(appOrigin, versionId, options, check, async () => {
        waits++;
      }),
      (error) =>
        error instanceof PublicCheckError && !error.retryable && expected.test(error.message),
    );
    assert.equal(waits, before);
  }
  defect = undefined;
  maintenance = true;
  landingCookies = [accessCookie];
  await maintenanceChecks(appOrigin, versionId, fetch, options);
  landingVersion = versionId;
  await assert.rejects(maintenanceChecks(appOrigin, versionId, fetch, options), retryableIdentity);
  delete options.landingVersionId;
  await maintenanceChecks(appOrigin, versionId, fetch, options);
});

test('public probes never forward Access credentials to an external page asset', async () => {
  const access = {
    'CF-Access-Client-Id': 'synthetic-id',
    'CF-Access-Client-Secret': 'synthetic-secret',
  };
  const fetcher = async (url, options) => {
    assert.equal(new URL(url).origin, config.origin);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['CF-Access-Client-Id'], access['CF-Access-Client-Id']);
    assert.equal(options.headers['CF-Access-Client-Secret'], access['CF-Access-Client-Secret']);
    const path = new URL(url).pathname;
    if (path === '/api/health')
      return Response.json({ ok: true }, { headers: { 'X-Corner-Version': versionId } });
    if (path.includes('sign-up'))
      return Response.json({ code: 'ORIGIN_NOT_ALLOWED' }, { status: 403 });
    if (path.includes('/api/rpc/'))
      return Response.json(
        { json: { defined: true, code: 'SIGN_IN_REQUIRED', status: 401 } },
        { status: 401 },
      );
    if (path === '/.env' || path === '/assets/not-found.js')
      return new Response(null, { status: 404 });
    return new Response('<script src="https://external.invalid/app.js"></script>', {
      headers: { 'Content-Security-Policy': "frame-ancestors 'none'" },
    });
  };
  await assert.rejects(
    publicChecks(config.origin, versionId, fetcher, access),
    /same-origin asset/,
  );
});

test('single runtime traffic-switch failure never records a deployed receipt', async () => {
  const f = fixture();
  const execute = f.options.execute;
  f.options.execute = (binary, args, options) => {
    if (args.includes('deploy')) throw new Error('runtime switch failed');
    return execute(binary, args, options);
  };
  await assert.rejects(promote(f.options), /runtime switch failed/);
  assert.equal(f.records.at(-1).phase, 'schema-attempted');
  assert(!f.records.some((row) => ['deployed', 'public-passed', 'complete'].includes(row.phase)));
});

function cutoverFixture({
  dbPhase = 'untouched',
  operationId = 'cutover-prod-2026-10-27',
  overrides = {},
} = {}) {
  const f = fixture(overrides);
  let currentDbPhase = dbPhase;
  let liveVersion = oldVersion;
  const preservingReport = {
    ...report,
    previousGeneration: 'document-v1',
    recovery: 'preserving',
  };
  f.payload.preservingCutover = true;
  f.payload.operationId = operationId;
  f.payload.qualification = preservingReport;
  const documentBaseline = {
    ...receipt,
    qualification: {
      ...report,
      sourceSha: previousSource,
      candidateDigest: previousDigest,
      generation: 'document-v1',
      previousGeneration: null,
      bootstrap: true,
      recovery: 'bootstrap',
    },
  };
  f.github.baseline = async () => {
    const latestProd = [...f.records]
      .reverse()
      .find((row) => ['deployed', 'public-passed', 'complete'].includes(row.phase));
    if (latestProd) {
      return {
        id: 21 + f.records.lastIndexOf(latestProd),
        payload: latestProd,
      };
    }
    return { id: 10, payload: documentBaseline };
  };
  f.github.schema = async () => {
    const latestSchema = [...f.records].reverse().find((row) => row.phase === 'schema-attempted');
    return latestSchema
      ? { id: 21 + f.records.lastIndexOf(latestSchema), payload: latestSchema }
      : null;
  };
  f.github.maintenance = async () => {
    const latestMaint = [...f.records]
      .reverse()
      .find((row) =>
        [
          'maintenance-uploaded',
          'maintenance-active',
          'cutover-validated',
          'maintenance-complete',
          'maintenance-aborted',
        ].includes(row.phase),
      );
    if (!latestMaint) return null;
    validateMaintenanceReceipt(latestMaint);
    return { id: 21 + f.records.lastIndexOf(latestMaint), payload: latestMaint };
  };
  const origApi = f.github.api;
  f.github.api = async (path) => {
    if (path === 'deployments/10')
      return { id: 10, environment: 'production', payload: documentBaseline };
    return origApi(path);
  };
  f.github.artifact = async (reference) => ({
    generation: reference.sourceSha === source ? 'relational-v1' : 'document-v1',
    directory: join(work, reference.sourceSha),
    manifest: {
      ...manifest,
      sourceSha: reference.sourceSha,
      maintenanceWorkerEntry: 'worker/maintenance-worker.js',
      files: {
        'worker/worker.js': 'f'.repeat(64),
        'worker/maintenance-worker.js': 'e'.repeat(64),
      },
    },
    digest: reference.sourceSha === source ? candidateDigest : previousDigest,
    qualification:
      reference.sourceSha === source ? preservingReport : documentBaseline.qualification,
  });
  let uploadCount = 0;
  f.options.execute = (binary, args) => {
    if (args.includes('upload')) {
      uploadCount += 1;
      const uploaded = uploadCount === 1 ? maintenanceVersionId : versionId;
      f.effects.push(`upload:${uploaded === maintenanceVersionId ? 'maintenance' : 'candidate'}`);
      return `Worker Version ID: ${uploaded}\n`;
    }
    if (args.includes('--inspect-cutover')) {
      f.effects.push(`inspect:${currentDbPhase}`);
      return `${JSON.stringify({
        phase: currentDbPhase,
        operationId: currentDbPhase === 'untouched' ? null : operationId,
      })}\n`;
    }
    if (args.includes('--preserving-cutover')) {
      f.effects.push('preserving-cutover');
      currentDbPhase = 'completed';
      return `${JSON.stringify({ phase: 'completed', operationId })}\n`;
    }
    if (args.includes('deploy')) {
      const spec = args.find((arg) => arg.endsWith('@100%'));
      liveVersion = spec.slice(0, -5);
      f.effects.push(
        `deploy:${liveVersion === maintenanceVersionId ? 'maintenance' : liveVersion === versionId ? 'candidate' : 'original'}`,
      );
      return '';
    }
    throw new Error(`Unexpected command: ${binary} ${args.join(' ')}`);
  };
  f.options.cf = async (path, { missing = false } = {}) => {
    if (missing) return null;
    if (path.endsWith('/settings'))
      return {
        bindings: ['DATABASE_URL', 'NEON_AUTH_BASE_URL'].map((name) => ({
          name,
          type: 'secret_text',
        })),
      };
    return {
      deployments: [{ versions: [{ version_id: liveVersion, percentage: 100 }] }],
    };
  };
  f.options.qualify = async () => preservingReport;
  f.options.checkMaintenance = async () => {
    f.effects.push('maintenance-checked');
  };
  f.setDbPhase = (next) => {
    currentDbPhase = next;
  };
  f.setLiveVersion = (next) => {
    liveVersion = next;
  };
  f.getLiveVersion = () => liveVersion;
  const migrationFile = join(work, source, manifest.migrationEntry);
  return {
    ...f,
    preservingReport,
    operationId,
    setupMigratorFile: async (customCode) => {
      await mkdir(dirname(migrationFile), { recursive: true });
      await writeFile(
        migrationFile,
        customCode ??
          `export const storageGeneration = 'relational-v1';
export function createDatabase() {
  let checkedOut = false;
  return {
    __isPool: true,
    async connect() {
      if (checkedOut) throw new Error('Pool max 1 deadlock');
      checkedOut = true;
      return {
        async query() { return { rows: [] }; },
        release() { checkedOut = false; },
      };
    },
    async end() {},
  };
}
export function directDatabaseUrl(u) { return u; }
export async function currentSchema() { return 'public'; }
export async function migrationHistory() {}
export async function validatePersistedRecords() {}
export async function inspectDocumentCutover(pool, opId) {
  if (!pool || !pool.__isPool) throw new Error('inspectDocumentCutover must receive Pool');
  const client = await pool.connect();
  client.release();
  return { phase: 'completed', operationId: opId ?? ${JSON.stringify(operationId)} };
}
`,
      );
    },
  };
}

test('preserving plan and promotion require serving code that supports the requested origin topology', async () => {
  const configuration = JSON.stringify({
    CORNER_ORIGIN: 'https://app.example.com',
    CORNER_LANDING_ORIGIN: 'https://example.com',
    NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
  });
  const configured = validateConfiguration(configuration);
  const f = cutoverFixture({ overrides: { configuration } });
  f.payload.origin = configured.origin;
  f.payload.runtimeConfigurationDigest = configured.digest;
  const artifact = f.github.artifact;
  f.github.artifact = async (reference) => {
    const result = await artifact(reference);
    if (reference.sourceSha === source)
      result.manifest.files['assets/landing/index.html'] = 'a'.repeat(64);
    return result;
  };
  await assert.rejects(
    plan({
      ...f.options,
      runId: '1',
      sourceSha: source,
      preservingCutover: true,
      operationId: f.operationId,
    }),
  );
  await assert.rejects(promote(f.options));
  assert.deepEqual(f.effects, []);
});

test('automatic release never invokes preserving cutover or maintenance implicitly', async () => {
  const f = cutoverFixture();
  await assert.rejects(
    plan({
      ...f.options,
      runId: '1',
      sourceSha: source,
      automatic: true,
      preservingCutover: true,
      operationId: f.operationId,
    }),
    /Automatic production cannot bootstrap, adopt, or roll back a Worker, or run a preserving cutover/,
  );
  f.payload.automatic = true;
  await assert.rejects(
    promote({ ...f.options, automatic: true }),
    /Automatic production cannot execute an operator release plan/,
  );
});

test('preserving cutover sequences maintenance upload, gate probe, journaled cutover, candidate validation, and completion without corrupting baseline', async () => {
  const f = cutoverFixture();
  await f.setupMigratorFile();
  const planned = await plan({
    ...f.options,
    runId: '1',
    sourceSha: source,
    preservingCutover: true,
    operationId: f.operationId,
  });
  assert.equal(planned.payload.preservingCutover, true);
  assert.equal(planned.payload.operationId, f.operationId);
  assert.equal(planned.payload.qualification.recovery, 'preserving');

  const completed = await promote(f.options);
  assert.equal(completed.payload.phase, 'complete');
  assert.equal(completed.payload.versionId, versionId);
  assert.equal(f.getLiveVersion(), versionId);
  assert.deepEqual(f.effects, [
    'planned',
    'inspect:untouched',
    'upload:maintenance',
    'upload:candidate',
    'maintenance-uploaded',
    'inspect:untouched',
    'deploy:maintenance',
    'maintenance-checked',
    'maintenance-active',
    'inspect:untouched',
    'schema-attempted',
    'preserving-cutover',
    'inspect:completed',
    'cutover-validated',
    'deploy:candidate',
    'deployed',
    'public',
    'public-passed',
    'complete',
    'maintenance-complete',
  ]);
});

test('first preserving cutover run succeeds and pre-cutover abort remains allowed when a preexisting failed schema-attempted journal is pinned', async () => {
  const f = cutoverFixture();
  await f.setupMigratorFile();
  const priorFailedSchema = {
    ...receipt,
    phase: 'schema-attempted',
    planId: '9',
    sourceSha: '9'.repeat(40),
    candidateDigest: '8'.repeat(64),
  };
  let currentSchemaRecord = { id: 15, payload: priorFailedSchema };
  f.github.schema = async () => {
    const latestSchema = [...f.records].reverse().find((row) => row.phase === 'schema-attempted');
    return latestSchema
      ? { id: 21 + f.records.lastIndexOf(latestSchema), payload: latestSchema }
      : currentSchemaRecord;
  };
  const origArtifact = f.github.artifact;
  f.github.artifact = async (reference) => {
    if (reference.sourceSha === priorFailedSchema.sourceSha) {
      return {
        generation: 'relational-v1',
        directory: join(work, source),
        manifest: { ...manifest, sourceSha: reference.sourceSha },
        digest: priorFailedSchema.candidateDigest,
        qualification: f.preservingReport,
      };
    }
    return origArtifact(reference);
  };
  const planned = await plan({
    ...f.options,
    runId: '1',
    sourceSha: source,
    preservingCutover: true,
    operationId: f.operationId,
  });
  assert.equal(planned.payload.schemaId, '15');
  f.payload.schemaId = '15';
  f.options.checkMaintenance = async () => {
    f.effects.push('maintenance-checked');
  };

  // First verify pre-cutover abort with untouched DB is not blocked by preexisting schemaId 15
  const origExecute = f.options.execute;
  f.options.execute = (binary, args) => {
    if (args.includes('--preserving-cutover')) throw new Error('halt before cutover');
    return origExecute(binary, args);
  };
  await assert.rejects(promote(f.options), /halt before cutover/);
  assert.equal(f.getLiveVersion(), maintenanceVersionId);
  const aborted = await resume({
    ...f.options,
    planId: '11',
    operationId: f.operationId,
    abort: true,
    checkMaintenance: f.options.checkMaintenance,
  });
  assert.equal(aborted.payload.phase, 'maintenance-aborted');
  assert.equal(f.getLiveVersion(), oldVersion);

  // Now run a fresh preserving cutover with preexisting schemaId 15 all the way to completion
  const f2 = cutoverFixture();
  await f2.setupMigratorFile();
  f2.github.schema = async () => {
    const latestSchema = [...f2.records].reverse().find((row) => row.phase === 'schema-attempted');
    return latestSchema
      ? { id: 21 + f2.records.lastIndexOf(latestSchema), payload: latestSchema }
      : currentSchemaRecord;
  };
  f2.payload.schemaId = '15';
  f2.options.checkMaintenance = async () => {};
  const completed = await promote(f2.options);
  assert.equal(completed.payload.phase, 'complete');
  assert.equal(f2.getLiveVersion(), versionId);
});

test('public probe failure after candidate traffic switch restores pinned maintenance version and preserves incomplete deployment', async () => {
  const f = cutoverFixture();
  await f.setupMigratorFile();
  f.options.checkPublic = async () => {
    f.effects.push('public-failed');
    throw new Error('public probe failed');
  };
  f.options.checkMaintenance = async () => {
    f.effects.push('maintenance-checked');
  };
  const origExecute = f.options.execute;
  await assert.rejects(promote(f.options), /public probe failed/);
  // Live Worker must be returned to the exact pinned maintenance version, never the old document-v1 Worker.
  assert.equal(f.getLiveVersion(), maintenanceVersionId);
  assert.equal((await f.github.baseline()).payload.phase, 'deployed');
  assert.equal((await f.github.baseline()).payload.versionId, versionId);
  assert.equal((await f.github.maintenance()).payload.phase, 'cutover-validated');
  assert(!f.effects.includes('deploy:original'));
  assert(!f.records.some((row) => row.phase === 'complete'));

  // Subsequent resume across a new workflow execution run ID completes without re-uploading or re-running cutover.
  process.env.GITHUB_RUN_ID = '999';
  process.env.GITHUB_RUN_ATTEMPT = '2';
  try {
    f.options.checkPublic = async () => {
      f.effects.push('public-recovered');
    };
    const resumed = await resume({
      ...f.options,
      planId: '11',
      operationId: f.operationId,
      checkMaintenance: f.options.checkMaintenance,
    });
    assert.equal(resumed.payload.phase, 'complete');
    assert.equal(f.getLiveVersion(), versionId);
    assert(f.effects.includes('public-recovered'));
  } finally {
    process.env.GITHUB_RUN_ID = '90';
    process.env.GITHUB_RUN_ATTEMPT = '1';
    f.options.execute = origExecute;
  }
});

test('resume inspects actual Group1 DB cutover state across crash phases and blocks pre-cutover abort once source is staged', async () => {
  for (const crashPhase of ['source-staged', 'native-schema-advanced', 'import-partial']) {
    const f = cutoverFixture({ dbPhase: 'untouched' });
    await f.setupMigratorFile();
    const origExecute = f.options.execute;
    let crashed = false;
    f.options.execute = (binary, args) => {
      if (args.includes('--preserving-cutover') && !crashed) {
        crashed = true;
        f.setDbPhase(crashPhase);
        throw new Error(`simulated crash at ${crashPhase}`);
      }
      return origExecute(binary, args);
    };
    f.options.checkMaintenance = async () => {
      f.effects.push('maintenance-checked');
    };
    await assert.rejects(promote(f.options), new RegExp(`simulated crash at ${crashPhase}`));
    assert.equal(f.getLiveVersion(), maintenanceVersionId);
    // Production baseline is still the original document-v1 release; maintenance is tracked separately.
    assert.equal((await f.github.baseline()).payload.versionId, oldVersion);

    // Attempting to abort after source-staged/native-schema-advanced/import-partial is strictly refused.
    await assert.rejects(
      resume({
        ...f.options,
        planId: '11',
        operationId: f.operationId,
        abort: true,
        checkMaintenance: f.options.checkMaintenance,
      }),
      /abort refused/,
    );
    assert.equal(f.getLiveVersion(), maintenanceVersionId);

    // Forward resume continues from the durable phase using the pinned versions and completes.
    process.env.GITHUB_RUN_ID = '105';
    try {
      const completed = await resume({
        ...f.options,
        planId: '11',
        operationId: f.operationId,
        checkMaintenance: f.options.checkMaintenance,
      });
      assert.equal(completed.payload.phase, 'complete');
      assert.equal(f.getLiveVersion(), versionId);
    } finally {
      process.env.GITHUB_RUN_ID = '90';
    }
  }
});

test('pre-cutover abort restores original live Worker only when DB cutover state is untouched', async () => {
  const f = cutoverFixture({ dbPhase: 'untouched' });
  await f.setupMigratorFile();
  const origExecute = f.options.execute;
  f.options.execute = (binary, args) => {
    if (args.includes('--preserving-cutover')) {
      throw new Error('halt before migration');
    }
    return origExecute(binary, args);
  };
  f.options.checkMaintenance = async () => {
    f.effects.push('maintenance-checked');
  };
  // Simulate failure right after maintenance-active before schema-attempted is recorded:
  const origRecord = f.github.record;
  f.github.record = async (payload, state) => {
    if (payload.phase === 'schema-attempted') throw new Error('halt before schema-attempted');
    return origRecord(payload, state);
  };
  await assert.rejects(promote(f.options), /halt before schema-attempted/);
  assert.equal(f.getLiveVersion(), maintenanceVersionId);
  f.github.record = origRecord;

  // If DB is mutated to source-staged even without schema-attempted, abort is still refused!
  f.setDbPhase('source-staged');
  await assert.rejects(
    resume({
      ...f.options,
      planId: '11',
      operationId: f.operationId,
      abort: true,
      checkMaintenance: f.options.checkMaintenance,
    }),
    /database cutover phase is source-staged/,
  );

  // When DB is genuinely untouched, abort restores originalVersionId and records maintenance-aborted.
  f.setDbPhase('untouched');
  const aborted = await resume({
    ...f.options,
    planId: '11',
    operationId: f.operationId,
    abort: true,
    checkMaintenance: f.options.checkMaintenance,
  });
  assert.equal(aborted.payload.phase, 'maintenance-aborted');
  assert.equal(f.getLiveVersion(), oldVersion);
  assert.equal((await f.github.baseline()).payload.versionId, oldVersion);
});

test('pre-cutover abort cannot restore a single-site artifact into dual-origin configuration', async () => {
  const configuration = JSON.stringify({
    CORNER_ORIGIN: 'https://app.example.com',
    CORNER_LANDING_ORIGIN: 'https://example.com',
    NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
  });
  const configured = validateConfiguration(configuration);
  const f = cutoverFixture({ overrides: { configuration } });
  f.payload.origin = configured.origin;
  f.payload.runtimeConfigurationDigest = configured.digest;
  const artifact = f.github.artifact;
  f.github.artifact = async (reference) => {
    const result = await artifact(reference);
    if (reference.sourceSha === source)
      result.manifest.files['assets/landing/index.html'] = 'a'.repeat(64);
    return result;
  };
  await f.setupMigratorFile();
  // A retained journal admitted before the topology guard must not restore incompatible code.
  await f.github.record({
    ...f.payload,
    phase: 'maintenance-active',
    planId: '11',
    originalVersionId: oldVersion,
    maintenanceVersionId,
    candidateVersionId: versionId,
  });
  f.setLiveVersion(maintenanceVersionId);
  f.effects.length = 0;
  await assert.rejects(
    resume({ ...f.options, planId: '11', operationId: f.operationId, abort: true }),
  );
  assert.deepEqual(f.effects, []);
  assert.equal(f.getLiveVersion(), maintenanceVersionId);
});

test('completion lost-response recovery converges without redeploying maintenance when recordCompletion or maintenance-complete fails partway', async () => {
  // Case 1: publicChecks pass and complete receipt is recorded, but maintenance-complete journal write fails.
  const f1 = cutoverFixture();
  await f1.setupMigratorFile();
  f1.options.checkMaintenance = async () => {
    f1.effects.push('maintenance-checked');
  };
  const origRecord1 = f1.github.record;
  let failMaintComplete = true;
  f1.github.record = async (payload, state) => {
    if (payload.phase === 'maintenance-complete' && failMaintComplete) {
      failMaintComplete = false;
      throw new Error('github maintenance-complete write lost');
    }
    return origRecord1(payload, state);
  };
  await assert.rejects(promote(f1.options), /github maintenance-complete write lost/);
  // Public checks already passed, so candidateVersionId stays live (not rolled back to maintenance).
  assert.equal(f1.getLiveVersion(), versionId);
  assert.equal((await f1.github.baseline()).payload.phase, 'complete');
  assert.equal((await f1.github.maintenance()).payload.phase, 'cutover-validated');

  const converged1 = await resume({
    ...f1.options,
    planId: '11',
    operationId: f1.operationId,
    checkMaintenance: f1.options.checkMaintenance,
  });
  assert.equal(converged1.payload.phase, 'complete');
  assert.equal((await f1.github.maintenance()).payload.phase, 'maintenance-complete');
  assert.equal(f1.getLiveVersion(), versionId);

  // Case 2: publicChecks pass and public-passed is recorded, but complete receipt write fails.
  const f2 = cutoverFixture();
  await f2.setupMigratorFile();
  f2.options.checkMaintenance = async () => {
    f2.effects.push('maintenance-checked');
  };
  const origRecord2 = f2.github.record;
  let failComplete = true;
  f2.github.record = async (payload, state) => {
    if (payload.phase === 'complete' && failComplete) {
      failComplete = false;
      throw new Error('github complete write lost');
    }
    return origRecord2(payload, state);
  };
  await assert.rejects(promote(f2.options), /github complete write lost/);
  assert.equal(f2.getLiveVersion(), versionId);
  assert.equal((await f2.github.baseline()).payload.phase, 'public-passed');
  assert.equal((await f2.github.maintenance()).payload.phase, 'cutover-validated');

  const converged2 = await resume({
    ...f2.options,
    planId: '11',
    operationId: f2.operationId,
    checkMaintenance: f2.options.checkMaintenance,
  });
  assert.equal(converged2.payload.phase, 'complete');
  assert.equal((await f2.github.maintenance()).payload.phase, 'maintenance-complete');
  assert.equal(f2.getLiveVersion(), versionId);
});

test('maintenanceChecks verifies 503, X-Corner-Version, Retry-After, no-store, and JSON/CSP contracts', async () => {
  const fetcher = async (url) => {
    const path = new URL(url).pathname;
    const headers = {
      'X-Corner-Version': maintenanceVersionId,
      'Cache-Control': 'private, no-store, max-age=0',
      'Retry-After': '60',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    };
    if (path.startsWith('/api/rpc/')) {
      return Response.json(
        {
          json: {
            defined: true,
            code: 'SERVICE_UNAVAILABLE',
            status: 503,
            message: 'Maintenance',
            data: { code: 'MAINTENANCE_ACTIVE' },
          },
        },
        { status: 503, headers },
      );
    }
    if (path.startsWith('/api/')) {
      return Response.json(
        { ok: false, maintenance: true, code: 'MAINTENANCE_ACTIVE', error: 'Maintenance' },
        { status: 503, headers },
      );
    }
    return new Response('<html>maintenance</html>', { status: 503, headers });
  };
  await maintenanceChecks(config.origin, maintenanceVersionId, fetcher);
  await assert.rejects(
    maintenanceChecks(config.origin, versionId, fetcher),
    /version identity mismatch/,
  );
});

test('completed receipt resume closes on failed probes and refuses unknown live drift', async () => {
  for (const drift of [false, true]) {
    const f = cutoverFixture();
    await f.setupMigratorFile();
    const record = f.github.record;
    f.github.record = async (payload, state) => {
      if (payload.phase === 'maintenance-complete') throw new Error('lost closure');
      return record(payload, state);
    };
    await assert.rejects(promote(f.options), /lost closure/);
    f.github.record = record;
    const before = f.effects.filter((effect) => effect.startsWith('deploy:')).length;
    const unknown = '77777777-7777-4777-8777-777777777777';
    f.options.checkPublic = async () => {
      if (drift) f.setLiveVersion(unknown);
      throw new Error('security probe failed');
    };
    await assert.rejects(
      resume({ ...f.options, operationId: f.operationId }),
      drift ? /restoring the pinned maintenance Worker also failed/ : /security probe failed/,
    );
    assert.equal(f.getLiveVersion(), drift ? unknown : maintenanceVersionId);
    assert.equal(
      f.effects.filter((effect) => effect.startsWith('deploy:')).length,
      before + (drift ? 0 : 1),
    );
  }
});

test('candidate traffic switch refuses drift introduced during converted-record validation', async () => {
  const f = cutoverFixture();
  await f.setupMigratorFile();
  const execute = f.options.execute;
  const unknown = '77777777-7777-4777-8777-777777777777';
  f.options.execute = (binary, args) => {
    const result = execute(binary, args);
    if (args.includes('--inspect-cutover') && f.effects.includes('preserving-cutover'))
      f.setLiveVersion(unknown);
    return result;
  };
  await assert.rejects(promote(f.options), /Live Worker drifted before pinned traffic transition/);
  assert.equal(f.getLiveVersion(), unknown);
  assert(!f.effects.includes('deploy:candidate'));
});
