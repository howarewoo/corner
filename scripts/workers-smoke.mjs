// Actual workerd requests, PostgreSQL transactions, and local managed-auth fixture.
// No cloud credentials, real mail, or model calls are used.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSmokeServices } from './smoke-services.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { unstable_startWorker } = await import(require.resolve('wrangler'));
const { Agent, fetch: fixtureFetch } = await import(require.resolve('undici'));
await access(join(root, 'apps/web/dist/index.html'));
const directory = await mkdtemp(join(tmpdir(), 'corner-workers-smoke-'));
const origin = 'https://corner.example.test';
let backend;
let worker;
let dispatcher;
try {
  backend = await startSmokeServices(directory, origin);
  dispatcher = new Agent({ connect: { ca: await readFile(backend.certificate) } });
  const bindings = {
    CORNER_ORIGIN: origin,
    DATABASE_URL: backend.databaseUrl,
    NEON_AUTH_BASE_URL: backend.authUrl,
    NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
    BETTER_AUTH_SECRET: 'synthetic-workers-session-binding-secret-over-32-characters',
    CORNER_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 42).toString('base64'),
  };
  worker = await unstable_startWorker({
    config: join(root, 'apps/server/wrangler.jsonc'),
    bindings: Object.fromEntries(Object.entries(bindings).map(([name, value]) => [name, { type: 'secret_text', value }])),
    dev: {
      server: { hostname: '127.0.0.1', port: 0 }, inspector: false,
      origin: { secure: true }, inferOriginFromRoutes: false,
      watch: false, persist: false, logLevel: 'error',
      // Only this local fixture uses a private CA. Production TLS stays verified.
      outboundService: async request => {
        assert.equal(new URL(request.url).origin, new URL(backend.authUrl).origin, 'The smoke must never contact a real provider.');
        return fixtureFetch(request.url, { method: request.method, headers: request.headers, body: request.body, duplex: 'half', redirect: 'manual', dispatcher });
      },
    },
  });
  await worker.ready;
  const call = (path, options = {}) => worker.fetch(new URL(path, origin), { ...options, signal: AbortSignal.timeout(20_000) });
  const post = (path, body, headers = {}) => call(path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.deepEqual(await (await call('/api/health')).json(), { ok: true });
  assert.equal((await call('https://wrong.example.test/api/health')).status, 400);
  assert.equal((await call('/api/state')).status, 401);
  assert.equal((await call('/.env')).status, 404);
  assert.equal((await call('/assets/not-found.js')).status, 404);
  assert.equal((await call('/api/not-found')).status, 401, 'API misses must not serve SPA HTML.');
  const page = await call('/account/reset-password');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  const html = await page.text();
  assert.match(html, /<div id="root"><\/div>/);
  const script = html.match(/src="([^"]+\.js)"/)[1];
  const asset = await call(script);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('Cache-Control'), /immutable/);
  await asset.arrayBuffer();
  assert.equal((await call('/', { method: 'POST' })).status, 405);

  async function signup(name) {
    const response = await post('/api/auth/sign-up/email', { name, email: `${name.toLowerCase()}@example.test`, password: 'synthetic-workers-smoke-password' });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).token, undefined);
    const cookies = response.headers.getSetCookie();
    assert(cookies.some(cookie => cookie.startsWith('__Secure-neon-auth.session_token=') && cookie.includes('HttpOnly') && cookie.includes('Secure')));
    return cookies.map(cookie => cookie.split(';', 1)[0]).join('; ');
  }
  const alice = await signup('Alice');
  const bob = await signup('Bob');
  const state = async cookie => {
    const response = await call('/api/state', { headers: { Cookie: cookie } });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    return response.json();
  };
  const initial = await state(alice);
  const body = { requestId: 'workers-manual-settings-123', mutation: { type: 'settings.save', data: { ...initial.state.settings, name: 'Saved on Workers' } } };
  assert.equal((await post('/api/mutate', body, { Cookie: alice, Origin: 'https://foreign.example.test' })).status, 403);
  const writes = await Promise.all([post('/api/mutate', body, { Cookie: alice }), post('/api/mutate', body, { Cookie: alice })]);
  for (const response of writes) {
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).revision, initial.revision + 1);
  }
  assert.equal((await state(alice)).state.settings.name, 'Saved on Workers');
  assert.equal((await state(bob)).state.settings.name, 'Bob');
  const connection = await (await call('/api/ai/connection', { headers: { Cookie: alice } })).json();
  assert.equal(connection.enabled, false);
  assert.equal(connection.available, false);
  assert.equal((await post('/api/ai/connect', {}, { Cookie: alice })).status, 409);
  assert.equal((await post('/api/agent/runs', { requestId: 'workers-plan-request-123', prompt: 'Plan my training', referenceDate: '2026-10-23' }, { Cookie: alice })).status, 503);
  assert.equal((await post('/api/auth/sign-out', {}, { Cookie: alice })).status, 200);
  assert.equal((await call('/api/state', { headers: { Cookie: alice } })).status, 401);
  process.stdout.write('Passed Workers assets, canonical origin, secure account cookies, isolated PostgreSQL writes/retries, sign-out, and hosted AI gate.\nNo live cloud, account email, or model requests were made.\n');
} finally {
  await worker?.dispose();
  await dispatcher?.close();
  await backend?.close();
  await rm(directory, { recursive: true, force: true });
}
