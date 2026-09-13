import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// Money columns come back as strings from node-postgres by default (numeric = OID 1700).
// Keep it that way and convert deliberately: silent float rounding on money is unacceptable.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);
// bigserial ids fit comfortably in a JS number for this workload.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'mpesa-tally',
});

pool.on('error', (err) => {
  logger.error({ err }, 'idle postgres client error');
});

export type Sql = pg.Pool | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  client: Sql = pool,
): Promise<T[]> {
  const res = await client.query<T>(sql, params as never[]);
  return res.rows;
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  client: Sql = pool,
): Promise<T | undefined> {
  const rows = await query<T>(sql, params, client);
  return rows[0];
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Postgres advisory lock keyed by an arbitrary string, held for the callback only.
 * Used to serialise matching per tenant so two workers cannot both claim an invoice.
 */
export async function withAdvisoryLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
    return await fn();
  } finally {
    await client
      .query('SELECT pg_advisory_unlock(hashtext($1))', [key])
      .catch(() => {});
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
