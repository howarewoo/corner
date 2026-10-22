import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Both src/config.ts and the compiled dist/config.js live three levels below
// the repository root. Workspace scripts must share one stable data location.
export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export type MailConfig = { apiKey: string; from: string };

export type Config = {
  origin: string;
  host: string;
  port: number;
  dataDir: string;
  deployment: 'local' | 'hosted';
  authSecret: string;
  tokenEncryptionKey: Buffer;
  mail?: MailConfig;
  proxySecret?: string;
};

type LocalSecrets = { authSecret: string; tokenEncryptionKey: string };

function mailConfiguration(environment: NodeJS.ProcessEnv, deployment: Config['deployment']): MailConfig | undefined {
  const apiKey = environment.RESEND_API_KEY;
  const from = environment.CORNER_EMAIL_FROM?.trim();
  if (apiKey === undefined && from === undefined) {
    if (deployment === 'hosted') throw new Error('Hosted deployments require RESEND_API_KEY and CORNER_EMAIL_FROM with a verified sender domain.');
    return undefined;
  }
  if (!apiKey || !from) throw new Error('Set both RESEND_API_KEY and CORNER_EMAIL_FROM to enable account email.');
  if (!/^re_[A-Za-z0-9_-]{8,500}$/.test(apiKey)) throw new Error('RESEND_API_KEY must be a valid Resend API key.');
  // Accept either an address or a conventional display-name/address pair.
  // No newlines or extra recipients can enter the provider's From field.
  const match = from.match(/^(?:[^<>]{1,80}\s<([^<>]+)>|([^<>]+))$/);
  const address = match?.[1] ?? match?.[2];
  if (from.length > 320 || /[\r\n\u0000]/.test(from) || !address || !z.string().email().safeParse(address).success) {
    throw new Error('CORNER_EMAIL_FROM must be one valid sender address, optionally with a display name.');
  }
  return { apiKey, from };
}

function encryptionKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('CORNER_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) throw new Error('CORNER_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  return decoded;
}

function localSecrets(dataDir: string): LocalSecrets {
  const file = join(dataDir, 'private-config.json');
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error('The private configuration must be a regular file.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const generated: LocalSecrets = { authSecret: randomBytes(48).toString('base64'), tokenEncryptionKey: randomBytes(32).toString('base64') };
    try { writeFileSync(file, JSON.stringify(generated), { flag: 'wx', mode: 0o600 }); }
    catch (writeError) { if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError; }
  }
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('The private configuration must be a regular file.');
  chmodSync(file, 0o600);
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error('The local private configuration could not be read. Restore it from your backup; do not replace existing keys.'); }
  const secrets = value as Partial<LocalSecrets> | null;
  if (!secrets || typeof secrets.authSecret !== 'string' || secrets.authSecret.length < 32 || typeof secrets.tokenEncryptionKey !== 'string') {
    throw new Error('The local private configuration is invalid. Restore it from your backup.');
  }
  encryptionKey(secrets.tokenEncryptionKey);
  return secrets as LocalSecrets;
}

/** Reads configuration without printing credentials or silently rotating keys. */
export function loadConfig(environment: NodeJS.ProcessEnv = process.env, options: { development?: boolean } = {}): Config {
  const development = options.development === true;
  const deployment = environment.CORNER_DEPLOYMENT ?? 'local';
  if (deployment !== 'local' && deployment !== 'hosted') throw new Error('CORNER_DEPLOYMENT must be local or hosted.');
  const port = Number(development ? (environment.CORNER_DEV_API_PORT ?? 3001) : (environment.CORNER_PORT ?? environment.PORT ?? 3000));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${development ? 'CORNER_DEV_API_PORT' : 'CORNER_PORT'} must be a valid TCP port.`);
  const rawOrigin = environment.CORNER_ORIGIN ?? (deployment === 'local' ? `http://127.0.0.1:${development ? 3000 : port}` : '');
  let url: URL;
  try { url = new URL(rawOrigin); } catch { throw new Error('Set CORNER_ORIGIN to the public origin of this application.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('CORNER_ORIGIN must contain only an HTTP or HTTPS origin.');
  }
  if (deployment === 'hosted' && url.protocol !== 'https:') throw new Error('Hosted deployments require an HTTPS CORNER_ORIGIN.');
  if (deployment === 'local' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Local deployments require a loopback CORNER_ORIGIN. Use hosted mode for a public origin.');
  }
  if (development && Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === port) throw new Error('CORNER_DEV_API_PORT must differ from the browser port in CORNER_ORIGIN.');
  const host = development ? '127.0.0.1' : environment.CORNER_HOST ?? '127.0.0.1';
  if (!host || /[\s/\\]/.test(host)) throw new Error('CORNER_HOST must be a bind address.');
  const dataDir = resolve(REPOSITORY_ROOT, environment.CORNER_DATA_DIR ?? 'data');
  let authSecret = environment.BETTER_AUTH_SECRET;
  let encodedKey = environment.CORNER_TOKEN_ENCRYPTION_KEY;
  if (deployment === 'hosted' && (!authSecret || !encodedKey)) throw new Error('Hosted deployments require BETTER_AUTH_SECRET and CORNER_TOKEN_ENCRYPTION_KEY.');
  // Validate supplied values before creating anything on disk.
  if (authSecret !== undefined && authSecret.length < 32) throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters.');
  if (encodedKey !== undefined) encryptionKey(encodedKey);
  const mail = mailConfiguration(environment, deployment);
  const proxySecret = environment.CORNER_PROXY_SECRET;
  if (proxySecret !== undefined && (proxySecret.trim().length < 32 || /[\r\n\u0000]/.test(proxySecret))) throw new Error('CORNER_PROXY_SECRET must contain at least 32 characters and no line breaks.');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (lstatSync(dataDir).isSymbolicLink() || !lstatSync(dataDir).isDirectory()) throw new Error('CORNER_DATA_DIR must be a private directory.');
  chmodSync(dataDir, 0o700);
  if (!authSecret || !encodedKey) {
    const saved = localSecrets(dataDir);
    authSecret ??= saved.authSecret;
    encodedKey ??= saved.tokenEncryptionKey;
  }
  return { origin: url.origin, host, port, dataDir, deployment, authSecret, tokenEncryptionKey: encryptionKey(encodedKey), ...(mail ? { mail } : {}), ...(proxySecret ? { proxySecret } : {}) };
}
