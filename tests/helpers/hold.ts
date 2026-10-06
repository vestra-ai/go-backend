import type pg from 'pg';
import type { Harness } from './harness.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls every 20 ms, for at most 5 s, for a backend in this database that waits on a lock held by `blockerPid`. */
export async function observedWaiting(h: Harness, blockerPid: number): Promise<boolean> {
  for (let i = 0; i < 250; i++) {
    const r = await h.pool.query(
      `select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and $1 = any(pg_blocking_pids(pid)) limit 1`,
      [blockerPid],
    );
    if (r.rowCount) return true;
    await sleep(20);
  }
  return false;
}

/**
 * Holds a lock from a side connection (`hold` runs inside its open transaction), starts the path under test, and reports
 * whether the path was seen waiting on that connection. The side transaction then ends (`finish`) and the path is awaited.
 */
export async function holdAndObserve<T>(h: Harness, hold: (side: pg.PoolClient) => Promise<void>, start: () => Promise<T>, finish: 'commit' | 'rollback' = 'rollback') {
  const side = await h.pool.connect();
  let running: Promise<T> | undefined;
  try {
    const pid = (await side.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    await side.query('begin');
    await hold(side);
    running = start();
    const waited = await observedWaiting(h, pid);
    await side.query(finish);
    return { waited, result: await running };
  } catch (err) {
    await side.query('rollback').catch(() => {}); // never leave the side transaction holding a lock
    throw err;
  } finally {
    side.release();
    await running?.catch(() => {});
  }
}
