import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAccountMailer, MailDeliveryError, type AccountEmail } from '../src/mail.ts';

const config = { apiKey: 're_test_only_not_a_real_key', from: 'Corner <accounts@example.test>' };
const origin = 'https://corner.example.test';
const message: AccountEmail = { kind: 'verification', to: 'recipient@example.test', url: `${origin}/api/auth/verify-email?token=test-only&callbackURL=${encodeURIComponent(`${origin}/?account=verified`)}` };

test('Resend adapter posts only to its fixed HTTPS endpoint and validates acceptance', async () => {
  let captured: { url: unknown; init: RequestInit } | undefined;
  const mailer = createAccountMailer(config, origin, async (url, init) => {
    captured = { url, init: init! };
    return Response.json({ id: 'test-delivery-id' });
  });
  await mailer.send(message);
  assert.equal(captured!.url, 'https://api.resend.com/emails');
  assert.equal(captured!.init.method, 'POST');
  assert.equal(captured!.init.redirect, 'error');
  assert(captured!.init.signal instanceof AbortSignal);
  const headers = new Headers(captured!.init.headers);
  assert.equal(headers.get('Authorization'), `Bearer ${config.apiKey}`);
  assert.match(headers.get('Idempotency-Key')!, /^corner-account-[a-f0-9]{64}$/);
  const body = JSON.parse(captured!.init.body as string);
  assert.deepEqual(body.to, ['recipient@example.test']);
  assert.equal(body.from, config.from);
  assert(body.text.includes(message.url));
  assert(body.html.includes('&amp;callbackURL='));
});

test('mail delivery rejects unconfirmed or oversized responses with one safe error', async () => {
  for (const response of [new Response('private-provider-error', { status: 401 }), new Response('not-json'), Response.json({ error: 'private-provider-error' }), Response.json({ id: 'x'.repeat(17 * 1024) })]) {
    const mailer = createAccountMailer(config, origin, async () => response);
    await assert.rejects(mailer.send(message), error => error instanceof MailDeliveryError && error.message === 'Account email delivery could not be confirmed.');
  }
  const offline = createAccountMailer(config, origin, async () => { throw new Error('test-only-private-provider-details'); });
  await assert.rejects(offline.send(message), error => error instanceof MailDeliveryError && !error.message.includes('private-provider'));
});

test('mail adapter rejects foreign links and malformed recipients before making any request', async () => {
  let calls = 0;
  const mailer = createAccountMailer(config, origin, async () => { calls++; return Response.json({ id: 'test-delivery' }); });
  for (const invalid of [{ ...message, url: 'https://other.example/api/auth/verify-email?token=test' }, { ...message, url: `${origin}/not-an-account-route` }, { ...message, to: 'one@example.test,two@example.test' }]) await assert.rejects(mailer.send(invalid), MailDeliveryError);
  assert.equal(calls, 0);
});
