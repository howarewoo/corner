import { drizzle, type NodePgDatabase, type NodePgTransaction } from 'drizzle-orm/node-postgres';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { Pool, PoolClient } from 'pg';
import * as schema from './schema.js';

export function createQueries(client: Pool | PoolClient): Database {
  return drizzle({ client, schema });
}

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;
export type QueryConnection = Database | Transaction;
