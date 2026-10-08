// GET /trips/:trip/itinerary (app contract §4.10, GO-CHANGES 1.8): everyone's view hides other people's private items;
// "Just me" keeps what is mine, shared or for the group, and rewords an item tied to a booking that covers me.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { daysFor, titleForPerson, wallClock } from '../src/domain/itinerary.js';
import { appApi } from './helpers/app-api.js';
import { startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
let flight: string;
let cab: string;
beforeAll(async () => {
  h = await startHarness(); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
  // Two bookings: a flight for Rahul and Arjun with seats, a cab for Priya with no journey.
  flight = (await h.go.call('add_booking', {
    request_id: 'rq_it_flight', trip_id: 't_goa', kind: 'flight', title: 'Flight to Goa', vendor: 'ixigo', ref: 'K7QX2M', amount_minor: 1184000, currency: 'INR', payer_person_id: 'p_rahul', for_person_ids: ['p_rahul', 'p_arjun'],
    journey: { mode: 'flight', origin: { name: 'Bengaluru', code: 'BLR' }, destination: { name: 'Mopa', code: 'GOX' }, depart_at: '2026-11-06T19:40:00+05:30', arrive_at: '2026-11-06T21:55:00+05:30', carrier_name: 'IndiGo', carrier_code: '6E', number: '5313' },
    passengers: [{ person_id: 'p_rahul', seat: '14A', pnr: 'K7QX2M' }, { person_id: 'p_arjun', pnr: 'K7QX2M' }],
  })).result.booking_id;
  cab = (await h.go.call('add_booking', { request_id: 'rq_it_cab', trip_id: 't_goa', kind: 'cab', title: 'Airport cab', vendor: 'Kabir Cabs', ref: 'c1', amount_minor: 160000, currency: 'INR', payer_person_id: 'p_priya', for_person_ids: ['p_priya'] })).result.booking_id;
  const itinerary = [
    { date: '2026-11-06', title: 'Arrive', image_url: 'https://images.example/day1.jpg', items: [
      { item_id: 'it_fly', time: '19:40', title: 'You + Arjun land at Mopa', category: 'getting_around', status: 'booked', booking_id: flight, person_ids: ['p_rahul', 'p_arjun'], audience: 'shared' },
      { item_id: 'it_cab', time: '22:10', title: 'Cab to the villa', category: 'getting_around', status: 'booked', booking_id: cab, person_ids: ['p_priya'] },
      { item_id: 'it_checkin', time: '22:30', title: 'Check in at Villa Sol', category: 'stay', status: 'booked', audience: 'group' },
      { item_id: 'it_call', time: '23:00', title: 'Call home', category: 'other', status: 'planned', person_ids: ['p_priya'], audience: 'private' },
      { item_id: 'it_yoga', time: '07:00', title: 'Yoga', category: 'activities', status: 'idea', person_ids: ['p_meher', 'p_kabir'] },
    ] },
    { date: '2026-11-07', items: [{ item_id: 'it_beach', title: 'Anjuna beach', category: 'activities', status: 'planned' }] },
  ];
  const r = await h.go.call('update_trip', { request_id: 'rq_it_days', trip_id: 't_goa', itinerary });
  if (r.error) throw new Error(JSON.stringify(r.error));
});
afterAll(() => h.stop());

const read = (who: string, scope?: string) => t.api(t.as(who), 'GET', `/app/v1/trips/t_goa/itinerary${scope ? `?scope=${scope}` : ''}`);
const ids = (days: any[]) => days.map((d) => d.items.map((i: any) => i.item_id));

describe('scope=everyone', () => {
  it('is the default, keeps every item but the private ones that do not name me, passes person_ids and audience through, and answers the change number', async () => {
    const rahul = await read('p_rahul');
    const seq = (await h.pool.query(`select seq from trips where trip_id = 't_goa'`)).rows[0].seq;
    expect([rahul.status, rahul.body.seq, ids(rahul.body.days)]).toEqual([200, seq, [['it_fly', 'it_cab', 'it_checkin', 'it_yoga'], ['it_beach']]]);
    expect(rahul.body.days[0]).toMatchObject({ date: '2026-11-06', title: 'Arrive', image_url: 'https://images.example/day1.jpg' });
    expect(rahul.body.days[0].items[0]).toEqual({ item_id: 'it_fly', time: '19:40', title: 'You + Arjun land at Mopa', category: 'getting_around', status: 'booked', booking_id: flight, person_ids: ['p_rahul', 'p_arjun'], audience: 'shared' }); // no rewording here
    expect(ids((await read('p_priya', 'everyone')).body.days)[0]).toContain('it_call'); // her own private item
    expect((await read('p_rahul', 'all')).status).toBe(422);
    expect((await t.api(t.as('p_stranger'), 'GET', '/app/v1/trips/t_goa/itinerary')).status).toBe(403);
    expect((await t.api(null, 'GET', '/app/v1/trips/t_goa/itinerary')).status).toBe(401);
  });
});

describe('scope=me', () => {
  it('keeps my items, shared and group ones and items that name nobody, drops the rest, and rewords an item of a booking that covers me from the booking', async () => {
    const rahul = (await read('p_rahul', 'me')).body;
    expect(ids(rahul.days)).toEqual([['it_fly', 'it_checkin'], ['it_beach']]); // not Priya's cab, not her call, not Meher and Kabir's yoga
    expect(rahul.days[0].items[0]).toMatchObject({ item_id: 'it_fly', title: 'BLR → GOX · 6E 5313, Seat 14A, lands Mopa 9:55 pm', booking_id: flight, person_ids: ['p_rahul', 'p_arjun'], audience: 'shared' });
    const arjun = (await read('p_arjun', 'me')).body;
    expect(arjun.days[0].items[0].title).toBe('BLR → GOX · 6E 5313, lands Mopa 9:55 pm'); // no seat on his passenger entry
    const priya = (await read('p_priya', 'me')).body;
    expect(ids(priya.days)[0]).toEqual(['it_fly', 'it_cab', 'it_checkin', 'it_call']); // the flight is shared with her; the cab is hers but has no journey: its title stays
    expect(priya.days[0].items.map((i: any) => i.title)).toEqual(['You + Arjun land at Mopa', 'Cab to the villa', 'Check in at Villa Sol', 'Call home']); // not covered by the flight: no rewording for her
    expect(ids((await read('p_kabir', 'me')).body.days)).toEqual([['it_fly', 'it_checkin', 'it_yoga'], ['it_beach']]);
  });

  it('the wording rule: codes fall back to names, a missing carrier code keeps the number, a booking without a journey keeps the stored title', () => {
    const journey = { mode: 'flight', origin: { name: 'Delhi' }, destination: { name: 'Goa', code: 'GOI' }, depart_at: '2026-11-06T08:00:00Z', arrive_at: '2026-11-06T10:30:00Z', number: '6E 123' };
    expect(titleForPerson('stored', { journey, passengers: null } as any, 'p_x')).toBe('Delhi → GOI · 6E 123, lands Goa 10:30 am');
    expect(titleForPerson('stored', { journey: { ...journey, carrier_code: undefined, number: undefined, carrier_name: 'IndiGo' }, passengers: [{ person_id: 'p_x', seat: '2C' }] } as any, 'p_x')).toBe('Delhi → GOI · IndiGo, Seat 2C, lands Goa 10:30 am');
    expect(titleForPerson('stored', { journey: null, passengers: [{ person_id: 'p_x', seat: '2C' }] } as any, 'p_x')).toBe('stored');
    expect([wallClock('2026-11-06T00:05:00+05:30'), wallClock('2026-11-06T12:00:00Z'), wallClock('2026-11-06T23:59:00-08:00'), wallClock('nonsense')]).toEqual(['12:05 am', '12:00 pm', '11:59 pm', undefined]);
    const days = daysFor([{ date: '2026-11-06', items: [{ title: 'x', person_ids: [] }, { title: 'y', audience: 'private' }] }] as any, [], 'p_x', 'me');
    expect(days[0]!.items.map((i: any) => i.title)).toEqual(['y']); // an empty person_ids names nobody I am part of; a private item with no person_ids names nobody at all and stays
  });
});

describe('PATCH /trips/:trip { itinerary }', () => {
  it('accepts the 1.1 item fields and Day.image_url from a person, and the two scopes read them back', async () => {
    const itinerary = [{ date: '2026-11-08', image_url: 'https://images.example/day3.jpg', items: [
      { title: 'Spa', category: 'activities', status: 'idea', person_ids: ['p_meher'], audience: 'private' },
      { title: 'Dinner', category: 'food', status: 'planned', audience: 'group' },
    ] }];
    const r = await t.api(t.as('p_meher'), 'PATCH', '/app/v1/trips/t_goa', { itinerary });
    expect(r.status).toBe(200);
    expect(ids((await read('p_rahul', 'everyone')).body.days)).toEqual([[undefined]]); // no item ids: the person sent none; Spa is Meher's private item
    expect((await read('p_rahul', 'everyone')).body.days[0].items.map((i: any) => i.title)).toEqual(['Dinner']);
    expect((await read('p_meher', 'me')).body.days[0].items.map((i: any) => i.title)).toEqual(['Spa', 'Dinner']);
    expect((await t.api(t.as('p_meher'), 'PATCH', '/app/v1/trips/t_goa', { itinerary: [{ date: '2026-11-08', items: [{ title: 'x', category: 'food', status: 'planned', audience: 'everyone' }] }] })).status).toBe(422);
  });
});
