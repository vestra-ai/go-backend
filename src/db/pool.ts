import { readFileSync } from 'node:fs';
import pg from 'pg';

// numeric columns we use (bigint seq, money) are far below 2^53: read them as numbers.
pg.types.setTypeParser(20, (v) => Number(v));
// date columns stay 'YYYY-MM-DD' strings, as in the contract.
pg.types.setTypeParser(1082, (v) => v);

export type Db = pg.Pool | pg.PoolClient;

/**
 * A pool for DATABASE_URL. Supabase (and any URL with sslmode) gets TLS: verified against `caCertPath` when given
 * (Supabase's own CA, from Database settings → SSL), otherwise encrypted without checking the certificate, with a
 * warning. Local Postgres (tests, the dev stack) stays plain.
 */
export function createPool(connectionString: string, max = 30, caCertPath?: string): pg.Pool {
  const url = new URL(connectionString);
  const wantsTls = /\.supabase\.(co|com)$/i.test(url.hostname) || (url.searchParams.has('sslmode') && url.searchParams.get('sslmode') !== 'disable') || !!caCertPath;
  if (!wantsTls) return new pg.Pool({ connectionString, max });
  // An sslmode in the URL would replace the ssl settings below, so the URL goes without it.
  url.searchParams.delete('sslmode');
  if (!caCertPath) console.warn('[db] TLS without a CA certificate: set DATABASE_CA_CERT to check the database is really Supabase');
  const ssl = caCertPath ? { ca: readFileSync(caCertPath, 'utf8'), rejectUnauthorized: true } : { rejectUnauthorized: false };
  return new pg.Pool({ connectionString: url.toString(), max, ssl });
}

export type AfterCommit = (fn: () => void | Promise<void>) => void;

/**
 * Runs `work` in one transaction. Functions registered with `after` run once, after the commit
 * (live updates and pushes), and never when the transaction rolls back.
 */
export async function withTx<T>(pool: pg.Pool, work: (db: pg.PoolClient, after: AfterCommit) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  const hooks: Array<() => void | Promise<void>> = [];
  let result: T;
  try {
    await db.query('begin');
    result = await work(db, (fn) => hooks.push(fn));
    await db.query('commit');
  } catch (err) {
    await db.query('rollback').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
  for (const hook of hooks) {
    try {
      await hook();
    } catch (err) {
      console.error('after-commit hook failed', err);
    }
  }
  return result;
}
