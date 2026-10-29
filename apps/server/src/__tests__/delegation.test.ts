import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import type { Pool } from 'pg';
import { createInitialState } from '@packages/workspace/initial-state';
import { createApp } from '../app.ts';
import { createDelegationService, isDelegationNativePath } from '../delegation.ts';
import { createQueries, type Database, type Transaction } from '../queries.ts';
import { WorkspaceStore } from '../store.ts';
import type { Config } from '../config.ts';
import { testDatabase, closeTestDatabase, createTestAuth, neonTestConfig } from '../../tests/helpers.ts';

let database: Pool;
let server: Server;
let origin: string;
let store: WorkspaceStore;
let alice: { id: string; email: string; jar: Jar };
let bob: { id: string; email: string; jar: Jar };
let counter = 0;
const password = 'synthetic-password-over-12';
const verifier = 'v'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const requests = new AsyncLocalStorage<{ transactions: number }>();
const resetDeliveries: Array<{ email: string; url: string; token: string }> = [];
type Jar = Map<string, string>;
type Registered = { client_id: string; client_name: string; redirect_uris: string[] };
type Tokens = { access_token: string; refresh_token: string; token_type: string; scope?: string };
type Reply<T> = { status: number; data: T; headers: Headers; location: string | null };

async function call<T = Record<string, any>>(path: string, body?: unknown, options: { jar?: Jar; bearer?: string; form?: boolean; origin?: string | null } = {}): Promise<Reply<T>> {
  const headers = new Headers();
  if (options.jar) headers.set('Cookie', [...options.jar].map(([name, value]) => `${name}=${value}`).join('; '));
  if (options.origin !== null) headers.set('Origin', options.origin ?? origin);
  if (options.bearer) { headers.set('Authorization', `Bearer ${options.bearer}`); headers.set('Accept', 'application/json, text/event-stream'); }
  if (body !== undefined) headers.set('Content-Type', options.form ? 'application/x-www-form-urlencoded' : 'application/json');
  const response = await fetch(new URL(path, origin), {
    method: body !== undefined ? 'POST' : 'GET', headers, redirect: 'manual',
    body: body === undefined ? undefined : options.form ? new URLSearchParams(body as Record<string, string>) : JSON.stringify(body),
  });
  if (options.jar) for (const cookie of response.headers.getSetCookie()) {
    const [name, value] = cookie.split(';', 1)[0]!.split(/=(.*)/s);
    if (value) options.jar.set(name!, value); else options.jar.delete(name!);
  }
  const text = await response.text();
  const mediaType = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
  const data: unknown = text && (mediaType === 'application/json' || mediaType?.endsWith('+json')) ? JSON.parse(text) : text || {};
  return { status: response.status, data: data as T, headers: response.headers, location: response.headers.get('Location') };
}

async function account(name: string) {
  const jar: Jar = new Map();
  const response = await call('/api/auth/sign-up/email', { name, email: `${name}@example.test`, password }, { jar });
  assert.equal(response.status, 200);
  return { id: response.data.user.id as string, email: response.data.user.email as string, jar };
}

async function register() {
  const response = await call<Registered>('/oauth/register', { client_name: `Client ${++counter}`, redirect_uris: ['http://127.0.0.1/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }, { origin: null });
  assert.equal(response.status, 201);
  return response.data;
}

async function start(client: Registered, owner = alice, scope = 'workouts:read', prompt?: string) {
  const jar = new Map(owner.jar);
  const response = await call('/oauth/authorize?' + new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uris[0]!, response_type: 'code', scope, resource: origin + '/mcp', code_challenge: challenge, code_challenge_method: 'S256', state: 'fixture-state', ...(prompt ? { prompt } : {}) }), undefined, { jar });
  assert.equal(response.status, 303);
  assert(response.location);
  const uid = new URL(response.location, origin).pathname.split('/').at(-1)!;
  return { jar, uid };
}

async function authorize(client: Registered, owner = alice, scope = 'workouts:read', selected = scope.split(' '), prompt?: string) {
  const pending = await start(client, owner, scope, prompt);
  const details = await call(`/api/delegation/consent/${pending.uid}`, undefined, { jar: pending.jar });
  assert.equal(details.status, 200);
  assert.equal(details.data.accountEmail, owner.email);
  const approval = await call(`/api/delegation/consent/${pending.uid}`, { accepted: true, scopes: selected }, { jar: pending.jar });
  assert.equal(approval.status, 200);
  const resumed = await call(approval.data.redirectTo, undefined, { jar: pending.jar });
  assert.equal(resumed.status, 303);
  const callback = new URL(resumed.location!);
  assert.equal(callback.origin + callback.pathname, client.redirect_uris[0]);
  assert.equal(callback.searchParams.get('state'), 'fixture-state');
  const code = callback.searchParams.get('code');
  assert(code);
  return code;
}

function codeBody(client: Registered, code: string) {
  return { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: client.redirect_uris[0]!, code, code_verifier: verifier, resource: origin + '/mcp' };
}
function exchange(client: Registered, code: string) {
  return call<Tokens>('/oauth/token', codeBody(client, code), { form: true, origin: null });
}
function refresh(client: Registered, token: string, resource = origin + '/mcp') {
  return call<Tokens>('/oauth/token', { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: token, resource }, { form: true, origin: null });
}
function mcp(token: string, name = 'list_workouts', args: Record<string, unknown> = {}) {
  return call('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { bearer: token, origin: null });
}
async function connection(client: Registered, owner = alice) {
  const result = await call('/api/delegation/connections', undefined, { jar: owner.jar });
  assert.equal(result.status, 200);
  const grant = result.data.connections.find((item: { clientName: string }) => item.clientName === client.client_name);
  assert(grant);
  return grant as { id: string; scopes: string[] };
}

before(async () => {
  database = await testDatabase();
  server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  const config: Config = { ...neonTestConfig, origin, host: '127.0.0.1', port: address.port, deployment: 'local', dataDir: '/tmp' };
  const auth = await createTestAuth(config, database, async ({ user, url, token }) => {
    resetDeliveries.push({ email: user.email, url, token });
  });
  const actual = createQueries(database);
  const db = new Proxy(actual, { get(target, key, receiver) {
    if (key === 'transaction') return async <T>(action: (tx: Transaction) => Promise<T>, options?: Parameters<Database['transaction']>[1]) => {
      const request = requests.getStore();
      if (request) request.transactions++;
      try { return await target.transaction(action, options); }
      finally { if (request) request.transactions--; }
    };
    return Reflect.get(target, key, receiver);
  } });
  store = new WorkspaceStore(db);
  const delegation = createDelegationService(config);
  const app = createApp({ config, auth, store, delegation });
  server.on('request', (req, res) => {
    void requests.run({ transactions: 0 }, async () => {
      try {
        const writeHead = res.writeHead;
        res.writeHead = (status: number, ...args: unknown[]) => {
          assert.equal(requests.getStore()?.transactions, 0, 'transaction completes before credentials/response headers');
          return Reflect.apply(writeHead, res, [status, ...args]);
        };
        if (isDelegationNativePath(new URL(req.url!, origin).pathname)) { await delegation.handleNative(req, res, { db, auth }); return; }
        const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers: req.headers as HeadersInit };
        if (!['GET', 'HEAD'].includes(req.method!)) { init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>; init.duplex = 'half'; }
        const response = await app.fetch(new Request(new URL(req.url!, origin), init));
        for (const [key, value] of response.headers) if (key !== 'set-cookie') res.setHeader(key, value);
        if (response.headers.getSetCookie().length) res.setHeader('Set-Cookie', response.headers.getSetCookie());
        res.writeHead(response.status);
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        if (!res.headersSent) res.writeHead(500);
        res.end();
        throw error;
      }
    });
  });
  alice = await account('alice');
  bob = await account('bob');
  for (const owner of [alice, bob]) {
    const state = createInitialState();
    state.training.sessions = [{ id: 'session', date: '2026-10-22', name: `${owner === alice ? 'alice' : 'bob'} workout`, kind: 'strength', status: 'completed', unit: 'kg', plannedMinutes: 30, durationMinutes: 30, rounds: null, sessionRpe: null, readiness: null, notes: '', changeReason: '', createdAt: '2026-10-22T12:00:00.000Z', updatedAt: '2026-10-22T12:00:00.000Z', exercises: [] }];
    await store.replaceImport(owner.id, `${owner.id}-seed`, state, 0);
  }
});
after(async () => {
  if (server) { server.closeAllConnections(); const closed = once(server, 'close'); server.close(); await closed; }
  if (database) await closeTestDatabase(database);
});

test('discovery activates insert-once keys, advertises separate canonical endpoints and only S256', async () => {
  assert.deepEqual((await database.query('SELECT origin FROM delegation_issuer')).rows, []);
  const metadata = await call('/.well-known/oauth-authorization-server', undefined, { origin: null });
  assert.equal(metadata.status, 200);
  assert.equal(metadata.data.issuer, origin);
  assert.equal(metadata.data.authorization_endpoint, origin + '/oauth/authorize');
  assert.equal(metadata.data.registration_endpoint, origin + '/oauth/register');
  assert.deepEqual(metadata.data.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(metadata.data.token_endpoint_auth_methods_supported.slice().sort(), ['client_secret_basic', 'client_secret_post', 'none']);
  const first = (await database.query('SELECT cookie_key,signing_jwk FROM delegation_issuer')).rows;
  assert.equal(first.length, 1);
  assert(first[0].signing_jwk.d);
  const publicKeys = await call('/oauth/jwks');
  assert.equal(publicKeys.status, 200);
  assert(publicKeys.data.keys.every((key: Record<string, unknown>) => !key.d && !key.p && !key.q));
  const unsupported = await call('/oauth/register', {
    client_name: 'Unsupported private-key client', redirect_uris: ['http://127.0.0.1/callback'],
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_signing_alg: 'RS256',
    jwks: { keys: publicKeys.data.keys },
  }, { origin: null });
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.data.error, 'invalid_client_metadata');
  await call('/.well-known/oauth-authorization-server');
  assert.deepEqual((await database.query('SELECT cookie_key,signing_jwk FROM delegation_issuer')).rows, first);
  const resource = await call('/.well-known/oauth-protected-resource/mcp');
  assert.equal(resource.data.resource, origin + '/mcp');
  assert.deepEqual(resource.data.authorization_servers, [origin]);
  assert.equal(resource.headers.get('Cache-Control'), 'private, no-store, max-age=0');
});

test('authorization, real owner-scoped MCP read, refresh and owner revocation complete with no MCP cookies', async () => {
  const client = await register();
  const token = await exchange(client, await authorize(client));
  assert.equal(token.status, 200);
  assert.equal(token.headers.get('Set-Cookie'), null);
  const read = await mcp(token.data.access_token);
  assert.equal(read.status, 200);
  assert.notEqual(read.data.result.isError, true);
  assert.deepEqual(read.data.result.structuredContent.items.map((item: { name: string }) => item.name), ['alice workout']);
  assert.equal(read.headers.get('Set-Cookie'), null);
  const rotated = await refresh(client, token.data.refresh_token);
  assert.equal(rotated.status, 200);
  const grant = await connection(client);
  assert.deepEqual(grant.scopes, ['workouts:read']);
  assert.equal((await call('/api/delegation/revoke', { id: grant.id }, { jar: bob.jar })).status, 404);
  assert.equal((await mcp(rotated.data.access_token)).status, 200);
  assert.equal((await call('/api/delegation/revoke', { id: grant.id }, { jar: alice.jar })).status, 200);
  const denied = await mcp(rotated.data.access_token);
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('WWW-Authenticate')!, /oauth-protected-resource\/mcp/);
  assert.equal((await refresh(client, rotated.data.refresh_token)).status, 400);
  const next = await exchange(client, await authorize(client));
  assert.equal(next.status, 200);
  assert.notEqual((await connection(client)).id, grant.id);
  assert.equal((await mcp(rotated.data.access_token)).status, 401);
});

test('switching managed accounts in one browser resets issuer identity without revoking existing grants', async () => {
  const client = await register();
  const jar: Jar = new Map();
  const tokens: Tokens[] = [];
  for (const owner of [alice, bob]) {
    assert.equal((await call('/api/auth/sign-in/email', { email: owner.email, password }, { jar })).status, 200);
    const pending = await start(client, { ...owner, jar });
    for (const [name, value] of pending.jar) jar.set(name, value);
    const path = `/api/delegation/consent/${pending.uid}`;
    const details = await call(path, undefined, { jar });
    assert.equal(details.status, 200);
    assert.equal(details.data.accountEmail, owner.email);
    const approved = await call(path, { accepted: true, scopes: ['workouts:read'] }, { jar });
    assert.equal(approved.status, 200);
    const resumed = await call(approved.data.redirectTo, undefined, { jar });
    assert.equal(resumed.status, 303);
    const code = new URL(resumed.location!).searchParams.get('code');
    assert(code);
    const token = await exchange(client, code);
    assert.equal(token.status, 200);
    tokens.push(token.data);
    assert.equal((await call('/api/auth/sign-out', {}, { jar })).status, 200);
  }
  for (const [index, name] of ['alice workout', 'bob workout'].entries()) {
    const rotated = await refresh(client, tokens[index]!.refresh_token);
    assert.equal(rotated.status, 200);
    const read = await mcp(rotated.data.access_token);
    assert.equal(read.status, 200);
    assert.deepEqual(read.data.result.structuredContent.items.map((item: { name: string }) => item.name), [name]);
  }
});

test('consent requires matching fresh managed session, exact UID and same-origin writes, including resume', async () => {
  const client = await register();
  const pending = await start(client);
  const path = `/api/delegation/consent/${pending.uid}`;
  assert.equal((await call(path)).status, 401);
  assert.equal((await call(path, undefined, { jar: alice.jar })).status, 404);
  assert.equal((await call(path, undefined, { jar: bob.jar })).status, 403);
  assert.equal((await call(path + 'x', undefined, { jar: pending.jar })).status, 404);
  assert.equal((await call(path, { accepted: true, scopes: ['workouts:read'] }, { jar: pending.jar, origin: 'https://wrong.example' })).status, 403);
  assert.equal((await call(path, { accepted: true, scopes: ['recipes:read'] }, { jar: pending.jar })).status, 400);
  assert.equal((await call(path, { accepted: true, scopes: [] }, { jar: pending.jar })).status, 400);
  const approved = await call(path, { accepted: true, scopes: ['workouts:read'] }, { jar: pending.jar });
  assert.equal(approved.status, 200);
  const changed = new Map(pending.jar);
  for (const [key, value] of bob.jar) changed.set(key, value);
  assert.equal((await call(approved.data.redirectTo, undefined, { jar: changed })).status, 403);
  const resumed = await call(approved.data.redirectTo, undefined, { jar: pending.jar });
  assert.equal(resumed.status, 303);
  assert.equal((await call(path, { accepted: true, scopes: ['workouts:read'] }, { jar: pending.jar })).status, 404);
});

test('scope selection exposes only permitted tools, and denied consent issues no code', async () => {
  const client = await register();
  const token = await exchange(client, await authorize(client, alice, 'workouts:read recipes:read', ['recipes:read']));
  assert.equal(token.status, 200);
  const list = await call('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { bearer: token.data.access_token, origin: null });
  assert.deepEqual(list.data.result.tools.map((tool: { name: string }) => tool.name).sort(), ['get_recipes', 'list_recipes']);
  const unavailable = await mcp(token.data.access_token);
  assert.equal(unavailable.status, 200);
  assert.equal(unavailable.data.result.isError, true);
  assert.equal(unavailable.data.result.structuredContent, undefined);
  const pending = await start(await register());
  const denied = await call(`/api/delegation/consent/${pending.uid}`, { accepted: false, scopes: [] }, { jar: pending.jar });
  assert.equal(denied.status, 200);
  const callback = await call(denied.data.redirectTo, undefined, { jar: pending.jar });
  const url = new URL(callback.location!);
  assert.equal(url.searchParams.get('error'), 'access_denied');
  assert.equal(url.searchParams.has('code'), false);
});

test('wrong resource/PKCE and cross-client replay cannot consume or revoke a victim credential', async () => {
  const client = await register();
  const code = await authorize(client);
  assert.equal((await call('/oauth/token', { ...codeBody(client, code), code_verifier: 'x'.repeat(64) }, { form: true, origin: null })).status, 400);
  const token = await exchange(client, code);
  assert.equal(token.status, 200);
  const attacker = await register();
  assert.equal((await call('/oauth/token', { ...codeBody(attacker, code), code_verifier: 'x'.repeat(64) }, { form: true, origin: null })).status, 400);
  assert.equal((await refresh(client, token.data.refresh_token, 'https://wrong.example/mcp')).status, 400);
  const rotated = await refresh(client, token.data.refresh_token);
  assert.equal(rotated.status, 200);
  assert.equal((await mcp(rotated.data.access_token)).status, 200);
  const mismatchedRevoke = await call('/oauth/revoke', { client_id: attacker.client_id, token: rotated.data.refresh_token, token_type_hint: 'refresh_token' }, { form: true, origin: null });
  assert.equal(mismatchedRevoke.status, 200);
  assert.equal((await refresh(client, rotated.data.refresh_token)).status, 200);
});

test('concurrent authorization-code reuse has one winner and revokes its live grant', async () => {
  const client = await register();
  const code = await authorize(client);
  const results = await Promise.all([exchange(client, code), exchange(client, code)]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
  assert.equal((await mcp(results.find((result) => result.status === 200)!.data.access_token)).status, 401);
});

test('concurrent refresh reuse has one winner and revokes its complete family', async () => {
  const client = await register();
  const token = await exchange(client, await authorize(client));
  const results = await Promise.all([refresh(client, token.data.refresh_token), refresh(client, token.data.refresh_token)]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
  assert.equal((await mcp(results.find((result) => result.status === 200)!.data.access_token)).status, 401);
  assert.equal((await mcp(token.data.access_token)).status, 401);
});

test('refresh versus owner revocation serializes without surviving credentials; standard revoke is live', async () => {
  const client = await register();
  const token = await exchange(client, await authorize(client));
  const grant = await connection(client);
  const [rotated, revoked] = await Promise.all([refresh(client, token.data.refresh_token), call('/api/delegation/revoke', { id: grant.id }, { jar: alice.jar })]);
  assert.equal(revoked.status, 200);
  assert([200, 400].includes(rotated.status));
  assert.equal((await mcp(token.data.access_token)).status, 401);
  if (rotated.status === 200) assert.equal((await mcp(rotated.data.access_token)).status, 401);
  const next = await exchange(client, await authorize(client));
  assert.equal((await call('/oauth/revoke', { client_id: client.client_id, token: next.data.refresh_token, token_type_hint: 'refresh_token' }, { form: true, origin: null })).status, 200);
  assert.equal((await mcp(next.data.access_token)).status, 401);
});

test('delegation survives real managed-session expiry but cannot use it for new consent', async () => {
  const expiring = await account('expiring');
  const client = await register();
  const token = await exchange(client, await authorize(client, expiring));
  const sessions = await database.query('SELECT id FROM "session" WHERE "userId"=$1', [expiring.id]);
  assert(sessions.rows.length > 0);
  await database.query('UPDATE "session" SET "expiresAt"=now()-interval \'1 second\' WHERE "userId"=$1', [expiring.id]);
  assert.equal((await call('/api/delegation/connections', undefined, { jar: expiring.jar })).status, 401);
  const rotated = await refresh(client, token.data.refresh_token);
  assert.equal(rotated.status, 200);
  assert.equal((await mcp(rotated.data.access_token)).status, 200);
});

test('bearer requests enforce supplied Origin and never accept cookies or query credentials as authorization', async () => {
  assert.equal((await call('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { jar: alice.jar })).status, 401);
  const client = await register();
  const token = await exchange(client, await authorize(client));
  assert.equal((await call('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { bearer: token.data.access_token, origin: 'https://wrong.example' })).status, 403);
  assert.equal((await call(`/mcp?access_token=${token.data.access_token}`, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { origin: null })).status, 401);
  assert.equal((await mcp(token.data.access_token)).status, 200);
  assert.equal((await call('/auth/callback?code=retired')).status, 404);
  assert.equal((await call('/api/ai/request', {}, { jar: alice.jar })).status, 404);
  assert.equal((await call('/oauth/account')).status, 404);
});

test('reset return permits only the same-origin reset route and one validated local OAuth return', async () => {
  const target = '/oauth/sign-in?' + new URLSearchParams({ returnTo: '/oauth/authorize?client_id=fixture' });
  for (const redirectTo of [origin + '/account/reset-password?next=elsewhere', origin + '/account/reset-password?oauthReturn=https%3A%2F%2Fwrong.example', origin + '/account/reset-password?oauthReturn=%2Foauth%2Fconsent%2Fuid&oauthReturn=%2Foauth%2Fconsent%2Fother', 'https://wrong.example/account/reset-password']) {
    assert.equal((await call('/api/auth/request-password-reset', { email: 'alice@example.test', redirectTo })).status, 400);
  }
  assert.equal(resetDeliveries.length, 0, 'Invalid returns must never reach reset delivery.');
  const redirectTo = origin + '/account/reset-password?' + new URLSearchParams({ oauthReturn: target });
  const valid = await call('/api/auth/request-password-reset', { email: alice.email, redirectTo });
  assert.equal(valid.status, 200);
  const delivery = resetDeliveries.at(-1);
  assert(delivery);
  assert.equal(delivery.email, alice.email);
  assert(delivery.token, 'The maintained identity fixture must issue a real reset token.');
  assert.equal(new URL(delivery.url).searchParams.get('callbackURL'), redirectTo);
});

test('explicit offline_access plus prompt=consent completes once and retains only selected domain scopes', async () => {
  const client = await register();
  const token = await exchange(client, await authorize(client, alice, 'workouts:read recipes:read offline_access', ['workouts:read'], 'consent'));
  assert.equal(token.status, 200);
  assert(token.data.refresh_token);
  const visible = await call('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { bearer: token.data.access_token, origin: null });
  assert.deepEqual(visible.data.result.tools.map((tool: { name: string }) => tool.name).sort(), ['exercise_history', 'get_workouts', 'list_workouts']);
  const grants = await call('/api/delegation/connections', undefined, { jar: alice.jar });
  const matches = grants.data.connections.filter((item: { clientName: string }) => item.clientName === client.client_name);
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0].scopes, ['workouts:read']);
  assert.equal((await refresh(client, token.data.refresh_token)).status, 200);
});

test('a valid maintained token with a different stored audience cannot access this MCP resource', async () => {
  const client = await register();
  const token = await exchange(client, await authorize(client));
  assert.equal(token.status, 200);
  const changed = await database.query(
    "UPDATE delegation_objects SET payload=jsonb_set(payload,'{aud}',to_jsonb($1::text)) WHERE model='AccessToken' AND client_id=$2 RETURNING id",
    ['https://different-resource.example/mcp', client.client_id],
  );
  assert.equal(changed.rowCount, 1);
  assert.equal((await mcp(token.data.access_token)).status, 401);
  await database.query(
    "UPDATE delegation_objects SET payload=jsonb_set(payload,'{aud}',to_jsonb($1::text)) WHERE model='AccessToken' AND client_id=$2",
    [origin + '/mcp', client.client_id],
  );
  assert.equal((await mcp(token.data.access_token)).status, 200);
});

test('another actual managed session for the same owner cannot take over pending consent', async () => {
  const pending = await start(await register());
  const replacement: Jar = new Map();
  assert.equal((await call('/api/auth/sign-in/email', { email: 'alice@example.test', password }, { jar: replacement })).status, 200);
  const changed = new Map(pending.jar);
  for (const [name, value] of replacement) changed.set(name, value);
  assert.equal((await call(`/api/delegation/consent/${pending.uid}`, undefined, { jar: changed })).status, 403);
  const approved = await call(`/api/delegation/consent/${pending.uid}`, { accepted: true, scopes: ['workouts:read'] }, { jar: pending.jar });
  assert.equal(approved.status, 200);
  assert.equal((await call(`/api/delegation/consent/${pending.uid}`, { accepted: true, scopes: ['workouts:read'] }, { jar: pending.jar })).status, 409);
});

test('owner-selected meal writes cross real OAuth and HTTP, retain raw retries and stop after revocation', async () => {
  const recipe = {
    id: 'http-meal-recipe', name: 'Oats', description: '', category: 'breakfast', prepMinutes: 1,
    cookMinutes: 0, nutrition: { calories: 100, protein: 10, carbs: 10, fat: 2 },
    ingredients: [{ name: 'Oats', quantity: 100, unit: 'g', aisle: 'Grains' }], steps: ['Mix'],
    storage: '', variation: '', tags: [], color: '#234b35', source: 'manual', favorite: false,
    createdAt: '2026-10-28T12:00:00.000Z',
  };
  await store.mutate(alice.id, 'http-recipe-seed', { type: 'recipe.save', data: recipe });
  const revision = (await store.bootstrap(alice.id)).revision;
  const client = await register();
  const token = await exchange(client, await authorize(client, alice, 'meal-plans:write recipes:read', ['meal-plans:write']));
  assert.equal(token.status, 200);
  const visible = await call('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { bearer: token.data.access_token, origin: null });
  assert.deepEqual(visible.data.result.tools.map((tool: { name: string }) => tool.name), ['edit_meal_plans']);
  const entry = { id: 'http-meal', date: '2026-10-28', slot: 'breakfast', recipeId: ' http-meal-recipe ', servings: 1 };
  const input = { operationId: 'http-meal-create', expectedRevision: revision, changes: [{ action: 'create', entry }] };
  const created = await mcp(token.data.access_token, 'edit_meal_plans', input);
  assert.deepEqual(created.data.result.structuredContent, { revision: revision + 1 });
  const patched = await mcp(token.data.access_token, 'edit_meal_plans', {
    operationId: 'http-meal-update', expectedRevision: revision + 1,
    changes: [{ action: 'update', id: entry.id, patch: { servings: 2 } }],
  });
  assert.deepEqual(patched.data.result.structuredContent, { revision: revision + 2 });
  assert.deepEqual((await mcp(token.data.access_token, 'edit_meal_plans', input)).data.result.structuredContent, { revision: revision + 1 });
  const changed = await mcp(token.data.access_token, 'edit_meal_plans', {
    ...input, changes: [{ action: 'create', entry: { ...entry, recipeId: entry.recipeId.trim() } }],
  });
  assert.equal(changed.data.result.structuredContent.code, 'REQUEST_ID_REUSED');
  const snapshot = await store.exportSnapshot(alice.id);
  assert.deepEqual(snapshot.state.plan.find((meal) => meal.id === entry.id), { ...entry, recipeId: entry.recipeId.trim(), servings: 2 });
  assert.equal(snapshot.revision, revision + 2);
  const renewed = await refresh(client, token.data.refresh_token);
  assert.equal(renewed.status, 200);
  assert.deepEqual((await connection(client)).scopes, ['meal-plans:write']);
  assert.equal((await mcp(renewed.data.access_token, 'list_recipes')).data.result.isError, true);
  const grant = await connection(client);
  assert.equal((await call('/api/delegation/revoke', { id: grant.id }, { jar: alice.jar })).status, 200);
  assert.equal((await mcp(renewed.data.access_token, 'edit_meal_plans', input)).status, 401);
});

test('nutrition OAuth grants keep edit/delete independent and HTTP CRUD returns no ungranted domain data', async () => {
  const client = await register();
  const requested = 'recipes:write recipes:delete food-logs:write food-logs:delete';
  const token = await exchange(client, await authorize(client, bob, requested, ['recipes:write', 'food-logs:write']));
  assert.equal(token.status, 200);
  const tools = await call('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { bearer: token.data.access_token, origin: null });
  assert.deepEqual(tools.data.result.tools.map((tool: { name: string }) => tool.name).sort(), ['create_food_log', 'create_recipe', 'update_food_log', 'update_recipe']);
  assert.equal((await mcp(token.data.access_token, 'delete_recipe', { operationId: 'denied-delete', expectedRevision: 0, id: 'anything' })).data.result.isError, true);
  const renewed = await refresh(client, token.data.refresh_token);
  assert.equal(renewed.status, 200);
  assert.deepEqual((await connection(client, bob)).scopes.slice().sort(), ['food-logs:write', 'recipes:write']);
  const deletionClient = await register();
  const deletion = await exchange(deletionClient, await authorize(deletionClient, bob, 'recipes:delete food-logs:delete'));
  assert.equal(deletion.status, 200);
  const nutrition = { calories: 111, protein: 7, carbs: 13, fat: 3 };
  const recipe = {
    id: 'http-crud-recipe', name: 'Explicit recipe', description: '', category: 'breakfast',
    prepMinutes: 1, cookMinutes: 0, nutrition, ingredients: [{ name: 'Oats', quantity: 100, unit: 'g', aisle: 'Grains' }],
    steps: ['Mix'], storage: '', variation: '', tags: [], color: '#234b35', source: 'manual',
    favorite: false, createdAt: '2026-10-28T12:00:00.000Z',
  };
  const entry = { id: 'http-crud-food', name: 'Explicit snapshot', date: '2026-10-28', slot: 'breakfast', nutrition, servings: 1, recipeId: recipe.id, createdAt: recipe.createdAt };
  let revision = (await store.bootstrap(bob.id)).revision;
  const changes: Array<[string, Record<string, unknown>, string]> = [
    ['create_recipe', { recipe }, renewed.data.access_token],
    ['create_food_log', { entry }, renewed.data.access_token],
    ['update_recipe', { id: recipe.id, patch: { name: 'Changed recipe' } }, renewed.data.access_token],
    ['update_food_log', { id: entry.id, patch: { servings: 2 } }, renewed.data.access_token],
    ['delete_recipe', { id: recipe.id }, deletion.data.access_token],
    ['delete_food_log', { id: entry.id }, deletion.data.access_token],
  ];
  for (const [name, fields, bearer] of changes) {
    const response = await mcp(bearer, name, { operationId: `http-crud-${name}`, expectedRevision: revision, ...fields });
    assert.equal(response.status, 200);
    assert.deepEqual(response.data.result.structuredContent, { revision: ++revision });
    if (name === 'delete_recipe') {
      const snapshot = await store.exportSnapshot(bob.id);
      assert.deepEqual(snapshot.state.logs.find(({ id }) => id === entry.id), { ...entry, servings: 2 });
    }
  }
  const snapshot = await store.exportSnapshot(bob.id);
  assert.equal(snapshot.state.recipes.some(({ id }) => id === recipe.id), false);
  assert.equal(snapshot.state.logs.some(({ id }) => id === entry.id), false);
});
