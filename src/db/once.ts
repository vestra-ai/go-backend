import type pg from 'pg';
import { conflict } from '../domain/errors.js';
import { withTx, type AfterCommit } from './pool.js';

const READ = 'select answer from go_requests where trip_id = $1 and request_id = $2';

/**
 * Does a write once per (trip_id, request_id). A repeat gets the first answer back, with the same
 * ids and the same `seq`, and runs nothing: no rule, no write, no push. The answer is stored in the
 * same transaction as the change. Functions given to `after` run once, after the commit.
 */
export async function once<T extends object>(
  pool: pg.Pool,
  tripId: string,
  requestId: string,
  work: (db: pg.PoolClient, after: AfterCommit) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  const hooks: Array<() => void | Promise<void>> = [];
  try {
    await db.query('begin');
    const seen = await db.query(READ, [tripId, requestId]);
    if (seen.rows.length > 0) {
      await db.query('rollback');
      return seen.rows[0].answer as T;
    }
    const answer = await work(db, (fn) => hooks.push(fn));
    await db.query('insert into go_requests (trip_id, request_id, answer) values ($1, $2, $3)', [tripId, requestId, JSON.stringify(answer)]);
    await db.query('commit');
    for (const hook of hooks) await Promise.resolve(hook()).catch((err) => console.error('after-commit hook failed', err));
    return answer;
  } catch (err) {
    await db.query('rollback').catch(() => {});
    // Two copies arrived at the same moment and the other one committed first. Whatever stopped this copy (the
    // unique index, or a rule the first copy's write now trips, such as "approval already used"), the request
    // was already done: answer with its first answer, never with a fresh error.
    const first = await pool.query(READ, [tripId, requestId]).catch(() => null);
    if (first && first.rows.length > 0) return first.rows[0].answer as T;
    // A different request for the same thing (the same reaction, the same card id) committed first: the unique
    // index refused this one. That is a conflict with what is there now, not our failure.
    if ((err as { code?: string }).code === '23505') throw conflict(`already exists: ${(err as { constraint?: string }).constraint ?? 'duplicate'}`);
    throw err;
  } finally {
    db.release();
  }
}

/**
 * `once` when the caller has a repeat key (the app's `client_id` press key), a plain transaction when it has none: the
 * app's writes without a press key are covered by the Idempotency-Key header instead (src/api/idempotency.ts).
 */
export function onceIfKeyed<T extends object>(pool: pg.Pool, tripId: string, key: string | undefined | '', work: (db: pg.PoolClient, after: AfterCommit) => Promise<T>): Promise<T> {
  return key ? once(pool, tripId, key, work) : withTx(pool, work);
}
