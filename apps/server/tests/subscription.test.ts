import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { SubscriptionError, SubscriptionProvider, type SubscriptionConfig } from '../src/subscription.ts';

// Every network response is synthetic. No test reads credentials, opens a
// browser, contacts OpenAI, or spends API/subscription usage.
const issuer = 'https://auth.openai.com';
const clientId = 'oaiapp_corner_test';
const directScopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const signingKeys = await generateKeyPair('RS256', { extractable: true });
const wrongKeys = await generateKeyPair('RS256', { extractable: true });
const jwk = { ...(await exportJWK(signingKeys.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

interface Call { url: string; init: RequestInit }
interface Harness {
  db: DatabaseSync;
  config: SubscriptionConfig;
  provider: SubscriptionProvider;
  calls: Call[];
  fetcher: typeof fetch;
  nonce: string;
  claims: Partial<JWTPayload>;
  expiresIn: number;
  scope: string;
  useWrongKey: boolean;
  tokenPatch: Record<string, unknown>;
  refreshPatch: Record<string, unknown>;
  refreshCount: number;
  catalog: unknown;
  tokenHandler?: (params: URLSearchParams) => Promise<Response>;
  inferenceHandler?: (init: RequestInit) => Promise<Response>;
  revokeStatus: number;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'x-request-id': 'req_test' } });
}

async function idToken(h: Harness, patch: Partial<JWTPayload> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: issuer, sub: 'openai-user-a', aud: clientId, iat: now, exp: now + 3600, nonce: h.nonce, email: 'person@example.test', name: 'Test Person', ...h.claims, ...patch })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .sign(h.useWrongKey ? wrongKeys.privateKey : signingKeys.privateKey);
}

function harness(t: TestContext, configPatch: Partial<SubscriptionConfig> = {}): Harness {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const config: SubscriptionConfig = {
    origin: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000, dataDir: '/tmp/corner-subscription-test',
    deployment: 'local', authSecret: 'synthetic-test-session-secret-not-an-actual-credential', tokenEncryptionKey: randomBytes(32), ...configPatch,
  };
  const calls: Call[] = [];
  let h: Harness;
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return json({ issuer, jwks_uri: `${issuer}/.well-known/jwks.json`, revocation_endpoint: `${issuer}/api/accounts/oauth/revoke` });
    }
    if (url === `${issuer}/.well-known/jwks.json`) return json({ keys: [jwk] });
    if (url === `${issuer}/api/accounts/oauth/token`) {
      const params = new URLSearchParams(String(init.body));
      if (h.tokenHandler) return h.tokenHandler(params);
      if (params.get('grant_type') === 'refresh_token') {
        h.refreshCount++;
        return json({ access_token: 'synthetic-rotated-access', refresh_token: 'synthetic-rotated-refresh', token_type: 'Bearer', expires_in: 3600, scope: h.scope, ...h.refreshPatch });
      }
      return json({ access_token: 'synthetic-private-access', refresh_token: 'synthetic-private-refresh', id_token: await idToken(h), token_type: 'Bearer', expires_in: h.expiresIn, scope: h.scope, ...h.tokenPatch });
    }
    if (url === `${issuer}/api/accounts/oauth/revoke`) return new Response('', { status: h.revokeStatus });
    if (url === 'https://api.openai.com/v1/models') return json(h.catalog);
    if (url === 'https://api.openai.com/v1/responses') {
      if (h.inferenceHandler) return h.inferenceHandler(init);
      return events([{ type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [] } }]);
    }
    throw new Error(`Unexpected mock endpoint: ${url}`);
  };
  h = {
    db, config, calls, fetcher, provider: new SubscriptionProvider({ db, config, fetch: fetcher }),
    nonce: '', claims: {}, expiresIn: 3600, scope: directScopes, useWrongKey: false,
    tokenPatch: {}, refreshPatch: {}, refreshCount: 0, revokeStatus: 200,
    catalog: { models: [
      { slug: 'test-model-a', display_name: 'Test Model A', visibility: 'list' },
      { slug: 'hidden-model', display_name: 'Hidden model', visibility: 'hidden' },
      { slug: 'test-model-b', display_name: 'Test Model B', visibility: 'list' },
    ] },
  };
  return h;
}

async function start(h: Harness, user = 'corner-user-a', session = 'session-a'): Promise<URL> {
  const { url } = await h.provider.begin(user, session);
  const result = new URL(url);
  h.nonce = result.searchParams.get('nonce')!;
  return result;
}

function callbackUrl(authorization: URL, patch: Record<string, string | null> = {}): URL {
  const url = new URL(authorization.searchParams.get('redirect_uri')!);
  url.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'synthetic-authorization-code', client_id: clientId }).toString();
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  return url;
}

async function connect(h: Harness, user = 'corner-user-a', session = 'session-a') {
  return h.provider.callback(user, callbackUrl(await start(h, user, session)), session);
}

function hasCode(expected: string) {
  return (error: unknown) => error instanceof SubscriptionError && error.code === expected;
}

function streamText(text: string, chunkSize = 17): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(bytes.length, offset + chunkSize);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  }), { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'req_test_stream' } });
}

function events(payloads: unknown[], chunkSize = 17): Response {
  return streamText(payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join(''), chunkSize);
}

test('hosted, noncanonical browser origins, and invalid listeners cannot use dynamic registration', async t => {
  for (const patch of [
    { deployment: 'hosted' as const, origin: 'https://corner.example.test' },
    { origin: 'http://localhost:3000' },
    { origin: 'https://127.0.0.1:3000' },
    { origin: 'http://127.0.0.1:3000/not-an-origin' },
    { origin: 'http://user@127.0.0.1:3000' },
    { origin: 'http://127.0.0.1:3000?redirect=elsewhere' },
    { host: '192.0.2.20' },
    { port: 0 },
    { port: 65536 },
  ]) {
    const h = harness(t, patch);
    const status = await h.provider.status('corner-user-a');
    assert.equal(status.supported, false);
    assert.equal(status.state, 'unavailable');
    await assert.rejects(h.provider.begin('corner-user-a', 'session-a'), hasCode('supported_registration_unavailable'));
    await assert.rejects(h.provider.models('corner-user-a'), hasCode('supported_registration_unavailable'));
    assert.equal(h.calls.length, 0);
  }
});

test('a separate development API port retains the exact canonical browser callback and PKCE', async t => {
  const h = harness(t, { port: 3001 });
  assert.equal((await h.provider.status('corner-user-a')).supported, true);
  const authorization = await start(h);
  assert.equal(authorization.searchParams.get('redirect_uri'), 'http://127.0.0.1:3000/auth/callback');
  const wrongListener = callbackUrl(authorization);
  wrongListener.port = '3001';
  await assert.rejects(h.provider.callback('corner-user-a', wrongListener, 'session-a'), hasCode('invalid_callback'));
  assert.equal(h.calls.length, 0);
  const connected = await h.provider.callback('corner-user-a', callbackUrl(authorization), 'session-a');
  assert.equal(connected.planEnabled, true);
  const exchange = h.calls.find(call => call.url.endsWith('/oauth/token'))!;
  const params = new URLSearchParams(String(exchange.init.body));
  assert.equal(params.get('redirect_uri'), 'http://127.0.0.1:3000/auth/callback');
  assert.equal(createHash('sha256').update(params.get('code_verifier')!).digest('base64url'), authorization.searchParams.get('code_challenge'));
});

test('a local Docker bind still requires the exact loopback browser origin', async t => {
  const h = harness(t, { host: '0.0.0.0' });
  assert.equal((await h.provider.status('corner-user-a')).supported, true);
  assert.equal(new URL((await h.provider.begin('corner-user-a', 'session-a')).url).searchParams.get('redirect_uri'), 'http://127.0.0.1:3000/auth/callback');
  const publicOrigin = harness(t, { host: '0.0.0.0', origin: 'http://corner.example.test:3000' });
  assert.equal((await publicOrigin.provider.status('corner-user-a')).supported, false);
});

test('authorization uses fresh PKCE, stable opaque host ID, official endpoints, and encrypted pending secrets', async t => {
  const h = harness(t);
  const first = await start(h);
  assert.equal(first.origin + first.pathname, `${issuer}/api/accounts/authorize`);
  assert.equal(first.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(first.searchParams.get('agent_name_hint'), 'Corner');
  assert.equal(first.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(first.searchParams.get('redirect_uri'), 'http://127.0.0.1:3000/auth/callback');
  assert.equal(first.searchParams.get('resource'), 'https://api.openai.com/v1');
  assert.equal(first.searchParams.get('scope'), directScopes);
  assert.match(first.searchParams.get('ext_agent_host_id')!, /^urn:uuid:[0-9a-f-]{36}$/);
  const stored = JSON.stringify(h.db.prepare('SELECT * FROM corner_subscription_attempts').all());
  assert.ok(!stored.includes(first.searchParams.get('state')!));
  assert.ok(!stored.includes(first.searchParams.get('nonce')!));
  assert.ok(!stored.includes('session-a'));
  h.provider = new SubscriptionProvider({ db: h.db, config: h.config, fetch: h.fetcher });
  const second = await start(h);
  assert.equal(first.searchParams.get('ext_agent_host_id'), second.searchParams.get('ext_agent_host_id'));
  assert.notEqual(first.searchParams.get('state'), second.searchParams.get('state'));
  assert.notEqual(first.searchParams.get('code_challenge'), second.searchParams.get('code_challenge'));
  await h.provider.callback('corner-user-a', callbackUrl(second), 'session-a');
  const exchange = h.calls.find(call => call.url.endsWith('/oauth/token'))!;
  const params = new URLSearchParams(String(exchange.init.body));
  assert.equal(params.get('client_id'), clientId);
  assert.equal(params.get('redirect_uri'), second.searchParams.get('redirect_uri'));
  assert.equal(createHash('sha256').update(params.get('code_verifier')!).digest('base64url'), second.searchParams.get('code_challenge'));
  assert.equal(params.has('client_secret'), false);
  assert.equal(exchange.init.redirect, 'error');
});

test('OAuth callback is bound to the initiating Corner owner and session and is single use', async t => {
  const h = harness(t);
  await assert.rejects(h.provider.begin('corner-user-a'), hasCode('session_required'));
  const callback = callbackUrl(await start(h));
  await assert.rejects(h.provider.callback('corner-user-b', callback, 'session-a'), hasCode('invalid_oauth_state'));
  await assert.rejects(h.provider.callback('corner-user-a', callback, 'other-session'), hasCode('invalid_oauth_state'));
  assert.equal(h.calls.length, 0);
  const result = await h.provider.callback('corner-user-a', callback, 'session-a');
  assert.equal(result.planEnabled, true);
  await assert.rejects(h.provider.callback('corner-user-a', callback, 'session-a'), hasCode('invalid_oauth_state'));
  assert.equal(h.calls.filter(call => call.url.endsWith('/oauth/token')).length, 1);
});

test('expired, wrong-origin, duplicate-parameter and incomplete callbacks do not exchange a code', async t => {
  const h = harness(t);
  const expired = callbackUrl(await start(h));
  h.db.prepare('UPDATE corner_subscription_attempts SET expires_at = 0').run();
  await assert.rejects(h.provider.callback('corner-user-a', expired, 'session-a'), hasCode('invalid_oauth_state'));
  const wrongOrigin = callbackUrl(await start(h));
  wrongOrigin.hostname = 'localhost';
  await assert.rejects(h.provider.callback('corner-user-a', wrongOrigin, 'session-a'), hasCode('invalid_callback'));
  const duplicate = callbackUrl(await start(h));
  duplicate.searchParams.append('code', 'second-code');
  await assert.rejects(h.provider.callback('corner-user-a', duplicate, 'session-a'), hasCode('invalid_callback'));
  const incompletePatches: Array<Record<string, string | null>> = [{ client_id: null }, { client_id: 'dynamic_agent_client' }, { code: null }];
  for (const patch of incompletePatches) {
    const incomplete = callbackUrl(await start(h), patch);
    await assert.rejects(h.provider.callback('corner-user-a', incomplete, 'session-a'), hasCode('registration_incomplete'));
  }
  assert.equal(h.calls.length, 0);
});

test('declining consent consumes the attempt without token exchange', async t => {
  const h = harness(t);
  const callback = callbackUrl(await start(h), { error: 'access_denied', code: null });
  await assert.rejects(h.provider.callback('corner-user-a', callback, 'session-a'), hasCode('oauth_access_denied'));
  assert.equal(h.calls.length, 0);
  assert.equal((await h.provider.status('corner-user-a')).connected, false);
});

test('ID-token signature, issuer, audience, expiry, nonce and authorized party are verified', async t => {
  const invalidCases: Array<{ claims?: Partial<JWTPayload>; wrongKey?: boolean }> = [
    { wrongKey: true }, { claims: { iss: 'https://attacker.example.test' } },
    { claims: { aud: 'some-other-app' } }, { claims: { exp: Math.floor(Date.now() / 1000) - 60 } },
    { claims: { nonce: 'wrong-nonce' } }, { claims: { sub: '' } },
    { claims: { aud: [clientId, 'another-app'], azp: 'another-app' } },
  ];
  for (const invalid of invalidCases) {
    const h = harness(t);
    h.claims = invalid.claims ?? {};
    h.useWrongKey = invalid.wrongKey ?? false;
    await assert.rejects(connect(h), hasCode('invalid_identity_token'));
    assert.equal((await h.provider.status('corner-user-a')).connected, false);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM corner_subscription_accounts').get()!.count, 0);
  }
});

test('identity-only consent remains linked but cannot perform plan inference', async t => {
  const h = harness(t);
  h.scope = 'openid profile email';
  const result = await connect(h);
  assert.equal(result.connected, true);
  assert.equal(result.planEnabled, false);
  assert.equal(result.state, 'permission_required');
  await assert.rejects(h.provider.respond('corner-user-a', { instructions: 'Help', input: [] }), hasCode('chatgpt_permission_required'));
  assert.equal(h.calls.some(call => call.url.endsWith('/responses')), false);
  const reauth = await start(h);
  assert.equal(reauth.searchParams.get('client_id'), clientId);
  assert.equal(reauth.searchParams.get('prompt'), 'consent');
  assert.equal(reauth.searchParams.has('agent_name_hint'), false);
  assert.equal(reauth.searchParams.has('id_token_hint'), false);
});

test('reauthorization must retain the issued client and verified account identity', async t => {
  const h = harness(t);
  await connect(h);
  const mismatch = callbackUrl(await start(h), { client_id: 'oaiapp_other' });
  await assert.rejects(h.provider.callback('corner-user-a', mismatch, 'session-a'), hasCode('client_mismatch'));
  h.claims = { sub: 'different-openai-user', email: 'other@example.test' };
  const wrongAccount = callbackUrl(await start(h), { client_id: null });
  await assert.rejects(h.provider.callback('corner-user-a', wrongAccount, 'session-a'), hasCode('account_mismatch'));
  assert.equal((await h.provider.status('corner-user-a')).account?.email, 'person@example.test');
});

test('new issued client ID survives invalid_grant without claiming a connected identity', async t => {
  const h = harness(t);
  h.tokenHandler = async () => json({ error: 'invalid_grant' }, 400);
  await assert.rejects(connect(h), hasCode('invalid_grant'));
  assert.equal((await h.provider.status('corner-user-a')).connected, false);
  assert.equal((await start(h)).searchParams.get('client_id'), clientId);
});

test('credentials are encrypted per user and never appear in safe status DTOs', async t => {
  const h = harness(t);
  await connect(h);
  const status = JSON.stringify(await h.provider.status('corner-user-a'));
  const rows = JSON.stringify(h.db.prepare('SELECT * FROM corner_subscription_accounts').all());
  for (const privateValue of ['synthetic-private-access', 'synthetic-private-refresh', 'openai-user-a', clientId]) {
    assert.equal(status.includes(privateValue), false);
    assert.equal(rows.includes(privateValue), false);
  }
  assert.equal(status.includes('person@example.test'), true);
  const row = h.db.prepare('SELECT encrypted FROM corner_subscription_accounts WHERE user_id = ?').get('corner-user-a') as { encrypted: string };
  h.db.prepare('INSERT INTO corner_subscription_accounts(user_id, encrypted) VALUES (?, ?)').run('corner-user-b', row.encrypted);
  assert.equal((await h.provider.status('corner-user-b')).state, 'reauth_required');
});

test('model selection uses only the current account visible models and rejects unavailable choices', async t => {
  const h = harness(t);
  await connect(h);
  assert.deepEqual(await h.provider.models('corner-user-a'), [
    { slug: 'test-model-a', displayName: 'Test Model A' },
    { slug: 'test-model-b', displayName: 'Test Model B' },
  ]);
  await assert.rejects(h.provider.setModel('corner-user-a', 'hidden-model'), hasCode('invalid_model'));
  assert.equal((await h.provider.setModel('corner-user-a', 'test-model-b')).model, 'test-model-b');
  h.catalog = { data: [{ id: 'wrong-api-shape' }] };
  await assert.rejects(h.provider.models('corner-user-a'), hasCode('invalid_model_catalog'));
});

test('concurrent renewal serializes rotating refresh tokens and persists the replacement', async t => {
  const h = harness(t);
  h.expiresIn = 1;
  await connect(h);
  await Promise.all(Array.from({ length: 8 }, () => h.provider.models('corner-user-a')));
  assert.equal(h.refreshCount, 1);
  const refresh = h.calls.filter(call => call.url.endsWith('/oauth/token')).at(-1)!;
  const params = new URLSearchParams(String(refresh.init.body));
  assert.equal(params.get('refresh_token'), 'synthetic-private-refresh');
  assert.equal(params.get('client_id'), clientId);
  assert.equal(params.has('scope'), false);
  const modelCalls = h.calls.filter(call => call.url.endsWith('/models'));
  assert.equal(modelCalls.length, 8);
  for (const call of modelCalls) assert.equal(new Headers(call.init.headers).get('Authorization'), 'Bearer synthetic-rotated-access');
  assert.equal(JSON.stringify(h.db.prepare('SELECT * FROM corner_subscription_accounts').all()).includes('synthetic-rotated'), false);
  h.provider = new SubscriptionProvider({ db: h.db, config: h.config, fetch: h.fetcher });
  await h.provider.models('corner-user-a');
  assert.equal(h.refreshCount, 1);
});

test('independent provider instances share a SQLite refresh lease', async t => {
  const h = harness(t);
  h.expiresIn = 1;
  await connect(h);
  const other = new SubscriptionProvider({ db: h.db, config: h.config, fetch: h.fetcher });
  await Promise.all([h.provider.models('corner-user-a'), other.models('corner-user-a')]);
  assert.equal(h.refreshCount, 1);
});

test('terminal refresh failures clear unusable tokens while temporary failures preserve the connection', async t => {
  const h = harness(t);
  h.expiresIn = 1;
  await connect(h);
  h.tokenHandler = async () => json({ error: { code: 'subscription_sharing_usage_unavailable' } }, 503);
  await assert.rejects(h.provider.models('corner-user-a'), hasCode('subscription_sharing_usage_unavailable'));
  assert.equal((await h.provider.status('corner-user-a')).connected, true);
  h.tokenHandler = async () => json({ error: 'invalid_grant' }, 400);
  await assert.rejects(h.provider.models('corner-user-a'), hasCode('invalid_grant'));
  assert.equal((await h.provider.status('corner-user-a')).state, 'reauth_required');
  assert.equal((await start(h)).searchParams.get('client_id'), clientId);
});

test('refresh checks changed identity and withdrawn plan permissions', async t => {
  const wrongIdentity = harness(t);
  wrongIdentity.expiresIn = 1;
  await connect(wrongIdentity);
  wrongIdentity.refreshPatch.id_token = await idToken(wrongIdentity, { sub: 'another-openai-user' });
  await assert.rejects(wrongIdentity.provider.models('corner-user-a'), hasCode('account_mismatch'));
  const withdrawn = harness(t);
  withdrawn.expiresIn = 1;
  await connect(withdrawn);
  withdrawn.refreshPatch.scope = 'openid profile email';
  await assert.rejects(withdrawn.provider.models('corner-user-a'), hasCode('chatgpt_permission_required'));
  assert.equal((await withdrawn.provider.status('corner-user-a')).state, 'permission_required');
});

test('disconnect during token renewal cannot resurrect the saved connection', async t => {
  const h = harness(t);
  h.expiresIn = 1;
  await connect(h);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { started = resolve; });
  h.tokenHandler = async () => {
    started();
    await gate;
    return json({ access_token: 'synthetic-after-disconnect', refresh_token: 'synthetic-next-refresh', token_type: 'Bearer', expires_in: 3600, scope: directScopes });
  };
  const renewing = h.provider.models('corner-user-a');
  const rejected = assert.rejects(renewing, hasCode('connection_changed'));
  await waiting;
  assert.equal((await h.provider.disconnect('corner-user-a')).connected, false);
  release();
  await rejected;
  assert.equal((await h.provider.status('corner-user-a')).connected, false);
});

test('disconnect during an initial OAuth exchange cannot create a connection after the user disconnects', async t => {
  const h = harness(t);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const authorization = await start(h);
  const token = await idToken(h);
  h.tokenHandler = async () => {
    started();
    await gate;
    return json({ access_token: 'synthetic-disconnected-during-auth', refresh_token: 'synthetic-refresh', id_token: token, token_type: 'Bearer', expires_in: 3600, scope: directScopes });
  };
  const completing = h.provider.callback('corner-user-a', callbackUrl(authorization), 'session-a');
  const rejected = assert.rejects(completing, hasCode('connection_changed'));
  await waiting;
  await h.provider.disconnect('corner-user-a');
  release();
  await rejected;
  assert.equal((await h.provider.status('corner-user-a')).connected, false);
});

test('disconnect revokes the renewable session and honestly reports an unconfirmed remote revoke', async t => {
  const h = harness(t);
  await connect(h);
  const result = await h.provider.disconnect('corner-user-a');
  assert.equal(result.revocationConfirmed, true);
  assert.equal(result.connected, false);
  const revoke = h.calls.find(call => call.url.endsWith('/oauth/revoke'))!;
  const params = new URLSearchParams(String(revoke.init.body));
  assert.equal(params.get('token'), 'synthetic-private-refresh');
  assert.equal(params.get('client_id'), clientId);
  assert.equal(params.get('token_type_hint'), 'refresh_token');
  await connect(h);
  h.revokeStatus = 503;
  const failed = await h.provider.disconnect('corner-user-a');
  assert.equal(failed.revocationConfirmed, false);
  assert.equal(failed.connected, false);
  assert.match(failed.message, /not confirmed/);
});

test('inference preserves namespaced tools and sends only the supported request fields', async t => {
  const h = harness(t);
  await connect(h);
  const tools = [{ type: 'namespace', name: 'corner', description: 'Corner plan tools', tools: [{ type: 'function', name: 'save_plan', description: 'Propose a plan', parameters: { type: 'object', properties: {}, additionalProperties: false } }] }];
  const result = await h.provider.respond('corner-user-a', { instructions: 'Use only Corner data.', input: [{ role: 'user', content: 'Plan my training.' }], tools, tool_choice: 'auto' });
  assert.equal(result.status, 'completed');
  const call = h.calls.find(call => call.url.endsWith('/responses'))!;
  const body = JSON.parse(String(call.init.body));
  assert.deepEqual(body.tools, tools);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(Array.isArray(body.input), true);
  assert.equal(body.model, 'test-model-a');
  assert.deepEqual(Object.keys(body).sort(), ['input', 'instructions', 'model', 'store', 'stream', 'tool_choice', 'tools']);
  assert.equal(h.calls.some(call => call.url.includes('backend-api')), false);
});

test('SSE parser handles split UTF-8, CRLF, comments, and multiline JSON without releasing partial results', async t => {
  const h = harness(t);
  await connect(h);
  const completed = { id: 'resp_unicode', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Training 🥊' }] }] };
  const finalJSON = JSON.stringify({ type: 'response.completed', response: completed }, null, 2).split('\n').map(line => `data: ${line}`).join('\r\n');
  h.inferenceHandler = async () => streamText(`: heartbeat\r\n\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"Partial"}\r\n\r\n${finalJSON}\r\n\r\n`, 1);
  assert.deepEqual(await h.provider.respond('corner-user-a', { instructions: 'Help', input: [] }), completed);
});

test('partial streams, failed events, incomplete events and DONE without completion never count as success', async t => {
  const cases = [
    { text: 'data: {"type":"response.output_text.delta","delta":"Partial"}\n\n', code: 'response_interrupted' },
    { text: 'data: [DONE]\n\n', code: 'response_interrupted' },
    { text: 'data: {"type":"response.completed","response":{"status":"completed","output":[]}}', code: 'response_interrupted' },
    { text: 'data: {"type":"response.incomplete"}\n\n', code: 'response_incomplete' },
    { text: 'data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"synthetic-private-access"}}}\n\n', code: 'subscription_sharing_usage_limit_exceeded' },
    { text: 'data: {broken}\n\n', code: 'invalid_provider_stream' },
    { text: 'data: {"type":"response.completed","response":{"status":"incomplete","output":[]}}\n\n', code: 'invalid_provider_stream' },
  ];
  for (const item of cases) {
    const h = harness(t);
    await connect(h);
    h.inferenceHandler = async () => streamText(item.text);
    await assert.rejects(h.provider.respond('corner-user-a', { instructions: 'Help', input: [] }), error => {
      assert.ok(hasCode(item.code)(error));
      assert.equal(JSON.stringify(error).includes('synthetic-private-access'), false);
      assert.equal(String(error).includes('synthetic-private-access'), false);
      return true;
    });
  }
});

test('HTTP admission errors preserve safe status/code and never expose upstream diagnostic text', async t => {
  const h = harness(t);
  await connect(h);
  h.inferenceHandler = async () => json({ detail: 'synthetic-private-access; user prompt; confidential account metadata' }, 403);
  await assert.rejects(h.provider.respond('corner-user-a', { instructions: 'Help', input: [] }), error => {
    assert.ok(error instanceof SubscriptionError);
    assert.equal(error.status, 403);
    assert.equal(error.upstreamStatus, 403);
    assert.equal(error.requestId, 'req_test');
    assert.equal(String(error).includes('synthetic-private-access'), false);
    return true;
  });
});

test('request cancellation stops a hanging stream and returns no partial completion', async t => {
  const h = harness(t);
  await connect(h);
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  h.inferenceHandler = async () => {
    started();
    return new Response(new ReadableStream<Uint8Array>({}), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const controller = new AbortController();
  const pending = h.provider.respond('corner-user-a', { instructions: 'Help', input: [], signal: controller.signal });
  const rejection = assert.rejects(pending, hasCode('request_aborted'));
  await ready;
  controller.abort();
  await rejection;
});

test('caller cancellation also stops waiting for a shared token refresh', async t => {
  const h = harness(t);
  h.expiresIn = 1;
  await connect(h);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { started = resolve; });
  h.tokenHandler = async () => {
    started();
    await gate;
    return json({ access_token: 'synthetic-refreshed-access', refresh_token: 'synthetic-refreshed-refresh', token_type: 'Bearer', expires_in: 3600, scope: directScopes });
  };
  const controller = new AbortController();
  const pending = h.provider.respond('corner-user-a', { instructions: 'Help', input: [], signal: controller.signal });
  const rejected = assert.rejects(pending, hasCode('request_aborted'));
  await waiting;
  controller.abort();
  await rejected;
  assert.equal(h.calls.some(call => call.url.endsWith('/responses')), false);
  release();
  // Drain the still-shared refresh before this test closes its database.
  await h.provider.models('corner-user-a');
});

test('request and SSE frame limits reject oversized data before it can be applied', async t => {
  const h = harness(t);
  await connect(h);
  await assert.rejects(h.provider.respond('corner-user-a', { instructions: 'Help', input: [{ role: 'user', content: 'a'.repeat(600_000) }] }), hasCode('agent_request_too_large'));
  assert.equal(h.calls.some(call => call.url.endsWith('/responses')), false);
  h.inferenceHandler = async () => streamText(`data: ${'a'.repeat(1_100_000)}\n\n`, 65_536);
  await assert.rejects(h.provider.respond('corner-user-a', { instructions: 'Help', input: [] }), hasCode('provider_response_too_large'));
});
