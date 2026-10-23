import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntimeConfig } from './runtime-config.js';

// Both src/config.ts and the compiled dist/config.js live three levels below
// the repository root. Workspace scripts must share one stable data location.
export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export type Config = {
  origin: string;
  host: string;
  port: number;
  dataDir: string;
  deployment: 'local' | 'hosted';
  databaseUrl: string;
  neonAuthBaseUrl: string;
  neonAuthRequireEmailVerification: boolean;
  authSecret: string;
  tokenEncryptionKey: Buffer;
  proxySecret?: string;
};

type LocalSecrets = { authSecret: string; tokenEncryptionKey: string };


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
  return secrets as LocalSecrets;
}

/** Reads configuration without printing credentials or silently rotating keys. */
export function loadConfig(environment: NodeJS.ProcessEnv = process.env, options: { development?: boolean } = {}): Config {
  const dataDir = resolve(REPOSITORY_ROOT, environment.CORNER_DATA_DIR ?? 'data');
  return loadRuntimeConfig(environment, {
    ...options, dataDir,
    localSecrets: () => {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      if (lstatSync(dataDir).isSymbolicLink() || !lstatSync(dataDir).isDirectory()) throw new Error('CORNER_DATA_DIR must be a private directory.');
      chmodSync(dataDir, 0o700);
      return localSecrets(dataDir);
    },
  });
}
