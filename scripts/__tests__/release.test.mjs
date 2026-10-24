import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  verifyRun,
  validateConfiguration,
  validateReceipt,
  assertBaseline,
  rollbackEligible,
  requiresOperator,
  manualAttestation,
  GitHub,
  plan,
  promote,
  publicChecks,
  validateLiveRollback,
  validateOperational,
} from '../release.mjs';

const source = 'a'.repeat(40),
  previousSource = 'b'.repeat(40),
  candidateDigest = 'c'.repeat(64),
  previousDigest = 'd'.repeat(64),
  configurationSha256 = 'e'.repeat(64);
const versionId = '12345678-1234-1234-1234-123456789012',
  oldVersion = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
const frontendVersionId = '22345678-1234-1234-1234-123456789012',
  oldFrontendVersion = 'bbcdefab-abcd-abcd-abcd-abcdefabcdef';
const configuration = JSON.stringify({
  CORNER_ORIGIN: 'https://corner.example.com',
  NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
});
const saved = { ...process.env };
process.env.CORNER_PRODUCTION_BINDINGS_REVISION = 'test-config-1';
process.env.DATABASE_URL_UNPOOLED = 'postgresql://synthetic.invalid/unused';
process.env.GITHUB_RUN_ATTEMPT = '1';
process.env.GITHUB_RUN_ID = '90';
process.env.GITHUB_ACTOR = 'reviewer';
delete process.env.CORNER_PRODUCTION_ORIGIN;
const config = validateConfiguration(configuration);
const report = {
  format: 1,
  sourceSha: source,
  candidateDigest,
  previousDigest,
  bootstrap: false,
  passed: true,
};
const receipt = {
  format: 2,
  kind: 'corner-production',
  phase: 'complete',
  runId: '1',
  artifactId: '2',
  sourceSha: previousSource,
  candidateDigest: previousDigest,
  configurationSha256,
  frontendConfigurationSha256: configurationSha256,
  runtimeConfigurationDigest: config.digest,
  versionId: oldVersion,
  frontendVersionId: oldFrontendVersion,
  qualification: { ...report, sourceSha: previousSource, candidateDigest: previousDigest },
};
const manifest = {
  sourceSha: source,
  configurationSha256,
  frontendConfigurationSha256: configurationSha256,
  configurationEntry: 'wrangler.json',
  workerEntry: 'worker/worker.js',
  migrationEntry: 'migration/dist/migrate.mjs',
  workerName: 'corner-server',
  frontendName: 'corner-web',
  frontendEntry: 'frontend/worker.js',
  frontendConfigurationEntry: 'frontend/wrangler.json',
  migrations: [{ name: '001_corner.sql', sha256: 'f'.repeat(64) }],
};
manifest.wranglerVersion = JSON.parse(
  await readFile(
    new URL('../../apps/server/node_modules/wrangler/package.json', import.meta.url),
    'utf8',
  ),
).version;
const review = JSON.stringify({
  sourceSha: source,
  reviewer: 'reviewer',
  affectedFlow: 'Meal planner save and reload',
  desktopWidth: 1280,
  phoneWidth: 390,
  keyboardFocus: 'passed',
  stagingReview: { sourceSha: previousSource, deploymentId: '5' },
});
const work = await mkdtemp(join(tmpdir(), 'corner-release-tests-'));
const packagedConfig = {
  name: 'corner-server',
  main: manifest.workerEntry,
  no_bundle: true,
  assets: { directory: 'assets', binding: 'ASSETS' },
  workers_dev: false,
  preview_urls: false,
};
for (const revision of [source, previousSource]) {
  await mkdir(join(work, revision));
  await writeFile(join(work, revision, 'wrangler.json'), JSON.stringify(packagedConfig));
  await mkdir(join(work, revision, 'frontend'));
  await writeFile(
    join(work, revision, manifest.frontendConfigurationEntry),
    JSON.stringify({
      name: 'corner-web',
      main: 'worker.js',
      no_bundle: true,
      assets: { directory: '../assets' },
      services: [{ binding: 'SERVER', service: 'corner-server' }],
    }),
  );
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
  const payload = {
    ...receipt,
    phase: 'planned',
    sourceSha: source,
    candidateDigest,
    baselineId: '10',
    schemaId: null,
    executionRunId: '90',
    bootstrap: false,
    rollback: false,
    rollbackVersionId: null,
    qualification: report,
    operatorRequired: false,
    origin: config.origin,
  };
  payload.manualReview = JSON.parse(review);
  payload.executionRunAttempt = '1';
  const github = {
    baseline: async () =>
      records.at(-1)?.phase === 'backend-deployed'
        ? { id: 20 + records.length, payload: records.at(-1) }
        : { id: 10, payload: receipt },
    schema: async () => null,
    approval: async (environment) => ({
      runId: '90',
      attempt: '1',
      environment,
      reviewer: 'protected-owner',
    }),
    api: async (path) => {
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
      directory: join(work, reference.sourceSha),
      manifest: { ...manifest, sourceSha: reference.sourceSha },
      digest: reference.sourceSha === source ? candidateDigest : previousDigest,
      qualification: {
        ...report,
        sourceSha: reference.sourceSha,
        candidateDigest: reference.sourceSha === source ? candidateDigest : previousDigest,
      },
    }),
    record: async (payload) => {
      effects.push(payload.phase);
      records.push(payload);
      return { id: 20 + records.length, payload };
    },
  };
  const execute = (binary, args) => {
    const frontend = args.some((value) => String(value).includes('wrangler-frontend'));
    effects.push(
      args.includes('upload')
        ? frontend
          ? 'upload-frontend'
          : 'upload'
        : args.includes('--apply')
          ? 'migrate'
          : frontend
            ? 'deploy-frontend'
            : 'deploy',
    );
    return `Worker Version ID: ${frontend ? frontendVersionId : versionId}\n`;
  };
  const cf = async (path, { missing = false } = {}) => {
    if (missing) return null;
    if (path.endsWith('/settings'))
      return {
        bindings: [
          'DATABASE_URL',
          'NEON_AUTH_BASE_URL',
          'BETTER_AUTH_SECRET',
          'CORNER_TOKEN_ENCRYPTION_KEY',
        ].map((name) => ({ name, type: 'secret_text' })),
      };
    const frontend = path.includes('corner-web');
    return {
      deployments: [
        {
          versions: [
            {
              version_id: frontend
                ? effects.includes('deploy-frontend')
                  ? frontendVersionId
                  : oldFrontendVersion
                : effects.includes('deploy')
                  ? versionId
                  : oldVersion,
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
});
test('receipt and rollback require real qualified identities and CURRENT compatibility/configuration', () => {
  validateReceipt(receipt);
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
test('manual review binds actor/source and records human assertion rather than invented automation', () => {
  assert.equal(
    manualAttestation(review, source, 'reviewer').kind,
    'human-attestation-not-automated-proof',
  );
  assert.throws(() => manualAttestation(review, previousSource, 'reviewer'), /bind/);
  assert.throws(() => manualAttestation(review, source, 'someone-else'), /bind/);
  assert.throws(
    () => manualAttestation(review.replace('390', '800'), source, 'reviewer'),
    /widths/,
  );
});
test('web auth and build changes require operational completion', async () => {
  const cases = [
    [
      ['apps/web/src/components/training-panel.tsx', 'packages/ui/src/catalog/toast.tsx'],
      'complete',
    ],
    [['apps/web/src/main.tsx'], 'public-passed'],
    [['apps/web/src/api.ts'], 'public-passed'],
    [['apps/web/vite.config.ts'], 'public-passed'],
    [['packages/ui/package.json'], 'public-passed'],
    [['apps/server/src/worker.ts'], 'public-passed'],
    [['apps/web/src/worker.ts'], 'public-passed'],
    [['apps/server/migrations/002.sql'], 'public-passed'],
  ];
  for (const [files, phase] of cases) {
    const f = fixture();
    const api = f.github.api;
    let prepared;
    f.github.api = async (path) => {
      if (path.startsWith('compare/'))
        return { status: 'ahead', files: files.map((filename) => ({ filename })) };
      if (prepared && path === `deployments/${prepared.id}`)
        return JSON.parse(JSON.stringify({ ...prepared, environment: 'production-plan' }));
      return api(path);
    };
    prepared = await plan({
      ...f.options,
      runId: '1',
      sourceSha: source,
      attestation: review,
      actor: 'reviewer',
      qualify: async () => report,
    });
    const result = await promote({ ...f.options, planId: String(prepared.id) });
    assert.equal(result.payload.phase, phase, files.join(', '));
    assert.equal(
      f.records.some((row) => row.phase === 'complete'),
      phase === 'complete',
    );
    assert(!f.records.some((row) => row.phase === 'operational-validated'));
  }
  assert.equal(requiresOperator([], true, null, manifest, config.digest), true);
});
test('stale approved baseline fails before artifact execution or effects', async () => {
  assert.throws(() => assertBaseline('10', '12'), /Stale approval/);
  const f = fixture();
  f.github.baseline = async () => ({ id: 12, payload: receipt });
  await assert.rejects(promote(f.options), /Stale approval/);
  assert.deepEqual(f.effects, []);
});
test('stale schema journal or cross-run plan fails before effects', async () => {
  const f = fixture();
  f.github.schema = async () => ({ id: 99 });
  await assert.rejects(promote(f.options), /Stale approval/);
  assert.deepEqual(f.effects, []);
  f.github.schema = async () => null;
  f.payload.executionRunId = 'other-run';
  await assert.rejects(promote(f.options), /different approval/);
  assert.deepEqual(f.effects, []);
});
test('missing baseline never silently bootstraps', async () => {
  const f = fixture();
  f.github.baseline = async () => null;
  await assert.rejects(
    plan({ ...f.options, runId: '1', sourceSha: source, attestation: review, actor: 'reviewer' }),
    /explicit bootstrap/,
  );
  assert.deepEqual(f.effects, []);
});
test('qualification failure occurs before approval record', async () => {
  const f = fixture();
  await assert.rejects(
    plan({
      ...f.options,
      runId: '1',
      sourceSha: source,
      attestation: review,
      actor: 'reviewer',
      qualify: async () => {
        throw new Error('incompatible documents');
      },
    }),
    /incompatible/,
  );
  assert.deepEqual(f.records, []);
});
test('plan persists exact real artifact and baseline qualification before approval', async () => {
  const f = fixture();
  const result = await plan({
    ...f.options,
    runId: '1',
    sourceSha: source,
    attestation: review,
    actor: 'reviewer',
    qualify: async () => report,
  });
  assert.equal(result.payload.artifactId, '2');
  assert.equal(result.payload.baselineId, '10');
  assert.equal(result.payload.qualification.previousDigest, previousDigest);
  assert.equal(result.payload.phase, 'planned');
});
test('migration failure journals schema attempt and prevents traffic/public checks', async () => {
  const f = fixture();
  f.options.execute = (binary, args) => {
    if (args.includes('--apply')) {
      f.effects.push('migration-failed');
      throw new Error('migration failed');
    }
    f.effects.push('upload');
    return `Worker Version ID: ${versionId}`;
  };
  await assert.rejects(promote(f.options), /migration failed/);
  assert.deepEqual(f.effects, ['upload', 'upload', 'schema-attempted', 'migration-failed']);
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
    'upload-frontend',
    'schema-attempted',
    'migrate',
    'deploy',
    'backend-deployed',
    'deploy-frontend',
    'deployed',
    'public',
    'public-passed',
    'complete',
  ]);
  assert.equal(result.payload.versionId, versionId);
  assert.equal(result.payload.frontendVersionId, frontendVersionId);
  assert(commands[0][1].includes('--no-bundle'));
  assert(commands[3][1].includes(`${versionId}@100%`));
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
    main: join(work, source, manifest.workerEntry),
    assets: { ...packagedConfig.assets, directory: join(work, source, 'assets') },
  });
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
test('public failure preserves deployed state and cannot claim public/operational success', async () => {
  const f = fixture();
  f.options.checkPublic = async () => {
    throw new Error('wrong deployed version');
  };
  await assert.rejects(promote(f.options), /wrong deployed version/);
  assert.equal(f.records.at(-1).phase, 'deployed');
  assert(!f.records.some((row) => row.phase === 'complete'));
});
test('artifact identity is rechecked after protected approval', async () => {
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
test('public checks require actual deployed version, not merely a 200 response', async () => {
  const fetcher = async (url) =>
    new URL(url).pathname.includes('sign-up')
      ? Response.json({ code: 'ORIGIN_NOT_ALLOWED' }, { status: 403 })
      : Response.json({ ok: true }, { headers: { 'X-Corner-Version': oldVersion } });
  await assert.rejects(publicChecks(config.origin, versionId, fetcher), /version identity/);
});
test('live rollback validates actual stored documents read-only without logging or reversing SQL', async () => {
  const statements = [];
  let released = false,
    ended = false;
  const connection = {
    query: async (sql) => {
      statements.push(sql);
      if (sql.startsWith('SELECT name'))
        return { rows: [{ name: '001_corner.sql', checksum: 'f'.repeat(64) }] };
      if (sql.startsWith('SELECT user_id'))
        return { rows: [{ user_id: 'owner', data: JSON.stringify({ saved: 'private' }) }] };
      return { rows: [] };
    },
    release: () => {
      released = true;
    },
  };
  const load = async () => ({
    createDatabase: () => ({
      connect: async () => connection,
      end: async () => {
        ended = true;
      },
    }),
    inspectImport: (raw) => ({ state: { ...raw, defaulted: true } }),
  });
  await assert.rejects(
    validateLiveRollback({ directory: work, manifest }, { manifest }, load),
    /private details withheld/,
  );
  assert(statements[0].includes('READ ONLY'));
  assert(statements.includes('ROLLBACK'));
  assert(released && ended);
  assert(!statements.some((sql) => /INSERT|UPDATE|DELETE|ALTER/.test(sql)));
});
test('operational validation rejects stale deployment or incomplete human assertion', async () => {
  const f = fixture();
  await assert.rejects(
    validateOperational({ github: f.github, deploymentId: '9', evidence: '{}' }),
    /exact current/,
  );
  f.github.baseline = async () => ({
    id: 10,
    payload: { ...receipt, phase: 'public-passed', origin: config.origin },
  });
  await assert.rejects(
    validateOperational({ github: f.github, deploymentId: '10', evidence: '{}' }),
    /human attestation/,
  );
  assert.deepEqual(f.records, []);
});
test('bootstrap validates all required bindings before any production mutation', async () => {
  const f = fixture();
  f.github.baseline = async () => null;
  Object.assign(f.payload, {
    bootstrap: true,
    baselineId: null,
    operatorRequired: true,
    qualification: { ...report, bootstrap: true, previousDigest: null },
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
test('explicit bootstrap migrates before first creation and remains operationally incomplete', async () => {
  const f = fixture();
  f.github.baseline = async () =>
    f.records.at(-1)?.phase === 'backend-deployed'
      ? { id: 20 + f.records.length, payload: f.records.at(-1) }
      : null;
  Object.assign(f.payload, {
    bootstrap: true,
    baselineId: null,
    operatorRequired: true,
    qualification: { ...report, bootstrap: true, previousDigest: null },
  });
  const before = {
    database: process.env.DATABASE_URL,
    worker: process.env.CORNER_WORKER_SECRETS_JSON,
  };
  process.env.DATABASE_URL = 'postgresql://synthetic.invalid/unused';
  process.env.CORNER_WORKER_SECRETS_JSON = JSON.stringify({
    DATABASE_URL: process.env.DATABASE_URL,
    NEON_AUTH_BASE_URL: 'https://auth.example.invalid/neondb/auth',
    BETTER_AUTH_SECRET: 'synthetic-session-secret-over-thirty-two-characters',
    CORNER_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 42).toString('base64'),
  });
  const invocations = [];
  f.options.execute = (binary, args) => {
    invocations.push(args);
    const frontend = args.some((value) => String(value).includes('wrangler-frontend'));
    f.effects.push(args.includes('--apply') ? 'migrate' : frontend ? 'deploy-frontend' : 'deploy');
    return `Current Version ID: ${frontend ? frontendVersionId : versionId}`;
  };
  try {
    const cf = f.options.cf;
    f.options.cf = async () => ({ bindings: [] });
    await assert.rejects(promote(f.options), /Bootstrap Worker already exists/);
    assert.deepEqual(f.effects, []);
    f.options.cf = cf;
    const result = await promote(f.options);
    assert.equal(result.payload.phase, 'public-passed');
    assert(f.effects.indexOf('migrate') < f.effects.indexOf('deploy'));
    assert(invocations[1].includes('--secrets-file'));
    assert(invocations[1].includes('--no-bundle'));
    assert(!invocations.some((args) => args.includes('upload')));
    assert(!f.effects.includes('complete'));
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
                  version_id: path.includes('corner-web') ? oldFrontendVersion : oldVersion,
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
test('protected operational recovery rechecks exact version, records public evidence and then human evidence separately', async () => {
  const f = fixture();
  f.github.baseline = async () => ({
    id: 10,
    payload: { ...receipt, phase: 'deployed', origin: config.origin },
  });
  const evidence = JSON.stringify({
    sourceSha: previousSource,
    versionId: oldVersion,
    frontendVersionId: oldFrontendVersion,
    reviewer: 'reviewer',
    accountAccess: 'passed',
    saveReload: 'passed',
    recovery: 'passed',
    authOriginRoutingSecretsPersistence: 'passed',
  });
  const result = await validateOperational({
    github: f.github,
    deploymentId: '10',
    evidence,
    checkPublic: async (origin, version) => {
      assert.equal(origin, config.origin);
      assert.equal(version, oldVersion);
      f.effects.push('public');
    },
  });
  assert.deepEqual(f.effects, ['public', 'public-passed', 'operational-validated']);
  assert.equal(result.payload.evidence.kind, 'human-attestation-not-automated-proof');
});
test('fixed-SHA source comparison treats API truncation and renames across boundaries conservatively', async () => {
  for (const files of [
    Array.from({ length: 300 }, (_, index) => ({ filename: `apps/web/src/${index}.tsx` })),
    [{ filename: 'apps/web/src/moved.ts', previous_filename: 'apps/server/src/store.ts' }],
  ]) {
    const f = fixture();
    const api = f.github.api;
    f.github.api = async (path) => {
      if (path.startsWith('compare/')) {
        assert.equal(path, `compare/${previousSource}...${source}`);
        return { status: 'ahead', files };
      }
      return api(path);
    };
    const result = await plan({
      ...f.options,
      runId: '1',
      sourceSha: source,
      attestation: review,
      actor: 'reviewer',
      qualify: async () => report,
    });
    assert.equal(result.payload.operatorRequired, true);
  }
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
    attestation: review.replace(source, previousSource),
    actor: 'reviewer',
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
  assert.equal(result.payload.operatorRequired, true);
  f.github.api = async () => ({
    id: 9,
    environment: 'production',
    task: 'corner-release',
    payload: { ...receipt, phase: 'public-passed' },
  });
  await assert.rejects(
    plan({ ...f.options, rollbackId: '9', attestation: review, actor: 'reviewer' }),
    /completed operational/,
  );
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
test('effectful jobs require actual protected-environment approval records, not an environment name', async () => {
  const github = new GitHub({ repository: 'owner/corner', token: 'synthetic' });
  github.api = async (path) => {
    assert.equal(path, 'actions/runs/90/approvals');
    return [];
  };
  await assert.rejects(github.approval('production'), /actual protected/);
  github.api = async () => [
    {
      state: 'approved',
      environments: [{ name: 'production-validation' }],
      user: { login: 'owner', type: 'User', id: 123 },
    },
  ];
  await assert.rejects(github.approval('production'), /actual protected/);
  assert.equal((await github.approval('production-validation')).reviewer, 'owner');
  const f = fixture();
  f.github.approval = async () => {
    throw new Error('approval missing');
  };
  await assert.rejects(promote(f.options), /approval missing/);
  assert.deepEqual(f.effects, []);
});
test('post-upload payload changes block before migrations or traffic changes', async () => {
  const f = fixture();
  f.options.verify = async () => ({ digest: previousDigest });
  await assert.rejects(promote(f.options), /Immutable payload changed/);
  assert.deepEqual(f.effects, ['upload']);
});

test('frontend failure retains backend progress and cannot claim a deployed pair', async () => {
  const f = fixture();
  const execute = f.options.execute;
  f.options.execute = (binary, args, options) => {
    if (
      args.includes('deploy') &&
      args.some((value) => String(value).includes('wrangler-frontend'))
    )
      throw new Error('frontend switch failed');
    return execute(binary, args, options);
  };
  await assert.rejects(promote(f.options), /frontend switch failed/);
  assert.equal(f.records.at(-1).phase, 'backend-deployed');
  assert.equal(f.records.at(-1).versionId, versionId);
  assert.equal(f.records.at(-1).frontendVersionId, oldFrontendVersion);
  assert.equal(f.records.at(-1).pendingFrontendVersionId, frontendVersionId);
  assert(!f.records.some((row) => ['deployed', 'public-passed', 'complete'].includes(row.phase)));
});

test('frontend drift blocks a coordinated release before uploads or migration', async () => {
  const f = fixture();
  const cf = f.options.cf;
  f.options.cf = async (path, options) =>
    path.includes('corner-web')
      ? { deployments: [{ versions: [{ version_id: frontendVersionId, percentage: 100 }] }] }
      : cf(path, options);
  await assert.rejects(promote(f.options), /drifted/);
  assert.deepEqual(f.effects, []);
});

test('staging accepts only current successful staging CI and fixed nonproduction targets, without production approval', async () => {
  const before = { ...process.env };
  try {
    process.env.CORNER_RELEASE_ENVIRONMENT = 'staging';
    process.env.CORNER_STAGING_BINDINGS_REVISION = 'test-config-1';
    process.env.CORNER_STAGING_ACCESS_CLIENT_ID = 'synthetic-access-id';
    process.env.CORNER_STAGING_ACCESS_CLIENT_SECRET = 'synthetic-access-secret';
    assert.throws(() => verifyRun(run, source), /push-to-staging/);
    verifyRun({ ...run, head_branch: 'staging' }, source);
    assert.throws(() => validateReceipt(receipt), /paired release receipt/);
    const f = fixture();
    Object.assign(f.payload, { kind: 'corner-staging', manualReview: null });
    f.github.baseline = async () =>
      f.records.at(-1)?.phase === 'backend-deployed'
        ? { id: 20 + f.records.length, payload: f.records.at(-1) }
        : { id: 10, payload: { ...receipt, kind: 'corner-staging' } };
    f.github.approval = async () => {
      throw new Error('Production approval must never be queried for staging');
    };
    const api = f.github.api;
    f.github.api = async (path) =>
      path === 'git/ref/heads/staging'
        ? { object: { sha: source } }
        : path === 'deployments/11'
          ? { environment: 'staging-plan', payload: f.payload }
          : api(path);
    const result = await promote(f.options);
    assert.equal(result.payload.phase, 'complete');
    assert.equal(result.payload.approval.kind, 'automatic-staging');
    const serverConfig = JSON.parse(await readFile(join(work, 'wrangler-deploy.json'), 'utf8'));
    const frontendConfig = JSON.parse(await readFile(join(work, 'wrangler-frontend.json'), 'utf8'));
    assert.equal(serverConfig.name, 'corner-server-staging');
    assert.equal(frontendConfig.name, 'corner-web-staging');
    assert.deepEqual(frontendConfig.services, [
      { binding: 'SERVER', service: 'corner-server-staging' },
    ]);
    f.effects.length = 0;
    f.github.api = async (path) =>
      path === 'git/ref/heads/staging'
        ? { object: { sha: previousSource } }
        : { environment: 'staging-plan', payload: f.payload };
    await assert.rejects(promote(f.options), /Superseded/);
    assert.deepEqual(f.effects, []);
    await assert.rejects(plan({ ...f.options, sourceSha: source }), /Superseded/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  }
});

test('production manual review requires staging evidence or an explicit emergency exception', () => {
  const value = JSON.parse(review);
  delete value.stagingReview;
  assert.throws(
    () => manualAttestation(JSON.stringify(value), source, 'reviewer'),
    /reviewed staging/,
  );
  value.hotfixReason = 'Urgent production authentication repair';
  assert.equal(
    manualAttestation(JSON.stringify(value), source, 'reviewer').hotfixReason,
    value.hotfixReason,
  );
});

test('a repaired staging boundary completes only the exact recorded pair and never requests production approval', async () => {
  const before = { ...process.env };
  try {
    process.env.CORNER_RELEASE_ENVIRONMENT = 'staging';
    process.env.CORNER_STAGING_ACCESS_CLIENT_ID = 'synthetic-access-id';
    process.env.CORNER_STAGING_ACCESS_CLIENT_SECRET = 'synthetic-access-secret';
    const f = fixture();
    const current = {
      id: 40,
      payload: { ...receipt, kind: 'corner-staging', phase: 'deployed', origin: config.origin },
    };
    f.github.baseline = async () => current;
    f.github.approval = async () => {
      throw new Error('No production authority');
    };
    let observed;
    await assert.rejects(
      validateOperational({ github: f.github, deploymentId: '39' }),
      /exact current/,
    );
    const result = await validateOperational({
      github: f.github,
      deploymentId: '40',
      checkPublic: async (origin, backend, _fetch, frontend, access) => {
        observed = { origin, backend, frontend };
        assert.equal(access['CF-Access-Client-Id'], 'synthetic-access-id');
      },
    });
    assert.deepEqual(observed, {
      origin: config.origin,
      backend: oldVersion,
      frontend: oldFrontendVersion,
    });
    assert.equal(result.payload.phase, 'complete');
    assert.equal(
      result.payload.evidence,
      undefined,
      'Automated public recheck is not a human account attestation.',
    );
    current.payload.phase = 'backend-deployed';
    await assert.rejects(
      validateOperational({ github: f.github, deploymentId: '40' }),
      /exact current/,
    );
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  }
});

test('public checks refuse a stale frontend even when the backend version is correct', async () => {
  const fetcher = async (url) =>
    new URL(url).pathname.includes('sign-up')
      ? Response.json({ code: 'ORIGIN_NOT_ALLOWED' }, { status: 403 })
      : Response.json(
          { ok: true },
          {
            headers: {
              'X-Corner-Version': versionId,
              'X-Corner-Frontend-Version': oldFrontendVersion,
            },
          },
        );
  await assert.rejects(
    publicChecks(config.origin, versionId, fetcher, frontendVersionId),
    /frontend version identity/,
  );
});
