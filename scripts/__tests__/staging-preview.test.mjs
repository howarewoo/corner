import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { deployPreview, previewConfiguration, previewCredentials } from '../staging-preview.mjs';

const sourceSha = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const origin = 'https://staging-corner.example.workers.dev';
function environment() {
  const secrets = {
    DATABASE_URL: 'postgresql://owner:synthetic@ep-staging-pooler.example/neondb',
    NEON_AUTH_BASE_URL: 'https://staging-auth.example/neondb/auth',
    BETTER_AUTH_SECRET: 's'.repeat(32),
    CORNER_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  };
  return {
    CORNER_STAGING_ORIGIN: origin,
    CORNER_STAGING_BINDINGS_REVISION: 'test-1',
    CORNER_STAGING_CONFIG_JSON: JSON.stringify({
      CORNER_ORIGIN: origin,
      NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
    }),
    CORNER_WORKER_SECRETS_JSON: JSON.stringify(secrets),
    DATABASE_URL: secrets.DATABASE_URL,
    DATABASE_URL_UNPOOLED: 'postgresql://owner:synthetic@ep-staging.example/neondb',
    CORNER_STAGING_ACCESS_CLIENT_ID: 'synthetic-id',
    CORNER_STAGING_ACCESS_CLIENT_SECRET: 'synthetic-secret',
  };
}

test('Preview rejects production origins, extra runtime bindings, and disabled verification', () => {
  const env = environment();
  for (const configuration of [
    { CORNER_ORIGIN: 'https://corner.example.com', NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'true' },
    { CORNER_ORIGIN: origin, NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'false' },
    {
      CORNER_ORIGIN: origin,
      NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
      DATABASE_URL: 'private',
    },
  ])
    assert.throws(() => previewConfiguration(JSON.stringify(configuration), env));
});

test('Preview refuses a migration connection to a different database or owner', () => {
  const env = environment();
  for (const direct of [
    'postgresql://owner:synthetic@ep-production.example/neondb',
    'postgresql://other:synthetic@ep-staging.example/neondb',
    'postgresql://owner:synthetic@ep-staging.example/production',
  ]) {
    assert.throws(
      () => previewCredentials({ ...env, DATABASE_URL_UNPOOLED: direct }),
      /destinations must agree/,
    );
  }
});

async function scenario(t, overrides = {}) {
  const work = await mkdtemp(join(tmpdir(), 'corner-preview-boundary-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const effects = [];
  const github = {
    repository: 'owner/corner',
    all: async () => [],
    api: async (path, options) => {
      if (path === 'git/ref/heads/staging') return { object: { sha: sourceSha } };
      if (path.includes('/artifacts?'))
        return { artifacts: [{ id: 2, name: `corner-release-${sourceSha}` }] };
      if (options?.method === 'POST' && path === 'deployments') {
        const value = JSON.parse(options.body);
        effects.push(value.payload.phase);
        return { id: 3, payload: value.payload };
      }
      if (path === 'deployments/3/statuses') return {};
      throw new Error(`Unexpected request ${path}`);
    },
  };
  const candidate = {
    directory: work,
    digest,
    manifest: {
      migrationEntry: 'migration/dist/migrate.mjs',
      migrations: [],
      wranglerVersion: createRequire(new URL('../../apps/server/package.json', import.meta.url))(
        'wrangler/package.json',
      ).version,
    },
  };
  const options = {
    github,
    sourceSha,
    runId: '1',
    work,
    environment: environment(),
    loadArtifact: async () => candidate,
    qualify: async () => ({ passed: true, candidateDigest: digest, previousDigest: null }),
    verify: async () => ({ digest }),
    cf: async (path) => {
      if (path.endsWith('/deployments/latest')) return null;
      return path.endsWith('/subdomain') ? { previews_enabled: true } : { deployments: [] };
    },
    execute: () => {
      effects.push('migration');
      throw new Error('migration failed');
    },
    checkPublic: async () => {
      effects.push('public');
    },
    ...overrides,
  };
  return { options, effects };
}

async function uploadingScenario(t, workerName = 'corner') {
  const f = await scenario(t);
  const candidate = await f.options.loadArtifact();
  candidate.manifest.configurationEntry = 'wrangler.json';
  candidate.manifest.workerEntry = 'worker.js';
  await writeFile(
    join(candidate.directory, 'wrangler.json'),
    JSON.stringify({
      compatibility_date: '2026-10-19',
      compatibility_flags: ['nodejs_compat'],
      assets: { binding: 'ASSETS' },
    }),
  );
  let uploaded = false;
  f.options.execute = (binary, args, options) => {
    if (binary === process.execPath) {
      f.effects.push('migration');
      return '';
    }
    uploaded = true;
    f.effects.push('upload');
    if (options.env.WRANGLER_OUTPUT_FILE_PATH)
      writeFileSync(
        options.env.WRANGLER_OUTPUT_FILE_PATH,
        JSON.stringify({
          type: 'preview',
          version: 1,
          worker_name: workerName,
          preview_name: 'staging',
          preview_id: 'native-preview',
          preview_urls: [origin],
          deployment_id: 'native-deployment',
          deployment_urls: ['https://deployment.example.workers.dev'],
        }) + '\n',
      );
    return 'Building list of assets...\nStarting asset upload...\n{"preview":{},"deployment":{}}\n';
  };
  f.options.cf = async (path) => {
    if (path.endsWith('/deployments/latest'))
      return uploaded
        ? {
            id: 'native-deployment',
            env: {
              CORNER_ORIGIN: { type: 'plain_text', text: origin },
              ...Object.fromEntries(
                [
                  'DATABASE_URL',
                  'NEON_AUTH_BASE_URL',
                  'BETTER_AUTH_SECRET',
                  'CORNER_TOKEN_ENCRYPTION_KEY',
                ].map((name) => [name, { type: 'secret_text' }]),
              ),
            },
          }
        : null;
    return path.endsWith('/subdomain') ? { previews_enabled: true } : { deployments: [] };
  };
  return f;
}

test('successful upload with noisy stdout records and verifies the serving deployment', async (t) => {
  const f = await uploadingScenario(t);
  const result = await deployPreview(f.options);
  assert.equal(result.payload.deploymentId, 'native-deployment');
  assert.equal(result.payload.phase, 'complete');
  assert.deepEqual(f.effects, [
    'schema-attempted',
    'migration',
    'upload',
    'deployed',
    'public',
    'complete',
  ]);
});

test('machine output for another Worker cannot become the staging serving baseline', async (t) => {
  const f = await uploadingScenario(t, 'another-worker');
  await assert.rejects(deployPreview(f.options), /Native Preview identity or stable URL differs/);
  assert.deepEqual(f.effects, ['schema-attempted', 'migration', 'upload']);
});

test('superseded staging head cannot qualify, journal, or migrate', async (t) => {
  const f = await scenario(t);
  f.options.github.api = async () => ({ object: { sha: 'c'.repeat(40) } });
  f.options.qualify = async () => {
    throw new Error('must not qualify');
  };
  await assert.rejects(deployPreview(f.options), /Superseded staging/);
  assert.deepEqual(f.effects, []);
});

test('failed compatibility qualification cannot journal or migrate staging', async (t) => {
  const f = await scenario(t, {
    qualify: async () => {
      throw new Error('incompatible stored documents');
    },
  });
  await assert.rejects(deployPreview(f.options), /incompatible stored documents/);
  assert.deepEqual(f.effects, []);
});

test('migration failure leaves a schema journal without deploying a Preview', async (t) => {
  const f = await scenario(t);
  await assert.rejects(deployPreview(f.options), /migration failed/);
  assert.deepEqual(f.effects, ['schema-attempted', 'migration']);
});

test('native Preview routing must be enabled before any staging schema effect', async (t) => {
  const f = await scenario(t, {
    cf: async (path) => (path.endsWith('/deployments/latest') ? null : { previews_enabled: false }),
  });
  await assert.rejects(deployPreview(f.options), /Enable corner Preview URLs/);
  assert.deepEqual(f.effects, []);
});

async function interruptedDeployment(t) {
  const f = await scenario(t);
  const load = f.options.loadArtifact;
  const candidate = await load();
  const migration = { name: '0000_corner.sql', sha256: '1'.repeat(64), when: 1 };
  const attemptedMigration = { name: '0001_next.sql', sha256: '2'.repeat(64), when: 2 };
  candidate.manifest.migrations = [migration, attemptedMigration];
  const serving = {
    ...candidate,
    directory: join(f.options.work, 'serving-a'),
    digest: 'c'.repeat(64),
    manifest: { ...candidate.manifest, migrations: [migration] },
  };
  const attempted = {
    ...candidate,
    directory: join(f.options.work, 'attempted-b'),
    digest: 'd'.repeat(64),
  };
  const payload = {
    format: 4,
    kind: 'corner-staging-preview',
    workerName: 'corner',
    previewName: 'staging',
    origin,
    deploymentId: 'deployment-a',
  };
  f.options.github.all = async (path) =>
    path.includes('environment=staging-schema&')
      ? [{ payload: { ...payload, phase: 'schema-attempted', artifactId: 'b' } }]
      : [{ payload: { ...payload, phase: 'complete', artifactId: 'a' } }];
  f.options.loadArtifact = async ({ reference }) => {
    if (reference.artifactId === 'a') return serving;
    if (reference.artifactId === 'b') return attempted;
    return candidate;
  };
  const cf = f.options.cf;
  f.options.cf = async (path, options) =>
    path.endsWith('/deployments/latest') ? { id: 'deployment-a' } : cf(path, options);
  return { ...f, candidate, serving, attempted };
}

test('interrupted B schema attempt preserves A as C compatibility baseline', async (t) => {
  const f = await interruptedDeployment(t);
  let qualified = false;
  f.options.qualify = async ({ candidate, previous, bootstrap }) => {
    qualified = true;
    assert.equal(candidate, f.candidate.directory);
    assert.equal(previous, f.serving.directory);
    assert.equal(bootstrap, false);
    return { passed: true, candidateDigest: digest, previousDigest: f.serving.digest };
  };
  await assert.rejects(deployPreview(f.options), /migration failed/);
  assert.equal(qualified, true);
  assert.deepEqual(f.effects, ['schema-attempted', 'migration']);
});

test('C cannot remove or rewrite B attempted migrations while A serves', async (t) => {
  for (const rewrite of [false, true]) {
    const f = await interruptedDeployment(t);
    f.candidate.manifest = {
      ...f.candidate.manifest,
      migrations: rewrite
        ? [f.candidate.manifest.migrations[0], { name: '002.sql', sha256: 'e'.repeat(64) }]
        : f.serving.manifest.migrations,
    };
    f.options.qualify = async () => assert.fail('must reject before qualification');
    await assert.rejects(deployPreview(f.options), /CURRENT attempted migration history/);
    assert.deepEqual(f.effects, []);
  }
});

test('C incompatible with still-serving A cannot migrate after a B schema attempt', async (t) => {
  const f = await interruptedDeployment(t);
  f.options.qualify = async ({ previous }) => {
    assert.equal(previous, f.serving.directory);
    throw new Error('A cannot use C schema');
  };
  await assert.rejects(deployPreview(f.options), /A cannot use C schema/);
  assert.deepEqual(f.effects, []);
});

test('unrecorded live Preview cannot bootstrap or migrate', async (t) => {
  const f = await scenario(t, { cf: async () => ({ id: 'unrecorded' }) });
  await assert.rejects(deployPreview(f.options), /Live Preview deployment differs/);
  assert.deepEqual(f.effects, []);
});

test('live drift from serving ledger is rejected initially and after qualification', async (t) => {
  for (const driftAt of [1, 2]) {
    const f = await interruptedDeployment(t);
    const cf = f.options.cf;
    let reads = 0;
    f.options.cf = async (path, options) => {
      if (path.endsWith('/deployments/latest') && ++reads >= driftAt) return { id: 'drift' };
      return cf(path, options);
    };
    f.options.qualify = async () => ({
      passed: true,
      candidateDigest: digest,
      previousDigest: f.serving.digest,
    });
    await assert.rejects(deployPreview(f.options), /Live Preview deployment differs/);
    assert.deepEqual(f.effects, []);
  }
});

test('Preview rejects pre-Drizzle schema history before any effects', async (t) => {
  const f = await scenario(t);
  f.options.github.all = async (path) => path.includes('environment=staging-schema&')
    ? [{ payload: { format: 1, kind: 'corner-staging-preview', phase: 'schema-attempted' } }]
    : [];
  await assert.rejects(deployPreview(f.options));
  assert.deepEqual(f.effects, []);
});

async function cutoverScenario(t) {
  const f = await uploadingScenario(t);
  Object.assign(f.options.environment, {
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    PREVIEW_ADOPTION_RECEIPT: '7307415225',
    PREVIEW_ADOPTION_HOST: 'ep-staging.example',
  });
  const legacy = { id: 7307415225, payload: {
    format: 1, kind: 'corner-staging-preview', phase: 'complete', origin,
    sourceSha: 'c79f7de10c185a6f5862685967e1b9c8d5913dcc',
    workerName: 'corner', previewName: 'staging', runId: '7', artifactId: '8',
    candidateDigest: 'c'.repeat(64), runtimeConfigurationDigest: 'd'.repeat(64),
    bindingsRevision: 'legacy-1', qualification: { format: 1, passed: true },
    deploymentId: '5dad7d52-53cd-44ab-b2f5-2783196a35e9',
  } };
  let schema = { id: 7307413943, payload: { ...legacy.payload, phase: 'schema-attempted' } };
  f.options.github.all = async path => path.includes('environment=staging-schema&') ? [schema] : [legacy];
  const api = f.options.github.api;
  f.options.github.api = async (path, options) => {
    const result = await api(path, options);
    if (path === 'deployments' && result.payload.phase === 'schema-attempted') schema = result;
    return result;
  };
  const cf = f.options.cf;
  f.options.cf = async path => {
    const result = await cf(path);
    return path.endsWith('/deployments/latest') && !result ? { id: legacy.payload.deploymentId } : result;
  };
  const load = f.options.loadArtifact;
  f.candidate = await load();
  f.artifactReferences = [];
  f.options.loadArtifact = async ({ reference }) => {
    assert.notEqual(reference.sourceSha, legacy.payload.sourceSha, 'never execute or verify a legacy artifact');
    f.artifactReferences.push(reference);
    return f.candidate;
  };
  f.options.qualify = async ({ previous, bootstrap }) => {
    assert.equal(previous, undefined);
    assert.equal(bootstrap, true);
    return { passed: true, candidateDigest: digest, previousDigest: null };
  };
  return f;
}

test('manual pinned cutover distinguishes legacy evidence and retries an upload interruption', async t => {
  const f = await cutoverScenario(t);
  const execute = f.options.execute;
  let interrupted = true;
  f.options.execute = (binary, args, options) => {
    if (binary === process.execPath) {
      assert.ok(args.includes('--adopt-staging'));
      assert.equal(options.env.STAGING_ADOPTION_HOST, 'ep-staging.example');
    } else if (interrupted) throw new Error('upload interrupted before effects');
    return execute(binary, args, options);
  };
  await assert.rejects(deployPreview(f.options), /upload interrupted/);
  assert.deepEqual(f.effects, ['schema-attempted', 'migration']);
  assert.deepEqual(f.artifactReferences.map(({ runId, sourceSha: sha, artifactId, phase }) =>
    ({ runId, sourceSha: sha, artifactId, phase })),
  [{ runId: '1', sourceSha, artifactId: '2', phase: undefined }]);
  interrupted = false;
  const retryWork = await mkdtemp(join(tmpdir(), 'corner-preview-cutover-retry-'));
  t.after(() => rm(retryWork, { recursive: true, force: true }));
  f.options.work = retryWork;
  const result = await deployPreview(f.options);
  assert.equal(result.payload.stagingCutover.priorDrizzleQualification, false);
  assert.equal(result.payload.stagingCutover.legacyReceiptId, '7307415225');
  assert.equal(result.payload.qualification.previousDigest, null);
  assert.equal(result.payload.phase, 'complete');
  assert.deepEqual(f.artifactReferences.map(({ runId, sourceSha: sha, artifactId, phase }) =>
    ({ runId, sourceSha: sha, artifactId, phase })), [
    { runId: '1', sourceSha, artifactId: '2', phase: undefined },
    { runId: '1', sourceSha, artifactId: '2', phase: undefined },
    { runId: '1', sourceSha, artifactId: '2', phase: 'schema-attempted' },
  ]);
});

test('cutover rejects automatic invocation, incomplete pins, wrong host and wrong receipt before effects', async t => {
  for (const override of [
    { GITHUB_EVENT_NAME: 'workflow_run' },
    { PREVIEW_ADOPTION_RECEIPT: '' },
    { PREVIEW_ADOPTION_HOST: '' },
    { PREVIEW_ADOPTION_HOST: 'ep-production.example' },
    { PREVIEW_ADOPTION_RECEIPT: '7307415226' },
  ]) {
    const f = await cutoverScenario(t);
    Object.assign(f.options.environment, override);
    await assert.rejects(deployPreview(f.options));
    assert.deepEqual(f.effects, []);
  }
});

test('manual cutover still rejects a different serving receipt and live deployment drift', async t => {
  for (const live of [false, true]) {
    const f = await cutoverScenario(t);
    if (live) f.options.cf = async () => ({ id: 'unrecorded' });
    else f.options.github.all = async path => path.includes('environment=staging-schema&') ? [] : [{
      id: 7307415226, payload: { format: 1 },
    }];
    await assert.rejects(deployPreview(f.options));
    assert.deepEqual(f.effects, []);
  }
});

test('cutover rejects disagreement in legacy schema evidence without loading historical code', async t => {
  const f = await cutoverScenario(t);
  const all = f.options.github.all;
  f.options.github.all = async path => {
    const rows = await all(path);
    return path.includes('environment=staging-schema&')
      ? [{ ...rows[0], payload: { ...rows[0].payload, artifactId: 'different' } }]
      : rows;
  };
  await assert.rejects(deployPreview(f.options), /schema attempt differs/);
  assert.deepEqual(f.effects, []);
});

test('cutover retry preserves the already attempted native migration prefix', async t => {
  const f = await cutoverScenario(t);
  const candidate = f.candidate;
  const all = f.options.github.all;
  f.options.github.all = async path => path.includes('environment=staging-schema&') ? [{
    payload: { format: 4, kind: 'corner-staging-preview', phase: 'schema-attempted',
      stagingCutover: { legacyReceiptId: '7307415225',
        legacyDeploymentId: '5dad7d52-53cd-44ab-b2f5-2783196a35e9',
        databaseHost: 'ep-staging.example', priorDrizzleQualification: false } },
  }] : all(path);
  f.options.loadArtifact = async ({ reference }) => reference.sourceSha === sourceSha
    ? candidate : { ...candidate, manifest: { ...candidate.manifest, migrations: [{ name: 'attempted' }] } };
  await assert.rejects(deployPreview(f.options), /CURRENT attempted migration history/);
  assert.deepEqual(f.effects, []);
});
