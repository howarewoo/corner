import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { authenticatePreview } from '../worker-preview.js';

const env = {
  CORNER_PREVIEW: 'true', CORNER_PREVIEW_SHA: 'a'.repeat(40), CORNER_PREVIEW_ORIGIN: 'https://pr-1.example.test',
  CORNER_PREVIEW_ACCESS_ISSUER: 'https://corner.cloudflareaccess.com', CORNER_PREVIEW_ACCESS_AUD: 'pr-1-audience', CORNER_PREVIEW_ACCESS_CLIENT_ID: 'pr-1-client',
};

test('real signed Access JWT admits only the paired service identity and preserves CSRF origin', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  const key = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256' }] });
  const sign = (aud = env.CORNER_PREVIEW_ACCESS_AUD, common_name = env.CORNER_PREVIEW_ACCESS_CLIENT_ID, expiry = '5m') => new SignJWT({ common_name })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(env.CORNER_PREVIEW_ACCESS_ISSUER).setAudience(aud).setIssuedAt().setExpirationTime(expiry).sign(privateKey);
  const request = (token: string) => new Request('https://fixed.backend.test/api/state?revision=2', {
    method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': token, Origin: 'https://attacker.test', Cookie: '__Secure-neon-auth.session_token=session', 'X-Forwarded-Host': 'spoof.test', 'X-Corner-Preview-Origin': 'https://spoof.test' }, body: '{"changes":[]}',
  });
  const accepted = await authenticatePreview(request(await sign()), env, key);
  assert.ok(accepted instanceof Request);
  assert.equal(accepted.url, 'https://pr-1.example.test/api/state?revision=2');
  assert.equal(accepted.headers.get('origin'), 'https://attacker.test');
  assert.equal(accepted.headers.get('cookie'), '__Secure-neon-auth.session_token=session');
  assert.equal(accepted.headers.get('cf-access-jwt-assertion'), null);
  assert.equal(accepted.headers.get('x-forwarded-host'), null);
  assert.equal(await accepted.text(), '{"changes":[]}');
  for (const token of [await sign('pr-2-audience'), await sign(undefined, 'pr-2-client'), await sign(undefined, undefined, '-1s'), 'forged.jwt.value']) {
    const rejected = await authenticatePreview(request(token), env, key);
    assert.ok(rejected instanceof Response);
    assert.equal(rejected.status, 403);
  }
  const other = await generateKeyPair('RS256');
  const forged = await new SignJWT({ common_name: env.CORNER_PREVIEW_ACCESS_CLIENT_ID }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(env.CORNER_PREVIEW_ACCESS_ISSUER).setAudience(env.CORNER_PREVIEW_ACCESS_AUD).setIssuedAt().setExpirationTime('5m').sign(other.privateKey);
  assert.equal((await authenticatePreview(request(forged), env, key) as Response).status, 403);
});

test('incomplete configuration and unauthenticated requests fail before application dependencies', async () => {
  const request = new Request('https://backend.example.test/api/health');
  for (const config of [{}, { ...env, CORNER_PREVIEW_SHA: '' }, { ...env, CORNER_PREVIEW_ORIGIN: 'http://localhost' }, { ...env, CORNER_PREVIEW_ACCESS_ISSUER: 'https://attacker.test' }]) {
    assert.equal((await authenticatePreview(request, config) as Response).status, 503);
  }
  assert.equal((await authenticatePreview(request, env) as Response).status, 403);
});
