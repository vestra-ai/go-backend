import { afterAll, beforeAll, expect, it } from 'vitest';
import { check } from '../src/contract/index.js';
import { appApi } from './helpers/app-api.js';
import { EVERYONE } from './helpers/cancel-flow.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';

const PWA = 'https://pwa.example';
let h: Harness;
beforeAll(async () => {
  h = await startHarness({ origins: [PWA] });
});
afterAll(() => h.stop());

it('the whole feature in one walk from the web app\'s origin: every change takes the next number with one valid event, Go never sees a UPI id or a contact detail', async () => {
  const t = appApi(h);
  const statuses: string[] = [];
  const call = async (who: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, body?: unknown) => {
    const r = await t.api(t.as(who), method, url, body, { origin: PWA });
    if (r.status >= 300 || r.headers['access-control-allow-origin'] !== PWA) statuses.push(`${method} ${url}: ${r.status}`);
    return r;
  };
  const trip = '/app/v1/trips/t_goa';
  // a vote, decided; a booking against it, updated; the group cancels it
  const vote = await call('p_priya', 'POST', `${trip}/decisions`, { client_id: 'v1', question: 'Where do we stay?', kind: 'choice', anonymous: false, options: [{ label: 'Villa Sol', price_minor: 5420000 }, { label: 'Casa Azul' }] });
  for (const who of EVERYONE) await call(who, 'PUT', `${trip}/decisions/${vote.body.decision.decision_id}/vote`, { option_index: 0 });
  const booking = await call('p_arjun', 'POST', `${trip}/bookings`, { kind: 'stay', title: 'Villa Sol', vendor: 'ixigo', ref: 'IXG-1', amount_minor: 5420000, payer_person_id: 'p_rahul', for_person_ids: EVERYONE, decision_id: vote.body.decision.decision_id });
  await call('p_meher', 'PATCH', `${trip}/bookings/${booking.body.booking_id}`, { ref: 'IXG-2' });
  const cancel = await call('p_priya', 'POST', `${trip}/bookings/${booking.body.booking_id}/cancel-vote`, {});
  for (const who of ['p_rahul', 'p_priya', 'p_arjun']) await call(who, 'PUT', `${trip}/decisions/${cancel.body.decision_id}/vote`, { option_index: 0 });
  await call('p_rahul', 'POST', `${trip}/decisions/${cancel.body.decision_id}/close`);
  // people change their own details, answers and the trip
  await call('p_rahul', 'PATCH', '/app/v1/me', { name: 'Rahul K' });
  await call('p_priya', 'PUT', '/app/v1/me/upi', { upi_id: 'priya@okbank' });
  await call('p_arjun', 'PUT', `${trip}/me/join-answers`, { from_city: 'Delhi', know: ['Window seat'] });
  await call('p_meher', 'PATCH', trip, { title: 'Goa, again', status: 'booked' });
  // money: an expense (it counts at once), whom Priya owes, and a pay link to Rahul
  await call('p_rahul', 'POST', `${trip}/expenses`, { paid_by_person_id: 'p_rahul', amount_minor: 100000, note: 'Dinner', category: 'food', split_person_ids: EVERYONE });
  const money = await call('p_priya', 'GET', `${trip}/money`);
  const link = await call('p_priya', 'POST', `${trip}/transfers/pay-link`, { to_person_id: 'p_rahul', amount_minor: 20000 });
  await h.flush();

  const events = (await rows(h.pool, 'select body from outbox where trip_id = $1 order by seq', ['t_goa'])).map((r) => r.body);
  const snap = (await h.go.call('read_trip', { trip_id: 't_goa' })).result;
  const seen = JSON.stringify([events, snap]);
  expect(statuses).toEqual([]); // every call succeeded and carried the origin's headers
  // 2, 3, 4... each with exactly one event: the server's own pills (poll anchors, "won", "booked", the money line) as message.created
  const pills = (await rows(h.pool, `select seq from messages where trip_id = 't_goa' and author_kind = 'system' order by seq`)).map((p) => p.seq as number);
  expect(events.map((e) => e.seq)).toEqual(Array.from({ length: events.length }, (_, i) => i + 2));
  expect(events.filter((e) => e.type === 'message.created').map((e) => e.seq)).toEqual(pills);
  expect(h.go.events.filter((e) => e.trip_id === 't_goa').map((e) => e.seq)).toEqual(events.map((e) => e.seq)); // and Go received each one, in order
  const label = (e: any) => e.type === 'message.created' ? `pill:${e.data.message.author.kind}:${e.data.message.text.replace(/[\u00a0\u202f]/g, ' ')}`
    : e.type + (e.data.change ? `:${e.data.change}` : '') + (e.type === 'trip.updated' ? `:${e.data.by.kind}:${e.data.changed}` : '') + (e.type === 'person.updated' ? `:${e.data.changed}` : '');
  expect(events.map(label)).toEqual([
    'decision.opened', 'pill:system:Where do we stay?', ...Array(5).fill('decision.voted'), 'decision.closed', 'record.changed:added', 'pill:system:Villa Sol won · 5 votes', // the first vote, decided
    'booking.changed:added', 'record.changed:updated', 'pill:system:Villa Sol booked', 'booking.changed:updated', // a booking against it, updated
    'decision.opened', 'pill:system:Cancel this booking? Villa Sol', ...Array(3).fill('decision.voted'), 'decision.closed', 'booking.changed:cancelled', 'record.changed:added', 'pill:system:Cancel: Villa Sol won · 3 votes', // the group cancels it
    'person.updated:name', 'person.updated:has_upi', 'person.updated:from_city,know', // a rename, a UPI id (only that one exists), join answers
    'trip.updated:person:title,status', // the trip edit names the person
    'expense.changed:added', 'pill:system:Rahul K added Dinner · ₹1,000 · split 5 ways', // the expense and its money line
  ]);
  expect([snap.bookings[0].status, snap.title, snap.status, snap.people.find((p: any) => p.person_id === 'p_rahul').name, snap.people.find((p: any) => p.person_id === 'p_priya').has_upi]).toEqual(['cancelled', 'Goa, again', 'booked', 'Rahul K', true]);
  expect([events.every((e) => check('Event', e).ok), check('TripSnapshot', snap).ok, snap.seq === events.at(-1).seq, events.at(-1).seq === pills.at(-1)]).toEqual([true, true, true, true]); // the last change is the room's line for the expense
  // Go never sees a contact detail, and with no group budget set it reads nobody having answered.
  expect([/rahul@upi|priya@okbank|\+91p_|@mail\.test/.test(seen), snap.budget]).toEqual([false, { answered: 0, of: 5 }]);
  expect([money.body.me.i_owe, money.body.me.spent_minor, link.body.upi_uri]).toEqual([[{ from_person_id: 'p_priya', to_person_id: 'p_rahul', amount_minor: 20000, currency: 'INR' }], 20000, 'upi://pay?pa=rahul%40upi&pn=Rahul%20K&am=200.00&cu=INR&tn=Goa%2C%20again%20%C2%B7%20settle%20up']);
});

/** The change number each live notice for the trip is about, in the order the app got them. */
const liveSeqs = (h: Harness, tripId: string) => h.live.events.filter((e) => e.tripId === tripId)
  .map(({ event: e }) => (e.kind === 'trip' ? e.seq : e.kind === 'message' ? e.updated_seq : null)).filter((n): n is number => n !== null);

// Found against production Go (10 Oct 2026): a vote closing, a poll opening, a booking, a join and a leave sent the pill's
// `message` notice (seq N+1) before the `trip` notice (seq N). An app that keeps the highest seq drops the late one and never
// re-reads people, votes or bookings.
it('the live notices reach the app in change-number order, through votes, bookings and a leave', async () => {
  const seqs = liveSeqs(h, 't_goa');
  expect(seqs.length).toBeGreaterThan(20);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  const mark = h.live.events.length;
  const t = appApi(h);
  expect((await t.api(t.as('p_kabir'), 'POST', '/app/v1/trips/t_goa/leave', {})).status).toBeLessThan(300);
  const after = h.live.events.slice(mark).filter((e) => e.tripId === 't_goa').map((e) => e.event.kind);
  expect(after.slice(0, 2)).toEqual(['trip', 'message']); // person.left, then its "… left" line
  const all = liveSeqs(h, 't_goa');
  expect(all).toEqual([...all].sort((a, b) => a - b));
});
