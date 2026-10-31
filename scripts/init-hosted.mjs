import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const domain = args.length === 2 && args[0] === '--domain' ? args[1].toLowerCase() : '';
const labels = domain.split('.');
let canonicalHostname = '';
try {
  canonicalHostname = new URL(`https://${domain}`).hostname;
} catch {
  /* Invalid host rejected below. */
}
// Reject IPv4 shorthand and legacy numeric spellings that a browser would
// silently normalize into an IP address instead of a public DNS hostname.
if (
  domain.length > 248 || // Leave room for the guide's docs. hostname.
  labels.length < 2 ||
  domain !== canonicalHostname ||
  isIP(canonicalHostname) ||
  labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
) {
  process.stderr.write(
    'Use: node scripts/init-hosted.mjs --domain corner.your-domain.com\nSupply a bare DNS hostname you control, without a protocol, port, or path.\n',
  );
  process.exitCode = 1;
} else {
  const destination = resolve('.env.hosted');
  const contents = [
    '# Private deployment configuration. Keep an encrypted off-server backup.',
    '# Never commit or share this file. Existing files are never overwritten.',
    `CORNER_DOMAIN=${domain}`,
    '# Landing uses this root; app/Auth/API/MCP use app.<CORNER_DOMAIN>; guide uses docs.<CORNER_DOMAIN>.',
    `CORNER_PROXY_SECRET=${randomBytes(48).toString('base64url')}`,
    '',
    '# Pull these server-only values with neon deploy, then copy them here.',
    'DATABASE_URL=',
    'DATABASE_URL_UNPOOLED=',
    'NEON_AUTH_BASE_URL=',
    '# Configure verification codes and custom SMTP in Neon before deploying.',
    '',
  ].join('\n');
  try {
    writeFileSync(destination, contents, { mode: 0o600, flag: 'wx' });
    process.stdout.write(
      'Created .env.hosted with one random proxy proof.\nConfigure root, app and docs DNS/TLS and register only the app origin with managed Auth, then follow HOSTING.md.\n',
    );
  } catch (error) {
    process.stderr.write(
      error?.code === 'EEXIST'
        ? '.env.hosted already exists. Keep its keys; edit it deliberately instead of regenerating them.\n'
        : 'Could not create the private deployment file. Check directory permissions.\n',
    );
    process.exitCode = 1;
  }
}
