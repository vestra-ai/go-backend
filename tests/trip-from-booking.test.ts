// A booking settles part of the trip (11 Oct 2026): the trip takes its empty destination, stay and dates from its
// confirmed bookings. Never a value someone set; dates from flights only with both a going and a return journey.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fillsFromBookings, placeFromAddress, repairStayDestinations, repairSystemDates } from '../src/domain/trip-from-booking.js';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';

const EMPTY = { destination: null, stay: null, dates_start: null };
const VILLA = { kind: 'stay', title: 'Villa Sol, Anjuna', place: { name: 'Villa Sol, Anjuna', address: 'Anjuna, Goa', timezone: 'Asia/Kolkata' }, starts_at: '2026-11-06T08:30:00Z', ends_at: '2026-11-09T05:30:00Z', journey: null, return_journey: null };
const leg = (from: string, to: string, depart: string, arrive: string) => ({ mode: 'flight', origin: { name: from === 'BLR' ? 'Bengaluru' : 'Mopa', code: from }, destination: { name: to === 'BLR' ? 'Bengaluru' : 'Mopa', code: to }, depart_at: depart, arrive_at: arrive });
const flight = (journey: object, back: object | null = null) => ({ kind: 'flight', title: 'IndiGo', place: null, starts_at: null, ends_at: null, journey, return_journey: back });
const OUT = leg('BLR', 'GOX', '2026-11-06T19:40:00+05:30', '2026-11-06T21:05:00+05:30');
const BACK = leg('GOX', 'BLR', '2026-11-10T10:00:00+05:30', '2026-11-10T11:25:00+05:30');

describe('fillsFromBookings', () => {
  it('a stay alone: its place, its name and its check-in to check-out', () => {
    expect(fillsFromBookings(EMPTY, [VILLA as any])).toEqual({ destination: { name: 'Goa' }, stay: 'Villa Sol, Anjuna' }); // the place, never the hotel's name; never the dates
  });

  it('the place from a stay\'s address: its town, or the state people travel to; nothing when there is no address', () => {
    expect([
      placeFromAddress('Anjuna Beach Road, Anjuna, Goa 403509'), placeFromAddress('Old Manali, Manali, Himachal Pradesh 175131'),
      placeFromAddress('MG Road, Udaipur, Rajasthan, India'), placeFromAddress('Anjuna, North Goa, Goa'), placeFromAddress('Rawalpora, Srinagar'),
      placeFromAddress('Srinagar', 'The Sarai'), placeFromAddress('Villa Sol', 'Villa Sol'), placeFromAddress(undefined),
    ]).toEqual(['Goa', 'Manali', 'Udaipur', 'Goa', 'Srinagar', 'Srinagar', undefined, undefined]); // Go's real addresses: often the town alone
    expect(fillsFromBookings(EMPTY, [{ ...VILLA, place: { name: 'Villa Sol' } } as any]).destination).toBeUndefined(); // the hotel's name alone is never the trip's place
  });

  it('a one-way flight: the city it lands in (Goa, not the airport town Mopa), and no dates', () => {
    expect(fillsFromBookings(EMPTY, [flight(OUT) as any])).toEqual({ destination: { name: 'Goa' } });
  });

  it('never the dates (12 Oct 2026: they are Go\'s and the people\'s to set), not even from going and return flights', () => {
    expect(fillsFromBookings(EMPTY, [flight(OUT, BACK) as any])).toEqual({ destination: { name: 'Goa' } });
    expect(fillsFromBookings(EMPTY, [flight(OUT) as any, flight(BACK) as any, VILLA as any])).toEqual({ destination: { name: 'Goa' }, stay: 'Villa Sol, Anjuna' });
  });

  it('never a field the trip already has', () => {
    expect(fillsFromBookings({ destination: { name: 'Hampi' }, stay: 'My homestay', dates_start: '2026-12-01' }, [VILLA as any, flight(OUT, BACK) as any])).toEqual({});
  });
});

describe('after a booking is written', () => {
  let h: Harness;
  let t: ReturnType<typeof appApi>;
  beforeAll(async () => {
    h = await startHarness(); // t_goa: dates 6-9 Nov, no destination, no stay
    t = appApi(h);
  });
  afterAll(() => h.stop());

  it('a stay a person adds gives the trip its place and stay, keeps its dates, tells Go once (by the system) with the place "Goa" from its address (never the hotel name)', async () => {
    const before = h.go.events.length;
    const r = await t.api(t.as('p_rahul'), 'POST', '/app/v1/trips/t_goa/bookings', {
      kind: 'stay', title: 'Villa Sol, Anjuna', vendor: 'ixigo', ref: 'IXG-9', amount_minor: 5400000, payer_person_id: 'p_rahul', for_person_ids: ['p_rahul', 'p_priya'],
      place: { name: 'Villa Sol, Anjuna', address: 'Anjuna, Goa' }, starts_at: '2026-11-20T08:30:00Z', ends_at: '2026-11-23T05:30:00Z',
    });
    expect(r.status).toBeLessThan(300);
    const [trip] = await rows(h.pool, "select destination, stay, dates_start::text as s, dates_end::text as e from trips where trip_id = 't_goa'");
    expect([trip.destination.name, trip.stay, trip.s, trip.e]).toEqual(['Goa', 'Villa Sol, Anjuna', '2026-11-06', '2026-11-09']); // the place from the address, the hotel as the stay; the dates were set: kept
    await h.flush();
    const updated = h.go.events.slice(before).filter((e: any) => e.type === 'trip.updated');
    expect(updated.map((e: any) => e.data)).toEqual([{ by: { kind: 'system' }, changed: ['destination', 'stay'] }]);
  });
});

// The one-time repair (12 Oct 2026): the first version filled a trip's destination with the stay's whole place.
describe('repairStayDestinations', () => {
  let h: Harness;
  beforeAll(async () => (h = await startHarness()));
  afterAll(() => h.stop());

  it('a destination the system filled with a stay\'s hotel becomes the place from its address; one a person set is left; a second run does nothing', async () => {
    const t = appApi(h);
    const villa = { name: 'Villa Sol', address: 'Anjuna, North Goa, Goa', lat: 15.58, lng: 73.74 };
    expect((await t.api(t.as('p_rahul'), 'POST', '/app/v1/trips/t_goa/bookings', {
      kind: 'stay', title: 'Villa Sol', vendor: 'ixigo', ref: 'IXG-R', amount_minor: 100, payer_person_id: 'p_rahul', for_person_ids: ['p_rahul'], place: villa,
    })).status).toBeLessThan(300); // today's rule already fills "Goa"
    // As the first version left it: the hotel's whole place as the destination (the system's trip.updated is in the outbox).
    await h.pool.query("update trips set destination = $1 where trip_id = 't_goa'", [JSON.stringify(villa)]);
    expect(await repairStayDestinations(h.ctx)).toBe(1);
    expect((await rows(h.pool, "select destination from trips where trip_id = 't_goa'"))[0].destination).toEqual({ name: 'Goa' });
    expect(await repairStayDestinations(h.ctx)).toBe(0);
    await h.pool.query("update trips set destination = $1 where trip_id = 't_goa'", [JSON.stringify({ name: 'Hampi' })]); // a person's own value
    expect(await repairStayDestinations(h.ctx)).toBe(0);
  });
});

// The one-time dates repair (12 Oct 2026): dates the system set on a trip are cleared, so Go sets the right ones.
describe('repairSystemDates', () => {
  let h: Harness;
  beforeAll(async () => (h = await startHarness()));
  afterAll(() => h.stop());

  it('clears dates whose newest change was the system\'s; leaves dates a person or Go set after it; a second run does nothing', async () => {
    const t = appApi(h);
    // As before the fix: the system filled the trip's dates (its trip.updated naming dates is in the outbox).
    await h.pool.query("update trips set dates_start = null, dates_end = null where trip_id = 't_goa'");
    await h.pool.query('begin');
    await h.pool.query("update trips set dates_start = '2026-10-13', dates_end = '2026-10-16' where trip_id = 't_goa'");
    await h.pool.query('commit');
    const { change } = await import('../src/db/write-change.js');
    const c = await h.pool.connect();
    try { await c.query('begin'); await change(c, 't_goa', 'trip.updated', { by: { kind: 'system' }, changed: ['dates'] }); await c.query('commit'); } finally { c.release(); }
    expect(await repairSystemDates(h.ctx)).toBe(1);
    expect((await rows(h.pool, "select dates_start, dates_end from trips where trip_id = 't_goa'"))[0]).toEqual({ dates_start: null, dates_end: null });
    expect(await repairSystemDates(h.ctx)).toBe(0);
    expect((await t.api(t.as('p_rahul'), 'PATCH', '/app/v1/trips/t_goa', { dates: { start: '2026-11-01', end: '2026-11-05' } })).status).toBe(200); // a person sets them
    expect(await repairSystemDates(h.ctx)).toBe(0);
    expect((await rows(h.pool, "select dates_start::text as s from trips where trip_id = 't_goa'"))[0].s).toBe('2026-11-01');
  });
});

