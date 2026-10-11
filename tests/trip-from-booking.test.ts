// A booking settles part of the trip (11 Oct 2026): the trip takes its empty destination, stay and dates from its
// confirmed bookings. Never a value someone set; dates from flights only with both a going and a return journey.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fillsFromBookings } from '../src/domain/trip-from-booking.js';
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
    expect(fillsFromBookings(EMPTY, [VILLA as any])).toEqual({ destination: VILLA.place, stay: 'Villa Sol, Anjuna', dates: { start: '2026-11-06', end: '2026-11-09' } });
  });

  it('a one-way flight: the city it lands in (Goa, not the airport town Mopa), and no dates', () => {
    expect(fillsFromBookings(EMPTY, [flight(OUT) as any])).toEqual({ destination: { name: 'Goa' } });
  });

  it('going and return flights, in one booking or two: the going departure date to the return arrival date', () => {
    const want = { destination: { name: 'Goa' }, dates: { start: '2026-11-06', end: '2026-11-10' } };
    expect(fillsFromBookings(EMPTY, [flight(OUT, BACK) as any])).toEqual(want);
    expect(fillsFromBookings(EMPTY, [flight(OUT) as any, flight(BACK) as any])).toEqual(want);
  });

  it('never a field the trip already has; a stay\'s dates win over flights when both are booked', () => {
    expect(fillsFromBookings({ destination: { name: 'Hampi' }, stay: 'My homestay', dates_start: '2026-12-01' }, [VILLA as any, flight(OUT, BACK) as any])).toEqual({});
    expect(fillsFromBookings(EMPTY, [flight(OUT, BACK) as any, VILLA as any]).dates).toEqual({ start: '2026-11-06', end: '2026-11-09' });
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

  it('a stay a person adds gives the trip its place and stay, keeps its dates, tells Go once (by the system) and the app reads "Villa Sol, Anjuna"', async () => {
    const before = h.go.events.length;
    const r = await t.api(t.as('p_rahul'), 'POST', '/app/v1/trips/t_goa/bookings', {
      kind: 'stay', title: 'Villa Sol, Anjuna', vendor: 'ixigo', ref: 'IXG-9', amount_minor: 5400000, payer_person_id: 'p_rahul', for_person_ids: ['p_rahul', 'p_priya'],
      place: { name: 'Villa Sol, Anjuna', address: 'Anjuna, Goa' }, starts_at: '2026-11-20T08:30:00Z', ends_at: '2026-11-23T05:30:00Z',
    });
    expect(r.status).toBeLessThan(300);
    const [trip] = await rows(h.pool, "select destination, stay, dates_start::text as s, dates_end::text as e from trips where trip_id = 't_goa'");
    expect([trip.destination.name, trip.stay, trip.s, trip.e]).toEqual(['Villa Sol, Anjuna', 'Villa Sol, Anjuna', '2026-11-06', '2026-11-09']); // the dates were set: kept
    await h.flush();
    const updated = h.go.events.slice(before).filter((e: any) => e.type === 'trip.updated');
    expect(updated.map((e: any) => e.data)).toEqual([{ by: { kind: 'system' }, changed: ['destination', 'stay'] }]);
  });
});
