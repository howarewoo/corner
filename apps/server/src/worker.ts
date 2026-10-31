import './worker-node-require.js';
import { createApp } from './app.js';
import { createAuth } from './auth.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { createWorkerDatabase } from './worker-database.js';
import { WorkspaceStore } from './store.js';
import {
  createDelegationService,
  isDelegationNativePath,
  type DelegationService,
} from './delegation.js';
import { createWorkerDelegationHandler } from './delegation-worker.js';
import type { DelegationRuntime } from './delegation.js';
import { fetchSiteAssets, secureResponse as secure } from './worker-assets.js';

let delegationCache:
  | {
      origin: string;
      databaseUrl: string;
      service: DelegationService;
      fetch: (request: Request, runtime: DelegationRuntime) => Promise<Response>;
    }
  | undefined;

export type WorkerEnvironment = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
  CORNER_ORIGIN: string;
  CORNER_LANDING_ORIGIN: string;
  CORNER_DOCS_ORIGIN: string;
  DATABASE_URL: string;
  NEON_AUTH_BASE_URL: string;
  NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: string;
};

async function fetchApplication(request: Request, env: WorkerEnvironment): Promise<Response> {
  const url = new URL(request.url);
  const api =
    url.pathname === '/api' ||
    url.pathname.startsWith('/api/') ||
    url.pathname === '/auth/callback' ||
    url.pathname === '/mcp' ||
    url.pathname === '/.well-known/oauth-protected-resource/mcp' ||
    isDelegationNativePath(url.pathname);
  try {
    // Never read local .env files or generate keys in the Workers filesystem.
    // Binding selection also prevents relabelling a public Worker as local.
    const config = loadRuntimeConfig(
      {
        CORNER_DEPLOYMENT: 'hosted',
        CORNER_ORIGIN: env.CORNER_ORIGIN,
        CORNER_LANDING_ORIGIN: env.CORNER_LANDING_ORIGIN,
        CORNER_DOCS_ORIGIN: env.CORNER_DOCS_ORIGIN,
        DATABASE_URL: env.DATABASE_URL,
        NEON_AUTH_BASE_URL: env.NEON_AUTH_BASE_URL,
        NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: env.NEON_AUTH_REQUIRE_EMAIL_VERIFICATION,
      },
      { dataDir: '/tmp/corner' },
    );
    if (
      (url.origin !== config.origin &&
        url.origin !== config.landingOrigin &&
        url.origin !== config.docsOrigin) ||
      (request.headers.has('Host') && request.headers.get('Host') !== url.host)
    )
      return secure(
        new Response('Open Corner using its configured origin.', { status: 400 }),
        true,
      );
    if (url.origin !== config.origin || !api)
      return await fetchSiteAssets(request, config, env.ASSETS, env.CF_VERSION_METADATA?.id);
    const headers = new Headers(request.headers);
    for (const name of [
      'x-corner-client-ip',
      'x-corner-proxy-ip',
      'x-corner-proxy-token',
      'x-forwarded-for',
      'x-forwarded-host',
      'x-forwarded-proto',
      'forwarded',
    ])
      headers.delete(name);
    const incoming = new Request(request, { headers });
    // Workers sockets belong to the invoking request, never to an isolate-wide pool.
    const { pool, db } = createWorkerDatabase(config.databaseUrl);
    try {
      const store = new WorkspaceStore(db);
      if (
        !delegationCache ||
        delegationCache.origin !== config.origin ||
        delegationCache.databaseUrl !== config.databaseUrl
      ) {
        const service = createDelegationService(config);
        delegationCache = {
          origin: config.origin,
          databaseUrl: config.databaseUrl,
          service,
          fetch: createWorkerDelegationHandler(service),
        };
      }
      const delegation = delegationCache;
      const auth = createAuth(config, fetch, env.CF_VERSION_METADATA?.id);
      const response = isDelegationNativePath(url.pathname)
        ? await delegation.fetch(incoming, { db, auth })
        : await createApp({ config, auth, store, delegation: delegation.service }).fetch(incoming);
      const result = secure(response, true);
      if (env.CF_VERSION_METADATA?.id)
        result.headers.set('X-Corner-Version', env.CF_VERSION_METADATA.id);
      return result;
    } finally {
      await pool.end();
    }
  } catch {
    return secure(
      Response.json({ error: 'This request could not be completed.' }, { status: 500 }),
      true,
    );
  }
}

export default { fetch: fetchApplication };
