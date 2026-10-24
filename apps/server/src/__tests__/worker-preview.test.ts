import assert from 'node:assert/strict';
import { test } from 'node:test';
import preview from '../worker-preview.ts';

function environment(origins: string) {
  return {
    CORNER_PREVIEW_ORIGINS: origins,
    ASSETS: { fetch: async () => { throw new Error('Rejected preview requests must not reach assets.'); } },
    DATABASE_URL: 'not-configured', NEON_AUTH_BASE_URL: 'not-configured',
    NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: 'true', BETTER_AUTH_SECRET: '', CORNER_TOKEN_ENCRYPTION_KEY: '',
  };
}

test('an unconfigured preview backend fails closed before accessing services', async () => {
  for (const origins of ['', '   ']) {
    const response = await preview.fetch(new Request('https://preview.example.test/api/health'), environment(origins));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  }
});

test('preview origin approval is exact, HTTPS-only, and based on the request URL rather than its Origin header', async () => {
  for (const [url, origins] of [
    ['https://unknown.example.test/api/health', 'https://preview.example.test'],
    ['https://preview.example.test.attacker.test/api/health', 'https://preview.example.test'],
    ['https://preview.example.test:8443/api/health', 'https://preview.example.test'],
    ['https://preview.example.test/api/health', '*.example.test'],
    ['http://preview.example.test/api/health', 'http://preview.example.test'],
  ]) {
    const response = await preview.fetch(new Request(url, { headers: { Origin: 'https://preview.example.test' } }), environment(origins));
    assert.equal(response.status, 400, url);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  }
});
