import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { createDatabase } from './database.js';

export async function migrate(database: Pool): Promise<void> {
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
  const connection = await database.connect();
  try {
    await connection.query('BEGIN');
    await connection.query("SELECT pg_advisory_xact_lock(hashtextextended('corner:schema-migrations', 0))");
    await connection.query('CREATE TABLE IF NOT EXISTS corner_schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL)');
    for (const name of (await readdir(directory)).filter(name => /^\d+_.+\.sql$/.test(name)).sort()) {
      const sql = await readFile(join(directory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = (await connection.query('SELECT checksum FROM corner_schema_migrations WHERE name = $1', [name])).rows[0];
      if (existing) {
        if (existing.checksum !== checksum) throw new Error(`Applied migration ${name} was modified.`);
        continue;
      }
      await connection.query(sql);
      await connection.query('INSERT INTO corner_schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
      process.stdout.write(`Applied ${name}\n`);
    }
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}

if (process.argv.includes('--apply')) {
  if (!process.env.DATABASE_URL_UNPOOLED) throw new Error('DATABASE_URL_UNPOOLED is required for schema migrations.');
  const database = createDatabase(process.env.DATABASE_URL_UNPOOLED);
  try { await migrate(database); process.stdout.write('Corner PostgreSQL schema is current.\n'); }
  finally { await database.end(); }
}
