import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestClientIP } from '../src/request-identity.ts';

const secret = 'synthetic-edge-proof-with-more-than-32-characters';
const peer = '172.20.0.2';

test('ordinary deployments use the socket despite arbitrary forwarding headers', () => {
  assert.equal(
    requestClientIP(
      {
        'x-forwarded-for': '198.51.100.1',
        'cf-connecting-ip': '198.51.100.2',
        'x-corner-client-ip': '198.51.100.3',
        'x-corner-proxy-ip': '198.51.100.4',
        'x-corner-proxy-token': secret,
      },
      peer,
    ),
    peer,
  );
});

test('authenticated edge proof accepts a single IPv4 or IPv6 identity', () => {
  for (const address of ['198.51.100.20', '2001:db8::20']) {
    assert.equal(
      requestClientIP(
        { 'x-corner-proxy-token': secret, 'x-corner-proxy-ip': address },
        peer,
        secret,
      ),
      address,
    );
  }
});

test('missing, wrong, duplicate, or oversized edge proofs cannot alter rate-limit identity', () => {
  for (const proof of [undefined, 'wrong-proof', secret + 'x', [secret, secret], 'x'.repeat(513)]) {
    assert.equal(
      requestClientIP(
        { 'x-corner-proxy-token': proof, 'x-corner-proxy-ip': '198.51.100.20' },
        peer,
        secret,
      ),
      peer,
    );
  }
});

test('a correct proof cannot turn an IP list, URL, or malformed value into an identity', () => {
  for (const address of [
    undefined,
    '198.51.100.20, 198.51.100.21',
    ' 198.51.100.20',
    'https://example.test',
    'example.test',
    'fe80::1%eth0',
    ['198.51.100.20', '198.51.100.21'],
  ]) {
    assert.equal(
      requestClientIP(
        { 'x-corner-proxy-token': secret, 'x-corner-proxy-ip': address },
        peer,
        secret,
      ),
      peer,
    );
  }
});

test('missing socket metadata has a stable conservative bucket', () => {
  assert.equal(requestClientIP({}, undefined, secret), 'unknown');
});
