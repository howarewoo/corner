import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { createInitialState } from '@packages/workspace/initial-state';
import { createDatabase } from '../dist/database.js';
import { migrate } from '../dist/migrate.js';
import { createApp } from '../dist/app.js';
import { createAuth } from '../dist/auth.js';
import { WorkspaceStore } from '../dist/store.js';
import { loadConfig } from '../dist/config.js';
import { initializeLocalDatabase, localAuthOptions, seedLocalUsers } from './local-services.mjs';

export async function startLocalServices({ config, databaseUrl, origin, directory, key, certificate }) {
  const database = createDatabase(databaseUrl);
  let server, managed, seeding;
  const close = async () => {
    try { await seeding; }
    finally {
      if (server?.listening) await new Promise((accept) => server.close(accept));
      await database.end();
    }
  };
  try {
    const identity = (await database.query('SELECT current_database() AS database, current_user AS role')).rows[0];
    if (identity.database !== `corner_${config.instance}` || identity.role !== `corner_${config.instance}`)
      throw new Error('Refusing an unexpected local database or role.');
    await initializeLocalDatabase(database, config.instance);
    await migrate(database);
    let authUrl;
    server = createServer({ key: await readFile(key), cert: await readFile(certificate) }, async (req, res) => {
      try {
        if (!req.url?.startsWith('/neondb/auth/') || req.headers.host !== new URL(authUrl).host) {
          res.writeHead(400); res.end(); return;
        }
        const init = { method: req.method, headers: req.headers };
        if (!['GET', 'HEAD'].includes(req.method)) { init.body = Readable.toWeb(req); init.duplex = 'half'; }
        const response = await managed.handler(new Request(`${authUrl}${req.url.slice('/neondb/auth'.length)}`, init));
        response.headers.forEach((value, name) => { if (name !== 'set-cookie') res.setHeader(name, value); });
        if (response.headers.getSetCookie().length) res.setHeader('Set-Cookie', response.headers.getSetCookie());
        res.writeHead(response.status);
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(503); res.end(); }
    });
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
    authUrl = `https://127.0.0.1:${server.address().port}/neondb/auth`;
    const options = localAuthOptions(database, authUrl, origin, config.authSecret);
    await (await getMigrations(options)).runMigrations();
    managed = betterAuth(options);
    await managed.$context;
    const appConfig = loadConfig({
      DATABASE_URL: databaseUrl, NEON_AUTH_BASE_URL: authUrl, CORNER_ORIGIN: origin,
      CORNER_DATA_DIR: join(directory, 'data'), CORNER_DEPLOYMENT: 'local',
    }, { development: true });
    const app = createApp({
      config: appConfig, store: new WorkspaceStore(database),
      auth: createAuth(appConfig, (input, init) => managed.handler(new Request(String(input), init))),
    });
    return {
      authUrl, close,
      seed() {
        if (seeding) return seeding;
        seeding = seedLocalUsers({ database, managed, app, origin, authUrl, instance: config.instance, initialState: createInitialState })
          .finally(() => { seeding = undefined; });
        return seeding;
      },
    };
  } catch (error) { await close(); throw error; }
}
