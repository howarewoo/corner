import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  deployPreview,
  completePreview,
  previewConfiguration,
  previewCredentials,
} from '../staging-preview.mjs';
import { PublicCheckError } from '../release.mjs';

const sourceSha = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const origin = 'https://staging-corner.example.workers.dev';
function environment() {
  const secrets = {
    DATABASE_URL: 'postgresql://owner:synthetic@ep-staging-pooler.example/neondb',
    NEON_AUTH_BASE_URL: 'https://staging-auth.example/neondb/auth',
  };
  return {
    CORNER_STAGING_ORIGIN: origin,
    CORNER_STAGING_BINDINGS_REVISION: 'test-1',
    CORNER_STAGING_CONFIG_JSON: JSON.stringify({
      CORNER_ORIGIN: origin,
      NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
    }),
    CORNER_WORKER_SECRETS_JSON: JSON.stringify(secrets),
    DATABASE_URL: secrets.DATABASE_URL,
    DATABASE_URL_UNPOOLED: 'postgresql://owner:synthetic@ep-staging.example/neondb',
    CORNER_STAGING_ACCESS_CLIENT_ID: 'synthetic-id',
    CORNER_STAGING_ACCESS_CLIENT_SECRET: 'synthetic-secret',
  };
}

test('Preview rejects production origins, extra runtime bindings, and enabled or invalid verification', () => {
  const env = environment();
  for (const configuration of [
    { CORNER_ORIGIN: 'https://corner.example.com', NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'false' },
    { CORNER_ORIGIN: origin },
    { CORNER_ORIGIN: origin, NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'true' },
    { CORNER_ORIGIN: origin, NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: false },
    { CORNER_ORIGIN: origin, NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: '0' },
    {
      CORNER_ORIGIN: origin,
      NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
      DATABASE_URL: 'private',
    },
  ])
    assert.throws(() => previewConfiguration(JSON.stringify(configuration), env));
});

test('Preview refuses a migration connection to a different database or owner', () => {
  const env = environment();
  const currentSecrets = JSON.parse(env.CORNER_WORKER_SECRETS_JSON);
  env.CORNER_WORKER_SECRETS_JSON = JSON.stringify({
    ...currentSecrets,
    retainedOpaqueConfiguration: { encrypted: 'synthetic-preserved-bytes' },
  });
  const retainedEnvironment = structuredClone(env);
  assert.deepEqual(previewCredentials(env), currentSecrets);
  assert.deepEqual(env, retainedEnvironment);
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
    generation: 'relational-v1',
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
    qualify: async () => ({
      passed: true,
      candidateDigest: digest,
      previousDigest: null,
      generation: 'relational-v1',
      previousGeneration: null,
      recovery: 'bootstrap',
    }),
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
              ...Object.fromEntries(
                Object.entries(JSON.parse(f.options.environment.CORNER_STAGING_CONFIG_JSON)).map(
                  ([name, text]) => [name, { type: 'plain_text', text }],
                ),
              ),
              ...Object.fromEntries(
                ['DATABASE_URL', 'NEON_AUTH_BASE_URL'].map((name) => [
                  name,
                  { type: 'secret_text' },
                ]),
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

test('dual-origin Preview refuses missing landing configuration before schema effects', async (t) => {
  const f = await scenario(t);
  const candidate = await f.options.loadArtifact();
  candidate.manifest.files = { 'assets/landing/index.html': 'c'.repeat(64) };
  await assert.rejects(deployPreview(f.options), /requires CORNER_LANDING_ORIGIN/);
  assert.deepEqual(f.effects, []);
  const value = JSON.parse(f.options.environment.CORNER_STAGING_CONFIG_JSON);
  value.CORNER_LANDING_ORIGIN = 'https://staging.previews.example.com';
  const configured = previewConfiguration(JSON.stringify(value), f.options.environment);
  assert.equal(configured.landingOrigin, value.CORNER_LANDING_ORIGIN);
  for (const invalid of [origin, 'http://staging.example.com', `${value.CORNER_LANDING_ORIGIN}/`])
    assert.throws(() =>
      previewConfiguration(
        JSON.stringify({ ...value, CORNER_LANDING_ORIGIN: invalid }),
        f.options.environment,
      ),
    );
});

test('single-site Preview cannot qualify an explicit dual-origin configuration', async (t) => {
  const f = await scenario(t);
  const value = JSON.parse(f.options.environment.CORNER_STAGING_CONFIG_JSON);
  value.CORNER_LANDING_ORIGIN = 'https://staging.previews.example.com';
  f.options.environment.CORNER_STAGING_CONFIG_JSON = JSON.stringify(value);
  let qualifications = 0;
  const qualify = f.options.qualify;
  f.options.qualify = async (...args) => {
    qualifications++;
    return qualify(...args);
  };
  await assert.rejects(deployPreview(f.options));
  assert.equal(qualifications, 0);
  assert.deepEqual(f.effects, []);
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
    return {
      passed: true,
      candidateDigest: digest,
      previousDigest: f.serving.digest,
      generation: 'relational-v1',
      previousGeneration: 'relational-v1',
      recovery: 'compatible',
    };
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
      generation: 'relational-v1',
      previousGeneration: 'relational-v1',
      recovery: 'compatible',
    });
    await assert.rejects(deployPreview(f.options), /Live Preview deployment differs/);
    assert.deepEqual(f.effects, []);
  }
});

test('Preview rejects pre-Drizzle schema and serving history before any effects', async (t) => {
  for (const environment of ['staging-schema', 'staging']) {
    const f = await scenario(t);
    f.options.github.all = async (path) =>
      path.includes(`environment=${environment}&`)
        ? [
            {
              payload: {
                format: 1,
                kind: 'corner-staging-preview',
                phase: environment === 'staging-schema' ? 'schema-attempted' : 'complete',
                workerName: 'corner',
                previewName: 'staging',
                origin,
                deploymentId: 'legacy-deployment',
              },
            },
          ]
        : [];
    await assert.rejects(deployPreview(f.options));
    assert.deepEqual(f.effects, []);
  }
});

async function completionScenario(t) {
  const f = await scenario(t);
  const config = previewConfiguration(
    f.options.environment.CORNER_STAGING_CONFIG_JSON,
    f.options.environment,
  );
  const p = {
    format: 4,
    kind: 'corner-staging-preview',
    workerName: 'corner',
    previewName: 'staging',
    sourceSha,
    runId: '1',
    artifactId: '2',
    candidateDigest: digest,
    origin,
    runtimeConfigurationDigest: config.digest,
    bindingsRevision: config.bindingsRevision,
    deploymentId: 'recorded-live',
    versionId: 'recorded-live',
    phase: 'deployed',
    qualification: {
      passed: true,
      candidateDigest: digest,
      sourceSha,
      generation: 'relational-v1',
    },
  };
  const current = { id: 9, payload: p };
  const schema = { id: 8, payload: { ...p, phase: 'schema-attempted' } };
  const statuses = [];
  f.options.github.all = async (path) =>
    structuredClone(path.includes('environment=staging-schema&') ? [schema] : [current]);
  f.options.github.api = async (path, options) => {
    if (path === 'git/ref/heads/staging') return { object: { sha: sourceSha } };
    if (path === 'deployments' && options?.method === 'POST') {
      const value = JSON.parse(options.body);
      f.effects.push(value.payload.phase);
      return { id: 10, payload: value.payload };
    }
    if (/^deployments\/\d+\/statuses$/.test(path)) {
      statuses.push({ id: Number(path.split('/')[1]), state: JSON.parse(options.body).state });
      return {};
    }
    throw new Error(`Unexpected completion request ${path}`);
  };
  const live = {
    id: p.deploymentId,
    env: {
      ...Object.fromEntries(
        Object.entries(config.value).map(([name, text]) => [name, { type: 'plain_text', text }]),
      ),
      CF_VERSION_METADATA: { type: 'version_metadata' },
      ...Object.fromEntries(
        ['DATABASE_URL', 'NEON_AUTH_BASE_URL'].map((name) => [name, { type: 'secret_text' }]),
      ),
    },
  };
  f.options.cf = async (path) =>
    path.endsWith('/deployments/latest') ? live : { deployments: [] };
  delete f.options.environment.CORNER_WORKER_SECRETS_JSON;
  delete f.options.environment.DATABASE_URL;
  delete f.options.environment.DATABASE_URL_UNPOOLED;
  return { ...f, current, schema, live, statuses };
}

test('pinned completion verifies the serving Preview without migration, upload, or private database keys', async (t) => {
  const f = await completionScenario(t);
  const completed = await completePreview({ ...f.options, deploymentId: '9' });
  assert.equal(completed.payload.deploymentId, f.live.id);
  assert.equal(completed.payload.phase, 'complete');
  assert.deepEqual(f.effects, ['public', 'complete']);
  assert.deepEqual(f.statuses, [
    { id: 8, state: 'success' },
    { id: 10, state: 'success' },
    { id: 9, state: 'inactive' },
  ]);
});

test('completion refuses a wrong pin, changed configuration, schema advance, artifact drift, or live drift', async (t) => {
  for (const change of ['pin', 'configuration', 'schema', 'artifact', 'live']) {
    const f = await completionScenario(t);
    if (change === 'configuration') f.current.payload.runtimeConfigurationDigest = 'c'.repeat(64);
    if (change === 'schema') f.schema.payload.candidateDigest = 'c'.repeat(64);
    if (change === 'artifact') f.options.verify = async () => ({ digest: 'c'.repeat(64) });
    if (change === 'live') f.live.id = 'unrecorded';
    await assert.rejects(
      completePreview({ ...f.options, deploymentId: change === 'pin' ? '7' : '9' }),
    );
    assert.deepEqual(f.effects, []);
    assert.deepEqual(f.statuses, []);
  }
});

test('a failing security probe keeps the Preview incomplete and marks its receipt failed', async (t) => {
  const f = await completionScenario(t);
  f.options.checkPublic = async () => {
    throw new PublicCheckError('Public cross-origin authentication boundary failed');
  };
  f.options.wait = async () => assert.fail('Security failures must not be retried');
  await assert.rejects(completePreview({ ...f.options, deploymentId: '9' }), /cross-origin/);
  assert.deepEqual(f.effects, []);
  assert.deepEqual(f.statuses, [{ id: 9, state: 'failure' }]);
});

test('schema or serving journal changes during public validation prevent a completed receipt', async (t) => {
  for (const target of ['schema', 'current']) {
    const f = await completionScenario(t);
    f.options.checkPublic = async () => {
      f[target].id++;
    };
    await assert.rejects(completePreview({ ...f.options, deploymentId: '9' }), /journal changed/);
    assert.deepEqual(f.effects, []);
    assert.equal(
      f.statuses.some((value) => value.state === 'success'),
      false,
    );
  }
});
