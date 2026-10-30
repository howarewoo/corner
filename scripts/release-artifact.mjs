import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { migrationInventory } from '../apps/server/src/migration-inventory.ts';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safe = (name) =>
  typeof name === 'string' &&
  Boolean(name) &&
  !name.includes('\\') &&
  !name.includes('\0') &&
  !name.startsWith('/') &&
  name.split('/').every((part) => part && !part.startsWith('.'));
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

async function inventory(directory, prefix = '', hashContent = true) {
  if (!(await lstat(directory)).isDirectory())
    throw new Error('Artifact directories must be real directories.');
  const files = Object.create(null);
  for (const name of (await readdir(directory)).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (!safe(path)) throw new Error(`Unsafe artifact path: ${path}`);
    const entry = join(directory, name);
    const stat = await lstat(entry);
    if (stat.isSymbolicLink()) throw new Error(`Symlink forbidden: ${path}`);
    if (stat.isDirectory()) Object.assign(files, await inventory(entry, path, hashContent));
    else if (stat.isFile()) files[path] = hashContent ? hash(await readFile(entry)) : '';
    else throw new Error(`Nonregular artifact file: ${path}`);
  }
  return files;
}

export async function verifyArtifact(directory) {
  directory = resolve(directory);
  const files = await inventory(directory);
  const bytes = await readFile(join(directory, 'manifest.json'));
  const manifest = JSON.parse(bytes);
  if (
    !object(manifest) ||
    manifest.format !== 4 ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceSha) ||
    !sha(manifest.lockfileSha256) ||
    !/^v24\.(?:1[5-9]|[2-9]\d|\d{3,})\.\d+$/.test(manifest.nodeVersion) ||
    !/^\d+\.\d+\.\d+$/.test(manifest.wranglerVersion) ||
    !object(manifest.files) ||
    !Array.isArray(manifest.migrations) ||
    (manifest.recoveryEpoch !== undefined &&
      (!Number.isSafeInteger(manifest.recoveryEpoch) || manifest.recoveryEpoch < 0)) ||
    Object.keys(manifest).some(
      (key) =>
        ![
          'format',
          'sourceSha',
          'lockfileSha256',
          'nodeVersion',
          'wranglerVersion',
          'configurationSha256',
          'configurationEntry',
          'workerEntry',
          'maintenanceWorkerEntry',
          'workerName',
          'migrationEntry',
          'files',
          'migrations',
          'recoveryEpoch',
        ].includes(key),
    )
  )
    throw new Error(
      'Invalid format-4 artifact; pre-Drizzle artifacts are retired recovery targets.',
    );
  delete files['manifest.json'];
  const names = Object.keys(manifest.files).sort();
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(files).sort()))
    throw new Error('Artifact contains missing or unlisted files.');
  for (const name of names) {
    if (!safe(name) || !sha(manifest.files[name]) || files[name] !== manifest.files[name])
      throw new Error(`Artifact digest mismatch: ${name}`);
    if (
      !/^(worker\/|assets\/|migration\/|wrangler\.json$)/.test(name) ||
      /\.(?:map|pem|key|env)$/i.test(name)
    )
      throw new Error(`Forbidden payload: ${name}`);
  }
  if (
    manifest.configurationEntry !== 'wrangler.json' ||
    manifest.migrationEntry !== 'migration/dist/migrate.mjs' ||
    manifest.workerEntry !== 'worker/worker.js' ||
    !files[manifest.workerEntry] ||
    !files[manifest.migrationEntry] ||
    !files['assets/index.html'] ||
    files['wrangler.json'] !== manifest.configurationSha256 ||
    (manifest.maintenanceWorkerEntry !== undefined &&
      (manifest.maintenanceWorkerEntry !== 'worker/maintenance-worker.js' ||
        !files[manifest.maintenanceWorkerEntry]))
  )
    throw new Error('Invalid artifact entry points.');
  const config = JSON.parse(await readFile(join(directory, 'wrangler.json'), 'utf8'));
  const configKeys = new Set([
    'name',
    'main',
    'no_bundle',
    'compatibility_date',
    'compatibility_flags',
    'workers_dev',
    'preview_urls',
    'assets',
    'observability',
    'version_metadata',
  ]);
  if (
    !object(config) ||
    Object.keys(config).some((key) => !configKeys.has(key)) ||
    config.no_bundle !== true ||
    config.main !== manifest.workerEntry ||
    config.name !== 'corner' ||
    manifest.workerName !== config.name ||
    !/^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date) ||
    !Array.isArray(config.compatibility_flags) ||
    !config.compatibility_flags.includes('nodejs_compat') ||
    config.assets?.directory !== 'assets' ||
    config.workers_dev !== false ||
    config.preview_urls !== true ||
    config.assets?.binding !== 'ASSETS' ||
    config.assets?.run_worker_first !== true ||
    config.assets?.html_handling !== 'none' ||
    config.assets?.not_found_handling !== 'none' ||
    Object.keys(config.assets).some(
      (key) =>
        ![
          'directory',
          'binding',
          'run_worker_first',
          'html_handling',
          'not_found_handling',
        ].includes(key),
    ) ||
    config.version_metadata?.binding !== 'CF_VERSION_METADATA' ||
    Object.keys(config.version_metadata).length !== 1 ||
    config.observability?.enabled !== true ||
    config.observability?.logs?.invocation_logs !== false ||
    Object.keys(config.observability).some((key) => !['enabled', 'logs'].includes(key)) ||
    Object.keys(config.observability.logs).some((key) => key !== 'invocation_logs')
  )
    throw new Error('Unsafe packaged deployment configuration.');
  const migrations = await migrationInventory(join(directory, 'migration/migrations'));
  if (!isDeepStrictEqual(manifest.migrations, migrations))
    throw new Error('Artifact migration inventory differs from validated Kit metadata.');
  const snapshot = JSON.parse(
    await readFile(
      join(
        directory,
        'migration/migrations/meta',
        `${String(migrations.length - 1).padStart(4, '0')}_snapshot.json`,
      ),
      'utf8',
    ),
  );
  const tables = snapshot.tables;
  const relational = Object.hasOwn(tables, 'public.workspace_metadata');
  if (relational && Object.hasOwn(tables, 'public.workspace_state'))
    throw new Error('Ambiguous artifact storage generation.');
  return {
    manifest,
    digest: hash(bytes),
    generation: relational ? 'relational-v1' : 'document-v1',
  };
}

export function qualificationRecovery(current, prior, preserving = false) {
  if (!prior) {
    if (preserving)
      throw new Error('Preserving cutover qualification requires a previous artifact.');
    return 'bootstrap';
  }
  if (current.generation === prior.generation) {
    if (preserving)
      throw new Error(
        'Preserving cutover qualification requires a document-to-relational transition.',
      );
    if (current.generation !== 'relational-v1') return 'compatible';
    const currentEpoch = current.manifest?.recoveryEpoch ?? 0;
    const priorEpoch = prior.manifest?.recoveryEpoch ?? 0;
    if (currentEpoch < priorEpoch)
      throw new Error(
        'Candidate recovery epoch predates the previous artifact; forward repair required.',
      );
    if (currentEpoch > priorEpoch) return 'forward-only';
    return 'compatible';
  }
  if (current.generation === 'relational-v1' && prior.generation === 'document-v1')
    return preserving ? 'preserving' : 'forward-only';
  throw new Error('Unsupported artifact storage generation transition.');
}

export function assertQualificationGeneration(report, current, prior, preserving = false) {
  if (
    report.generation !== current.generation ||
    report.previousGeneration !== (prior?.generation ?? null) ||
    report.recovery !== qualificationRecovery(current, prior, preserving)
  )
    throw new Error('Qualification storage generation mismatch.');
}

async function copyTree(source, destination) {
  const files = await inventory(source, '', false);
  for (const name of Object.keys(files)) {
    if (name.endsWith('.map') || name === 'README.md') continue;
    if (/\.(?:map|pem|key|env)$/i.test(name) || name.startsWith('.'))
      throw new Error(`Forbidden packaging input: ${name}`);
    await mkdir(dirname(join(destination, name)), { recursive: true });
    await copyFile(join(source, name), join(destination, name));
  }
}

export async function packageArtifact({ root: sourceRoot = root, out, sourceSha }) {
  sourceRoot = resolve(sourceRoot);
  out = resolve(out);
  sourceSha ??= execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: sourceRoot,
    encoding: 'utf8',
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('A full source SHA is required.');
  const serverRequire = createRequire(join(sourceRoot, 'apps/server/package.json'));
  const webRequire = createRequire(join(sourceRoot, 'apps/web/package.json'));
  const { experimental_readRawConfig } = await import(serverRequire.resolve('wrangler'));
  const recoveryEpoch = JSON.parse(
    await readFile(join(sourceRoot, 'apps/server/package.json'), 'utf8'),
  ).corner?.recoveryEpoch;
  if (!Number.isSafeInteger(recoveryEpoch) || recoveryEpoch < 1)
    throw new Error('Packaging requires an explicit positive recovery epoch.');
  for (const name of ['nutrition', 'training', 'workspace']) {
    const files = await readdir(join(sourceRoot, 'packages', name, 'dist')).catch(() => []);
    if (!files.some((file) => file.endsWith('.js')))
      throw new Error(`Build ${name} before packaging.`);
  }
  await access(join(sourceRoot, 'apps/server/dist/migrate.js'));
  const workerSource = join(sourceRoot, 'apps/server/dist/worker');
  await access(join(workerSource, 'worker.js'));
  await access(join(workerSource, 'maintenance-worker.js'));
  await access(join(sourceRoot, 'apps/web/dist/index.html'));
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out); // Deliberately not recursive: existing outputs are immutable.
  await copyTree(workerSource, join(out, 'worker'));
  await copyTree(join(sourceRoot, 'apps/web/dist'), join(out, 'assets'));
  await copyTree(join(sourceRoot, 'apps/server/migrations'), join(out, 'migration/migrations'));
  await mkdir(join(out, 'migration/dist'), { recursive: true });
  const { build } = await import(webRequire.resolve('esbuild'));
  await build({
    stdin: {
      contents:
        "export { migrate, migrationCli, preservingDocumentCutover, inspectDocumentCutover, cutoverRecoverySchema, directDatabaseUrl } from './migrate.js'; export { migrationInventory } from './migration-inventory.js'; export { migrationHistory, currentSchema } from './migration-history.js'; export { createDatabase } from './database.js'; export { storageGeneration, validatePersistedRecords } from './persisted-records.js';",
      resolveDir: join(sourceRoot, 'apps/server/dist'),
      sourcefile: 'packaged-migration.js',
      loader: 'js',
    },
    outfile: join(out, 'migration/dist/migrate.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    packages: 'bundle',
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    sourcemap: false,
    legalComments: 'none',
  });
  const { rawConfig: original } = experimental_readRawConfig({
    config: join(sourceRoot, 'apps/server/wrangler.jsonc'),
  });
  const config = {
    name: original.name,
    main: 'worker/worker.js',
    no_bundle: true,
    compatibility_date: original.compatibility_date,
    compatibility_flags: original.compatibility_flags,
    workers_dev: false,
    preview_urls: true,
    assets: { ...original.assets, directory: 'assets' },
    observability: original.observability,
  };
  if (original.version_metadata) config.version_metadata = original.version_metadata;
  await writeFile(join(out, 'wrangler.json'), `${JSON.stringify(config, null, 2)}\n`, {
    flag: 'wx',
  });
  const files = await inventory(out);
  const manifest = {
    format: 4,
    sourceSha,
    lockfileSha256: hash(await readFile(join(sourceRoot, 'pnpm-lock.yaml'))),
    nodeVersion: process.version,
    wranglerVersion: serverRequire('wrangler/package.json').version,
    configurationSha256: files['wrangler.json'],
    configurationEntry: 'wrangler.json',
    workerEntry: 'worker/worker.js',
    maintenanceWorkerEntry: 'worker/maintenance-worker.js',
    workerName: original.name,
    migrationEntry: 'migration/dist/migrate.mjs',
    files,
    migrations: await migrationInventory(join(out, 'migration/migrations')),
    recoveryEpoch,
  };
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
  });
  return verifyArtifact(out);
}

export async function qualifyArtifact({
  candidate,
  previous,
  bootstrap = false,
  preserving = false,
  report,
}) {
  if (!report || Boolean(previous) === Boolean(bootstrap) || (preserving && bootstrap))
    throw new Error(
      'Qualification requires exactly one of --previous or --bootstrap, and --report.',
    );
  candidate = resolve(candidate);
  report = resolve(report);
  for (const tree of [candidate, previous && resolve(previous)].filter(Boolean)) {
    const path = relative(tree, report);
    if (!path.startsWith('..') && !path.startsWith('/'))
      throw new Error('Qualification report must be outside artifacts.');
  }
  const current = await verifyArtifact(candidate);
  if (
    preserving &&
    (!current.manifest.maintenanceWorkerEntry ||
      !current.manifest.files[current.manifest.maintenanceWorkerEntry])
  )
    throw new Error(
      'Preserving cutover qualification requires a packaged maintenance Worker entry.',
    );
  let prior;
  if (previous) {
    previous = resolve(previous);
    prior = await verifyArtifact(previous);
    const receipt = JSON.parse(
      await readFile(join(dirname(previous), 'qualification.json'), 'utf8'),
    );
    if (
      receipt.format !== 1 ||
      receipt.passed !== true ||
      receipt.candidateDigest !== prior.digest ||
      receipt.sourceSha !== prior.manifest.sourceSha ||
      typeof receipt.bootstrap !== 'boolean' ||
      (receipt.bootstrap ? receipt.previousDigest !== null : !sha(receipt.previousDigest))
    )
      throw new Error('Previous artifact has no matching successful qualification.');
    if (
      prior.generation === 'relational-v1' &&
      (receipt.generation !== prior.generation ||
        (receipt.bootstrap
          ? receipt.previousGeneration !== null || receipt.recovery !== 'bootstrap'
          : !(
              (receipt.previousGeneration === 'document-v1' &&
                ['forward-only', 'preserving'].includes(receipt.recovery)) ||
              (receipt.previousGeneration === 'relational-v1' &&
                (receipt.recovery === 'compatible' ||
                  (receipt.recovery === 'forward-only' && prior.manifest.recoveryEpoch > 0)))
            )))
    )
      throw new Error('Previous artifact has no matching storage generation qualification.');
    for (const [index, item] of prior.manifest.migrations.entries()) {
      const candidateMigration = current.manifest.migrations[index];
      if (!isDeepStrictEqual(candidateMigration, item))
        throw new Error(
          'Candidate removed or rewrote a previous migration; prior inventory must remain a prefix.',
        );
    }
  }
  const recovery = qualificationRecovery(current, prior, preserving);
  execFileSync(
    process.execPath,
    [
      join(root, 'scripts/workers-smoke.mjs'),
      '--config',
      join(candidate, 'wrangler.json'),
      '--migration-entry',
      join(candidate, current.manifest.migrationEntry),
      ...(previous
        ? [
            '--previous-config',
            join(previous, 'wrangler.json'),
            '--previous-migration-entry',
            join(previous, prior.manifest.migrationEntry),
          ]
        : []),
      ...(preserving ? ['--preserving'] : []),
    ],
    { cwd: root, env: process.env, stdio: 'inherit' },
  );
  // Recheck the payload after executing its smoke, binding evidence to immutable bytes.
  if (
    (await verifyArtifact(candidate)).digest !== current.digest ||
    (previous && (await verifyArtifact(previous)).digest !== prior.digest)
  )
    throw new Error('Artifact changed during qualification.');
  const result = {
    format: 1,
    sourceSha: current.manifest.sourceSha,
    candidateDigest: current.digest,
    previousDigest: prior?.digest ?? null,
    bootstrap,
    generation: current.generation,
    previousGeneration: prior?.generation ?? null,
    recovery,
    passed: true,
  };
  await writeFile(report, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = process.argv.slice(2);
  if (input[0] === '--') input.shift();
  const command = input.shift();
  if (input[0] === '--') input.shift();
  const directory = input.shift();
  const args = input;
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--bootstrap') {
      if (options.bootstrap) throw new Error('Duplicate --bootstrap');
      options.bootstrap = true;
    } else if (flag === '--preserving') {
      if (options.preserving) throw new Error('Duplicate --preserving');
      options.preserving = true;
    } else if (
      ['--source', '--previous', '--report'].includes(flag) &&
      args[index + 1] &&
      !args[index + 1].startsWith('--')
    ) {
      const key = flag.slice(2);
      if (options[key]) throw new Error(`Duplicate ${flag}`);
      options[key] = args[++index];
    } else throw new Error(`Unknown or incomplete option: ${flag}`);
  }
  if (!directory) throw new Error('Artifact directory required.');
  let result;
  if (command === 'package' && Object.keys(options).every((key) => key === 'source'))
    result = await packageArtifact({ out: directory, sourceSha: options.source });
  else if (command === 'verify' && !Object.keys(options).length)
    result = await verifyArtifact(directory);
  else if (command === 'qualify' && !options.source)
    result = await qualifyArtifact({ candidate: directory, ...options });
  else throw new Error('Expected package, verify, or qualify with valid options.');
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
