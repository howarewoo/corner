// Real PostgreSQL plus a local HTTPS Better Auth fixture; never uses Neon credentials.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { betterAuth } = await import(require.resolve('better-auth'));
const { getMigrations } = await import(require.resolve('better-auth/db/migration'));

export async function startSmokeServices(directory, origin, initialize, databaseFactory) {
  const createDatabase =
    databaseFactory ?? (await import('../apps/server/dist/database.js')).createDatabase;
  initialize ??= (await import('../apps/server/dist/migrate.js')).migrate;
  if (!process.env.CORNER_TEST_DATABASE_URL)
    throw new Error('Set CORNER_TEST_DATABASE_URL to a disposable PostgreSQL database.');
  const url = new URL(process.env.CORNER_TEST_DATABASE_URL);
  const admin = createDatabase(url.href);
  const schema = `corner_smoke_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const database = createDatabase(url.href);
  const key = join(directory, `${schema}.key`);
  const certificate = join(directory, `${schema}.crt`);
  let server;
  async function close() {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await database.end();
    try {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  }
  try {
    await initialize(database);
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        certificate,
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    let auth;
    server = createServer(
      { key: await readFile(key), cert: await readFile(certificate) },
      async (request, response) => {
        try {
          const method = request.method ?? 'GET';
          const init = { method, headers: request.headers };
          if (!['GET', 'HEAD'].includes(method)) {
            init.body = Readable.toWeb(request);
            init.duplex = 'half';
          }
          const result = await auth.handler(
            new Request(`${baseUrl}${request.url.replace(/^\/neondb\/auth/, '')}`, init),
          );
          result.headers.forEach((value, name) => {
            if (name !== 'set-cookie') response.setHeader(name, value);
          });
          if (result.headers.getSetCookie().length)
            response.setHeader('Set-Cookie', result.headers.getSetCookie());
          response.writeHead(result.status);
          response.end(Buffer.from(await result.arrayBuffer()));
        } catch {
          response.writeHead(500);
          response.end();
        }
      },
    );
    const applicationUrl = new URL(origin);
    const applicationPort = Number(
      applicationUrl.port || (applicationUrl.protocol === 'https:' ? 443 : 80),
    );
    for (;;) {
      const listening = once(server, 'listening');
      server.listen(0, '127.0.0.1');
      await listening;
      if (server.address().port !== applicationPort) break;
      // Port zero can claim the application's fixed port before its process starts.
      await new Promise((resolve) => server.close(resolve));
    }
    const baseUrl = `https://127.0.0.1:${server.address().port}/neondb/auth`;
    const options = {
      database,
      baseURL: baseUrl,
      basePath: '/neondb/auth',
      trustedOrigins: [origin],
      secret: 'synthetic-smoke-auth-provider-secret-at-least-32-characters',
      emailAndPassword: { enabled: true, minPasswordLength: 12 },
      advanced: { useSecureCookies: true, cookiePrefix: 'neon-auth' },
      logger: { disabled: true },
    };
    await (await getMigrations(options)).runMigrations();
    auth = betterAuth(options);
    await auth.$context;
    return { database, databaseUrl: url.href, authUrl: baseUrl, certificate, close };
  } catch (error) {
    await close();
    throw error;
  }
}
