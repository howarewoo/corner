import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { runInNewContext } from 'node:vm';

type FetchEvent = {
  request: { url: string; mode: string; method: string };
  respondWith: (response: Promise<Response>) => void;
};

function worker(network: typeof fetch) {
  let onFetch!: (event: FetchEvent) => void;
  runInNewContext(readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8'), {
    URL,
    Response,
    fetch: network,
    self: {
      location: { origin: 'https://corner.test' },
      addEventListener(type: string, handler: (event: FetchEvent) => void) {
        if (type === 'fetch') onFetch = handler;
      },
    },
    // Any accidental Cache API access fails: private responses must never be persisted.
    get caches() {
      throw new Error('Corner must not cache responses.');
    },
  });
  return (path: string, mode = 'navigate', method = 'GET') => {
    let response: Promise<Response> | undefined;
    onFetch({
      request: { url: new URL(path, 'https://corner.test').href, mode, method },
      respondWith(value) {
        response = value;
      },
    });
    return response;
  };
}

test('offline workspace navigation has a private, self-contained recovery page', async () => {
  const dispatch = worker(async () => {
    throw new TypeError('Network unavailable');
  });
  const response = await dispatch('/workouts?day=2026-10-25');
  assert(response);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
  const html = await response.text();
  assert.match(html, /<a href="">/); // Retry stays on the requested page, not the start URL.
  assert.doesNotMatch(html, /<script|<link|<img|2026-10-25/);
});

test('offline handling leaves account, API, external, asset, and write requests to the browser', () => {
  const dispatch = worker(async () => {
    throw new Error('Excluded requests must not be intercepted.');
  });
  for (const path of [
    '/api',
    '/api/rpc/workspace/get',
    '/auth/callback?code=private-code',
    '/account/reset-password?token=private-token',
    'https://other.test/',
  ])
    assert.equal(dispatch(path), undefined, path);
  assert.equal(dispatch('/assets/app.js', 'cors'), undefined);
  assert.equal(dispatch('/workouts', 'navigate', 'POST'), undefined);
});

test('server failures stay failures instead of being misreported as offline', async () => {
  const dispatch = worker(async () => new Response('Service unavailable', { status: 502 }));
  const response = await dispatch('/recipes');
  assert(response);
  assert.equal(response.status, 502);
  assert.equal(await response.text(), 'Service unavailable');
});
