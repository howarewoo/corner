import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { MailConfig } from './config.js';

export type AccountEmail = { kind: 'verification' | 'password-reset'; to: string; url: string };
export class MailDeliveryError extends Error {
  constructor() { super('Account email delivery could not be confirmed.'); this.name = 'MailDeliveryError'; }
}

const escapeHTML = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

/** Real HTTPS delivery; the injected fetch is used only by isolated tests. */
export function createAccountMailer(config: MailConfig, origin: string, fetchImpl: typeof fetch = fetch) {
  return {
    async send(message: AccountEmail): Promise<void> {
      try {
        if (!z.string().email().safeParse(message.to).success) throw new MailDeliveryError();
        const link = new URL(message.url);
        const expectedPath = message.kind === 'verification' ? link.pathname === '/api/auth/verify-email' : /^\/api\/auth\/reset-password\/[A-Za-z0-9_-]+$/.test(link.pathname);
        if (link.origin !== origin || link.username || link.password || link.hash || !expectedPath) throw new MailDeliveryError();
        const verification = message.kind === 'verification';
        const heading = verification ? 'Verify your Corner email' : 'Reset your Corner password';
        const action = verification ? 'Verify email' : 'Reset password';
        const explanation = verification ? 'Verify your email address to finish creating your Corner account.' : 'Use this link to choose a new password for your Corner account. Existing sessions will be signed out after you reset it.';
        const expiry = verification ? 'This link expires in 1 hour.' : 'This link expires in 30 minutes and can be used once.';
        const ignore = 'If you did not request this, you can ignore this email.';
        const response = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
          headers: {
            Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json',
            'Idempotency-Key': `corner-account-${createHash('sha256').update(JSON.stringify(message)).digest('hex')}`,
          },
          body: JSON.stringify({
            from: config.from, to: [message.to], subject: heading,
            text: `${heading}\n\n${explanation}\n\n${message.url}\n\n${expiry}\n${ignore}`,
            html: `<h1>${heading}</h1><p>${explanation}</p><p><a href="${escapeHTML(message.url)}">${action}</a></p><p>${expiry}</p><p>${ignore}</p>`,
          }),
        });
        if (!response.ok || !response.body) { await response.body?.cancel(); throw new MailDeliveryError(); }
        // Never surface or log provider response bodies. Bound even error-like
        // success payloads so an unexpected upstream response cannot grow memory.
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > 16 * 1024) { await reader.cancel(); throw new MailDeliveryError(); }
            chunks.push(next.value);
          }
        } finally { reader.releaseLock(); }
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: unknown };
        if (typeof result.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(result.id)) throw new MailDeliveryError();
      } catch { throw new MailDeliveryError(); }
    },
  };
}
