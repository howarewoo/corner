import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { productionReadiness } from '../production-readiness.mjs';

const sourceSha = 'a'.repeat(40);
const settings = {
  CORNER_ORIGIN: 'https://app.example.com',
  CORNER_LANDING_ORIGIN: 'https://example.com',
  CORNER_DOCS_ORIGIN: 'https://docs.example.com',
  NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
};
const files = {
  'assets/landing/index.html': 'b'.repeat(64),
  'assets/docs/index.html': 'b'.repeat(64),
  'assets/docs/search-index.json': 'b'.repeat(64),
};

function scenario() {
  const reads = [];
  const options = {
    github: {
      repository: 'owner/corner',
      api: async (path, request) => {
        assert.equal(request?.method ?? 'GET', 'GET');
        reads.push(path);
        if (path === 'git/ref/heads/staging') return { object: { sha: sourceSha } };
        if (path === 'actions/runs/1/artifacts?per_page=100')
          return { artifacts: [{ id: 2, name: `corner-release-${sourceSha}`, expired: false }] };
        throw new Error(`Unexpected readiness request: ${path}`);
      },
    },
    runId: '1',
    sourceSha,
    configuration: JSON.stringify(settings),
    origin: settings.CORNER_ORIGIN,
    revision: 'test-1',
    work: tmpdir(),
    loadArtifact: async () => ({ digest: 'c'.repeat(64), manifest: { files } }),
  };
  return { options, reads };
}

test('production origin capability mismatch blocks readiness for new and retained artifact profiles', async () => {
  for (const [inventory, configuration, error] of [
    [
      files,
      { CORNER_ORIGIN: settings.CORNER_ORIGIN, NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'true' },
      /requires CORNER_DOCS_ORIGIN/,
    ],
    [
      { 'assets/landing/index.html': 'b'.repeat(64) },
      { CORNER_ORIGIN: settings.CORNER_ORIGIN, NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'true' },
      /requires CORNER_LANDING_ORIGIN/,
    ],
    [{}, settings, /without docs cannot serve CORNER_DOCS_ORIGIN/],
  ]) {
    const { options } = scenario();
    options.configuration = JSON.stringify(configuration);
    options.loadArtifact = async () => ({ manifest: { files: inventory } });
    await assert.rejects(productionReadiness(options), error);
  }
});

test('incomplete or inconsistent repository production settings cannot produce readiness', async () => {
  for (const changed of [
    { configuration: undefined },
    { origin: undefined },
    { revision: undefined },
    { origin: 'https://other.example.com' },
  ]) {
    const { options, reads } = scenario();
    await assert.rejects(
      productionReadiness({ ...options, ...changed }),
      /required|origin differs/,
    );
    assert.deepEqual(reads, []);
  }
});

test('a superseded candidate cannot pass before or after artifact verification', async () => {
  for (const driftAfterLoad of [false, true]) {
    const { options } = scenario();
    const api = options.github.api;
    let loaded = false;
    options.loadArtifact = async () => {
      loaded = true;
      return { manifest: { files } };
    };
    options.github.api = async (path, request) => {
      if (path === 'git/ref/heads/staging' && (!driftAfterLoad || loaded))
        return { object: { sha: 'd'.repeat(40) } };
      return api(path, request);
    };
    await assert.rejects(productionReadiness(options), /Superseded staging candidate/);
    assert.equal(loaded, driftAfterLoad);
  }
});

test('missing, expired, or ambiguous release candidates cannot produce readiness', async () => {
  for (const artifacts of [
    [],
    [{ id: 2, name: `corner-release-${sourceSha}`, expired: true }],
    [2, 3].map((id) => ({ id, name: `corner-release-${sourceSha}`, expired: false })),
  ]) {
    const { options } = scenario();
    const api = options.github.api;
    options.github.api = async (path, request) =>
      path.includes('/artifacts?') ? { artifacts } : api(path, request);
    options.loadArtifact = async () => assert.fail('An unselected artifact must not be loaded.');
    await assert.rejects(productionReadiness(options), /Exactly one unexpired qualified staging/);
  }
});
