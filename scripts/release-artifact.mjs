import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    manifest.format !== 2 ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceSha) ||
    !sha(manifest.lockfileSha256) ||
    !/^v24\.(?:1[5-9]|[2-9]\d|\d{3,})\.\d+$/.test(manifest.nodeVersion) ||
    !/^\d+\.\d+\.\d+$/.test(manifest.wranglerVersion) ||
    !object(manifest.files) ||
    !Array.isArray(manifest.migrations)
  )
    throw new Error(
      'Invalid paired artifact manifest; backend-only artifacts require operator reconciliation.',
    );
  delete files['manifest.json'];
  const names = Object.keys(manifest.files).sort();
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(files).sort()))
    throw new Error('Artifact contains missing or unlisted files.');
  for (const name of names) {
    if (!safe(name) || !sha(manifest.files[name]) || files[name] !== manifest.files[name])
      throw new Error(`Artifact digest mismatch: ${name}`);
    if (
      !/^(worker\/|frontend\/|assets\/|migration\/|wrangler\.json$)/.test(name) ||
      /\.(?:map|pem|key|env)$/i.test(name)
    )
      throw new Error(`Forbidden payload: ${name}`);
  }
  if (
    manifest.configurationEntry !== 'wrangler.json' ||
    manifest.migrationEntry !== 'migration/dist/migrate.mjs' ||
    !safe(manifest.workerEntry) ||
    !manifest.workerEntry.startsWith('worker/') ||
    !files[manifest.workerEntry] ||
    !files[manifest.migrationEntry] ||
    !files['assets/index.html'] ||
    files['wrangler.json'] !== manifest.configurationSha256
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
    config.name !== 'corner-server' ||
    manifest.workerName !== config.name ||
    !/^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date) ||
    !Array.isArray(config.compatibility_flags) ||
    !config.compatibility_flags.includes('nodejs_compat') ||
    config.assets?.directory !== 'assets' ||
    config.workers_dev !== false ||
    config.preview_urls !== false
  )
    throw new Error('Unsafe packaged deployment configuration.');
  if (
    manifest.frontendConfigurationEntry !== 'frontend/wrangler.json' ||
    manifest.frontendEntry !== 'frontend/worker.js' ||
    manifest.frontendName !== 'corner-web' ||
    !files[manifest.frontendEntry] ||
    files[manifest.frontendConfigurationEntry] !== manifest.frontendConfigurationSha256
  )
    throw new Error('Invalid frontend artifact entry points.');
  const frontend = JSON.parse(
    await readFile(join(directory, manifest.frontendConfigurationEntry), 'utf8'),
  );
  if (
    !object(frontend) ||
    Object.keys(frontend).some((key) => !configKeys.has(key) && key !== 'services') ||
    frontend.name !== manifest.frontendName ||
    frontend.main !== 'worker.js' ||
    frontend.no_bundle !== true ||
    frontend.workers_dev !== false ||
    frontend.preview_urls !== false ||
    frontend.assets?.directory !== '../assets' ||
    frontend.compatibility_date !== config.compatibility_date ||
    !Array.isArray(frontend.compatibility_flags) ||
    !frontend.compatibility_flags.includes('nodejs_compat') ||
    JSON.stringify(frontend.services) !==
      JSON.stringify([{ binding: 'SERVER', service: manifest.workerName }]) ||
    frontend.version_metadata?.binding !== 'CF_VERSION_METADATA' ||
    config.version_metadata?.binding !== 'CF_VERSION_METADATA'
  )
    throw new Error('Unsafe packaged frontend configuration or backend binding.');
  const migrationNames = names.filter((name) => name.startsWith('migration/migrations/'));
  if (manifest.migrations.length === 0 || manifest.migrations.length !== migrationNames.length)
    throw new Error('Missing migration inventory.');
  const seen = new Set();
  for (const migration of manifest.migrations) {
    if (
      !object(migration) ||
      !/^\d+_[a-zA-Z0-9_.-]+\.sql$/.test(migration.name) ||
      seen.has(migration.name) ||
      files[`migration/migrations/${migration.name}`] !== migration.sha256
    )
      throw new Error('Invalid migration digest.');
    seen.add(migration.name);
  }
  return { manifest, digest: hash(bytes) };
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
  const shared = await readdir(join(sourceRoot, 'packages/shared/dist')).catch(() => []);
  if (!shared.some((name) => name.endsWith('.js')))
    throw new Error('Build shared before packaging.');
  await access(join(sourceRoot, 'apps/server/dist/migrate.js'));
  const workerSource = join(sourceRoot, 'apps/server/dist/worker');
  await access(join(workerSource, 'worker.js'));
  const frontendSource = join(sourceRoot, 'apps/web/.wrangler/worker');
  await access(join(frontendSource, 'worker.js'));
  await access(join(sourceRoot, 'apps/web/dist/index.html'));
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out); // Deliberately not recursive: existing outputs are immutable.
  await copyTree(workerSource, join(out, 'worker'));
  await copyTree(frontendSource, join(out, 'frontend'));
  await copyTree(join(sourceRoot, 'apps/web/dist'), join(out, 'assets'));
  await copyTree(join(sourceRoot, 'apps/server/migrations'), join(out, 'migration/migrations'));
  await mkdir(join(out, 'migration/dist'), { recursive: true });
  const { build } = await import(webRequire.resolve('esbuild'));
  await build({
    stdin: {
      contents:
        "export { migrate } from './migrate.js'; export { createDatabase } from './database.js'; export { inspectImport } from './store.js';",
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
    preview_urls: false,
    assets: { ...original.assets, directory: 'assets' },
    observability: original.observability,
  };
  if (original.version_metadata) config.version_metadata = original.version_metadata;
  await writeFile(join(out, 'wrangler.json'), `${JSON.stringify(config, null, 2)}\n`, {
    flag: 'wx',
  });
  const { rawConfig: frontendOriginal } = experimental_readRawConfig({
    config: join(sourceRoot, 'apps/web/wrangler.jsonc'),
  });
  const frontendConfig = {
    name: frontendOriginal.name,
    main: 'worker.js',
    no_bundle: true,
    compatibility_date: frontendOriginal.compatibility_date,
    compatibility_flags: frontendOriginal.compatibility_flags,
    workers_dev: false,
    preview_urls: false,
    assets: { ...frontendOriginal.assets, directory: '../assets' },
    observability: frontendOriginal.observability,
    version_metadata: frontendOriginal.version_metadata,
    services: frontendOriginal.services,
  };
  await writeFile(
    join(out, 'frontend/wrangler.json'),
    `${JSON.stringify(frontendConfig, null, 2)}\n`,
    { flag: 'wx' },
  );
  const files = await inventory(out);
  const manifest = {
    format: 2,
    sourceSha,
    lockfileSha256: hash(await readFile(join(sourceRoot, 'pnpm-lock.yaml'))),
    nodeVersion: process.version,
    wranglerVersion: serverRequire('wrangler/package.json').version,
    configurationSha256: files['wrangler.json'],
    configurationEntry: 'wrangler.json',
    workerEntry: 'worker/worker.js',
    workerName: original.name,
    frontendName: frontendOriginal.name,
    frontendEntry: 'frontend/worker.js',
    frontendConfigurationEntry: 'frontend/wrangler.json',
    frontendConfigurationSha256: files['frontend/wrangler.json'],
    migrationEntry: 'migration/dist/migrate.mjs',
    files,
    migrations: Object.keys(files)
      .filter((name) => name.startsWith('migration/migrations/'))
      .map((name) => ({ name: name.split('/').at(-1), sha256: files[name] })),
  };
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
  });
  return verifyArtifact(out);
}

export async function qualifyArtifact({ candidate, previous, bootstrap = false, report }) {
  if (!report || Boolean(previous) === Boolean(bootstrap))
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
    const migrations = new Map(current.manifest.migrations.map((item) => [item.name, item.sha256]));
    for (const item of prior.manifest.migrations)
      if (migrations.get(item.name) !== item.sha256)
        throw new Error('Candidate removed or rewrote a previous migration.');
  }
  execFileSync(
    process.execPath,
    [
      join(root, 'scripts/workers-smoke.mjs'),
      '--config',
      join(candidate, 'wrangler.json'),
      '--frontend-config',
      join(candidate, current.manifest.frontendConfigurationEntry),
      '--migration-entry',
      join(candidate, current.manifest.migrationEntry),
      ...(previous
        ? [
            '--previous-config',
            join(previous, 'wrangler.json'),
            '--previous-frontend-config',
            join(previous, prior.manifest.frontendConfigurationEntry),
            '--previous-migration-entry',
            join(previous, prior.manifest.migrationEntry),
          ]
        : []),
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
