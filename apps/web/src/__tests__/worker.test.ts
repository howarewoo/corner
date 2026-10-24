import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../worker.js';

const env = {
  ASSETS: { fetch: async (request: Request) => new URL(request.url).pathname === '/index.html' ? new Response('<main>Corner</main>') : new Response('missing', { status: 404 }) },
  SERVER: { fetch: async () => new Response('private', { status: 401, headers: { 'X-Corner-Frontend-Version': 'forged', 'Cache-Control': 'private, no-store', 'Set-Cookie': '__Secure-neon-auth.session_token=renewed; Secure; HttpOnly; Path=/' } }) },
  CF_VERSION_METADATA: { id: '12345678-1234-1234-1234-123456789012' },
};

test('account reset deep links resolve the app, while private files and missing assets never do', async () => {
  const page = await worker.fetch(new Request('https://corner.test/account/reset-password'), env);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<main>Corner<\/main>/);
  assert.match(page.headers.get('Content-Security-Policy') ?? '', /frame-ancestors 'none'/);
  assert.equal(page.headers.get('X-Corner-Frontend-Version'), env.CF_VERSION_METADATA.id);
  for (const path of ['/.env', '/assets/missing.js', '/%00']) {
    assert.equal((await worker.fetch(new Request('https://corner.test' + path), env)).status, 404);
  }
  assert.equal((await worker.fetch(new Request('https://corner.test/', { method: 'POST' }), env)).status, 405);
});

test('frontend identity cannot be spoofed by backend headers and does not discard auth responses', async () => {
  const response = await worker.fetch(new Request('https://corner.test/api/session'), env);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('X-Corner-Frontend-Version'), env.CF_VERSION_METADATA.id);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(response.headers.getSetCookie(), ['__Secure-neon-auth.session_token=renewed; Secure; HttpOnly; Path=/']);
});
