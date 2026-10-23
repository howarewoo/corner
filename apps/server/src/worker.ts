import { extname } from 'node:path';
import { createApp } from './app.js';
import { createAuth } from './auth.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { createDatabase } from './database.js';
import { WorkspaceStore } from './store.js';
import { SubscriptionProvider } from './subscription.js';
import { PlanningAgent } from './planning-agent.js';
import { connectionDTO, createAIRouter } from './ai-routes.js';

export type WorkerEnvironment = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  CORNER_ORIGIN: string;
  DATABASE_URL: string;
  NEON_AUTH_BASE_URL: string;
  NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: string;
  BETTER_AUTH_SECRET: string;
  CORNER_TOKEN_ENCRYPTION_KEY: string;
};

function secure(response: Response, api: boolean): Response {
  const result = new Response(response.body, response);
  result.headers.set('Referrer-Policy', 'no-referrer');
  result.headers.set('X-Frame-Options', 'DENY');
  result.headers.set('X-Content-Type-Options', 'nosniff');
  if (api) result.headers.set('Cache-Control', 'private, no-store');
  else {
    result.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    result.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  }
  return result;
}

export default {
  async fetch(request: Request, env: WorkerEnvironment): Promise<Response> {
    const url = new URL(request.url);
    const api = url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname === '/auth/callback';
    try {
      // Never read local .env files or generate keys in the Workers filesystem.
      // Binding selection also prevents relabelling a public Worker as local.
      const config = loadRuntimeConfig({
        CORNER_DEPLOYMENT: 'hosted', CORNER_ORIGIN: env.CORNER_ORIGIN,
        DATABASE_URL: env.DATABASE_URL, NEON_AUTH_BASE_URL: env.NEON_AUTH_BASE_URL,
        NEON_AUTH_REQUIRE_EMAIL_VERIFICATION: env.NEON_AUTH_REQUIRE_EMAIL_VERIFICATION,
        BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET, CORNER_TOKEN_ENCRYPTION_KEY: env.CORNER_TOKEN_ENCRYPTION_KEY,
      }, { dataDir: '/tmp/corner' });
      if (url.origin !== config.origin) return secure(new Response('Open Corner using its configured origin.', { status: 400 }), true);
      if (!api) {
        if (!['GET', 'HEAD'].includes(request.method)) return secure(new Response(null, { status: 405 }), false);
        const decoded = decodeURIComponent(url.pathname);
        if (decoded.includes('\0') || decoded.split('/').some(part => part.startsWith('.'))) return secure(new Response(null, { status: 404 }), false);
        let response = await env.ASSETS.fetch(request);
        if (response.status === 404 && !extname(decoded)) {
          response = await env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
        }
        const result = secure(response, false);
        result.headers.set('Cache-Control', url.pathname.startsWith('/assets/') && result.ok ? 'public, max-age=31536000, immutable' : 'no-cache');
        return result;
      }
      const headers = new Headers(request.headers);
      for (const name of ['x-corner-client-ip', 'x-corner-proxy-ip', 'x-corner-proxy-token', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded']) headers.delete(name);
      const incoming = new Request(request, { headers });
      // Workers sockets belong to the invoking request, never to an isolate-wide pool.
      const db = createDatabase(config.databaseUrl);
      const store = new WorkspaceStore(db);
      const provider = new SubscriptionProvider({ db, config });
      const agent = new PlanningAgent(store, provider);
      try {
        // Hosted status forbids new inference. Keep persisted history/application,
        // but do not run process-start recovery or provider registration in isolates.
        const app = createApp({
          config, auth: createAuth(config), store,
          aiAvailable: async principal => connectionDTO(await provider.status(principal.userId)).available,
          extraRoute: createAIRouter(provider, agent),
        });
        return secure(await app(incoming), true);
      } finally {
        await agent.close();
        await db.end();
      }
    } catch {
      return secure(Response.json({ error: 'This request could not be completed.' }, { status: 500 }), true);
    }
  },
};
