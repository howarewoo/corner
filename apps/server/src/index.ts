import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { loadConfig, REPOSITORY_ROOT } from './config.js';
import { createAuth } from './auth.js';
import { createDatabase } from './database.js';
import { createQueries } from './queries.js';
import { WorkspaceStore } from './store.js';
import { workspaceMetadata } from './schema.js';
import { createApp } from './app.js';
import { requestClientIP, verifiedProxyIP } from './request-identity.js';
import { createDelegationService, isDelegationNativePath } from './delegation.js';

const development = process.argv.includes('--dev');
const config = loadConfig(process.env, { development });
const db = createDatabase(config.databaseUrl);
const auth = createAuth(config);
const queries = createQueries(db);
const store = new WorkspaceStore(queries);
const delegation = createDelegationService(config);
await store.db.select({ user_id: workspaceMetadata.user_id }).from(workspaceMetadata).limit(1);
const app = createApp({
  config,
  auth,
  store,
  delegation,
});
const server = createServer();
const appHost = new URL(config.origin).host;
const landingHost = new URL(config.landingOrigin).host;
const docsHost = new URL(config.docsOrigin).host;
const dist = join(REPOSITORY_ROOT, 'apps', 'web', 'dist');
const landingDist = join(REPOSITORY_ROOT, 'apps', 'landing', 'dist');
const docsDist = join(REPOSITORY_ROOT, 'apps', 'docs', 'dist');
if (
  !development &&
  (!existsSync(join(dist, 'index.html')) ||
    !existsSync(join(landingDist, 'index.html')) ||
    !existsSync(join(docsDist, 'index.html')))
)
  throw new Error('Build all three interfaces first with pnpm run build, then run pnpm start.');

const activeRequests = new Set<Promise<void>>();
server.on('request', (req, res) => {
  const task = handleRequest(req, res);
  activeRequests.add(task);
  void task.then(
    () => activeRequests.delete(task),
    () => activeRequests.delete(task),
  );
});

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    if (closing) {
      res.writeHead(503, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store',
        Connection: 'close',
      });
      res.end('Corner is restarting. Please try again shortly.');
      return;
    }
    const landing = req.headers.host === landingHost;
    const docs = req.headers.host === docsHost;
    const origin = docs ? config.docsOrigin : landing ? config.landingOrigin : config.origin;
    // Exact host matching precedes every account, OAuth, MCP, and asset handler.
    if (
      req.headers.host !== (docs ? docsHost : landing ? landingHost : appHost) ||
      !req.url?.startsWith('/') ||
      req.url.startsWith('//')
    ) {
      res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Open Corner using its configured origin.');
      return;
    }
    const requestURL = new URL(req.url, origin);
    if (requestURL.origin !== origin) {
      res.writeHead(400, { 'Cache-Control': 'no-store' });
      res.end('Open Corner using its configured origin.');
      return;
    }
    const path = requestURL.pathname;
    const localHealthProbe =
      path === '/api/health' &&
      req.method === 'GET' &&
      ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '');
    if (
      config.proxySecret &&
      !verifiedProxyIP(req.headers, config.proxySecret) &&
      !localHealthProbe
    ) {
      res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Use the configured HTTPS address to open Corner.');
      return;
    }
    if (landing || docs) {
      if (!['GET', 'HEAD'].includes(req.method ?? 'GET')) {
        res.writeHead(405, { 'Cache-Control': 'no-store' });
        res.end();
      } else if (path === '/open-app') {
        res.writeHead(302, {
          Location: config.origin,
          'Cache-Control': 'no-store',
        });
        res.end();
      } else if (landing && path === '/open-docs') {
        res.writeHead(302, { Location: config.docsOrigin, 'Cache-Control': 'no-store' });
        res.end();
      } else await serveStatic(req, res, path, docs ? docsDist : landingDist, false, docs);
      return;
    }
    if (isDelegationNativePath(path)) {
      await delegation.handleNative(req, res, { db: queries, auth });
      return;
    }
    if (
      path.startsWith('/api/') ||
      path === '/auth/callback' ||
      path === '/mcp' ||
      path === '/.well-known/oauth-protected-resource/mcp'
    ) {
      const request = toWebRequest(req);
      const response = await app.fetch(request);
      // Rejected bodies must not leave an unread stream on a reusable HTTP connection.
      if (request.body && !req.readableEnded) res.shouldKeepAlive = false;
      await sendWebResponse(res, response);
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method ?? 'GET')) {
      res.writeHead(405);
      res.end();
      return;
    }
    if (development) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Open Corner at its configured browser origin.');
      return;
    }
    await serveStatic(req, res, path);
  } catch {
    if (!res.headersSent)
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'This request could not be completed.' }));
  }
}
server.requestTimeout = 210_000;
server.headersTimeout = 20_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 1000;
server.listen(config.port, config.host, () => {
  process.stdout.write(`Corner is ready at ${config.origin}\n`);
  if (development)
    process.stdout.write(
      `Development API listens at http://${config.host}:${config.port}; browser requests arrive through the web workspace proxy.\n`,
    );
  process.stdout.write(
    `Mode: ${config.deployment}${development ? ' (development)' : ''}. Records: ${development ? 'local PostgreSQL' : 'Neon Postgres'}. Accounts: ${development ? 'local Auth' : 'Neon Auth'}.\n`,
  );
});

function toWebRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (
      [
        'x-corner-client-ip',
        'x-corner-proxy-ip',
        'x-corner-proxy-token',
        'x-forwarded-for',
        'x-forwarded-host',
        'x-forwarded-proto',
        'forwarded',
      ].includes(key)
    )
      continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else if (value !== undefined) headers.set(key, value);
  }
  headers.set(
    'x-corner-client-ip',
    requestClientIP(req.headers, req.socket.remoteAddress, config.proxySecret),
  );
  const method = req.method ?? 'GET';
  const init: RequestInit & { duplex?: 'half' } = { method, headers };
  if (!['GET', 'HEAD'].includes(method)) {
    // Let the response finish before closing a rejected upload's transport.
    init.body = (Readable.toWeb(req) as ReadableStream<Uint8Array>).pipeThrough(
      new TransformStream(),
      { preventCancel: true },
    );
    init.duplex = 'half';
  }
  return new Request(new URL(req.url!, config.origin), init);
}
async function sendWebResponse(res: ServerResponse, response: Response) {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie') headers[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  headers['Referrer-Policy'] = 'no-referrer';
  headers['X-Frame-Options'] = 'DENY';
  headers['X-Content-Type-Options'] = 'nosniff';
  headers['Cache-Control'] = 'private, no-store';
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  for await (const chunk of response.body as any) res.write(chunk);
  res.end();
}
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};
async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  directory = dist,
  spa = true,
  docs = false,
) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (
    decoded.includes('\0') ||
    decoded.includes('\\') ||
    decoded.split('/').some((part) => part.startsWith('.')) ||
    /^\/(?:app|landing|docs)(?:\/|$)/.test(decoded) ||
    (!spa &&
      /^\/(?:api(?:\/|$)|auth(?:\/|$)|account(?:\/|$)|oauth(?:\/|$)|mcp(?:\/|$)|sw\.js$|manifest\.webmanifest$)/.test(
        decoded,
      ))
  ) {
    res.writeHead(404);
    res.end();
    return;
  }
  let file = resolve(directory, `.${decoded}`);
  if (!file.startsWith(directory + sep) && file !== directory) {
    res.writeHead(404);
    res.end();
    return;
  }
  if (docs && !extname(decoded)) {
    const nested = join(file, 'index.html');
    if (existsSync(nested) && statSync(nested).isFile()) file = nested;
  }
  if (file === directory || !existsSync(file) || !statSync(file).isFile()) {
    if ((!spa && decoded !== '/') || extname(decoded)) {
      res.writeHead(404);
      res.end();
      return;
    }
    file = join(directory, 'index.html');
  }
  const content = await readFile(file);
  res.writeHead(200, {
    'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
    'Content-Length': content.length,
    'Cache-Control': path.startsWith('/oauth/')
      ? 'private, no-store, max-age=0'
      : file.includes(`${sep}assets${sep}`) || file.includes(`${sep}_astro${sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    // Astro supplies the per-page script hashes in its native meta policy.
    'Content-Security-Policy':
      docs && extname(file) === '.html'
        ? "base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'"
        : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  res.end(req.method === 'HEAD' ? undefined : content);
}

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
  const deadline = setTimeout(() => {
    process.stderr.write('CORNER_SHUTDOWN_TIMEOUT\n');
    server.closeAllConnections();
    process.exit(1);
  }, 25_000);
  try {
    await Promise.allSettled([...activeRequests]);
    await stopped;
    await db.end();
    process.exitCode = 0;
  } finally {
    clearTimeout(deadline);
  }
}
process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});
