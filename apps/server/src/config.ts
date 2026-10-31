import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntimeConfig } from './runtime-config.js';

// Both src/config.ts and the compiled dist/config.js live three levels below
// the repository root. Workspace scripts must share one stable data location.
export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export type Config = {
  origin: string;
  landingOrigin: string;
  docsOrigin: string;
  host: string;
  port: number;
  dataDir: string;
  deployment: 'local' | 'hosted';
  databaseUrl: string;
  neonAuthBaseUrl: string;
  neonAuthRequireEmailVerification: boolean;
  proxySecret?: string;
};

/** Reads application configuration without opening or changing retained private keys. */
export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  options: { development?: boolean } = {},
): Config {
  const dataDir = resolve(REPOSITORY_ROOT, environment.CORNER_DATA_DIR ?? 'data');
  return loadRuntimeConfig(environment, {
    ...options,
    dataDir,
  });
}
