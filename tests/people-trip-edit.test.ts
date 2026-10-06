import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check } from '../src/contract/index.js';
import { appApi } from './helpers/app-api.js';
import { holdAndObserve } from './helpers/hold.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';
import { seedTrip } from './helpers/seed.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness(); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir; Nov 6 to 9
  t = appApi(h);
  await seedTrip(h.pool, 't_other', [{ id: 'p_orgx', name: 'Orgx', role: 'organizer' }]);
  await h.pool.query(`insert into bookings (booking_id, trip_id, kind, title, vendor, ref, amount_minor, currency, payer_person_id) values ('b_elsewhere', 't_other', 'stay', 'Villa', 'V', 'R', 1, 'INR', 'p_orgx')`);
});
afterAll(() => h.stop());

const priya = () => t.as('p_priya'); // not the organizer
const patch = (body: unknown, who: any = priya()) => t.api(who, 'PATCH', '/app/trips/t_goa', body);
const refusal = (r: { status: number; body: any }) => [r.status, r.body?.error?.code];
const personEdits = () => t.events('trip.updated').filter((e) => e.data.by.kind === 'person');

describe('a trip\'s details and status', () => {
  it('a member who is not the organizer changes title, dates and status in any direction; only what differs is listed; the same values change nothing', async () => {
    const first = await patch({ title: 'Goa again', status: 'booked' });
    const second = await patch({ status: 'planning', dates: { start: '2026-11-07', end: '2026-11-10' } }); // status moves backwards
    const same = await patch({ title: 'Goa again', status: 'planning', dates: { start: '2026-11-07', end: '2026-11-10' } });
    await h.flush();
    expect([first.status, second.status, same.body.seq]).toEqual([200, 200, null]);
    expect(personEdits().map((e) => [e.data.by.person_id, e.data.changed])).toEqual([['p_priya', ['title', 'status']], ['p_priya', ['dates', 'status']]]);
    expect(refusal(await patch({ title: 'x' }, null))).toEqual([401, 'unauthorized']);
    expect(refusal(await patch({ title: 'x' }, t.as('p_stranger')))).toEqual([403, 'forbidden']);
  });

  it('an itinerary Go wrote with an extra field, saved back with its keys in another order, is stored unchanged and sends nothing; reordering two days does send; refuses another trip\'s booking, reversed dates and an unknown field', async () => {
    const day1 = { date: '2026-11-07', title: 'Arrival', items: [{ title: 'Check in', category: 'stay', status: 'planned', time: '14:00', custom: { a: 1, b: [2, 3] } }] };
    const day2 = { date: '2026-11-08', items: [{ title: 'Beach', category: 'activities', status: 'idea' }] };
    await h.go.call('update_trip', { request_id: 'rq_it1', trip_id: 't_goa', itinerary: [day1, day2] });
    const before = (await rows(h.pool, `select itinerary from trips where trip_id = 't_goa'`))[0].itinerary;
    const reordered = [{ items: [{ custom: { b: [2, 3], a: 1 }, time: '14:00', status: 'planned', category: 'stay', title: 'Check in' }], title: 'Arrival', date: '2026-11-07' }, day2];
    const sameValues = await patch({ itinerary: reordered });
    const swapped = await patch({ itinerary: [day2, day1] });
    await h.flush();
    const after = (await rows(h.pool, `select itinerary from trips where trip_id = 't_goa'`))[0].itinerary;
    expect([sameValues.body.seq, typeof swapped.body.seq, before[0].items[0].custom, after[1].items[0].custom]).toEqual([null, 'number', { a: 1, b: [2, 3] }, { a: 1, b: [2, 3] }]); // Go's extra field was there, and survived the swap
    expect(personEdits().at(-1)!.data.changed).toEqual(['itinerary']);
    const foreign = { date: '2026-11-07', items: [{ title: 'Villa', category: 'stay', status: 'booked', booking_id: 'b_elsewhere' }] };
    expect(refusal(await patch({ itinerary: [foreign] }))).toEqual([422, 'invalid']);
    expect(refusal(await patch({ dates: { start: '2026-11-10', end: '2026-11-07' } }))).toEqual([422, 'invalid']);
    expect(refusal(await patch({ title: 'x', extra: 1 }))).toEqual([422, 'invalid']);
  });

  it('refuses a day or item that breaks the contract, a __proto__ key that would skip that check, and a date in year 0000, all with 422', async () => {
    const raw = (payload: string) => h.app.inject({ method: 'PATCH', url: '/app/trips/t_goa', headers: { authorization: `Bearer ${priya().token}`, 'content-type': 'application/json' }, payload });
    const code = async (payload: string) => (await raw(payload)).statusCode;
    expect(await code(JSON.stringify({ itinerary: [{ date: '2026-11-07', items: [{ title: 'x', category: 'spa', status: 'idea' }] }] }))).toBe(422); // not a category
    expect(await code('{"itinerary":[{"__proto__":{"date":"2026-11-07","items":[]}}]}')).toBe(422); // a day that would pass by inheritance
    expect(await code('{"dates":{"start":"0000-01-01","end":"0000-01-02"}}')).toBe(422); // the database has no year 0
    expect((await rows(h.pool, `select itinerary from trips where trip_id = 't_goa'`))[0].itinerary).not.toEqual([{ date: '2026-11-07', items: [{ title: 'x', category: 'spa', status: 'idea' }] }]);
    expect(check('Day', JSON.parse('{"__proto__":{"date":"2026-11-07","items":[]}}')).ok).toBe(false); // the contract check itself, on its own (it also guards Go's requests)
  });

  it('free-form itinerary fields cannot smuggle in what the database cannot store or a body nested too deeply to handle', async () => {
    const deep = (levels: number) => ({ date: '2026-11-07', items: [], note: JSON.parse('['.repeat(levels) + ']'.repeat(levels)) });
    expect(refusal(await patch({ itinerary: [{ date: '2026-11-07', items: [], note: 'a\u0000b' }] }))).toEqual([422, 'invalid']);
    expect(refusal(await patch({ itinerary: [deep(100)] }))).toEqual([422, 'invalid']);
    const raw = await h.app.inject({ method: 'PATCH', url: '/app/trips/t_goa', headers: { authorization: `Bearer ${priya().token}`, 'content-type': 'application/json' }, payload: `{"itinerary":[{"date":"2026-11-07","items":[],"note":${'['.repeat(20000)}${']'.repeat(20000)}}]}` });
    expect(raw.statusCode).toBeLessThan(500); // refused (422 or 400), never a crash
  });

  it('an edit by someone whose leave is ahead of it, holding the trip\'s change number, is refused once that leave commits, and sends nothing in their name', async () => {
    const leaving = async (side: any) => {
      await side.query(`update trip_people set left_at = now() where trip_id = 't_goa' and person_id = 'p_kabir'`);
      await side.query(`update trips set seq = seq + 1 where trip_id = 't_goa'`); // the leave has taken the trip's change number
    };
    const seen = await holdAndObserve(h, leaving, () => patch({ title: 'Too late' }, t.as('p_kabir')), 'commit');
    await h.flush();
    expect([seen.waited, refusal(seen.result), personEdits().filter((e) => e.data.by.person_id === 'p_kabir').length]).toEqual([true, [403, 'forbidden'], 0]);
  });
});
