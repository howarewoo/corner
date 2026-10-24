import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../worker.js';

const env = {
  ASSETS: { fetch: async () => new Response('asset') },
  SERVER: { fetch: async () => new Response('production binding') },
  CORNER_PREVIEW: 'true', CORNER_PREVIEW_SHA: 'a'.repeat(40), CORNER_PREVIEW_ORIGIN: 'https://pr-1.example.test',
  CORNER_PREVIEW_BACKEND_URL: 'https://fixed.backend.test', CORNER_PREVIEW_ACCESS_CLIENT_ID: 'client', CORNER_PREVIEW_ACCESS_CLIENT_SECRET: 'secret',
};

test('preview gateway preserves request and application errors, filters identity and cookies', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async input => {
      const request = input as Request;
      assert.equal(request.url, 'https://fixed.backend.test/api/state?revision=2');
      assert.equal(request.method, 'POST');
      assert.equal(await request.text(), '{"changes":[]}');
      assert.equal(request.redirect, 'manual');
      assert.equal(request.headers.get('origin'), 'https://attacker.test');
      assert.equal(request.headers.get('cookie'), '__Secure-neon-auth.session_token=session');
      assert.equal(request.headers.get('cf-access-client-id'), 'client');
      assert.equal(request.headers.get('cf-access-client-secret'), 'secret');
      assert.equal(request.headers.get('cf-access-jwt-assertion'), null);
      assert.equal(request.headers.get('x-forwarded-host'), null);
      const headers = new Headers({ 'X-Corner-Preview-Sha': env.CORNER_PREVIEW_SHA });
      headers.append('Set-Cookie', 'CF_Authorization=access; Secure; HttpOnly');
      headers.append('Set-Cookie', '__Secure-neon-auth.session_token=renewed; Secure; HttpOnly; Path=/');
      headers.append('Set-Cookie', '__Secure-neon-auth.session_data=data; Secure; HttpOnly; Path=/');
      return new Response('{"error":"INVALID_ORIGIN"}', { status: 403, headers });
    };
    const response = await worker.fetch(new Request(env.CORNER_PREVIEW_ORIGIN + '/api/state?revision=2', {
      method: 'POST', headers: { Origin: 'https://attacker.test', Cookie: 'CF_Authorization=browser; __Secure-neon-auth.session_token=session; unrelated=private', 'Cf-Access-Jwt-Assertion': 'forged', 'X-Forwarded-Host': 'spoof' }, body: '{"changes":[]}',
    }), env);
    assert.equal(response.status, 403);
    assert.equal(await response.text(), '{"error":"INVALID_ORIGIN"}');
    assert.deepEqual(response.headers.getSetCookie(), ['__Secure-neon-auth.session_token=renewed; Secure; HttpOnly; Path=/', '__Secure-neon-auth.session_data=data; Secure; HttpOnly; Path=/']);
    assert.equal(response.headers.get('X-Corner-Preview-Sha'), env.CORNER_PREVIEW_SHA);
  } finally { globalThis.fetch = original; }
});

test('gateway fails closed on wrong pairing, Access login, invalid target and transport errors', async () => {
  const original = globalThis.fetch;
  try {
    for (const response of [new Response('wrong sha', { headers: { 'X-Corner-Preview-Sha': 'b'.repeat(40) } }), new Response(null, { status: 302, headers: { Location: 'https://team.cloudflareaccess.com/login' } }), new Response(null, { status: 302, headers: { Location: 'https://attacker.test/', 'X-Corner-Preview-Sha': env.CORNER_PREVIEW_SHA } })]) {
      globalThis.fetch = async () => response;
      assert.equal((await worker.fetch(new Request(env.CORNER_PREVIEW_ORIGIN + '/api/health'), env)).status, 502);
    }
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.equal((await worker.fetch(new Request(env.CORNER_PREVIEW_ORIGIN + '/api/health'), env)).status, 502);
    for (const target of ['http://backend.test', 'https://user:password@backend.test', 'https://backend.test/path', 'not a URL']) {
      assert.equal((await worker.fetch(new Request(env.CORNER_PREVIEW_ORIGIN + '/api/health'), { ...env, CORNER_PREVIEW_BACKEND_URL: target })).status, 503);
    }
    assert.equal((await worker.fetch(new Request('https://other.test/api/health'), env)).status, 400);
    assert.equal((await worker.fetch(new Request(env.CORNER_PREVIEW_ORIGIN + '/api/health'), { ...env, CORNER_PREVIEW_ACCESS_CLIENT_SECRET: '' })).status, 503);
    assert.equal((await worker.fetch(new Request(env.CORNER_PREVIEW_ORIGIN + '/api/session', { headers: { Cookie: '__Secure-neon-auth.session_token=one; neon-auth.session_token=two' } }), env)).status, 400);
  } finally { globalThis.fetch = original; }
});

test('production uses service binding and assets without preview credentials', async () => {
  const production = { ASSETS: env.ASSETS, SERVER: env.SERVER };
  assert.equal(await (await worker.fetch(new Request('https://corner.test/api/health'), production)).text(), 'production binding');
  assert.equal(await (await worker.fetch(new Request('https://corner.test/'), production)).text(), 'asset');
});
