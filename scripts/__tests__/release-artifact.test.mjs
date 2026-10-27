import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  packageArtifact,
  verifyArtifact,
  qualifyArtifact,
  qualificationRecovery,
  assertQualificationGeneration,
} from '../release-artifact.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('published initial migration snapshot retains its immutable digest', async () => {
  const snapshot = await readFile(
    new URL('../../apps/server/migrations/meta/0000_snapshot.json', import.meta.url),
  );
  assert.equal(hash(snapshot), '6fc033de3477b3926ebfa00dd322c44c0e6306b22d18d82d1f6213dd4642cf9c');
});

test('storage transition is artifact-derived, distinct from bootstrap, and cannot qualify document recovery', () => {
  const document = { generation: 'document-v1' };
  const relational = { generation: 'relational-v1' };
  assert.equal(qualificationRecovery(relational), 'bootstrap');
  assert.equal(qualificationRecovery(relational, document), 'forward-only');
  assert.equal(qualificationRecovery(relational, document, true), 'preserving');
  assert.equal(qualificationRecovery(relational, relational), 'compatible');
  assert.throws(() => qualificationRecovery(document, relational), /Unsupported/);
  for (const report of [
    { generation: 'relational-v1', previousGeneration: 'document-v1', recovery: 'compatible' },
    { generation: 'relational-v1', previousGeneration: null, recovery: 'bootstrap' },
    { generation: 'document-v1', previousGeneration: 'document-v1', recovery: 'compatible' },
    { generation: 'relational-v1', previousGeneration: 'document-v1', recovery: 'preserving' },
  ])
    assert.throws(
      () => assertQualificationGeneration(report, relational, document),
      /generation mismatch/,
    );
  assert.doesNotThrow(() =>
    assertQualificationGeneration(
      {
        generation: 'relational-v1',
        previousGeneration: 'document-v1',
        recovery: 'forward-only',
      },
      relational,
      document,
    ),
  );
  assert.doesNotThrow(() => assertQualificationGeneration({
    generation: 'relational-v1', previousGeneration: 'document-v1', recovery: 'preserving',
  }, relational, document, true));
  assert.throws(() => assertQualificationGeneration({
    generation: 'relational-v1', previousGeneration: 'document-v1', recovery: 'forward-only',
  }, relational, document, true), /generation mismatch/);
});
async function fixture(t, migration = 'CREATE TABLE example (id int);') {
  const directory = await mkdtemp(join(tmpdir(), 'corner-artifact-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const candidate = join(directory, 'candidate');
  const payload = {
    'worker/worker.js': 'export default { fetch() { return new Response("ok"); } };',
    'assets/index.html': '<html>artifact</html>',
    'migration/dist/migrate.mjs':
      'throw new Error("Artifact verification must not execute payload code");',
    'migration/migrations/0000_example.sql': migration,
    'migration/migrations/meta/_journal.json': JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: [{ idx: 0, version: '7', when: 1, tag: '0000_example', breakpoints: true }],
    }),
    'migration/migrations/meta/0000_snapshot.json': JSON.stringify({
      id: '11111111-1111-4111-8111-111111111111',
      prevId: '00000000-0000-0000-0000-000000000000',
      version: '7',
      dialect: 'postgresql',
      tables: {},
    }),
    'wrangler.json': JSON.stringify({
      name: 'corner',
      main: 'worker/worker.js',
      no_bundle: true,
      compatibility_date: '2026-10-19',
      compatibility_flags: ['nodejs_compat'],
      workers_dev: false,
      preview_urls: true,
      assets: {
        directory: 'assets',
        binding: 'ASSETS',
        run_worker_first: true,
        html_handling: 'none',
        not_found_handling: 'none',
      },
      observability: { enabled: true, logs: { invocation_logs: false } },
      version_metadata: { binding: 'CF_VERSION_METADATA' },
    }),
  };
  for (const [name, bytes] of Object.entries(payload)) {
    await mkdir(join(candidate, name, '..'), { recursive: true });
    await writeFile(join(candidate, name), bytes);
  }
  const manifest = {
    format: 4,
    sourceSha: 'a'.repeat(40),
    lockfileSha256: 'b'.repeat(64),
    nodeVersion: 'v24.15.0',
    wranglerVersion: '4.152.0',
    configurationEntry: 'wrangler.json',
    configurationSha256: hash(payload['wrangler.json']),
    workerEntry: 'worker/worker.js',
    workerName: 'corner',
    migrationEntry: 'migration/dist/migrate.mjs',
    files: Object.fromEntries(Object.entries(payload).map(([name, bytes]) => [name, hash(bytes)])),
    migrations: [
      {
        name: '0000_example.sql',
        sha256: hash(migration),
        when: 1,
        journalSha256: hash(
          JSON.stringify(JSON.parse(payload['migration/migrations/meta/_journal.json']).entries[0]),
        ),
        snapshotSha256: hash(payload['migration/migrations/meta/0000_snapshot.json']),
      },
    ],
  };
  await writeFile(join(candidate, 'manifest.json'), JSON.stringify(manifest));
  return { directory, candidate, manifest };
}

test('verified snapshot generation cannot be relabelled by a report or an ambiguous tip', async (t) => {
  const { candidate, manifest } = await fixture(t);
  assert.equal((await verifyArtifact(candidate)).generation, 'document-v1');
  const path = 'migration/migrations/meta/0000_snapshot.json';
  const snapshot = JSON.parse(await readFile(join(candidate, path), 'utf8'));
  snapshot.tables['public.workspace_metadata'] = {};
  let bytes = JSON.stringify(snapshot);
  await writeFile(join(candidate, path), bytes);
  manifest.files[path] = manifest.migrations[0].snapshotSha256 = hash(bytes);
  await writeFile(join(candidate, 'manifest.json'), JSON.stringify(manifest));
  assert.equal((await verifyArtifact(candidate)).generation, 'relational-v1');
  snapshot.tables['public.workspace_state'] = {};
  bytes = JSON.stringify(snapshot);
  await writeFile(join(candidate, path), bytes);
  manifest.files[path] = manifest.migrations[0].snapshotSha256 = hash(bytes);
  await writeFile(join(candidate, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyArtifact(candidate), /Ambiguous/);
});

test('packaging canonicalizes JSONC comments and trailing commas but rejects malformed configs', async (t) => {
  const { directory, candidate } = await fixture(t);
  const sourceRoot = join(directory, 'source');
  const inputs = {
    'package.json': '{"type":"module"}',
    'pnpm-lock.yaml': 'lockfileVersion: "9.0"\n',
    ...Object.fromEntries(
      ['nutrition', 'training', 'workspace', 'agent'].map((name) => [
        `packages/${name}/dist/index.js`,
        'export {};',
      ]),
    ),
    'apps/server/dist/worker/maintenance-worker.js':
      'export default { fetch() { return new Response("maintenance", { status: 503 }); } };',
    'apps/server/dist/migrate.js':
      'export function migrate() { throw new Error("packaging fixture"); } export function migrationCli() { throw new Error("packaging fixture CLI"); } export function preservingDocumentCutover() { throw new Error("packaging fixture"); } export function inspectDocumentCutover() { throw new Error("packaging fixture"); } export function cutoverRecoverySchema() { throw new Error("packaging fixture"); } export function directDatabaseUrl() { throw new Error("packaging fixture"); }',
    'apps/server/dist/database.js':
      'export function createDatabase() { throw new Error("packaging fixture"); }',
    'apps/server/dist/persisted-records.js':
      'export const storageGeneration = "relational-v1"; export function validatePersistedRecords() { throw new Error("packaging fixture"); }',
    'apps/server/dist/migration-history.js':
      'export function currentSchema() { throw new Error("packaging fixture"); } export function migrationHistory() { throw new Error("packaging fixture"); }',
    'apps/server/dist/migration-inventory.js': `export { migrationInventory } from ${JSON.stringify(fileURLToPath(new URL('../../apps/server/src/migration-inventory.ts', import.meta.url)))};`,
    'apps/server/wrangler.jsonc': await readFile(join(candidate, 'wrangler.json')),
  };
  for (const [name, bytes] of Object.entries(inputs)) {
    await mkdir(join(sourceRoot, name, '..'), { recursive: true });
    await writeFile(join(sourceRoot, name), bytes);
  }
  for (const app of ['server', 'web']) {
    await mkdir(join(sourceRoot, `apps/${app}`), { recursive: true });
    await symlink(
      fileURLToPath(new URL(`../../apps/${app}/node_modules`, import.meta.url)),
      join(sourceRoot, `apps/${app}/node_modules`),
      'dir',
    );
  }
  for (const [from, to] of [
    ['worker/worker.js', 'apps/server/dist/worker/worker.js'],
    ['assets/index.html', 'apps/web/dist/index.html'],
    ['migration/migrations/0000_example.sql', 'apps/server/migrations/0000_example.sql'],
    ['migration/migrations/meta/_journal.json', 'apps/server/migrations/meta/_journal.json'],
    [
      'migration/migrations/meta/0000_snapshot.json',
      'apps/server/migrations/meta/0000_snapshot.json',
    ],
  ]) {
    await mkdir(join(sourceRoot, to, '..'), { recursive: true });
    await copyFile(join(candidate, from), join(sourceRoot, to));
  }
  const options = { root: sourceRoot, sourceSha: 'a'.repeat(40) };
  const plain = await packageArtifact({ ...options, out: join(directory, 'plain') });
  const path = join(sourceRoot, 'apps/server/wrangler.jsonc');
  const json = JSON.stringify(JSON.parse(await readFile(path, 'utf8')), null, 2);
  await writeFile(path, `// Wrangler JSONC\n/* format-only change */\n${json.slice(0, -2)},\n}\n`);
  const jsonc = await packageArtifact({ ...options, out: join(directory, 'jsonc') });
  assert.equal(jsonc.digest, plain.digest, 'JSONC formatting must not change the release payload.');
  assert.equal(plain.manifest.maintenanceWorkerEntry, 'worker/maintenance-worker.js');
  assert.ok(plain.manifest.files['worker/maintenance-worker.js']);
  await writeFile(path, '{"name": }');
  await assert.rejects(
    packageArtifact({ ...options, out: join(directory, 'malformed') }),
    /ValueExpected/,
  );
});

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
  await assert.rejects(verifyArtifact(candidate));
  manifest.migrations[0].sha256 = manifest.files['migration/migrations/0000_example.sql'];
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

test('preserving qualification requires a packaged maintenance Worker entry', async (t) => {
  const { candidate, directory } = await fixture(t);
  await assert.rejects(
    qualifyArtifact({
      candidate,
      previous: candidate,
      preserving: true,
      report: join(directory, 'preserving-report.json'),
    }),
    /maintenance Worker entry/,
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

test('unsafe runtime configuration is rejected even with matching payload digests', async (t) => {
  for (const mutate of [
    (config) => {
      config.services = [{ binding: 'SERVER', service: 'other' }];
    },
    (config) => {
      config.assets.run_worker_first = false;
    },
    (config) => {
      config.assets.binding = 'OTHER';
    },
    (config) => {
      config.assets.html_handling = 'auto-trailing-slash';
    },
    (config) => {
      config.assets.not_found_handling = 'single-page-application';
    },
    (config) => {
      config.version_metadata.binding = 'OTHER';
    },
    (config) => {
      config.observability.logs.invocation_logs = true;
    },
    (config) => {
      config.workers_dev = true;
    },
    (config) => {
      config.preview_urls = false;
    },
  ]) {
    const { candidate, manifest } = await fixture(t);
    const config = JSON.parse(await readFile(join(candidate, 'wrangler.json'), 'utf8'));
    mutate(config);
    const bytes = JSON.stringify(config);
    await writeFile(join(candidate, 'wrangler.json'), bytes);
    manifest.configurationSha256 = manifest.files['wrangler.json'] = hash(bytes);
    await writeFile(join(candidate, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(verifyArtifact(candidate), /deployment configuration/);
  }
});

test('pre-Drizzle artifacts are ineligible', async (t) => {
  for (const format of [1, 2, 3]) {
    const { candidate, manifest } = await fixture(t);
    manifest.format = format;
    await writeFile(join(candidate, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(verifyArtifact(candidate));
  }
});

test('single-worker manifests reject obsolete fields and payload directories', async (t) => {
  const { candidate, manifest } = await fixture(t);
  manifest.frontendName = 'obsolete';
  await writeFile(join(candidate, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyArtifact(candidate));
  delete manifest.frontendName;
  await mkdir(join(candidate, 'frontend'));
  await writeFile(join(candidate, 'frontend/worker.js'), 'obsolete');
  manifest.files['frontend/worker.js'] = hash('obsolete');
  await writeFile(join(candidate, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyArtifact(candidate), /Forbidden payload/);
});

test('qualified migration inventory must remain the candidate prefix', async (t) => {
  const { candidate, directory, manifest } = await fixture(t);
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
  const name = 'migration/migrations/meta/_journal.json';
  const journal = JSON.parse(await readFile(join(candidate, name), 'utf8'));
  journal.entries[0].when = 2;
  const bytes = JSON.stringify(journal);
  await writeFile(join(candidate, name), bytes);
  manifest.files[name] = hash(bytes);
  manifest.migrations[0].when = 2;
  manifest.migrations[0].journalSha256 = hash(JSON.stringify(journal.entries[0]));
  await writeFile(join(candidate, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(
    qualifyArtifact({
      candidate,
      previous: prior.candidate,
      report: join(directory, 'qualification.json'),
    }),
    /must remain a prefix/,
  );
});

test('Kit SQL and metadata must be exact listed immutable inputs', async (t) => {
  for (const name of [
    'migration/migrations/0000_example.sql',
    'migration/migrations/meta/_journal.json',
    'migration/migrations/meta/0000_snapshot.json',
  ]) {
    const { candidate } = await fixture(t);
    await writeFile(join(candidate, name), 'tampered');
    await assert.rejects(verifyArtifact(candidate));
    await rm(join(candidate, name));
    await assert.rejects(verifyArtifact(candidate));
  }
  const { candidate, manifest } = await fixture(t);
  const name = 'migration/migrations/meta/extra.json';
  await writeFile(join(candidate, name), '{}');
  manifest.files[name] = hash('{}');
  await writeFile(join(candidate, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyArtifact(candidate));
});

test('published Kit metadata cannot change before executing candidate code', async (t) => {
  for (const kind of ['snapshot', 'journal']) {
    const f = await fixture(t);
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
    const marker = join(f.directory, 'candidate-executed');
    const entry = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); throw new Error('unexpected execution');`;
    await writeFile(join(f.candidate, f.manifest.migrationEntry), entry);
    f.manifest.files[f.manifest.migrationEntry] = hash(entry);
    const name = `migration/migrations/meta/${kind === 'snapshot' ? '0000_snapshot.json' : '_journal.json'}`;
    const metadata = JSON.parse(await readFile(join(f.candidate, name), 'utf8'));
    if (kind === 'snapshot') metadata.tables['public.changed'] = {};
    else metadata.entries[0].breakpoints = false;
    const bytes = JSON.stringify(metadata);
    await writeFile(join(f.candidate, name), bytes);
    f.manifest.files[name] = hash(bytes);
    f.manifest.migrations[0][kind === 'snapshot' ? 'snapshotSha256' : 'journalSha256'] = hash(
      kind === 'snapshot' ? bytes : JSON.stringify(metadata.entries[0]),
    );
    await writeFile(join(f.candidate, 'manifest.json'), JSON.stringify(f.manifest));
    await verifyArtifact(f.candidate);
    await assert.rejects(
      qualifyArtifact({
        candidate: f.candidate,
        previous: prior.candidate,
        report: join(f.directory, 'qualification.json'),
      }),
    );
    assert.equal(
      existsSync(marker),
      false,
      'changed published metadata must be rejected before code execution',
    );
  }
});
