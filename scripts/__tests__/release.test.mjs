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
  deploy,
  publicChecks,
  validateLiveRollback,
  validateOperational,
} from '../release.mjs';
import { loadCiArtifact } from '../ci-artifact.mjs';
import { releaseTarget } from '../release-target.mjs';

const source = 'a'.repeat(40),
  previousSource = 'b'.repeat(40),
  candidateDigest = 'c'.repeat(64),
  previousDigest = 'd'.repeat(64),
  configurationSha256 = 'e'.repeat(64);
const versionId = '12345678-1234-1234-1234-123456789012',
  oldVersion = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
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
    operatorRequired: false,
    origin: config.origin,
  };
  payload.manualReview = JSON.parse(review);
  payload.executionRunAttempt = '1';
  const github = {
    repository: 'owner/corner',
    baseline: async () => ({ id: 10, payload: receipt }),
    schema: async () => null,
    approval: async (environment) => ({
      runId: '90',
      attempt: '1',
      environment,
      reviewer: 'protected-owner',
    }),
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
    effects.push(
      args.includes('upload') ? 'upload' : args.includes('--apply') ? 'migrate' : 'deploy',
    );
    return `Worker Version ID: ${versionId}\n`;
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

test('provisioned Worker version pins cannot be used for an ordinary release', async () => {
  const f = fixture();
  await assert.rejects(
    plan({
      ...f.options,
      runId: '1',
      sourceSha: source,
      provisionedVersionId: oldVersion,
      attestation: review,
      actor: 'reviewer',
    }),
    /valid only for explicit bootstrap/,
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

test('successful current main CI deploys backend changes without a second human gate and reruns do not redeploy', async () => {
  const f = fixture();
  const api = f.github.api;
  f.github.api = async (path) =>
    path.startsWith('compare/')
      ? { status: 'ahead', files: [{ filename: 'apps/server/src/worker.ts' }] }
      : api(path);
  f.github.approval = async () => {
    throw new Error('Automatic releases must not request human approval');
  };
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
  assert.equal(result.payload.manualReview, null);
  assert.equal(result.payload.approval.kind, 'successful-main-ci');
  assert(f.effects.indexOf('migrate') < f.effects.indexOf('deploy'));
  assert(f.effects.indexOf('public') < f.effects.indexOf('complete'));
  f.github.baseline = async () => result;
  f.effects.length = 0;
  await deploy(options);
  assert.deepEqual(f.effects, ['public']);
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
      version: '7', dialect: 'postgresql',
      entries: [{ idx: 0, version: '7', when: 1, tag: '0000_corner', breakpoints: true }],
    }),
    'migration/migrations/meta/0000_snapshot.json': JSON.stringify({
      id: '11111111-1111-4111-8111-111111111111',
      prevId: '00000000-0000-0000-0000-000000000000',
      version: '7', dialect: 'postgresql', tables: {},
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
      migrations: [{
        name: '0000_corner.sql', sha256: hash(migration), when: 1,
        journalSha256: hash(JSON.stringify(JSON.parse(files['migration/migrations/meta/_journal.json']).entries[0])),
        snapshotSha256: hash(files['migration/migrations/meta/0000_snapshot.json']),
      }],
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
    /still requires public\/operational validation/,
  );
  assert.deepEqual(f.effects, []);
});

test('automatic public failure leaves the deployed release incomplete', async () => {
  const f = fixture();
  await assert.rejects(
    deploy({
      ...f.options,
      runId: '1',
      sourceSha: source,
      qualify: async () => report,
      checkPublic: async () => {
        throw new Error('wrong deployed version');
      },
    }),
    /wrong deployed version/,
  );
  assert.equal(f.records.at(-1).phase, 'deployed');
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
      if (sql.startsWith('SELECT user_id'))
        return { rows: [{ user_id: 'owner', data: JSON.stringify({ saved: 'private' }) }] };
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
    inspectImport: (raw) => ({ state: { ...raw, defaulted: true } }),
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
  f.github.baseline = async () => null;
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
    f.effects.push(args.includes('--apply') ? 'migrate' : 'deploy');
    return `Current Version ID: ${versionId}`;
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

test('explicit adoption pins the existing Worker before migration and again before deployment', async (t) => {
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
  try {
    for (const scenario of ['changed-before-migration', 'changed-during-migration', 'stable']) {
      await t.test(scenario, async () => {
        const f = fixture();
        f.github.baseline = async () => null;
        Object.assign(f.payload, {
          bootstrap: true,
          provisionedVersionId: oldVersion,
          baselineId: null,
          operatorRequired: true,
          qualification: { ...report, bootstrap: true, previousDigest: null },
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
          assert.equal(result.payload.phase, 'public-passed');
          assert(f.effects.indexOf('migrate') < f.effects.indexOf('deploy'));
          assert(!f.effects.includes('complete'));
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
test('protected operational recovery rechecks exact version, records public evidence and then human evidence separately', async () => {
  const f = fixture();
  f.github.baseline = async () => ({
    id: 10,
    payload: { ...receipt, phase: 'deployed', origin: config.origin },
  });
  const evidence = JSON.stringify({
    sourceSha: previousSource,
    versionId: oldVersion,
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
  await assert.rejects(github.approval('production-operations'), /actual protected/);
  github.api = async () => [
    {
      state: 'approved',
      environments: [{ name: 'production-validation' }],
      user: { login: 'owner', type: 'User', id: 123 },
    },
  ];
  await assert.rejects(github.approval('production-operations'), /actual protected/);
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

test('public probes require a canonical native protected RPC error, not an obsolete REST 401', async () => {
  const requests = [];
  let native = true;
  const fetcher = async (url, options = {}) => {
    const path = new URL(url).pathname;
    requests.push(path);
    if (path === '/api/health')
      return Response.json({ ok: true }, { headers: { 'X-Corner-Version': versionId } });
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
  await publicChecks(config.origin, versionId, fetcher);
  assert.equal(requests.includes('/api/state'), false);
  native = false;
  await assert.rejects(publicChecks(config.origin, versionId, fetcher), /RPC authentication/);
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
    assert.throws(() => rollbackEligible(
      { ...receipt, format }, receipt, report, config.digest,
    ));
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

test('legacy production adoption requires a current explicitly pinned bootstrap plan', async () => {
  const adoption = {
    runId: '1', sourceSha: source, bootstrap: true, provisionedVersionId: oldVersion,
    productionAdoptionHost: 'synthetic.invalid', attestation: review, actor: 'reviewer',
  };
  for (const override of [
    { automatic: true }, { bootstrap: false }, { provisionedVersionId: null },
    { rollbackId: '10' }, { productionAdoptionHost: 'https://synthetic.invalid' },
  ]) {
    const f = fixture();
    await assert.rejects(plan({ ...f.options, ...adoption, ...override }));
    assert.deepEqual(f.effects, []);
  }
  const f = fixture();
  f.github.baseline = async () => null;
  const api = f.github.api;
  f.github.api = async path => path === 'git/ref/heads/main'
    ? { object: { sha: previousSource } } : api(path);
  await assert.rejects(plan({ ...f.options, ...adoption }));
  assert.deepEqual(f.effects, []);
  f.github.api = api;
  const prepared = await plan({
    ...f.options, ...adoption,
    qualify: async () => ({ ...report, bootstrap: true, previousDigest: null }),
  });
  assert.equal(prepared.payload.productionAdoptionHost, adoption.productionAdoptionHost);
  assert.equal(prepared.payload.operatorRequired, true);
  f.github.schema = async () => ({ payload: {
    productionAdoptionHost: 'different.invalid',
  } });
  await assert.rejects(plan({ ...f.options, ...adoption }));
  assert.deepEqual(f.effects, ['planned']);
});

test('production adoption rejects mismatched approved and protected database destinations before effects', async () => {
  const before = {
    database: process.env.DATABASE_URL, direct: process.env.DATABASE_URL_UNPOOLED,
    worker: process.env.CORNER_WORKER_SECRETS_JSON,
  };
  try {
    for (const mismatch of [
      { host: 'different.invalid' },
      { direct: 'postgresql://synthetic-pooler.invalid/unused' },
      { direct: 'postgresql://synthetic.invalid/unused?options=-c%20search_path%3Dother' },
      ...['host=different.invalid', 'hostaddr=127.0.0.1', 'port=5433', 'user=other', 'database=other',
        'dbname=other', 'options=-c%20search_path%3Dother', '%68ost=different.invalid'].flatMap(query => [
        { direct: `postgresql://synthetic.invalid/unused?${query}` },
        { pooled: `postgresql://synthetic.invalid/unused?${query}` },
      ]),
      { pooled: 'postgresql://other.invalid/unused' },
      { pooled: 'postgresql://synthetic.invalid:5433/unused' },
      { pooled: 'https://synthetic.invalid/unused' },
      { pooled: 'postgresql://owner@synthetic.invalid/unused' },
      { pooled: 'postgresql://synthetic.invalid/other' },
    ]) {
      process.env.DATABASE_URL = mismatch.pooled ?? 'postgresql://synthetic.invalid/unused';
      process.env.DATABASE_URL_UNPOOLED = mismatch.direct ?? 'postgresql://synthetic.invalid/unused';
      process.env.CORNER_WORKER_SECRETS_JSON = JSON.stringify({
        DATABASE_URL: process.env.DATABASE_URL,
        NEON_AUTH_BASE_URL: 'https://auth.example.invalid/neondb/auth',
        BETTER_AUTH_SECRET: 'synthetic-session-secret-over-thirty-two-characters',
        CORNER_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 42).toString('base64'),
      });
      const f = fixture();
      f.github.baseline = async () => null;
      Object.assign(f.payload, {
        bootstrap: true, provisionedVersionId: oldVersion,
        productionAdoptionHost: mismatch.host ?? 'synthetic.invalid',
        baselineId: null, operatorRequired: true,
        qualification: { ...report, bootstrap: true, previousDigest: null },
      });
      await assert.rejects(promote(f.options), mismatch.pooled?.startsWith('https:')
        ? /Invalid bootstrap database binding/
        : /Production adoption database destinations differ from the approved host/);
      assert.deepEqual(f.effects, []);
    }
  } finally {
    for (const [key, value] of [
      ['DATABASE_URL', before.database], ['DATABASE_URL_UNPOOLED', before.direct],
      ['CORNER_WORKER_SECRETS_JSON', before.worker],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
