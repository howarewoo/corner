// Real loopback HTTP checks against the production entrypoint. All accounts,
// secrets, and databases are disposable. No mail or AI request is sent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSmokeServices } from './smoke-services.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = join(root, 'apps/server/dist/index.js');
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { createORPCClient, ORPCError } = await import(require.resolve('@orpc/client'));
const { RPCLink } = await import(require.resolve('@orpc/client/fetch'));
try {
  await Promise.all([access(serverEntry), access(join(root, 'apps/web/dist/index.html'))]);
} catch {
  throw new Error('Build the workspaces with pnpm run build before running pnpm run smoke.');
}
const temporary = await mkdtemp(join(tmpdir(), 'corner-runtime-smoke-'));
const proof = 'synthetic-http-proxy-proof-with-more-than-32-characters';
const password = 'synthetic-smoke-test-password-not-used-elsewhere';
const children = new Set();
const services = new Set();

async function exitOf(child) {
  if (child.exitCode !== null || child.signalCode !== null)
    return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

async function run(mode, port) {
  const origin = mode === 'hosted' ? 'https://corner.example.test' : `http://127.0.0.1:${port}`;
  const listener = `http://127.0.0.1:${port}`;
  const backend = await startSmokeServices(temporary, origin);
  services.add(backend);
  const environment = {
    ...process.env,
    NODE_ENV: 'production',
    CORNER_DEPLOYMENT: mode,
    CORNER_ORIGIN: origin,
    CORNER_HOST: '127.0.0.1',
    CORNER_PORT: String(port),
    CORNER_DATA_DIR: join(temporary, mode),
    CORNER_PROXY_SECRET: proof,
    BETTER_AUTH_SECRET: 'synthetic-http-account-secret-with-more-than-32-characters',
    CORNER_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 42).toString('base64'),
    DATABASE_URL: backend.databaseUrl,
    NEON_AUTH_BASE_URL: backend.authUrl,
    NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
    NODE_EXTRA_CA_CERTS: backend.certificate,
  };
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`The ${mode} HTTP test server did not start.`)),
      15_000,
    );
    child.once('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(deadline);
      reject(new Error(`The ${mode} HTTP test server exited before startup. ${output}`));
    });
    child.stdout.on('data', () => {
      if (output.includes('Corner is ready at')) {
        clearTimeout(deadline);
        resolve();
      }
    });
  });
  const headers = {
    Host: new URL(origin).host,
    'X-Corner-Proxy-Token': proof,
    'X-Corner-Proxy-IP': '192.0.2.12',
  };
  // The explicit HTTP API preserves the canonical Host while connecting to
  // loopback; fetch may replace it with the local listener's host and port.
  const call = (path, options = {}) =>
    new Promise((resolve, reject) => {
      const request = httpRequest(
        listener + path,
        {
          method: options.method ?? 'GET',
          agent: false,
          signal: AbortSignal.timeout(15_000),
          headers: { ...headers, ...options.headers },
        },
        (response) => {
          const chunks = [];
          let length = 0;
          response.on('data', (chunk) => {
            chunks.push(chunk);
            length += chunk.length;
            if (length > 2 * 1024 * 1024)
              request.destroy(new Error('The HTTP test response is too large.'));
          });
          response.on('error', reject);
          response.on('end', () => {
            const responseHeaders = new Headers();
            for (let i = 0; i < response.rawHeaders.length; i += 2)
              responseHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
            const status = response.statusCode ?? 500;
            resolve(
              new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), {
                status,
                headers: responseHeaders,
              }),
            );
          });
        },
      );
      request.on('error', reject);
      request.end(options.body);
    });
  const json = (path, body, extra = {}) =>
    call(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { Origin: origin, 'Content-Type': 'application/json', ...extra },
    });
  const rpc = (procedure, input, extra = {}) =>
    json(`/api/rpc/${procedure}`, { json: input }, extra);
  assert.equal(
    (await rpc('account/policy', undefined, { 'X-Corner-Proxy-Token': 'forged' })).status,
    403,
  );
  assert.equal(
    (
      await rpc('account/policy', undefined, {
        'X-Corner-Proxy-IP': '192.0.2.12, 192.0.2.13',
      })
    ).status,
    403,
  );
  assert.equal(
    (await rpc('account/policy', undefined, { Host: 'other.example.test' })).status,
    400,
  );
  assert.deepEqual((await (await rpc('account/policy')).json()).json, {
    emailVerificationRequired: false,
    passwordResetAvailable: true,
  });
  const page = await call('/account/reset-password');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /<div id="root"><\/div>/);
  assert.equal((await call('/.env.hosted')).status, 404);
  const check = spawn(process.execPath, ['scripts/healthcheck.mjs'], {
    cwd: root,
    env: environment,
    stdio: 'ignore',
  });
  assert.deepEqual(
    await exitOf(check),
    { code: 0, signal: null },
    'The real health script must use the configured Host and listener port.',
  );

  // Hosted checks never create accounts or contact an AI provider.
  if (mode === 'local') {
    const signup = await json('/api/auth/sign-up/email', {
      name: 'HTTP test',
      email: 'http-test@example.test',
      password,
    });
    assert.equal(signup.status, 200);
    const cookie = signup.headers
      .getSetCookie()
      .map((value) => value.split(';', 1)[0])
      .join('; ');
    assert(cookie);
    const workspace = (await (await rpc('workspace/get', undefined, { Cookie: cookie })).json()).json;
    assert.equal(workspace.state.settings.name, 'HTTP test');
    const native = createORPCClient(new RPCLink({
      url: listener + '/api/rpc',
      headers: { ...headers, Origin: origin, Cookie: cookie },
    }));
    const oversized = {
      requestId: 'http-body-limit-123',
      mutation: { type: 'grocery.check', data: { key: 'x'.repeat(192 * 1024), checked: true } },
    };
    await assert.rejects(
      native.workspace.mutate(oversized),
      (error) => error instanceof ORPCError && error.status === 413 && error.data.code === 'REQUEST_TOO_LARGE',
    );
    assert.deepEqual(await native.workspace.get(), workspace);
    // Chunked uploads have no Content-Length; cancellation must still deliver
    // the native 413 response without destroying the next HTTP connection.
    const streamed = await fetch(listener + '/api/rpc/workspace/mutate', {
      method: 'POST',
      headers: { ...headers, Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ json: oversized })));
          controller.close();
        },
      }),
      duplex: 'half',
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(streamed.status, 413);
    assert.equal((await streamed.json()).json.data.code, 'REQUEST_TOO_LARGE');
    assert.deepEqual(await native.workspace.get(), workspace);
    assert.equal(
      (await rpc('workspace/get', undefined, { 'oai-authenticated-user-id': 'forged-user' })).status,
      401,
    );
    assert.equal(
      (
        await json(
          '/api/auth/sign-out',
          {},
          { Cookie: cookie, Origin: 'https://other.example.test' },
        )
      ).status,
      403,
    );
    assert.equal((await json('/api/auth/sign-out', {}, { Cookie: cookie })).status, 200);
    const signedOut = await rpc('workspace/get', undefined, { Cookie: cookie });
    assert.equal(signedOut.status, 401);
    assert.equal((await signedOut.json()).json.code, 'SIGN_IN_REQUIRED');

    // The 100-continue handshake confirms that Node accepted this handler.
    // SIGTERM arrives while its body is pending. Shutdown must finish the
    // accepted managed-auth request before closing the PostgreSQL pool.
    const body = JSON.stringify({
      name: 'During shutdown',
      email: 'shutdown@example.test',
      password,
    });
    const status = await new Promise((resolve, reject) => {
      const pending = httpRequest(listener + '/api/auth/sign-up/email', {
        method: 'POST',
        headers: {
          ...headers,
          Origin: origin,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Expect: '100-continue',
        },
      });
      pending.setTimeout(15_000, () =>
        pending.destroy(new Error('The in-flight shutdown check timed out.')),
      );
      pending.on('error', reject);
      pending.on('continue', () => {
        child.kill('SIGTERM');
        pending.end(body);
      });
      pending.on('response', (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      pending.flushHeaders();
    });
    assert.equal(status, 200, 'An accepted account request must finish during graceful shutdown.');
  } else child.kill('SIGTERM');
  assert.deepEqual(
    await exitOf(child),
    { code: 0, signal: null },
    'The Node process must finish its orderly shutdown.',
  );
  children.delete(child);
  await backend.close();
  services.delete(backend);
  process.stdout.write(`Passed ${mode} production HTTP, proxy, health, and shutdown checks.\n`);
}

try {
  await run('hosted', 43137);
  await run('local', 43138);
  process.stdout.write('No live account email or model requests were made.\n');
} finally {
  for (const child of children) {
    child.kill('SIGKILL');
    await exitOf(child);
  }
  for (const backend of services) await backend.close();
  await rm(temporary, { recursive: true, force: true });
}
