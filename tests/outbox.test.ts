import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { change } from '../src/db/write-change.js';
import { OutboxSender } from '../src/outbox/sender.js';
import { SocketCallError, SocketTimeoutError } from '../src/go/go-socket.js';
import { freshDb } from './helpers/db.js';
import { seedTrip } from './helpers/seed.js';

let pool: pg.Pool;
let close: () => Promise<void>;
beforeAll(async () => ({ pool, close } = await freshDb()));
afterAll(() => close());
beforeEach(async () => {
  await pool.query('truncate outbox, trip_people, people, trips cascade');
});

/** n events for a trip, each in its own transaction like real changes (trip.created took change 1, so these are 2, 3, ...). */
async function makeEvents(tripId: string, n: number) {
  for (let i = 0; i < n; i++) await change(pool, tripId, 'message.deleted', { message_id: `m_${tripId}_${i}` });
}
const statusOf = async (tripId: string) =>
  (await pool.query('select seq, status, attempts from outbox where trip_id = $1 order by seq', [tripId])).rows;

describe('outbox sender', () => {
  it('takes consecutive change numbers per trip and sends them in order, one at a time per trip', async () => {
    await seedTrip(pool, 't_a');
    await seedTrip(pool, 't_b');
    await makeEvents('t_a', 4);
    await makeEvents('t_b', 3);
    const seen: Array<[string, number]> = [];
    const inFlight = new Set<string>();
    let overlap = false;
    const sender = new OutboxSender({
      pool,
      send: async (e) => {
        const trip = e.trip_id as string;
        if (inFlight.has(trip)) overlap = true;
        inFlight.add(trip);
        await new Promise((r) => setTimeout(r, 15));
        seen.push([trip, e.seq as number]);
        inFlight.delete(trip);
        return { accepted: true, duplicate: false };
      },
    });
    await sender.tick();
    await sender.idle();
    expect(overlap).toBe(false);
    expect(seen.filter(([t]) => t === 't_a').map(([, s]) => s)).toEqual([2, 3, 4, 5]);
    expect(seen.filter(([t]) => t === 't_b').map(([, s]) => s)).toEqual([2, 3, 4]);
    expect((await statusOf('t_a')).every((r) => r.status === 'sent')).toBe(true);
  });

  it('marks an event sent when Go says duplicate: true', async () => {
    await seedTrip(pool, 't_a');
    await makeEvents('t_a', 1);
    const sender = new OutboxSender({ pool, send: async () => ({ accepted: true, duplicate: true }) });
    await sender.tick();
    await sender.idle();
    expect((await statusOf('t_a'))[0]!.status).toBe('sent');
  });

  it('retries a timeout later and holds back only its own trip', async () => {
    await seedTrip(pool, 't_a');
    await seedTrip(pool, 't_b');
    await makeEvents('t_a', 2);
    await makeEvents('t_b', 1);
    const sent: string[] = [];
    const sender = new OutboxSender({
      pool,
      send: async (e) => {
        if (e.trip_id === 't_a') throw new SocketTimeoutError('no answer');
        sent.push(e.event_id as string);
        return { accepted: true, duplicate: false };
      },
    });
    await sender.tick();
    await sender.idle();
    const a = await statusOf('t_a');
    expect(a.map((r) => [r.status, r.attempts])).toEqual([['pending', 1], ['pending', 0]]); // change 2 waits behind change 1
    expect((await statusOf('t_b'))[0]!.status).toBe('sent');
    const { rows } = await pool.query("select extract(epoch from (next_attempt_at - now())) as s from outbox where trip_id = 't_a' and seq = 2");
    expect(Number(rows[0].s)).toBeGreaterThan(0); // the 1 second step of the schedule
    expect(Number(rows[0].s)).toBeLessThanOrEqual(1);
    expect(await sender.tick()).toEqual([]); // not due yet: nothing is sent
  });

  it('follows the schedule 1s, 5s, 30s, 2m, 10m, 10m', async () => {
    await seedTrip(pool, 't_a');
    await makeEvents('t_a', 1);
    const waits: number[] = [];
    const sender = new OutboxSender({ pool, send: async () => { throw new SocketCallError(503, 'deploy', 'unavailable'); } });
    for (let i = 0; i < 6; i++) {
      await pool.query("update outbox set next_attempt_at = now() where trip_id = 't_a'");
      await sender.tick();
      await sender.idle();
      const { rows } = await pool.query("select round(extract(epoch from (next_attempt_at - now()))) as s from outbox where trip_id = 't_a'");
      waits.push(Number(rows[0].s));
    }
    expect(waits).toEqual([1, 5, 30, 120, 600, 600]);
  });

  it('waits as long as a 429 says', async () => {
    await seedTrip(pool, 't_a');
    await makeEvents('t_a', 1);
    const sender = new OutboxSender({ pool, send: async () => { throw new SocketCallError(429, 'slow down', 'rate_limited', 30); } });
    await sender.tick();
    await sender.idle();
    const { rows } = await pool.query("select round(extract(epoch from (next_attempt_at - now()))) as s from outbox");
    expect(Number(rows[0].s)).toBe(30);
  });

  it('does not retry a 422: marks it failed and sends the trip\'s next event', async () => {
    await seedTrip(pool, 't_a');
    await makeEvents('t_a', 2);
    const sender = new OutboxSender({
      pool,
      send: async (e) => {
        if (e.seq === 2) throw new SocketCallError(422, 'data.x is wrong', 'invalid');
        return { accepted: true, duplicate: false };
      },
    });
    await sender.tick();
    await sender.idle();
    expect((await statusOf('t_a')).map((r) => r.status)).toEqual(['failed', 'sent']);
  });

  it('gives up on an event after 24 hours', async () => {
    await seedTrip(pool, 't_a');
    await makeEvents('t_a', 1);
    await pool.query("update outbox set created_at = now() - interval '25 hours'");
    const sender = new OutboxSender({ pool, send: async () => { throw new SocketTimeoutError('no answer'); } });
    await sender.tick();
    await sender.idle();
    expect((await statusOf('t_a'))[0]!.status).toBe('failed');
  });

  it('sends nothing while the socket is down and uses up no retry', async () => {
    await seedTrip(pool, 't_a');
    await makeEvents('t_a', 2);
    let up = false;
    const sent: number[] = [];
    const sender = new OutboxSender({ pool, ready: () => up, send: async (e) => (sent.push(e.seq as number), { accepted: true, duplicate: false }) });
    expect(await sender.tick()).toEqual([]);
    expect((await statusOf('t_a')).map((r) => r.attempts)).toEqual([0, 0]);
    up = true;
    await sender.tick();
    await sender.idle();
    expect(sent).toEqual([2, 3]);
  });

  it('two server instances never send the same trip at once, and send each event once', async () => {
    await seedTrip(pool, 't_a');
    await makeEvents('t_a', 12);
    const sent: number[] = [];
    let inFlight = 0;
    let overlap = false;
    const send = async (e: Record<string, unknown>) => {
      if (++inFlight > 1) overlap = true;
      await new Promise((r) => setTimeout(r, 10));
      sent.push(e.seq as number);
      inFlight--;
      return { accepted: true, duplicate: false };
    };
    const one = new OutboxSender({ pool, send }, { maxPerHold: 3 });
    const two = new OutboxSender({ pool, send }, { maxPerHold: 3 });
    for (let i = 0; i < 20; i++) {
      await Promise.all([one.tick(), two.tick()]);
      await Promise.all([one.idle(), two.idle()]);
      if (sent.length >= 12) break;
    }
    expect(overlap).toBe(false);
    expect(sent).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });
});
