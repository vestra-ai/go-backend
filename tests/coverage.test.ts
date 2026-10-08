// Contract rules the review found working but untested (docs/REVIEW.md): each is now proved here.
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RECONNECT_BACKOFF_SECONDS } from '../src/contract/index.js';
import { change } from '../src/db/write-change.js';
import { GoSocket, SocketCallError } from '../src/go/go-socket.js';
import { PgLive, type LiveEvent } from '../src/live/live.js';
import { OutboxSender } from '../src/outbox/sender.js';
import { freshDb } from './helpers/db.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';
import { MockGo } from './helpers/mock-go.js';
import { seedTrip } from './helpers/seed.js';

const freePort = () => new Promise<number>((resolve) => { const s = createServer(); s.listen(0, () => { const p = (s.address() as any).port; s.close(() => resolve(p)); }); });
const until = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('the socket\'s reconnect schedule (guide: "Keeping it alive")', () => {
  it('waits 1, 2, 5, 10, then 30 seconds between tries, and keeps trying every 30 seconds', async () => {
    expect(RECONNECT_BACKOFF_SECONDS).toEqual([1, 2, 5, 10, 30]);
    const port = await freePort(); // nothing listens here: every try fails at once
    const real = globalThis.setTimeout;
    const waits: number[] = [];
    // Record each reconnect wait, then run it straight away, so seven tries take milliseconds instead of minutes.
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms && ms >= 1000 && ms <= 30_000 && ms % 1000 === 0) {
        waits.push(ms / 1000);
        return real(fn, 0);
      }
      return real(fn, ms);
    }) as typeof setTimeout);
    const socket = new GoSocket({ url: `ws://127.0.0.1:${port}/v1/socket?instance=t`, secret: 's', handlers: {}, log: () => {} });
    try {
      socket.start();
      await until(() => waits.length >= 7);
    } finally {
      socket.stop();
      spy.mockRestore();
    }
    expect(waits.slice(0, 7)).toEqual([1, 2, 5, 10, 30, 30, 30]);
  });

  it('after a good connect the next wait starts again at 1 second', async () => {
    const go = new MockGo();
    const base = await go.listen();
    const real = globalThis.setTimeout;
    const waits: number[] = [];
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms && [1000, 2000, 5000, 10_000, 30_000].includes(ms)) waits.push(ms / 1000);
      return real(fn, ms);
    }) as typeof setTimeout);
    const socket = new GoSocket({ url: `${base}/v1/socket?instance=t`, secret: go.secret, handlers: {}, log: () => {} });
    try {
      socket.start();
      await go.untilConnected();
      for (let i = 0; i < 2; i++) {
        go.dropSockets();
        await until(() => !socket.connected);
        await until(() => socket.connected, 5000);
      }
    } finally {
      socket.stop();
      spy.mockRestore();
      await go.close();
    }
    expect(waits).toEqual([1, 1]); // not 1 then 2: each good connect resets the schedule
    expect(go.targets).toHaveLength(3); // three connects, each with its own fresh signature
  });
});

describe('the outbox retry schedule (guide: "Sending events reliably")', () => {
  let pool: Awaited<ReturnType<typeof freshDb>>['pool'];
  let close: () => Promise<void>;
  beforeAll(async () => ({ pool, close } = await freshDb()));
  afterAll(() => close());

  it('a 429 without retry_after_seconds falls back to the schedule: first retry after 1 second', async () => {
    await seedTrip(pool, 't_429');
    await change(pool, 't_429', 'message.deleted', { message_id: 'm_x' });
    const sender = new OutboxSender({ pool, send: async () => { throw new SocketCallError(429, 'slow down', 'rate_limited'); } });
    await sender.tick();
    await sender.idle();
    const [r] = await rows(pool, "select status, attempts, round(extract(epoch from (next_attempt_at - now()))) as s from outbox where trip_id = 't_429'");
    expect(r).toMatchObject({ status: 'pending', attempts: 1 });
    expect(Number(r.s)).toBe(1);
  });

  it('live updates reach a second instance, and keep coming after the LISTEN connection is cut', async () => {
    const a = new PgLive(pool, () => {});
    const b = new PgLive(pool, () => {});
    await b.listen();
    const got: Array<[string, LiveEvent]> = [];
    b.subscribe((trip, e) => got.push([trip, e]));
    await a.publish('t_live', { kind: 'trip', seq: 7 });
    await until(() => got.length === 1);
    expect(got[0]).toEqual(['t_live', { kind: 'trip', seq: 7 }]);
    // A database restart or a network blip ends the listening connection: it must listen again on its own.
    await pool.query("select pg_terminate_backend(pid) from pg_stat_activity where query = 'listen go_live'");
    await new Promise((r) => setTimeout(r, 1500)); // the first wait to listen again is 1 second
    await a.publish('t_live', { kind: 'trip', seq: 8 });
    await until(() => got.length === 2, 5000);
    expect(got[1]).toEqual(['t_live', { kind: 'trip', seq: 8 }]);
    await b.close();
  }, 10_000);
});

describe('events and errors not covered elsewhere', () => {
  let h: Harness;
  beforeAll(async () => (h = await startHarness()));
  afterAll(() => h.stop());
  let n = 0;
  const call = (method: string, params: Record<string, unknown>) => h.go.call(method, { request_id: `rq_cov_${++n}`, trip_id: 't_goa', ...params });
  // Seeded people sign in through the fake Supabase Auth, as the app does.
  const auth = async (id: string) => ({ authorization: `Bearer ${await h.token(id)}` });

  it('the organizer closing a vote early sends decision.closed with reason closed_by_person; a member who did not open it may not', async () => {
    const o = (await call('open_vote', { question: 'Brunch?', kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }] })).result;
    await h.pool.query("insert into votes (decision_id, person_id, option_index) values ($1, 'p_rahul', 1)", [o.decision_id]);
    expect((await h.app.inject({ method: 'POST', url: `/app/v1/trips/t_goa/decisions/${o.decision_id}/close`, headers: await auth('p_priya') })).statusCode).toBe(403);
    const r = await h.app.inject({ method: 'POST', url: `/app/v1/trips/t_goa/decisions/${o.decision_id}/close`, headers: await auth('p_rahul') });
    expect(r.statusCode).toBe(200);
    await h.flush();
    expect(h.go.events.find((e) => e.type === 'decision.closed' && e.data.decision.decision_id === o.decision_id)!.data).toMatchObject({ reason: 'closed_by_person', decision: { result_index: 1 } });
  });

  it('update_booking without cancelling sends booking.changed with change updated', async () => {
    const b = (await call('add_booking', { kind: 'cab', title: 'Cab', vendor: 'Kabir', ref: 'c1', amount_minor: 100000, currency: 'INR', payer_person_id: 'p_kabir', for_person_ids: ['p_kabir'] })).result;
    await call('update_booking', { booking_id: b.booking_id, ref: 'c2' });
    await h.flush();
    expect(h.go.events.filter((e) => e.type === 'booking.changed').at(-1)!.data).toMatchObject({ change: 'updated', by: { kind: 'go' }, booking: { booking_id: b.booking_id, ref: 'c2' } });
  });

  it('set_mandate on a vote that does not exist is 404', async () => {
    expect((await call('set_mandate', { decision_id: 'd_nope', choice_index: 0, cap_minor: 100, currency: 'INR', refundable_only: false, payer_person_id: 'p_rahul' })).error).toMatchObject({ code: 404 });
  });

  it('Go\'s own reaction removed sends reaction.removed with no person', async () => {
    const m = (await call('post_message', { text: 'note' })).result;
    await call('add_reaction', { message_id: m.message_id, emoji: '👀' });
    await call('remove_reaction', { message_id: m.message_id, emoji: '👀' });
    await h.flush();
    expect(h.go.events.filter((e) => e.type === 'reaction.removed').at(-1)!.data).toEqual({ message_id: m.message_id, reaction: { emoji: '👀' } });
  });

  // A person's typing travels on the live socket (tests/live-ws.test.ts), never to Go.
});
