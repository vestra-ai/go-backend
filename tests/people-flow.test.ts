import { afterAll, beforeAll, expect, it } from 'vitest';
import { check } from '../src/contract/index.js';
import { appApi } from './helpers/app-api.js';
import { EVERYONE } from './helpers/cancel-flow.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';

const PWA = 'https://pwa.example';
let h: Harness;
beforeAll(async () => (h = await startHarness({ origins: [PWA] })));
afterAll(() => h.stop());

it('one journey from the web app\'s origin: decide a vote, add a booking against it, update it, then the group cancels it; every change took the next number with one valid event, and Go\'s trip read matches', async () => {
  const t = appApi(h);
  const answers: Array<{ status: number; headers: Record<string, any> }> = [];
  const call = async (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) => {
    const r = await t.api(t.as(who), method, url, body, { origin: PWA });
    answers.push(r);
    return r;
  };
  const opened = await call('p_priya', 'POST', '/app/trips/t_goa/decisions', {
    client_id: 'v1', question: 'Where do we stay?', kind: 'choice', anonymous: false, options: [{ label: 'Villa Sol', price_minor: 5420000 }, { label: 'Casa Azul', price_minor: 6180000 }],
  });
  for (const who of EVERYONE) await call(who, 'POST', `/app/trips/t_goa/decisions/${opened.body.decision_id}/vote`, { option_index: 0 });
  const booked = await call('p_arjun', 'POST', '/app/trips/t_goa/bookings', {
    client_id: 'b1', kind: 'stay', title: 'Villa Sol, 3 nights', vendor: 'ixigo', ref: 'IXG-1', amount_minor: 5420000, payer_person_id: 'p_rahul', for_person_ids: EVERYONE, decision_id: opened.body.decision_id,
  });
  await call('p_meher', 'PATCH', `/app/trips/t_goa/bookings/${booked.body.booking_id}`, { ref: 'IXG-2', starts_at: '2026-11-06T08:00:00Z' });
  const proposed = await call('p_priya', 'POST', `/app/trips/t_goa/bookings/${booked.body.booking_id}/cancel-vote`, { client_id: 'c1' });
  for (const who of ['p_rahul', 'p_priya', 'p_arjun']) await call(who, 'POST', `/app/trips/t_goa/decisions/${proposed.body.decision_id}/vote`, { option_index: 0 });
  await call('p_kabir', 'POST', `/app/trips/t_goa/decisions/${proposed.body.decision_id}/close`);
  await h.flush();

  const events = await rows(h.pool, 'select body from outbox where trip_id = $1 order by seq', ['t_goa']);
  const bodies = events.map((r) => r.body);
  const snap = (await h.go.call('read_trip', { trip_id: 't_goa' })).result;
  expect(answers.map((a, i) => (a.status < 300 && a.headers['access-control-allow-origin'] === PWA ? null : `call ${i}: ${a.status}`)).filter(Boolean)).toEqual([]); // every call succeeded and carried the origin's headers
  expect(bodies.map((e) => e.seq)).toEqual(Array.from({ length: bodies.length }, (_, i) => i + 2)); // trip.created took 1 (seeded); then 2, 3, 4... with no gap and no repeat
  expect(bodies.map((e) => check('Event', e).ok).every(Boolean)).toBe(true);
  expect(bodies.map((e) => e.type + (e.data.change ? `:${e.data.change}` : ''))).toEqual([
    'decision.opened', ...Array(5).fill('decision.voted'), 'decision.closed', 'record.changed:added', // the first vote and its decided line
    'booking.changed:added', 'record.changed:updated', // the booking, and the decided line becoming the booked line
    'booking.changed:updated', // the reference and start time
    'decision.opened', ...Array(3).fill('decision.voted'), 'decision.closed', 'booking.changed:cancelled', 'record.changed:added', // the cancellation vote, passing
  ]);
  expect([check('TripSnapshot', snap).ok, snap.seq, snap.bookings[0].status, snap.bookings[0].ref, snap.bookings[0].starts_at]).toEqual([true, bodies.at(-1)!.seq, 'cancelled', 'IXG-2', '2026-11-06T08:00:00.000Z']);
  expect(JSON.stringify(snap)).not.toContain('cancels_booking');
});
