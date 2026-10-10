// Live notices go out with their transaction (src/db/pool.ts txContext, PgLive.publish): Postgres delivers a NOTIFY sent
// inside a transaction at its commit, in commit order, so two writes to one trip that commit back to back never interleave
// their frames. Found against production: an expense (trip_changed 18, its money line message 19) and the next one
// (22, 23) reached the app as `trip_changed 22` before `message 19`, because each notice used to go out after the
// commit, one by one, on whatever pool connection was free.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../src/context.js';
import { withTx } from '../src/db/pool.js';
import { nextSeq } from '../src/db/write-change.js';
import { createExpense } from '../src/domain/expenses.js';
import { PgLive, type LiveEvent } from '../src/live/live.js';
import { MemoryStorage } from '../src/storage/memory-storage.js';
import { freshDb } from './helpers/db.js';
import { seedTrip } from './helpers/seed.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; !ok(); ) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(10);
  }
};

/**
 * The pool as a busy production pool behaves (Supabase over the network): a query sent outside a transaction waits a
 * while for a free connection. Transactions take their own connection (`connect`), untouched.
 */
function slowPool(pool: pg.Pool, ms: number): pg.Pool {
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === 'query') return async (...args: unknown[]) => (await sleep(ms), (target.query as (...a: unknown[]) => unknown)(...args));
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

let pool: pg.Pool;
let close: () => Promise<void>;
let sender: PgLive;
let listener: PgLive;
const got: Array<{ tripId: string; event: LiveEvent }> = [];
beforeAll(async () => {
  ({ pool, close } = await freshDb());
  sender = new PgLive(slowPool(pool, 150), () => {});
  listener = new PgLive(pool, () => {});
  await listener.listen();
  listener.subscribe((tripId, event) => got.push({ tripId, event }));
});
afterAll(async () => {
  await listener.close();
  await close();
});

/** The change number a live notice is about. */
const seqOf = (e: LiveEvent) => (e.kind === 'trip' ? e.seq : e.kind === 'message' ? e.updated_seq : NaN);

/** Waits until `n` backends in this database wait on a lock (the side connection's trip row). */
async function waiting(n: number): Promise<void> {
  for (let i = 0; i < 250; i++) {
    const r = await pool.query(`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
    if (r.rows[0].n >= n) return;
    await sleep(20);
  }
  throw new Error(`never saw ${n} waiting on a lock`);
}

describe('live notices and transactions', () => {
  it('two expenses added at once on one trip: each one\'s trip_changed and money line arrive together, in commit order', async () => {
    await seedTrip(pool, 't_commit_order');
    const ctx = { pool, live: sender, storage: new MemoryStorage('https://go.example'), publicBaseUrl: 'https://go.example', spendPrivateKey: '', goContract: '1.1' } as Ctx;
    const add = (note: string) => createExpense(ctx, 't_commit_order', 'p_rahul', { amount_minor: 1000, note, category: 'food', split_person_ids: ['p_rahul', 'p_priya'] });

    // Both writes wait on the trip row held by a side connection, then go one after the other: the second waits on the
    // first's change number lock until the first commits, and commits right after it.
    const side = await pool.connect();
    let both: Promise<unknown[]> | undefined;
    try {
      await side.query('begin');
      await side.query(`select 1 from trips where trip_id = 't_commit_order' for update`);
      both = Promise.all([add('Lunch'), add('Dinner')]);
      await waiting(2);
      await side.query('commit');
      await both;
    } finally {
      await side.query('rollback').catch(() => {});
      side.release();
      await both?.catch(() => {});
    }

    await until(() => got.filter((g) => g.tripId === 't_commit_order').length === 4);
    const seqs = got.filter((g) => g.tripId === 't_commit_order').map((g) => [g.event.kind, seqOf(g.event)] as const);
    const start = seqs[0]![1];
    // Each expense: trip_changed N (the expense), then message N+1 (its money line); the second expense's after both.
    expect(seqs).toEqual([['trip', start], ['message', start + 1], ['trip', start + 2], ['message', start + 3]]);
  });

  it('a notice published in a transaction that rolls back is never delivered; one outside a transaction goes at once', async () => {
    await seedTrip(pool, 't_rollback');
    const fast = new PgLive(pool, () => {});
    await expect(
      withTx(pool, async (db) => {
        const seq = await nextSeq(db, 't_rollback');
        await fast.publish('t_rollback', { kind: 'trip', seq });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    await fast.publish('t_rollback', { kind: 'trip', seq: 999 });
    await until(() => got.some((g) => g.tripId === 't_rollback'));
    await sleep(100);
    expect(got.filter((g) => g.tripId === 't_rollback').map((g) => g.event)).toEqual([{ kind: 'trip', seq: 999 }]);
  });
});
