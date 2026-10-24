import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { demoState } from './local-fixtures.mjs';

const seedIdentity = new AsyncLocalStorage();
export const localUsers = [
  { key: 'empty', email: 'empty@corner.test', name: 'Empty local user' },
  { key: 'demo', email: 'demo@corner.test', name: 'Synthetic demo user' },
];
export const localPassword = 'Corner-local-only-2026!';

/** Seed IDs survive an interrupted signup; ordinary signup still receives random IDs. */
export function localAuthOptions(database, authUrl, origin, secret) {
  return {
    database, baseURL: authUrl, basePath: '/neondb/auth', trustedOrigins: [origin], secret,
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    advanced: {
      useSecureCookies: true, cookiePrefix: 'neon-auth',
      database: { generateId: ({ model }) => model === 'user' && seedIdentity.getStore() || randomUUID() },
    },
    logger: { disabled: true },
  };
}

export async function initializeLocalDatabase(database, instance) {
  // Local-only bookkeeping is atomic; a failed first launch cannot leave a half-created identity.
  const connection = await database.connect();
  try {
    await connection.query('BEGIN');
    await connection.query("SELECT pg_advisory_xact_lock(hashtextextended('corner:local-initialization', 0))");
    const tables = (await connection.query("SELECT tablename FROM pg_tables WHERE schemaname = current_schema()"))
      .rows.map((row) => row.tablename);
    if (!tables.includes('corner_local_identity')) {
      if (tables.length) throw new Error('Refusing to adopt a nonempty database without local ownership metadata.');
      await connection.query('CREATE TABLE corner_local_identity (instance TEXT PRIMARY KEY)');
      await connection.query('INSERT INTO corner_local_identity VALUES ($1)', [instance]);
    }
    const owners = (await connection.query('SELECT instance FROM corner_local_identity')).rows;
    if (owners.length !== 1 || owners[0].instance !== instance)
      throw new Error('Local database installation identity does not match. No migration or seed was applied.');
    await connection.query(`CREATE TABLE IF NOT EXISTS corner_local_seeds (
      fixture TEXT PRIMARY KEY, user_id TEXT NOT NULL, seed_date TEXT NOT NULL,
      complete BOOLEAN NOT NULL DEFAULT false
    )`);
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally { connection.release(); }
}

/** Use real account sessions and the existing HTTP import contract, never workspace SQL inserts. */
export async function seedLocalUsers({ database, managed, app, origin, authUrl, instance, initialState, now = new Date() }) {
  const owners = (await database.query('SELECT instance FROM corner_local_identity')).rows;
  if (owners.length !== 1 || owners[0].instance !== instance)
    throw new Error('Refusing to seed a database without this local installation identity.');
  for (const user of localUsers) {
    const id = createHash('sha256').update(`${instance}:${user.key}`).digest('hex').slice(0, 32);
    const previous = (await database.query('SELECT * FROM corner_local_seeds WHERE fixture = $1', [user.key])).rows[0];
    const account = (await database.query('SELECT id, email FROM "user" WHERE email = $1 OR id = $2', [user.email, id])).rows;
    if (account.some((row) => row.id !== id || row.email !== user.email) || (!previous && account.length))
      throw new Error(`Refusing to adopt an unexpected existing ${user.key} account.`);
    if (previous?.user_id && previous.user_id !== id) throw new Error('Local seed owner changed.');
    if (previous?.complete) {
      if (account.length !== 1) throw new Error(`The seeded ${user.key} account was removed. Use an explicit local reset.`);
      continue;
    }
    await database.query(
      'INSERT INTO corner_local_seeds (fixture, user_id, seed_date) VALUES ($1, $2, $3) ON CONFLICT (fixture) DO NOTHING',
      [user.key, id, now.toISOString().slice(0, 10)],
    );
    const record = (await database.query('SELECT * FROM corner_local_seeds WHERE fixture = $1', [user.key])).rows[0];
    if (!account.length) {
      const signup = await seedIdentity.run(id, () => managed.handler(new Request(`${authUrl}/sign-up/email`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ name: user.name, email: user.email, password: localPassword }),
      })));
      if (!signup.ok || (await signup.json()).user?.id !== id)
        throw new Error(`Could not create the local ${user.key} account.`);
    }
    const signin = await app.fetch(new Request(`${origin}/api/auth/sign-in/email`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: localPassword }),
    }));
    if (!signin.ok) throw new Error(`Local ${user.key} credentials changed; they were not reset.`);
    const cookie = signin.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
    const rpc = async (procedure, input) => {
      const response = await app.fetch(new Request(`${origin}/api/rpc/${procedure}`, {
        method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ json: input }),
      }));
      if (!response.ok) throw new Error(`Local ${user.key} ${procedure} failed; existing records were preserved.`);
      return (await response.json()).json;
    };
    const session = await rpc('account/session', undefined);
    if (session.user?.id !== id) throw new Error('Local seed session does not match its reserved owner.');
    if (user.key === 'demo') {
      const state = demoState(record.seed_date, initialState);
      // Exact date, state, expected revision and request ID remain stable after a lost acknowledgement.
      await rpc('workspace/import', { requestId: `local-seed-v1:${id}`, expectedRevision: 0, state });
    }
    await database.query('UPDATE corner_local_seeds SET complete = true WHERE fixture = $1', [user.key]);
    await app.fetch(new Request(`${origin}/api/auth/sign-out`, {
      method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}',
    }));
  }
}
