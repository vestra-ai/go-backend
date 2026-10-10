import { AsyncLocalStorage } from 'node:async_hooks';
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
 * The transaction the current code runs in, if any. Live notices published inside one go out with it: `PgLive` runs
 * its `pg_notify` on `db`, so Postgres delivers them at the commit, in commit order, and never on a rollback; a `Live`
 * that cannot join the transaction (the tests' in-memory one) puts its delivery in `deferred`, which runs right after
 * the commit. `open` turns false once the transaction ends, so a task started inside it that outlives it publishes on
 * its own.
 */
export interface TxStore {
  db: pg.PoolClient;
  deferred: Array<() => void | Promise<void>>;
  open: boolean;
}

export const txContext = new AsyncLocalStorage<TxStore>();

/** The transaction the caller is in, when it is still open. */
export function openTx(): TxStore | undefined {
  const store = txContext.getStore();
  return store?.open ? store : undefined;
}

/** Runs each function in order after the commit; one that fails is logged and the rest still run. */
export async function runAfterCommit(fns: Array<() => void | Promise<void>>): Promise<void> {
  for (const fn of fns) {
    try {
      await fn();
    } catch (err) {
      console.error('after-commit hook failed', err);
    }
  }
}

/**
 * Runs `work` in one transaction. Live notices published inside it are delivered at the commit (see `txContext`).
 * Functions registered with `after` run once, after the commit and the live notices, and never when the transaction
 * rolls back.
 */
export async function withTx<T>(pool: pg.Pool, work: (db: pg.PoolClient, after: AfterCommit) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  const hooks: Array<() => void | Promise<void>> = [];
  const store: TxStore = { db, deferred: [], open: true };
  let result: T;
  try {
    await db.query('begin');
    result = await txContext.run(store, () => work(db, (fn) => hooks.push(fn)));
    await db.query('commit');
  } catch (err) {
    store.open = false;
    await db.query('rollback').catch(() => {});
    throw err;
  } finally {
    store.open = false;
    db.release();
  }
  await runAfterCommit(store.deferred);
  await runAfterCommit(hooks);
  return result;
}
