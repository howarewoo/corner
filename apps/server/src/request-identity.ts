import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';

/** Accept an edge-supplied IP only when that edge proves its configured identity. */
export function verifiedProxyIP(headers: IncomingHttpHeaders, proxySecret?: string): string | null {
  if (!proxySecret) return null;
  const proof = headers['x-corner-proxy-token'];
  const address = headers['x-corner-proxy-ip'];
  if (
    typeof proof !== 'string' ||
    typeof address !== 'string' ||
    proof.length > 512 ||
    address.length > 64
  )
    return null;
  const actual = Buffer.from(proof);
  const expected = Buffer.from(proxySecret);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  // A list or a malformed header is never a client identity. Caddy sets this
  // from its immediate socket peer and overwrites caller-supplied values.
  if (!isIP(address) || /[\s,%]/.test(address)) return null;
  return address;
}

export function requestClientIP(
  headers: IncomingHttpHeaders,
  socketAddress: string | undefined,
  proxySecret?: string,
): string {
  return verifiedProxyIP(headers, proxySecret) || socketAddress || 'unknown';
}
