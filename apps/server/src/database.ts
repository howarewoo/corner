import pg from 'pg';

// These columns contain bounded revisions and millisecond timestamps, not arbitrary bigint data.
const types = { getTypeParser: (oid: number, format?: string) => oid === 20 ? Number : pg.types.getTypeParser(oid, format as 'text') };

export function createDatabase(connectionString: string): pg.Pool {
  const url = new URL(connectionString);
  // Keep certificate and hostname verification explicit across pg major versions.
  if (['require', 'prefer', 'verify-ca'].includes(url.searchParams.get('sslmode') ?? '')) url.searchParams.set('sslmode', 'verify-full');
  const pool = new pg.Pool({ connectionString: url.href, max: 10, connectionTimeoutMillis: 15_000, idleTimeoutMillis: 30_000, types });
  pool.on('error', () => { process.stderr.write('CORNER_DATABASE_CONNECTION_FAILED\n'); });
  return pool;
}
