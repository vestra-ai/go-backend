import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatMoney } from '../src/domain/actions.js';
import { appApi } from './helpers/app-api.js';
import { cancelFlow } from './helpers/cancel-flow.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';
import { seedTrip } from './helpers/seed.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
let f: ReturnType<typeof cancelFlow>;
beforeAll(async () => {
  h = await startHarness(); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
  f = cancelFlow(h, t);
  for (const trip of ['t_leave', 't_yen']) await seedTrip(h.pool, trip);
  await h.pool.query(`update trips set currency = 'JPY' where trip_id = 't_yen'`);
});
afterAll(() => h.stop());

const refusal = (r: { status: number; body: any }) => [r.status, r.body?.error?.code];
const goEvents = (trip: string) => h.go.events.filter((e) => e.trip_id === trip);

describe('the app can tell a cancellation vote from an ordinary one; Go cannot', () => {
  it('marks the vote with the booking it is about in the app\'s trip read and needs-you strip, and nowhere else', async () => {
    const bid = await f.addBooking('t_goa', { title: 'Villa Sol' });
    const cancel = (await f.propose(bid)).body.decision_id as string;
    const ordinary = (await t.api(t.as('p_priya'), 'POST', '/app/v1/trips/t_goa/decisions', { client_id: 'plain', question: 'Where to eat?', kind: 'yesno', anonymous: false, options: [{ label: 'Yes' }, { label: 'No' }] })).body.decision.decision_id as string;
    const trip = (await t.api(t.as('p_kabir'), 'GET', '/app/v1/trips/t_goa')).body;
    const marks = Object.fromEntries(trip.decisions.map((d: any) => [d.decision_id, d.cancels_booking_id]));
    const strip = (await t.api(t.as('p_kabir'), 'GET', '/app/v1/trips/t_goa/needs-you')).body.items.filter((x: any) => x.kind === 'vote');
    const item = (id: string) => strip.find((x: any) => x.target.decision_id === id);
    expect([marks[cancel], 'cancels_booking_id' in trip.decisions.find((d: any) => d.decision_id === ordinary), item(cancel).target.cancels_booking_id, 'cancels_booking_id' in item(ordinary).target]).toEqual([bid, false, bid, false]);
    await h.flush();
    const goSees = JSON.stringify([h.go.events, (await h.go.call('read_trip', { trip_id: 't_goa' })).result]); // the events and the read Go gets
    expect(goSees.includes('cancels_booking')).toBe(false);
  });
});

describe('leaving a trip', () => {
  it('sends the departure and then, only if the leaver had a budget answer, the moved band naming nobody (the first event is the answer being set; the last person.left is the leaver with no answer: no budget event follows)', async () => {
    await t.api(t.as('p_kabir'), 'PUT', '/app/v1/trips/t_leave/me/budget', { min_minor: 1234500, max_minor: 2345600 });
    await t.api(t.as('p_kabir'), 'POST', '/app/v1/trips/t_leave/leave');
    await t.api(t.as('p_meher'), 'POST', '/app/v1/trips/t_leave/leave'); // never answered
    await h.flush();
    const after = goEvents('t_leave').map((e) => [e.seq, e.type, e.data]);
    const left = after.filter((e) => e[1] === 'person.left' || (e[1] === 'trip.updated' && e[2].by.kind === 'system'));
    const snap = (await h.go.call('read_trip', { trip_id: 't_leave' })).result;
    expect([left.map((e) => e[1]), left[2]![0] === left[1]![0] + 1, left[2]![2], /1234500|2345600|p_kabir/.test(JSON.stringify(left[2]![2])), snap.budget.answered]).toEqual([['trip.updated', 'person.left', 'trip.updated', 'person.left'], true, { by: { kind: 'system' }, changed: ['budget'] }, false, 0]);
  });
});

describe('dates and itinerary sizes Postgres or a frame could not take', () => {
  it('Go\'s update_trip refuses a year-0000 date and an oversized itinerary with 422, writes nothing, and accepts year 1 and the size limit', async () => {
    const call = (params: Record<string, unknown>) => h.go.call('update_trip', { request_id: `rq_${Math.random()}`, trip_id: 't_goa', ...params });
    const before = (await rows(h.pool, `select seq from trips where trip_id = 't_goa'`))[0].seq;
    const zero = await call({ dates: { start: '0000-01-01', end: '0000-01-02' } });
    const pad = (n: number) => [{ date: '2026-11-07', items: [], pad: 'x'.repeat(n) }];
    const base = Buffer.byteLength(JSON.stringify(pad(0)));
    const over = await call({ itinerary: pad(262_144 - base + 1) });
    expect([zero.error?.code, zero.error?.data?.code, over.error?.code, (await rows(h.pool, `select seq from trips where trip_id = 't_goa'`))[0].seq === before]).toEqual([422, 'invalid', 422, true]);
    const ok = await call({ dates: { start: '0001-01-01', end: '0001-01-02' }, itinerary: pad(262_144 - base) });
    expect([ok.error, (await rows(h.pool, `select dates_start, dates_end from trips where trip_id = 't_goa'`))[0]]).toEqual([undefined, { dates_start: '0001-01-01', dates_end: '0001-01-02' }]);
  });

  it('creating a trip refuses a year-0000 date, a date that does not exist, and dates the wrong way round, all with 422', async () => {
    const create = (dates: unknown) => t.api(t.as('p_rahul'), 'POST', '/app/v1/trips', { title: 'Dates', dates });
    expect(refusal(await create({ start: '0000-01-01', end: '0000-01-02' }))).toEqual([422, 'invalid']);
    expect(refusal(await create({ start: '2026-02-30', end: '2026-03-02' }))).toEqual([422, 'invalid']);
    expect(refusal(await create({ start: '2026-11-09', end: '2026-11-06' }))).toEqual([422, 'invalid']);
    expect((await create({ start: '2026-11-06', end: '2026-11-09' })).status).toBe(201);
  });

  it('creating a trip also refuses a start that is not text and a valid start with an end date that does not exist', async () => {
    const create = (dates: unknown) => t.api(t.as('p_rahul'), 'POST', '/app/v1/trips', { title: 'Dates', dates });
    expect(refusal(await create({ start: ['2026-11-06'], end: ['2026-11-09'] }))).toEqual([422, 'invalid']);
    expect(refusal(await create({ start: '2026-02-01', end: '2026-02-30' }))).toEqual([422, 'invalid']);
  });
});

describe('amounts in notifications', () => {
  it('are written in the currency\'s own units: rupees as before, yen without a fraction, dinars with three digits', async () => {
    expect([formatMoney(113334, 'INR'), formatMoney(68000, 'INR'), formatMoney(5000, 'JPY'), formatMoney(5000, 'KWD'), formatMoney(5001, 'KWD')].map((x) => x.replace(/\u00a0/g, ' '))).toEqual(['₹1,133.34', '₹680', 'JP¥5,000', 'KWD 5', 'KWD 5.001']);
    await t.api(t.as('p_rahul'), 'POST', '/app/v1/trips/t_yen/expenses', { paid_by_person_id: 'p_rahul', amount_minor: 5000, note: 'Ramen', category: 'food', split_person_ids: ['p_rahul', 'p_priya'] });
    const before = h.push.sent.length;
    await t.api(t.as('p_rahul'), 'POST', '/app/v1/trips/t_yen/transfers/nudge', { from_person_id: 'p_priya' });
    expect(h.push.sent.slice(before).map((s) => s.n.body)).toEqual(['Rahul reminded you: you owe JP¥2,500']);
  });
});
