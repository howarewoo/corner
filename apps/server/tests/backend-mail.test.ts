import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SignJWT } from 'jose';
import { createAuth, drainAuthMail, type CornerAuth } from '../src/auth.ts';
import { createApp } from '../src/app.ts';
import { WorkspaceStore } from '../src/store.ts';
import type { Config } from '../src/config.ts';

const config: Config = { origin: 'https://corner.example.test', host: '127.0.0.1', port: 3000, dataDir: '/tmp', deployment: 'hosted', authSecret: 'unit-test-email-auth-secret-more-than-32-characters', tokenEncryptionKey: Buffer.alloc(32, 7), mail: { apiKey: 're_test_only_not_a_real_key', from: 'Corner <accounts@example.test>' } };
const email = 'alice@example.test';
const password = 'unit-test-only-long-original-password';
const newPassword = 'unit-test-only-new-long-password';
const verifiedURL = `${config.origin}/?account=verified`;
const resetURL = `${config.origin}/account/reset-password`;
const cookieOf = (response: Response) => response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');

describe('account email flows with real Better Auth and captured HTTPS only', { concurrency: false }, () => {
  let db: DatabaseSync;
  let auth: CornerAuth;
  let store: WorkspaceStore;
  let app: ReturnType<typeof createApp>;
  let sent: Array<{ to: string[]; text: string; subject: string }>;
  let failures: string[];
  let providerRejects: boolean;
  const capture: typeof fetch = async (_url, init) => {
    sent.push(JSON.parse(init!.body as string));
    if (providerRejects) throw new Error('test-only-private-mail-provider-details');
    return Response.json({ id: 'test-only-delivery-id' });
  };
  async function request(path: string, options: { body?: unknown; cookie?: string; origin?: string | null; ip?: string } = {}) {
    const headers = new Headers({ 'x-corner-client-ip': options.ip ?? '192.0.2.10' });
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    if (options.origin !== null) headers.set('Origin', options.origin ?? config.origin);
    if (options.cookie) headers.set('Cookie', options.cookie);
    return app(new Request(path.startsWith('https:') ? path : config.origin + path, { method: options.body === undefined ? 'GET' : 'POST', headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }));
  }
  async function signup() {
    const response = await request('/api/auth/sign-up/email', { body: { name: 'Alice', email, password, callbackURL: verifiedURL } });
    assert.equal(response.status, 200);
    await drainAuthMail(auth);
    return response;
  }
  function latestLink(kind: 'verification' | 'reset'): string {
    const subject = kind === 'verification' ? 'Verify your Corner email' : 'Reset your Corner password';
    const message = sent.findLast(item => item.subject === subject);
    assert(message);
    const link = message.text.match(/https:\/\/[^\s]+/);
    assert(link);
    return link[0];
  }
  async function verifiedAccount() {
    const signupResponse = await signup();
    const user = (await signupResponse.json()).user;
    const verified = await request(latestLink('verification'), { origin: null });
    assert.equal(verified.status, 302);
    assert.equal(verified.headers.get('Location'), verifiedURL);
    return user as { id: string };
  }
  async function login(attempt = password) {
    return request('/api/auth/sign-in/email', { body: { email, password: attempt } });
  }
  async function requestReset(target = email) {
    const response = await request('/api/auth/request-password-reset', { body: { email: target, redirectTo: resetURL } });
    await drainAuthMail(auth);
    return response;
  }
  beforeEach(async () => {
    db = new DatabaseSync(':memory:'); sent = []; failures = []; providerRejects = false;
    auth = await createAuth(config, db, { fetch: capture, onMailFailure: code => { failures.push(code); } });
    store = new WorkspaceStore(db);
    app = createApp({ config, auth, store });
  });
  afterEach(async () => { await drainAuthMail(auth); db.close(); });

  test('hosted policy is public and signup cannot create a session before verification', async () => {
    assert.deepEqual(await (await request('/api/account-policy', { origin: null })).json(), { emailVerificationRequired: true, passwordResetAvailable: true });
    const response = await signup();
    assert.equal((await response.json()).token, null);
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, [email]);
    assert.equal(new URL(latestLink('verification')).searchParams.get('callbackURL'), verifiedURL);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session').get()?.n, 0);
    const blocked = await login();
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).code, 'EMAIL_NOT_VERIFIED');
    assert.equal(sent.length, 1, 'sign-in does not bypass the explicit resend limit');
    const verified = await request(latestLink('verification'), { origin: null });
    assert.equal(verified.headers.get('Location'), verifiedURL);
    assert.equal(verified.headers.getSetCookie().length, 0, 'verification does not auto-login');
    const signedIn = await login();
    assert.equal(signedIn.status, 200);
    assert(signedIn.headers.getSetCookie().some(value => /secure/i.test(value) && /httponly/i.test(value)));
    assert.equal((await request('/api/state', { cookie: cookieOf(signedIn) })).status, 200);
  });

  test('invalid and expired verification links leave the account unverified', async () => {
    await signup();
    const invalid = new URL(latestLink('verification')); invalid.searchParams.set('token', 'invalid-test-token');
    const bad = await request(invalid.href, { origin: null });
    assert.equal(new URL(bad.headers.get('Location')!).searchParams.get('error'), 'INVALID_TOKEN');
    const expired = await new SignJWT({ email }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt(1).setExpirationTime(2).sign(new TextEncoder().encode(config.authSecret));
    invalid.searchParams.set('token', expired);
    const old = await request(invalid.href, { origin: null });
    assert.equal(new URL(old.headers.get('Location')!).searchParams.get('error'), 'TOKEN_EXPIRED');
    assert.equal(db.prepare('SELECT emailVerified FROM user WHERE email = ?').get(email)?.emailVerified, 0);
    assert.equal((await login()).status, 403);
  });

  test('password reset consumes its token and revokes all existing sessions without altering workspace data', async () => {
    const user = await verifiedAccount();
    const first = await login(); const second = await login();
    const cookies = [cookieOf(first), cookieOf(second)];
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session WHERE userId = ?').get(user.id)?.n, 2);
    store.mutate(user.id, 'before-password-reset', { type: 'grocery.check', data: { key: 'oats|g', checked: true } });
    const saved = store.read(user.id);
    const requested = await requestReset();
    assert.equal(requested.status, 200);
    const callback = await request(latestLink('reset'), { origin: null });
    const destination = new URL(callback.headers.get('Location')!);
    assert.equal(destination.origin + destination.pathname, resetURL);
    const token = destination.searchParams.get('token');
    assert(token);
    const reset = await request('/api/auth/reset-password', { body: { token, newPassword } });
    assert.equal(reset.status, 200);
    assert.deepEqual(await reset.json(), { status: true });
    assert.equal(reset.headers.getSetCookie().length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session WHERE userId = ?').get(user.id)?.n, 0);
    for (const cookie of cookies) assert.deepEqual(await (await request('/api/session', { cookie })).json(), { user: null });
    const replay = await request('/api/auth/reset-password', { body: { token, newPassword: 'different-test-only-long-password' } });
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).code, 'INVALID_TOKEN');
    assert.equal((await login()).status, 401);
    assert.equal((await login(newPassword)).status, 200);
    assert.deepEqual(store.read(user.id), saved);
  });

  test('invalid and expired reset tokens cannot change the password or revoke sessions', async () => {
    const user = await verifiedAccount();
    const signedIn = await login();
    await requestReset();
    const link = new URL(latestLink('reset'));
    const token = link.pathname.split('/').at(-1)!;
    assert.equal(db.prepare('UPDATE verification SET expiresAt = 0 WHERE identifier = ?').run(`reset-password:${token}`).changes, 1);
    const passwordBefore = db.prepare('SELECT password FROM account WHERE userId = ?').get(user.id)?.password;
    for (const candidate of ['invalid-test-only-token', token]) {
      const reset = await request('/api/auth/reset-password', { body: { token: candidate, newPassword } });
      assert.equal(reset.status, 400);
      assert.equal((await reset.json()).code, 'INVALID_TOKEN');
    }
    const callback = await request(link.href, { origin: null });
    assert.equal(new URL(callback.headers.get('Location')!).searchParams.get('error'), 'INVALID_TOKEN');
    assert.equal(db.prepare('SELECT password FROM account WHERE userId = ?').get(user.id)?.password, passwordBefore);
    assert.equal((await request('/api/state', { cookie: cookieOf(signedIn) })).status, 200);
  });

  test('account redirect controls and cookie writes reject foreign origins before delivery', async () => {
    for (const callbackURL of ['https://other.example/', '//other.example/', 'https://corner.example.test@other.example/', '/\\other.example/', `${config.origin}/account/reset-password`]) {
      const response = await request('/api/auth/sign-up/email', { body: { name: 'Alice', email, password, callbackURL } });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, 'INVALID_ACCOUNT_REDIRECT');
    }
    const foreignReset = await request('/api/auth/request-password-reset', { body: { email, redirectTo: 'https://other.example/' } });
    assert.equal(foreignReset.status, 400);
    const foreignCallback = await request(`/api/auth/verify-email?token=test&callbackURL=${encodeURIComponent('https://other.example/')}`, { origin: null });
    assert.equal(foreignCallback.status, 400);
    const crossOrigin = await request('/api/auth/send-verification-email', { origin: 'https://other.example', body: { email, callbackURL: verifiedURL } });
    assert.equal(crossOrigin.status, 403);
    assert.equal(sent.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user').get()?.n, 0);
  });

  test('resend and reset requests use generic responses even when the mail provider fails', async () => {
    await signup();
    providerRejects = true;
    const known = await request('/api/auth/send-verification-email', { body: { email, callbackURL: verifiedURL } });
    const absent = await request('/api/auth/send-verification-email', { body: { email: 'absent@example.test', callbackURL: verifiedURL } });
    await drainAuthMail(auth);
    assert.equal(known.status, 200); assert.equal(absent.status, 200);
    assert.deepEqual(await known.json(), await absent.json());
    const knownReset = await requestReset();
    const absentReset = await requestReset('absent@example.test');
    assert.equal(knownReset.status, 200); assert.equal(absentReset.status, 200);
    assert.deepEqual(await knownReset.json(), await absentReset.json());
    assert.deepEqual(failures, ['ACCOUNT_MAIL_DELIVERY_FAILED', 'ACCOUNT_MAIL_DELIVERY_FAILED']);
    assert.equal((await login()).status, 403, 'delivery failure never grants unverified access');
  });

  test('persistent request limits protect reset/resend and recipient limits span different IPs', async () => {
    for (let index = 0; index < 3; index++) assert.equal((await requestReset('absent@example.test')).status, 200);
    assert.equal((await requestReset('absent@example.test')).status, 429);
    const original = auth;
    auth = await createAuth(config, db, { fetch: capture, onMailFailure: code => { failures.push(code); } });
    await drainAuthMail(original);
    app = createApp({ config, auth, store });
    assert.equal((await requestReset('absent@example.test')).status, 429, 'restart retains rate limits');
    await signup();
    for (let index = 1; index <= 3; index++) {
      const response = await request('/api/auth/send-verification-email', { ip: `192.0.2.${20 + index}`, body: { email, callbackURL: verifiedURL } });
      assert.equal(response.status, 200);
    }
    await drainAuthMail(auth);
    assert.equal(sent.length, 3, 'signup and two resends exhaust the shared recipient window');
    const keys = db.prepare('SELECT key FROM corner_account_mail_limits').all();
    assert(keys.length > 0);
    assert(keys.every(row => /^[a-f0-9]{64}$/.test(String(row.key))));
    for (let index = 0; index < 3; index++) assert.equal((await request('/api/auth/send-verification-email', { ip: '192.0.2.99', body: { email: 'absent@example.test', callbackURL: verifiedURL } })).status, 200);
    assert.equal((await request('/api/auth/send-verification-email', { ip: '192.0.2.99', body: { email: 'absent@example.test', callbackURL: verifiedURL } })).status, 429);
  });

  test('an existing session cannot expose a workspace after its email becomes unverified', async () => {
    await verifiedAccount();
    const signedIn = await login();
    db.prepare('UPDATE user SET emailVerified = 0 WHERE email = ?').run(email);
    assert.deepEqual(await (await request('/api/session', { cookie: cookieOf(signedIn) })).json(), { user: null });
    assert.equal((await request('/api/state', { cookie: cookieOf(signedIn) })).status, 401);
  });
});

test('local no-mail mode stays usable and does not advertise email recovery', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const { mail: _mail, ...base } = config;
    await assert.rejects(createAuth(base, db), /Hosted accounts require/);
    const local: Config = { ...base, deployment: 'local', origin: 'http://127.0.0.1:3000' };
    const auth = await createAuth(local, db);
    const app = createApp({ config: local, auth, store: new WorkspaceStore(db) });
    assert.deepEqual(await (await app(new Request(`${local.origin}/api/account-policy`))).json(), { emailVerificationRequired: false, passwordResetAvailable: false });
    const signup = await app(new Request(`${local.origin}/api/auth/sign-up/email`, { method: 'POST', headers: { Origin: local.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Local user', email, password }) }));
    assert.equal(signup.status, 200);
    assert(cookieOf(signup));
    const reset = await app(new Request(`${local.origin}/api/auth/request-password-reset`, { method: 'POST', headers: { Origin: local.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) }));
    assert.equal(reset.status, 503);
    assert.equal((await reset.json()).code, 'ACCOUNT_EMAIL_UNAVAILABLE');
  } finally { db.close(); }
});
