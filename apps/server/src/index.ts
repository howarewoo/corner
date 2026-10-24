import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { loadConfig, REPOSITORY_ROOT } from './config.js';
import { createAuth } from './auth.js';
import { createDatabase } from './database.js';
import { WorkspaceStore } from './store.js';
import { createApp } from './app.js';
import { SubscriptionProvider } from './subscription.js';
import { PlanningAgent } from './planning-agent.js';
import { connectionDTO } from './ai-routes.js';
import { requestClientIP, verifiedProxyIP } from './request-identity.js';

const development = process.argv.includes('--dev');
const config = loadConfig(process.env, { development });
const db = createDatabase(config.databaseUrl);
await db.query('SELECT 1 FROM workspace_state LIMIT 1');
const auth = createAuth(config);
const store = new WorkspaceStore(db);
const provider = new SubscriptionProvider({ db, config });
await provider.initialize();
const agent = new PlanningAgent(store, provider);
await agent.initialize();
const app = createApp({
  config,
  auth,
  store,
  aiAvailable: async (principal) =>
    connectionDTO(await provider.status(principal.userId)).available,
  ai: { provider, agent },
});
const server = createServer();
const dist = join(REPOSITORY_ROOT, 'apps', 'web', 'dist');
if (!development && !existsSync(join(dist, 'index.html')))
  throw new Error('Build the interface first with npm run build, then run npm start.');

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
    if (closing) {
      res.writeHead(503, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store',
        Connection: 'close',
      });
      res.end('Corner is restarting. Please try again shortly.');
      return;
    }
    // Explicit host validation prevents DNS rebinding against a local account service.
    if (
      req.headers.host !== new URL(config.origin).host ||
      !req.url?.startsWith('/') ||
      req.url.startsWith('//')
    ) {
      res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Open Corner using its configured origin.');
      return;
    }
    const requestURL = new URL(req.url, config.origin);
    if (requestURL.origin !== config.origin) {
      res.writeHead(400);
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
    if (path.startsWith('/api/') || path === '/auth/callback') {
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
    `Mode: ${config.deployment}${development ? ' (development)' : ''}. Records: Neon Postgres. Accounts: Neon Auth.\n`,
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
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};
async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
  const decoded = decodeURIComponent(path);
  if (decoded.includes('\0') || decoded.split('/').some((part) => part.startsWith('.'))) {
    res.writeHead(404);
    res.end();
    return;
  }
  let file = resolve(dist, `.${decoded}`);
  if (!file.startsWith(dist + sep) && file !== dist) {
    res.writeHead(404);
    res.end();
    return;
  }
  if (file === dist || !existsSync(file) || !statSync(file).isFile()) {
    if (extname(decoded)) {
      res.writeHead(404);
      res.end();
      return;
    }
    file = join(dist, 'index.html');
  }
  const content = await readFile(file);
  res.writeHead(200, {
    'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
    'Content-Length': content.length,
    'Cache-Control': file.includes(`${sep}assets${sep}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
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
  // The app still owns in-memory agent tasks and must run as one process.
  const deadline = setTimeout(() => {
    process.stderr.write('CORNER_SHUTDOWN_TIMEOUT\n');
    server.closeAllConnections();
    process.exit(1);
  }, 25_000);
  try {
    await agent.close();
    await Promise.allSettled([...activeRequests]);
    await stopped;
    await agent.close();
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
