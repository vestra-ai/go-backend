// §4.2 Home: the one read behind the home screen, both its states, the lines the server works out (stage, attention),
// trips that are over, the home_changed notices, and the ideas carousel.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, v1, type Harness } from './helpers/harness.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
let asha: { id: string; token: string }, ben: { id: string; token: string };
beforeAll(async () => {
  h = await startHarness({ seed: false });
  t = appApi(h);
  asha = await h.signIn('Asha');
  ben = await h.signIn('Ben');
});
afterAll(() => h.stop());

const home = (who: { id: string; token: string }) => t.api(who, 'GET', v1('/home'));
const homeChanged = (personId: string) => h.live.events.filter((e) => e.event.kind === 'home' && e.event.person_id === personId).length;
const goCall = async (method: string, params: Record<string, unknown>) => {
  const f = await h.go.call(method, { request_id: `rq_${Math.random().toString(36).slice(2)}`, ...params });
  if (f.error) throw new Error(JSON.stringify(f.error));
  return f.result;
};

describe('the first run', () => {
  it('a new person\'s home is empty: me, no trips, no past trips, nothing owed, seq_hint 0; never cached', async () => {
    const r = await home(asha);
    expect([r.status, r.headers['cache-control'], r.body]).toEqual([200, 'private, no-store', { me: { person_id: asha.id, name: 'Asha', photo_url: 'https://lh3.googleusercontent.com/a/test-photo' }, trips: [], past_trips: [], owes: [], seq_hint: 0 }]);
    expect((await t.api(null, 'GET', v1('/home'))).status).toBe(401);
  });

  it('ideas: the general set when no city is known; the city\'s own set once the profile has one or the query names one; cached a day', async () => {
    const general = await t.api(asha, 'GET', v1('/discover/ideas'));
    expect([general.status, general.headers['cache-control'], general.body.from_city, general.body.items.length, general.body.items[0]]).toEqual([
      200, 'private, max-age=86400', null, 8, { idea_id: 'idea_any_goa', name: 'Goa', tag: 'Beach weekend', travel: { mode: 'flight', duration_minutes: 90 }, destination_hint: 'Goa' },
    ]);
    await t.api(asha, 'PATCH', v1('/me'), { from_city: 'Bengaluru' });
    const fromProfile = await t.api(asha, 'GET', v1('/discover/ideas?limit=3'));
    expect([fromProfile.body.from_city, fromProfile.body.items.map((i: any) => i.name)]).toEqual(['Bengaluru', ['Coorg', 'Gokarna', 'Pondicherry']]);
    const named = await t.api(asha, 'GET', v1('/discover/ideas?from_city=pune'));
    expect([named.body.from_city, named.body.items[0].name, named.body.items.every((i: any) => i.travel.duration_minutes > 0 && ['flight', 'car', 'train', 'bus'].includes(i.travel.mode))]).toEqual(['pune', 'Lonavala', true]);
    const unknown = await t.api(asha, 'GET', v1('/discover/ideas?from_city=Nowhere'));
    expect([unknown.body.from_city, unknown.body.items[0].idea_id]).toEqual(['Nowhere', 'idea_any_goa']); // the general set, with the city asked for
    expect((await t.api(asha, 'GET', v1('/discover/ideas?limit=0'))).status).toBe(422);
  });
});

describe('a returning person', () => {
  let newTrip: string, deciding: string, over: string;

  it('each trip card has stage and attention worked out by the server: new, then deciding, needs_you when a vote waits for me, all_set once planned', async () => {
    const before = homeChanged(asha.id);
    const fresh = await t.api(asha, 'POST', v1('/trips'), {}); // nothing at all: "New trip"
    newTrip = fresh.body.trip_id;
    const goa = await t.api(asha, 'POST', v1('/trips'), { title: 'Goa 🌴', destination: { name: 'Goa', photo_url: 'https://images.example/goa.jpg' }, dates: { start: '2026-11-06', end: '2026-11-09' } });
    deciding = goa.body.trip_id;
    expect([fresh.status, fresh.body.title, fresh.body.stage, goa.body.stage, homeChanged(asha.id) - before]).toEqual([201, 'New trip', 'new', 'deciding', 2]);
    let r = await home(asha);
    expect(r.body.trips.map((x: any) => [x.trip_id, x.stage, x.attention, x.photo_url, x.people_count, x.people_preview.length, x.status])).toEqual([
      [deciding, 'deciding', { kind: 'collecting' }, 'https://images.example/goa.jpg', 1, 1, 'planning'], // latest activity first
      [newTrip, 'new', { kind: 'collecting' }, undefined, 1, 1, 'planning'],
    ]);
    expect(r.body.trips[0]).toMatchObject({ title: 'Goa 🌴', destination: { name: 'Goa' }, dates: { start: '2026-11-06', end: '2026-11-09' }, people_preview: [{ person_id: asha.id, name: 'Asha' }], last_activity_at: expect.any(String) });
    expect(r.body.seq_hint).toBe(2); // trip.created, then the "Trip created" pill
    // Go opens a vote: something needs Asha.
    const vote = await goCall('open_vote', { trip_id: deciding, question: 'Where do we stay?', kind: 'choice', anonymous: false, options: [{ label: 'Villa Sol' }, { label: 'Casa Azul' }] });
    r = await home(asha);
    expect([r.body.trips[0].attention, r.body.seq_hint]).toEqual([{ kind: 'needs_you', count: 1 }, 3]);
    await t.api(asha, 'PUT', v1(`/trips/${deciding}/decisions/${vote.decision_id}/vote`), { option_index: 0 }); // everyone (she alone) voted: it closes
    expect((await home(asha)).body.trips[0].attention).toEqual({ kind: 'collecting' });
    // A confirmed booking with destination and dates: planned, and "all set".
    await t.api(asha, 'POST', v1(`/trips/${deciding}/bookings`), { kind: 'stay', title: 'Villa Sol', vendor: 'ixigo', ref: 'IXG-1', amount_minor: 5420000, payer_person_id: asha.id, for_person_ids: [asha.id] });
    r = await home(asha);
    expect([r.body.trips[0].stage, r.body.trips[0].attention]).toEqual(['planned', { kind: 'all_set' }]);
    // Something new to do beats "all set".
    await goCall('open_vote', { trip_id: deciding, question: 'Dinner?', kind: 'yesno', anonymous: false, options: [{ label: 'Yes' }, { label: 'No' }] });
    expect((await home(asha)).body.trips[0].attention).toEqual({ kind: 'needs_you', count: 1 });
  });

  it('an invite joins directly: the link is accepted with no answers, the trip appears on home, and home and Me carry nothing about pending invites', async () => {
    const code = (await t.api(asha, 'GET', v1(`/trips/${deciding}/invite`))).body.code;
    const before = homeChanged(ben.id);
    const first = await home(ben);
    const joined = await t.api(ben, 'POST', v1(`/invites/${code}/accept`)); // no body at all
    const r = await home(ben);
    expect(['invites' in first.body, first.body.trips, 'pending_invites' in (await t.api(ben, 'GET', v1('/me'))).body.counts]).toEqual([false, [], false]);
    expect([joined.status, joined.body.landing, r.body.trips.map((x: any) => x.trip_id), r.body.trips[0].people_preview.map((p: any) => p.person_id), r.body.trips[0].attention]).toEqual([
      200, 'trip_home', [deciding], [asha.id, ben.id], { kind: 'needs_you', count: 1 }, // the dinner vote waits for him too
    ]);
    expect(homeChanged(ben.id) - before).toBe(1); // the accept
    // The organizer's home shows the new face too, and a member's trip card never shows another member's from_city.
    const ashas = (await home(asha)).body.trips.find((x: any) => x.trip_id === deciding);
    expect([ashas.people_count, JSON.stringify(ashas).includes('from_city')]).toEqual([2, false]);
  });

  it('a trip that is over moves to past trips, settled when nobody owes anybody; it stops counting as active', async () => {
    const r0 = await t.api(asha, 'POST', v1('/trips'), { title: 'Coorg', destination_hint: 'ignored when there is a title' });
    over = r0.body.trip_id;
    const code = (await t.api(asha, 'GET', v1(`/trips/${over}/invite`))).body.code;
    await t.api(ben, 'POST', v1(`/invites/${code}/accept`), {});
    await t.api(asha, 'PATCH', v1(`/trips/${over}`), { status: 'over' });
    let r = await home(asha);
    expect([r.body.trips.map((x: any) => x.trip_id).includes(over), r.body.past_trips]).toEqual([false, [{ trip_id: over, title: 'Coorg', people_count: 2, all_settled: true }]]);
    await t.api(ben, 'POST', v1(`/trips/${over}/expenses`), { paid_by_person_id: ben.id, amount_minor: 100000, note: 'Dinner', category: 'food', split_person_ids: [asha.id, ben.id] });
    r = await home(asha);
    expect([r.body.past_trips[0].all_settled, (await t.api(asha, 'GET', v1('/me'))).body.counts]).toEqual([false, { active_trips: 2, past_trips: 1 }]);
  });

  it('a trip the person left is not on their home', async () => {
    await t.api(ben, 'POST', v1(`/trips/${deciding}/leave`));
    expect((await home(ben)).body.trips).toEqual([]);
    expect((await home(asha)).body.trips.find((x: any) => x.trip_id === deciding).people_count).toBe(1);
  });

  it('a destination hint becomes the title and the destination when there are none, and the organizer\'s from_city is their own answer', async () => {
    const r = await t.api(asha, 'POST', v1('/trips'), { destination_hint: 'Coorg', from_city: 'Bengaluru', currency: 'INR' });
    // Found against production Go (10 Oct 2026): the hint was only a title, so Go's trip.created had no destination.
    const created = (await rows(h.pool, `select body from outbox where trip_id = $1 and body->>'type' = 'trip.created'`, [r.body.trip_id]))[0]?.body;
    expect([r.body.destination?.name, created?.data.trip.destination?.name]).toEqual(['Coorg', 'Coorg']);
    expect([r.status, r.body.title, r.body.stage, r.body.me.person.from_city, r.body.people[0].from_city, r.body.seq, r.body.can]).toEqual([201, 'Coorg', 'deciding', 'Bengaluru', 'Bengaluru', 2, { invite: true, manage_trip: true }]); // seq 2: the "Trip created" pill
    expect((await t.api(asha, 'POST', v1('/trips'), { title: 'x', colour: 'blue' })).status).toBe(422);
    expect((await t.api(asha, 'POST', v1('/trips'), { dates: { start: '2026-11-09', end: '2026-11-06' } })).status).toBe(422);
    expect((await t.api(asha, 'POST', v1('/trips'), { currency: 'rupees' })).status).toBe(422);
  });
});
