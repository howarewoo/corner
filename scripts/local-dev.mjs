import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createServer as createTCPServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const stateDirectory = join(root, '.corner-local');
const socket = join(stateDirectory, 'control.sock');
const lock = join(stateDirectory, 'controller.pid');
const configPath = join(stateDirectory, 'config.json');
const workspace = createHash('sha256').update(root).digest('hex').slice(0, 12);
const project = `corner-local-${workspace}`;

// Allow host tooling to work, but never inherit application, Compose, pg, or Node options.
export function isolatedEnvironment(source = process.env) {
  return {
    ...Object.fromEntries(
      ['HOME', 'TMPDIR', 'TEMP', 'SystemRoot', 'TERM', 'LANG', 'SHELL'].flatMap((key) =>
        source[key] === undefined ? [] : [[key, source[key]]],
      ),
    ),
    PATH: `${dirname(process.execPath)}:${source.PATH ?? '/usr/bin:/bin'}`,
  };
}

async function regularFile(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`Unsafe local file: ${path}`);
  await chmod(path, 0o600);
}

export function validateLocalConfig(config, expectedWorkspace = workspace) {
  if (
    config?.format !== 1 ||
    config.workspace !== expectedWorkspace ||
    !/^[a-f0-9]{32}$/.test(config.instance ?? '') ||
    !/^[A-Za-z0-9_-]{43}$/.test(config.password ?? '') ||
    !/^[A-Za-z0-9_-]{64}$/.test(config.authSecret ?? '') ||
    !/^[A-Za-z0-9_-]{64}$/.test(config.controlSecret ?? '')
  )
    throw new Error('Invalid local configuration. Restore it; do not replace existing keys.');
  return config;
}

async function configuration(create = false) {
  try {
    const metadata = await lstat(stateDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error('Unsafe local state directory.');
  } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    await mkdir(stateDirectory, { mode: 0o700 });
  }
  await chmod(stateDirectory, 0o700);
  if (create) {
    const config = {
      format: 1,
      workspace,
      instance: randomUUID().replaceAll('-', ''),
      password: randomBytes(32).toString('base64url'),
      authSecret: randomBytes(48).toString('base64url'),
      controlSecret: randomBytes(48).toString('base64url'),
    };
    await writeFile(configPath, JSON.stringify(config), { flag: 'wx', mode: 0o600 }).catch(
      (error) => {
        if (error.code !== 'EEXIST') throw error;
      },
    );
  }
  await regularFile(configPath);
  return validateLocalConfig(JSON.parse(await readFile(configPath, 'utf8')));
}

async function command(binary, args, environment, cwd = root) {
  try {
    return (
      await exec(binary, args, { cwd, env: environment, timeout: 120_000, maxBuffer: 1024 * 1024 })
    ).stdout.trim();
  } catch {
    throw new Error(
      `Local ${binary} command failed. Check that Docker is responsive and dependencies are installed.`,
    );
  }
}

async function docker(config) {
  const environment = {
    ...isolatedEnvironment(),
    CORNER_LOCAL_INSTANCE: config.instance,
    CORNER_LOCAL_DATABASE: `corner_${config.instance}`,
    CORNER_LOCAL_PASSWORD: config.password,
  };
  const context = await command('docker', ['context', 'show'], environment);
  const host = await command(
    'docker',
    ['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}'],
    environment,
  );
  if (!host.startsWith('unix://'))
    throw new Error('Local development requires a local Unix-socket Docker context.');
  const run = (args) =>
    command('docker', ['--context', context, ...args], environment, stateDirectory);
  const compose = (args) =>
    run([
      'compose',
      '--project-name',
      project,
      '--project-directory',
      stateDirectory,
      '--env-file',
      '/dev/null',
      '--file',
      join(root, 'deployment', 'compose.local.yaml'),
      ...args,
    ]);
  return { run, compose };
}

/** Do not infer ownership from a loopback port, environment name, or database URL. */
export function ownedPostgres(container, config, expectedProject = project, requireRunning = true) {
  const labels = container.Config?.Labels ?? {};
  const bindings = container.NetworkSettings?.Ports?.['5432/tcp'];
  if (
    labels['com.docker.compose.project'] !== expectedProject ||
    labels['com.docker.compose.service'] !== 'postgres' ||
    labels['corner.local.instance'] !== config.instance
  )
    throw new Error('Refusing a Postgres container not owned by this local environment.');
  if (
    requireRunning &&
    (bindings?.length !== 1 ||
      bindings[0].HostIp !== '127.0.0.1' ||
      !/^\d+$/.test(bindings[0].HostPort) ||
      Number(bindings[0].HostPort) < 1 ||
      Number(bindings[0].HostPort) > 65535)
  )
    throw new Error('Local Postgres must have exactly one loopback port binding.');
  const data = container.Mounts?.find((mount) => mount.Destination === '/var/lib/postgresql/data');
  if (data?.Type !== 'volume' || data.Name !== `${expectedProject}_postgres-data`)
    throw new Error('Refusing an unowned local Postgres volume.');
  return requireRunning ? Number(bindings[0].HostPort) : undefined;
}

async function assertResources(engine, config) {
  const id = await engine.compose(['ps', '--all', '--quiet', 'postgres']);
  if (id) {
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('Expected one local Postgres container.');
    const [container] = JSON.parse(await engine.run(['inspect', id]));
    ownedPostgres(container, config, project, false);
  }
  const volumes = await engine.run([
    'volume',
    'ls',
    '--filter',
    `name=^${project}_postgres-data$`,
    '--format',
    '{{.Name}}',
  ]);
  if (volumes) {
    const [volume] = JSON.parse(
      await engine.run(['volume', 'inspect', `${project}_postgres-data`]),
    );
    if (
      volume.Labels?.['corner.local.instance'] !== config.instance ||
      volume.Labels?.['com.docker.compose.project'] !== project
    )
      throw new Error('Refusing an unowned local volume.');
  }
}

async function databaseTarget(engine, config) {
  const id = await engine.compose(['ps', '--all', '--quiet', 'postgres']);
  if (!/^[a-f0-9]{12,64}$/.test(id))
    throw new Error('Expected exactly one owned local Postgres container.');
  const [container] = JSON.parse(await engine.run(['inspect', id]));
  const port = ownedPostgres(container, config);
  const [volume] = JSON.parse(await engine.run(['volume', 'inspect', `${project}_postgres-data`]));
  if (
    volume.Labels?.['com.docker.compose.project'] !== project ||
    volume.Labels?.['corner.local.instance'] !== config.instance
  )
    throw new Error('Refusing a local volume with a different installation identity.');
  return `postgresql://corner_${config.instance}:${config.password}@127.0.0.1:${port}/corner_${config.instance}`;
}

export async function localCertificate(directory) {
  const key = join(directory, 'auth.key');
  const certificate = join(directory, 'auth.crt');
  try {
    await regularFile(key);
    await regularFile(certificate);
    const parsed = new X509Certificate(await readFile(certificate));
    if (Date.parse(parsed.validTo) > Date.now() + 86_400_000 && parsed.checkIP('127.0.0.1'))
      return { key, certificate };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = await mkdtemp(join(directory, 'certificate-'));
  try {
    const temporaryKey = join(temporary, 'auth.key'),
      temporaryCertificate = join(temporary, 'auth.crt');
    await command(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        temporaryKey,
        '-out',
        temporaryCertificate,
        '-days',
        '365',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ],
      isolatedEnvironment(),
    );
    await chmod(temporaryKey, 0o600);
    await chmod(temporaryCertificate, 0o600);
    await rename(temporaryKey, key);
    await rename(temporaryCertificate, certificate);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return { key, certificate };
}

async function control(config, action) {
  return new Promise((accept, reject) => {
    const call = request(
      {
        socketPath: socket,
        method: 'POST',
        path: `/${action}`,
        headers: { Authorization: `Bearer ${config.controlSecret}` },
        timeout: 120_000,
      },
      (response) => {
        let data = '';
        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => {
          if (response.statusCode !== 200)
            return reject(new Error(data || 'Local controller rejected the operation.'));
          try {
            const result = JSON.parse(data);
            if (result.instance !== config.instance)
              throw new Error('Wrong local controller identity.');
            accept(result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    call.on('timeout', () => call.destroy(new Error('Local controller did not respond.')));
    call.on('error', reject);
    call.end();
  });
}

async function availablePort(port) {
  const probe = createTCPServer();
  await new Promise((accept, reject) => {
    probe.once('error', () =>
      reject(new Error(`Local port ${port} is occupied; no existing listener was stopped.`)),
    );
    probe.listen(port, '127.0.0.1', accept);
  });
  await new Promise((accept) => probe.close(accept));
}

async function removeStaleLock() {
  try {
    await regularFile(lock);
    const pid = Number(await readFile(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid local controller lock.');
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      await rm(lock);
      const metadata = await lstat(socket).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (metadata?.isSocket()) await rm(socket);
      return;
    }
    throw new Error(
      'A local controller process is still alive. Stop it in its terminal; no process was killed.',
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function stopChildren(children) {
  await Promise.all(
    children.map(async (child) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      process.kill(-child.pid, 'SIGTERM');
      const stopped = new Promise((accept) => child.once('exit', accept));
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          process.kill(-child.pid, 'SIGKILL');
      }, 10_000);
      await stopped;
      clearTimeout(timer);
    }),
  );
}

async function serve(config, engine, port) {
  const origin = `http://127.0.0.1:${port}`;
  const landingOrigin = `http://localhost:${port + 3}`;
  const handle = await open(lock, 'wx', 0o600).catch(() => {
    throw new Error('Local controller lock exists. Run pnpm run dev:down before restarting.');
  });
  await handle.writeFile(String(process.pid));
  await handle.close();
  const children = [];
  let services,
    controlServer,
    stopping,
    finish,
    databaseStarted = false;
  let starting = true,
    stopRequested = false;
  const ended = new Promise((accept) => {
    finish = accept;
  });
  const stop = () =>
    (stopping ??= (async () => {
      await stopChildren(children);
      if (controlServer?.listening) await new Promise((accept) => controlServer.close(accept));
      await services?.close();
      if (databaseStarted) {
        await assertResources(engine, config);
        await engine.compose(['stop', 'postgres']);
      }
    })().finally(async () => {
      await rm(lock, { force: true });
      finish();
    }));
  // A pending startup step must settle before cleanup releases the lock or stops its resources.
  const onSignal = () => {
    stopRequested = true;
    if (!starting) void stop().catch((error) => console.error(error.message));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await Promise.all([port, port + 1, port + 2, port + 3].map(availablePort));
    if (stopRequested) return;
    // Build code before migration; no root environment file is loaded by these tasks.
    await command('pnpm', ['run', 'build', '--filter=server'], isolatedEnvironment());
    if (stopRequested) return;
    await assertResources(engine, config);
    if (stopRequested) return;
    databaseStarted = true;
    await engine.compose(['up', '--detach', '--wait', 'postgres']);
    if (stopRequested) return;
    const databaseUrl = await databaseTarget(engine, config);
    if (stopRequested) return;
    const certificates = await localCertificate(stateDirectory);
    if (stopRequested) return;
    // Compiled server imports do not exist until the build above completes.
    const { startLocalServices } = await import('../apps/server/scripts/local-runtime.mjs');
    if (stopRequested) return;
    services = await startLocalServices({
      config,
      databaseUrl,
      origin,
      directory: stateDirectory,
      ...certificates,
    });
    if (stopRequested) return;
    controlServer = createServer(async (req, res) => {
      if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${config.controlSecret}`) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (stopping) {
        res.writeHead(503);
        res.end('Local environment is stopping.');
        return;
      }
      try {
        if (req.url === '/seed') {
          await assertResources(engine, config);
          await services.seed();
        } else if (!['/status', '/stop'].includes(req.url)) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/stop') res.once('finish', onSignal);
        res.end(JSON.stringify({ instance: config.instance, origin, landingOrigin }));
      } catch (error) {
        res.writeHead(409);
        res.end(error.message);
      }
    });
    await new Promise((accept, reject) => {
      controlServer.once('error', reject);
      controlServer.listen(socket, accept);
    });
    await chmod(socket, 0o600);
    if (stopRequested) return;
    starting = false;
    const environment = {
      ...isolatedEnvironment(),
      NODE_ENV: 'development',
      CORNER_DEPLOYMENT: 'local',
      CORNER_ORIGIN: origin,
      CORNER_LANDING_ORIGIN: landingOrigin,
      CORNER_DEV_API_PORT: String(port + 1),
      CORNER_DESIGN_PORT: String(port + 2),
      CORNER_DATA_DIR: join(stateDirectory, 'data'),
      DATABASE_URL: databaseUrl,
      NEON_AUTH_BASE_URL: services.authUrl,
      NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
      NODE_EXTRA_CA_CERTS: certificates.certificate,
    };
    const launch = (binary, args, cwd) => {
      const child = spawn(binary, args, {
        cwd,
        env: environment,
        stdio: 'inherit',
        detached: true,
      });
      children.push(child);
      child.once('error', (error) => {
        console.error(error.message);
        process.exitCode = 1;
        onSignal();
      });
      child.once('exit', (code, signal) => {
        if (stopping) return;
        console.error(`Local development child exited unexpectedly (${signal ?? code}).`);
        process.exitCode = code || 1;
        onSignal();
      });
    };
    launch(
      'pnpm',
      [
        'exec',
        'turbo',
        'run',
        'dev',
        ...[
          'server',
          'web',
          'design',
          'landing',
          '@packages/nutrition',
          '@packages/training',
          '@packages/workspace',
          '@packages/api',
        ].map((name) => `--filter=${name}`),
      ],
      root,
    );
    console.log(
      `Local-only Corner: ${origin}\nLanding: ${landingOrigin}\nRun pnpm run dev:seed to create synthetic users. No cloud credentials are used.`,
    );
    await ended;
    await stopping;
  } finally {
    starting = false;
    await stop();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

export function localArguments(args) {
  const [action = 'up', option] = args;
  const port = action === 'up' && option?.startsWith('--port=') ? Number(option.slice(7)) : 3000;
  if (
    !['up', 'seed', 'down', 'reset'].includes(action) ||
    args.length > (['up', 'reset'].includes(action) ? 2 : 1) ||
    (action === 'up' && option !== undefined && !/^--port=\d+$/.test(option)) ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65532 ||
    (action === 'reset' && option !== '--confirm-delete-local-data')
  )
    throw new Error(
      'Use up [--port=3000], seed, down, or reset --confirm-delete-local-data. Only loopback ports are configurable.',
    );
  return { action, port };
}

export async function main(args = process.argv.slice(2)) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 15)
    throw new Error('Local development requires Node 24 (>=24.15.0).');
  const { action, port } = localArguments(args);
  // pg and other in-process clients also read process.env; sanitizing children alone is insufficient.
  const environment = isolatedEnvironment();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, environment);
  const config = await configuration(action === 'up');
  if (action === 'seed') {
    await control(config, 'seed');
    console.log(
      'Local users ready: empty@corner.test and demo@corner.test\nPassword for both: Corner-local-only-2026!\nExisting workspace edits were preserved.',
    );
    return;
  }
  if (action === 'up') {
    try {
      const running = await control(config, 'status');
      console.log(
        `Local-only Corner is already running at ${running.origin}.\nLanding: ${running.landingOrigin}\nReusing it; no services were started or stopped.`,
      );
      return;
    } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
    }
  }
  const engine = await docker(config);
  if (action === 'up') return serve(config, engine, port);
  try {
    await control(config, 'stop');
  } catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
  }
  // A controller removes its lock only after all of its child processes and clients stop.
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await lstat(lock).catch(() => null))) break;
    if (attempt === 99) await removeStaleLock();
    else await delay(200);
  }
  await assertResources(engine, config);
  if (action === 'reset') {
    await engine.compose(['down', '--volumes']);
    console.log(
      'Owned local database deleted. Existing repository data/, keys, and environment files were not touched.',
    );
  } else {
    await engine.compose(['stop', 'postgres']);
    console.log('Local services stopped. Accounts, workspace data, and keys were retained.');
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
