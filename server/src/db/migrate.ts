import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, pool } from './pool.js';
import { logger } from '../lib/logger.js';
import { isMain } from '../lib/isMain.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Applies every .sql file in migrations/ exactly once, in filename order.
 * Each migration runs in its own transaction, so a failure leaves no half-applied schema.
 */
export async function migrate(): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query<{ name: string }>(
    'SELECT name FROM schema_migrations',
  );
  const applied = new Set(rows.map((r) => r.name));
  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      ran.push(file);
      logger.info({ migration: file }, 'migration applied');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error({ err, migration: file }, 'migration failed');
      throw err;
    } finally {
      client.release();
    }
  }

  if (ran.length === 0) logger.info('schema up to date');
  return ran;
}

// `npm run migrate`
if (isMain(import.meta.url)) {
  migrate()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'migrate failed');
      process.exit(1);
    });
}
