import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDueVotes } from '../src/jobs/votes.js';
import { appApi } from './helpers/app-api.js';
import { cancelFlow } from './helpers/cancel-flow.js';
import { startHarness, type Harness } from './helpers/harness.js';
import { seedTrip } from './helpers/seed.js';

// Lock order, always: person row, vote rows, booking rows, then the trip's change number. Each case below holds the
// booking's row from a side connection, starts one path that can close a vote about that booking, and checks that the
// path waits for the booking BEFORE it has taken the trip's change number: a third connection tries the trip row with
// `for no key update nowait` (the strength a change number takes) and must get it.
let h: Harness;
let t: ReturnType<typeof appApi>;
let f: ReturnType<typeof cancelFlow>;
beforeAll(async () => {
  h = await startHarness();
  t = appApi(h);
  f = cancelFlow(h, t);
  for (const trip of ['t_l10', 't_l11', 't_l12', 't_l13']) await seedTrip(h.pool, trip);
});
afterAll(() => h.stop());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls every 20 ms, for at most 5 s, for a backend in this database that is waiting on a lock and is blocked by the side connection. */
async function observedWaiting(sidePid: number): Promise<boolean> {
  for (let i = 0; i < 250; i++) {
    const r = await h.pool.query(
      `select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and $1 = any(pg_blocking_pids(pid)) limit 1`,
      [sidePid],
    );
    if (r.rowCount) return true;
    await sleep(20);
  }
  return false;
}

/** True when the trip row can be locked right now at the strength a change number takes. */
async function tripFree(tripId: string): Promise<boolean> {
  const c = await h.pool.connect();
  try {
    await c.query('begin');
    await c.query('select 1 from trips where trip_id = $1 for no key update nowait', [tripId]);
    return true;
  } catch {
    return false;
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }
}

/** Holds the booking, starts the path, and reports whether it was seen waiting and whether the trip row was still free while it waited. */
async function holdAndObserve<T>(tripId: string, bookingId: string, start: () => Promise<T>) {
  const side = await h.pool.connect();
  const sidePid = (await side.query('select pg_backend_pid() as pid')).rows[0].pid as number;
  await side.query('begin');
  await side.query('select 1 from bookings where booking_id = $1 for update', [bookingId]);
  const running = start();
  const waited = await observedWaiting(sidePid);
  const free = waited ? await tripFree(tripId) : false;
  await side.query('rollback');
  side.release();
  await running;
  return { waited, free };
}

/** A cancellation vote that will pass: three "Cancel" votes are in the table already. Returns the booking and the vote. */
async function passingVote(trip: string, cast: Array<[string, number]>) {
  const bid = await f.addBooking(trip);
  const did = (await f.propose(bid, trip)).body.decision_id as string;
  await f.preCast(did, cast);
  return { bid, did };
}

describe('lock order for closing a vote about a booking', () => {
  it('a vote-completing castVote waits for the booking before it takes a change number', async () => {
    const { bid, did } = await passingVote('t_l10', [['p_rahul', 0], ['p_priya', 0], ['p_arjun', 0], ['p_meher', 1]]);
    const seen = await holdAndObserve('t_l10', bid, () => f.castVote(did, 'p_kabir', 0, 't_l10'));
    expect([seen, await f.bookingStatus(bid)]).toEqual([{ waited: true, free: true }, 'cancelled']);
  });

  it('a vote-completing leaveTrip waits for the booking before it takes a change number', async () => {
    const { bid } = await passingVote('t_l11', [['p_rahul', 0], ['p_priya', 0], ['p_arjun', 0], ['p_meher', 1]]);
    const seen = await holdAndObserve('t_l11', bid, () => t.api(t.as('p_kabir'), 'POST', '/app/v1/trips/t_l11/leave'));
    expect([seen, await f.bookingStatus(bid)]).toEqual([{ waited: true, free: true }, 'cancelled']);
  });

  it('the closing code itself waits for the booking before it takes a change number, whether a person, the timer or Go closes the vote', async () => {
    const three: Array<[string, number]> = [['p_rahul', 0], ['p_priya', 0], ['p_arjun', 0]];
    const byPerson = await passingVote('t_l12', three);
    const person = await holdAndObserve('t_l12', byPerson.bid, () => f.closeEarly(byPerson.did, 't_l12'));
    expect([person, await f.bookingStatus(byPerson.bid)]).toEqual([{ waited: true, free: true }, 'cancelled']);
    const byTimer = await passingVote('t_l12', three);
    await h.pool.query(`update decisions set closes_at = now() - interval '1 minute' where decision_id = $1`, [byTimer.did]);
    const timer = await holdAndObserve('t_l12', byTimer.bid, () => closeDueVotes(h.ctx));
    expect([timer, await f.bookingStatus(byTimer.bid)]).toEqual([{ waited: true, free: true }, 'cancelled']);
    const byGo = await passingVote('t_l12', three);
    const go = await holdAndObserve('t_l12', byGo.bid, () => h.go.call('close_vote', { request_id: `rq_lock_${f.next()}`, trip_id: 't_l12', decision_id: byGo.did }));
    expect([go, await f.bookingStatus(byGo.bid)]).toEqual([{ waited: true, free: true }, 'cancelled']);
  });

  it('a vote-completing castVote raced against Go\'s update_booking, repeated, never deadlocks: both complete every time', async () => {
    const problems: string[] = [];
    for (let i = 0; i < 8; i++) {
      const { bid, did } = await passingVote('t_l13', [['p_rahul', 0], ['p_priya', 0], ['p_arjun', 0], ['p_meher', 1]]);
      const [vote, goUpdate] = await Promise.all([
        f.castVote(did, 'p_kabir', 0, 't_l13'),
        h.go.call('update_booking', { request_id: `rq_race_${i}_${f.next()}`, trip_id: 't_l13', booking_id: bid, ref: `REF-${i}` }),
      ]);
      if (vote.status !== 200) problems.push(`round ${i}: vote ${vote.status} ${JSON.stringify(vote.body)}`);
      if (goUpdate.error && goUpdate.error.code !== 409) problems.push(`round ${i}: Go's update ${JSON.stringify(goUpdate.error)}`); // 409: the vote cancelled it first
    }
    expect(problems).toEqual([]);
  });
});
