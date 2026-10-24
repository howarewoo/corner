import type { Config } from './config.js';

function encryptionKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value))
    throw new Error('CORNER_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value)
    throw new Error('CORNER_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  return decoded;
}

type Options = {
  development?: boolean;
  dataDir: string;
  localSecrets?: () => { authSecret: string; tokenEncryptionKey: string };
};

const developmentConfigurationError =
  'Development requires loopback PostgreSQL and Auth in local mode. Run pnpm dev to start the isolated stack.';

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

/** Common validation without process environment, repository paths, or filesystem I/O. */
export function loadRuntimeConfig(environment: NodeJS.ProcessEnv, options: Options): Config {
  const development = options.development === true;
  const deployment = environment.CORNER_DEPLOYMENT ?? 'local';
  if (deployment !== 'local' && deployment !== 'hosted')
    throw new Error('CORNER_DEPLOYMENT must be local or hosted.');
  const databaseUrl = environment.DATABASE_URL;
  const authUrl = environment.NEON_AUTH_BASE_URL;
  if (development && (deployment !== 'local' || !databaseUrl || !authUrl))
    throw new Error(developmentConfigurationError);
  if (!databaseUrl)
    throw new Error('DATABASE_URL is required. Run neon deploy to pull Neon configuration.');
  let database: URL;
  try {
    database = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error();
  } catch {
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL.');
  }
  if (!authUrl)
    throw new Error('NEON_AUTH_BASE_URL is required. Run neon deploy to pull Neon configuration.');
  let neonAuthBaseUrl: string;
  let authHostname: string;
  try {
    const parsed = new URL(authUrl);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error();
    neonAuthBaseUrl = parsed.href.replace(/\/$/, '');
    authHostname = parsed.hostname;
  } catch {
    throw new Error('NEON_AUTH_BASE_URL must be an HTTPS service URL.');
  }
  if (development && (
    !isLoopback(database.hostname) ||
    !isLoopback(authHostname) ||
    database.searchParams.has('host') ||
    database.searchParams.has('hostaddr')
  )) throw new Error(developmentConfigurationError);
  if (
    environment.NEON_AUTH_REQUIRE_EMAIL_VERIFICATION !== undefined &&
    !['true', 'false'].includes(environment.NEON_AUTH_REQUIRE_EMAIL_VERIFICATION)
  )
    throw new Error('NEON_AUTH_REQUIRE_EMAIL_VERIFICATION must be true or false.');
  const neonAuthRequireEmailVerification =
    environment.NEON_AUTH_REQUIRE_EMAIL_VERIFICATION === 'true';
  const port = Number(
    development
      ? (environment.CORNER_DEV_API_PORT ?? 3001)
      : (environment.CORNER_PORT ?? environment.PORT ?? 3000),
  );
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(
      `${development ? 'CORNER_DEV_API_PORT' : 'CORNER_PORT'} must be a valid TCP port.`,
    );
  const rawOrigin =
    environment.CORNER_ORIGIN ??
    (deployment === 'local' ? `http://127.0.0.1:${development ? 3000 : port}` : '');
  let url: URL;
  try {
    url = new URL(rawOrigin);
  } catch {
    throw new Error('Set CORNER_ORIGIN to the public origin of this application.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('CORNER_ORIGIN must contain only an HTTP or HTTPS origin.');
  }
  if (deployment === 'hosted' && url.protocol !== 'https:')
    throw new Error('Hosted deployments require an HTTPS CORNER_ORIGIN.');
  if (deployment === 'local' && !isLoopback(url.hostname)) {
    throw new Error(
      'Local deployments require a loopback CORNER_ORIGIN. Use hosted mode for a public origin.',
    );
  }
  if (development && Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === port)
    throw new Error('CORNER_DEV_API_PORT must differ from the browser port in CORNER_ORIGIN.');
  const host = development ? '127.0.0.1' : (environment.CORNER_HOST ?? '127.0.0.1');
  if (!host || /[\s/\\]/.test(host)) throw new Error('CORNER_HOST must be a bind address.');
  let authSecret = environment.BETTER_AUTH_SECRET;
  let encodedKey = environment.CORNER_TOKEN_ENCRYPTION_KEY;
  if (deployment === 'hosted' && (!authSecret || !encodedKey))
    throw new Error(
      'Hosted deployments require BETTER_AUTH_SECRET and CORNER_TOKEN_ENCRYPTION_KEY.',
    );
  // Validate supplied values before the Node adapter creates anything on disk.
  if (authSecret !== undefined && authSecret.length < 32)
    throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters.');
  if (encodedKey !== undefined) encryptionKey(encodedKey);
  const proxySecret = environment.CORNER_PROXY_SECRET;
  if (
    proxySecret !== undefined &&
    (proxySecret.trim().length < 32 || /[\r\n\u0000]/.test(proxySecret))
  )
    throw new Error('CORNER_PROXY_SECRET must contain at least 32 characters and no line breaks.');
  if (!authSecret || !encodedKey) {
    if (!options.localSecrets)
      throw new Error('Local deployments require private configuration storage.');
    const saved = options.localSecrets();
    authSecret ??= saved.authSecret;
    encodedKey ??= saved.tokenEncryptionKey;
  }
  return {
    origin: url.origin,
    host,
    port,
    dataDir: options.dataDir,
    deployment,
    databaseUrl,
    neonAuthBaseUrl,
    neonAuthRequireEmailVerification,
    authSecret,
    tokenEncryptionKey: encryptionKey(encodedKey),
    ...(proxySecret ? { proxySecret } : {}),
  };
}
