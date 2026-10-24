import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
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
    cf: async (path) =>
      path.endsWith('/subdomain') ? { previews_enabled: true } : { deployments: [] },
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
  const f = await scenario(t, { cf: async () => ({ previews_enabled: false }) });
  await assert.rejects(deployPreview(f.options), /Enable corner Preview URLs/);
  assert.deepEqual(f.effects, []);
});
