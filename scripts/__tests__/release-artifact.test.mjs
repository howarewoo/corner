import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyArtifact, qualifyArtifact } from '../release-artifact.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, migration = 'CREATE TABLE example (id int);') {
  const directory = await mkdtemp(join(tmpdir(), 'corner-artifact-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const candidate = join(directory, 'candidate');
  const payload = {
    'worker/worker.js': 'export default { fetch() { return new Response("ok"); } };',
    'assets/index.html': '<html>artifact</html>',
    'migration/dist/migrate.mjs':
      'export async function migrate() { throw new Error("fixture is not executable qualification"); }',
    'migration/migrations/001_example.sql': migration,
    'wrangler.json': JSON.stringify({
      name: 'corner-server',
      main: 'worker/worker.js',
      no_bundle: true,
      compatibility_date: '2026-10-19',
      compatibility_flags: ['nodejs_compat'],
      workers_dev: false,
      preview_urls: false,
      assets: { directory: 'assets' },
      version_metadata: { binding: 'CF_VERSION_METADATA' },
    }),
    'frontend/worker.js': 'export default { fetch() { return new Response("frontend"); } };',
    'frontend/wrangler.json': JSON.stringify({
      name: 'corner-web',
      main: 'worker.js',
      no_bundle: true,
      compatibility_date: '2026-10-19',
      compatibility_flags: ['nodejs_compat'],
      workers_dev: false,
      preview_urls: false,
      assets: { directory: '../assets' },
      services: [{ binding: 'SERVER', service: 'corner-server' }],
      version_metadata: { binding: 'CF_VERSION_METADATA' },
    }),
  };
  for (const [name, bytes] of Object.entries(payload)) {
    await mkdir(join(candidate, name, '..'), { recursive: true });
    await writeFile(join(candidate, name), bytes);
  }
  const manifest = {
    format: 2,
    sourceSha: 'a'.repeat(40),
    lockfileSha256: 'b'.repeat(64),
    nodeVersion: 'v24.15.0',
    wranglerVersion: '4.152.0',
    configurationEntry: 'wrangler.json',
    configurationSha256: hash(payload['wrangler.json']),
    workerEntry: 'worker/worker.js',
    workerName: 'corner-server',
    frontendName: 'corner-web',
    frontendEntry: 'frontend/worker.js',
    frontendConfigurationEntry: 'frontend/wrangler.json',
    frontendConfigurationSha256: hash(payload['frontend/wrangler.json']),
    migrationEntry: 'migration/dist/migrate.mjs',
    files: Object.fromEntries(Object.entries(payload).map(([name, bytes]) => [name, hash(bytes)])),
    migrations: [{ name: '001_example.sql', sha256: hash(migration) }],
  };
  await writeFile(join(candidate, 'manifest.json'), JSON.stringify(manifest));
  return { directory, candidate, manifest };
}

test('verification binds exact manifest bytes and all packaged payloads', async (t) => {
  const { candidate, manifest } = await fixture(t);
  const result = await verifyArtifact(candidate);
  assert.deepEqual(result.manifest, manifest);
  assert.equal(result.digest, hash(await readFile(join(candidate, 'manifest.json'))));
  await writeFile(join(candidate, 'worker/worker.js'), 'tampered');
  await assert.rejects(verifyArtifact(candidate), /digest mismatch/);
});

test('unlisted files, symlinks, and manifest traversal are rejected', async (t) => {
  const { candidate, manifest, directory } = await fixture(t);
  const extra = join(candidate, 'worker/extra.js');
  await writeFile(extra, 'unexpected executable');
  await assert.rejects(verifyArtifact(candidate), /unlisted/);
  await rm(extra);
  await symlink(join(directory, 'outside'), extra);
  await assert.rejects(verifyArtifact(candidate), /Symlink/);
  await rm(extra);
  manifest.files['../outside.js'] = 'c'.repeat(64);
  await writeFile(join(candidate, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyArtifact(candidate), /unlisted|Unsafe/);
});

test('migration inventory and no-bundle configuration are verified independently', async (t) => {
  const { candidate, manifest } = await fixture(t);
  manifest.migrations[0].sha256 = 'd'.repeat(64);
  await writeFile(join(candidate, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyArtifact(candidate), /migration digest/);
  manifest.migrations[0].sha256 = manifest.files['migration/migrations/001_example.sql'];
  const bytes = JSON.stringify({
    name: 'corner',
    main: 'worker/worker.js',
    no_bundle: false,
    assets: { directory: 'assets' },
  });
  await writeFile(join(candidate, 'wrangler.json'), bytes);
  manifest.configurationSha256 = manifest.files['wrangler.json'] = hash(bytes);
  await writeFile(join(candidate, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyArtifact(candidate), /deployment configuration/);
});

test('qualification never infers bootstrap and cannot write inside an artifact', async (t) => {
  const { candidate } = await fixture(t);
  await assert.rejects(
    qualifyArtifact({ candidate, report: join(candidate, 'report.json') }),
    /exactly one/,
  );
  await assert.rejects(
    qualifyArtifact({
      candidate,
      bootstrap: true,
      previous: candidate,
      report: '/tmp/report.json',
    }),
    /exactly one/,
  );
  await assert.rejects(
    qualifyArtifact({ candidate, bootstrap: true, report: join(candidate, 'report.json') }),
    /outside/,
  );
});

test('missing or unqualified previous baselines fail before executing packaged code', async (t) => {
  const { candidate, directory } = await fixture(t);
  const prior = await fixture(t);
  const report = join(directory, 'qualification.json');
  await assert.rejects(
    qualifyArtifact({ candidate, previous: join(directory, 'missing'), report }),
    /ENOENT/,
  );
  await assert.rejects(qualifyArtifact({ candidate, previous: prior.candidate, report }), /ENOENT/);
  await writeFile(
    join(prior.directory, 'qualification.json'),
    JSON.stringify({
      format: 1,
      sourceSha: prior.manifest.sourceSha,
      candidateDigest: '0'.repeat(64),
      previousDigest: null,
      bootstrap: true,
      passed: true,
    }),
  );
  await assert.rejects(
    qualifyArtifact({ candidate, previous: prior.candidate, report }),
    /matching successful qualification/,
  );
  await assert.rejects(readFile(report), /ENOENT/);
});

test('removing or rewriting a qualified prior migration fails compatibility before smoke', async (t) => {
  const { candidate, directory } = await fixture(t, 'CREATE TABLE changed (id int);');
  const prior = await fixture(t);
  const { digest } = await verifyArtifact(prior.candidate);
  await writeFile(
    join(prior.directory, 'qualification.json'),
    JSON.stringify({
      format: 1,
      sourceSha: prior.manifest.sourceSha,
      candidateDigest: digest,
      previousDigest: null,
      bootstrap: true,
      passed: true,
    }),
  );
  const report = join(directory, 'qualification.json');
  await assert.rejects(
    qualifyArtifact({ candidate, previous: prior.candidate, report }),
    /removed or rewrote/,
  );
  await assert.rejects(readFile(report), /ENOENT/);
});

test('frontend binding changes cannot escape the qualified backend, even with matching payload digests', async (t) => {
  const { candidate, manifest } = await fixture(t);
  const config = JSON.parse(
    await readFile(join(candidate, manifest.frontendConfigurationEntry), 'utf8'),
  );
  config.services[0].service = 'unqualified-backend';
  const bytes = JSON.stringify(config);
  await writeFile(join(candidate, manifest.frontendConfigurationEntry), bytes);
  manifest.frontendConfigurationSha256 = manifest.files[manifest.frontendConfigurationEntry] =
    hash(bytes);
  await writeFile(join(candidate, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyArtifact(candidate), /frontend configuration or backend binding/);
});
