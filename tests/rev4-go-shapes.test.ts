// Rev 4, block B7 (GO-CHANGES §6): the shapes Go may now send. Labelled photos, a stay's price range and room types, the
// `rooms` card, and the group's budget through update_trip. Each is validated when present, stored and returned as sent.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check, parseParams } from '../src/contract/index.js';
import { appApi } from './helpers/app-api.js';
import { startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness(); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
});
afterAll(() => h.stop());

const trip = '/app/v1/trips/t_goa';
const call = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) => t.api(t.as(who), method, url, body);
let n = 0;
const go = async (method: string, params: Record<string, unknown>) => {
  const r = await h.go.call(method, { request_id: `rq_shapes_${++n}`, trip_id: 't_goa', ...params });
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r.result as any;
};

const photos = [{ url: 'https://images.example/deluxe.jpg', label: 'Deluxe room' }, { url: 'https://images.example/pool.jpg' }];
const roomTypes = [
  { room_type_id: 'rt_deluxe', label: 'Deluxe room', sleeps: 2, price_minor: 2400000, photos: [photos[0]] },
  { room_type_id: 'rt_std', label: 'Standard room', sleeps: 2, price_minor: 1800000 },
];
const stayOption = { option_id: 'opt_villa', title: 'Villa Sol', price_minor: 1200000, currency: 'INR', highlights: ['Pool'], photos, price_min_minor: 900000, price_max_minor: 1200000, room_types: roomTypes };
const stayCard = { card_id: 'c_stays', kind: 'options', fallback_text: 'Three stays in Goa', title: 'Stays', option_kind: 'stay', checked_at: '2026-10-10T06:00:00Z', options: [stayOption], actions: [{ action_id: 'pick', label: 'Pick', style: 'primary', per_option: true }] };
const roomsCard = {
  card_id: 'c_rooms', kind: 'rooms', fallback_text: 'Pick how you split the rooms at Villa Sol', title: 'Rooms at Villa Sol', option_id: 'opt_villa', for_person_ids: ['p_rahul'],
  arrangements: [{
    arrangement_id: 'ar_1', label: '1 Deluxe, 1 Standard',
    rooms: [{ room_type_id: 'rt_deluxe', label: 'Deluxe room', person_ids: ['p_rahul', 'p_priya'], price_minor: 2400000 }, { room_type_id: 'rt_std', label: 'Standard room', person_ids: ['p_arjun', 'p_kabir'], price_minor: 1800000 }],
    total_minor: 4200000,
    per_person: [{ person_id: 'p_rahul', amount_minor: 1200000 }, { person_id: 'p_priya', amount_minor: 1200000 }, { person_id: 'p_arjun', amount_minor: 900000 }, { person_id: 'p_kabir', amount_minor: 900000 }],
  }],
  actions: [{ action_id: 'pick', label: 'Choose', style: 'primary', per_option: true }],
};

describe('the contract check', () => {
  it('accepts each new shape, and still accepts the same things without them', () => {
    const plain = { ...stayCard, options: [{ option_id: 'opt_villa', title: 'Villa Sol', price_minor: 1200000, currency: 'INR', highlights: ['Pool'] }] };
    expect([check('Card', stayCard).ok, check('Card', plain).ok, check('Card', roomsCard).ok]).toEqual([true, true, true]);
    expect([check('Place', { name: 'Goa', photos }).ok, check('Place', { name: 'Goa' }).ok]).toEqual([true, true]);
    expect(check('DecisionOption', { label: 'Villa Sol', photos, price_min_minor: 900000, price_max_minor: 1200000, room_types: roomTypes }).ok).toBe(true);
    expect([parseParams('update_trip', { request_id: 'r', trip_id: 't', budget_per_person_minor: 2000000 }).ok, parseParams('update_trip', { request_id: 'r', trip_id: 't', title: 'Goa' }).ok]).toEqual([true, true]);
    expect(check('BudgetSummary', { answered: 4, of: 4, lowest: { min_minor: 2000000, max_minor: 2000000, currency: 'INR' }, per_person_minor: 2000000 }).ok).toBe(true);
  });

  it('refuses a malformed one: a photo without a link, a room nobody is in, a rooms card with no arrangement, a room type without a price, a budget of zero', () => {
    const roomless = { ...roomsCard, arrangements: [{ ...roomsCard.arrangements[0]!, rooms: [{ ...roomsCard.arrangements[0]!.rooms[0]!, person_ids: [] }] }] };
    const refused = [
      check('Place', { name: 'Goa', photos: [{ label: 'Pool' }] }).ok,
      check('Card', roomless).ok,
      check('Card', { ...roomsCard, arrangements: [] }).ok,
      check('Card', { ...stayCard, options: [{ ...stayOption, room_types: [{ room_type_id: 'rt', label: 'Room', sleeps: 2 }] }] }).ok,
      parseParams('update_trip', { request_id: 'r', trip_id: 't', budget_per_person_minor: 0 }).ok,
    ];
    expect(refused).toEqual([false, false, false, false, false]);
  });
});

describe('what Go sends reaches the app as sent', () => {
  it('a stay with photos, a price range and room types on an options card, and a destination with labelled photos', async () => {
    const posted = await go('post_message', { text: 'Three stays', card: stayCard });
    await go('update_trip', { destination: { name: 'Goa', photos } });
    const message = (await call('p_priya', 'GET', `${trip}/messages`)).body.messages.find((m: any) => m.message_id === posted.message_id);
    const view = (await call('p_priya', 'GET', trip)).body;
    const home = (await call('p_priya', 'GET', '/app/v1/home')).body.trips.find((x: any) => x.trip_id === 't_goa');
    expect(message.card).toEqual(stayCard);
    expect([view.destination, home.photo_url]).toEqual([{ name: 'Goa', photos }, photos[0]!.url]); // no cover photo set: the first photo stands in on the home card
  });

  it('a rooms card is stored as sent, listed by kind, and is in "needs you" for the people it names', async () => {
    const posted = await go('post_message', { text: 'How do you want to split the rooms?', card: roomsCard });
    const listed = (await call('p_priya', 'GET', `${trip}/cards?kind=rooms`)).body.items;
    const needs = async (who: string) => ((await call(who, 'GET', `${trip}/needs-you`)).body.items as any[]).filter((i) => i.kind === 'card' && i.target.card_id === 'c_rooms');
    expect(listed.map((i: any) => [i.message_id, i.card])).toEqual([[posted.message_id, roomsCard]]);
    expect([(await needs('p_rahul')).length, (await needs('p_priya')).length]).toEqual([1, 0]);
  });

  it('a tap on a rooms card goes to Go with the arrangement as option_id, and Go\'s answer comes back', async () => {
    h.go.answers.card_tap = () => ({ result: { result: 'done', toast: 'Rooms chosen.' } });
    const r = await call('p_rahul', 'POST', `${trip}/cards/c_rooms/actions`, { action_id: 'pick', option_id: 'ar_1', press_id: 'press-rooms-1' });
    const sent = h.go.requests.filter((x) => x.method === 'card_tap').at(-1)!;
    expect([r.status, r.body]).toEqual([200, { result: 'done', toast: 'Rooms chosen.' }]);
    expect(sent.params).toMatchObject({ trip_id: 't_goa', card_id: 'c_rooms', action_id: 'pick', person_id: 'p_rahul', option_id: 'ar_1' });
  });
});

describe('Go sets the group budget', () => {
  it('update_trip with only the budget is accepted: stored, read back, and trip.updated names budget by Go; the same value again tells nothing; without the field it is untouched; a new value changes it', async () => {
    await h.flush();
    const mark = h.go.events.length;
    const set = await go('update_trip', { budget_per_person_minor: 2000000 });
    const same = await go('update_trip', { budget_per_person_minor: 2000000 });
    const other = await go('update_trip', { title: 'Goa in November' });
    const raised = await go('update_trip', { budget_per_person_minor: 2500000 });
    await h.flush();
    const updates = h.go.events.slice(mark).filter((e) => e.type === 'trip.updated').map((e) => [e.data.by, e.data.changed]);
    const snap = (await h.go.call('read_trip', { trip_id: 't_goa' })).result;
    expect(updates).toEqual([[{ kind: 'go' }, ['budget']], [{ kind: 'go' }, ['title']], [{ kind: 'go' }, ['budget']]]);
    const card = (await call('p_priya', 'GET', '/app/v1/home')).body.trips.find((x: any) => x.trip_id === 't_goa');
    expect([same.seq, other.seq > set.seq, raised.seq > other.seq, snap.budget.per_person_minor, (await call('p_priya', 'GET', trip)).body.budget.per_person_minor, card.budget_per_person_minor]).toEqual([set.seq, true, true, 2500000, 2500000, 2500000]);
    expect(check('TripSnapshot', snap).ok).toBe(true);
  });
});

describe('a person may send labelled photos too', () => {
  it('on a new trip\'s destination and on a booking\'s place: stored, returned, and the trip card falls back to the first photo; a photo without a link is refused', async () => {
    const created = await call('p_priya', 'POST', '/app/v1/trips', { title: 'Coorg', destination: { name: 'Coorg', photos } });
    const booking = await call('p_priya', 'POST', `${trip}/bookings`, { kind: 'stay', title: 'Villa Sol', vendor: 'direct', ref: 'VS-1', amount_minor: 4200000, payer_person_id: 'p_rahul', for_person_ids: ['p_rahul', 'p_priya'], place: { name: 'Villa Sol', photos } });
    const card = (await call('p_priya', 'GET', '/app/v1/home')).body.trips.find((x: any) => x.trip_id === created.body.trip_id);
    const bad = await call('p_priya', 'POST', '/app/v1/trips', { title: 'x', destination: { name: 'x', photos: [{ label: 'Pool' }] } });
    expect([created.status, created.body.destination, card.photo_url]).toEqual([201, { name: 'Coorg', photos }, photos[0]!.url]);
    expect([booking.status, booking.body.place]).toEqual([201, { name: 'Villa Sol', photos }]);
    expect([bad.status, bad.body.error.code]).toEqual([422, 'invalid']);
  });
});
