import { drizzle, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { NeonQueryResultHKT } from 'drizzle-orm/neon-serverless';
import type { PgDatabase, PgTransaction } from 'drizzle-orm/pg-core';
import type { Pool, PoolClient } from 'pg';
import * as schema from './schema.js';

export function createQueries(client: Pool | PoolClient): Database {
  return drizzle({ client, schema });
}

type QueryResult = NodePgQueryResultHKT | NeonQueryResultHKT;
export type Database = PgDatabase<QueryResult, typeof schema>;
export type Transaction = PgTransaction<
  QueryResult,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
