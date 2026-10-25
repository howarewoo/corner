import { Pool, neonConfig, types } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import type { Database } from './queries.js';
import * as schema from './schema.js';

// Use the ordinary PostgreSQL authentication handshake, without optimistic password writes.
neonConfig.pipelineConnect = false;
neonConfig.poolQueryViaFetch = false;

export function createWorkerDatabase(connectionString: string): { pool: Pool; db: Database } {
  const pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 15_000,
    idleTimeoutMillis: 30_000,
    // Revisions and millisecond timestamps are bounded numbers, just as in native pg.
    types: {
      getTypeParser: (oid: number, format?: string) =>
        oid === 20 ? Number : types.getTypeParser(oid, format as 'text'),
    },
  });
  pool.on('error', () => {
    console.error('CORNER_DATABASE_CONNECTION_FAILED');
  });
  return { pool, db: drizzle({ client: pool, schema }) };
}
