import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { createDatabase } from '../src/database.ts';
import { migrate } from '../src/migrate.ts';
import { createAuth } from '../src/auth.ts';
import type { Config } from '../src/config.ts';

export const neonTestConfig = {
  databaseUrl: 'postgresql://unused.invalid/test',
  neonAuthBaseUrl: 'https://managed-auth.example.test/neondb/auth',
  neonAuthRequireEmailVerification: false,
};
const databases = new WeakMap<Pool, { admin: Pool; schema: string }>();

export async function testDatabase(): Promise<Pool> {
  if (!process.env.CORNER_TEST_DATABASE_URL)
    throw new Error(
      'Set CORNER_TEST_DATABASE_URL to a disposable PostgreSQL database; tests never use DATABASE_URL.',
    );
  const url = new URL(process.env.CORNER_TEST_DATABASE_URL);
  const admin = createDatabase(url.href);
  const schema = `corner_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const database = createDatabase(url.href);
  databases.set(database, { admin, schema });
  try {
    await migrate(database);
    return database;
  } catch (error) {
    await closeTestDatabase(database);
    throw error;
  }
}

export async function closeTestDatabase(database: Pool): Promise<void> {
  const owned = databases.get(database);
  if (!owned) throw new Error('Refusing to remove a schema not owned by this test.');
  await database.end();
  try {
    await owned.admin.query(`DROP SCHEMA "${owned.schema}" CASCADE`);
  } finally {
    await owned.admin.end();
    databases.delete(database);
  }
}

/** Actual Better Auth on disposable Postgres stands in for the managed service; no network or mail. */
export async function createTestAuth(config: Config, database: Pool) {
  const options = {
    database,
    secret: config.authSecret,
    baseURL: config.neonAuthBaseUrl,
    basePath: '/neondb/auth',
    trustedOrigins: [config.origin],
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    advanced: { useSecureCookies: true, cookiePrefix: 'neon-auth' },
    logger: { disabled: true },
  };
  await (await getMigrations(options)).runMigrations();
  const managed = betterAuth(options);
  await managed.$context;
  return createAuth(config, async (input, init) =>
    managed.handler(new Request(String(input), init)),
  );
}
