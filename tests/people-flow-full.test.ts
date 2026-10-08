import { createECDH, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { check } from '../src/contract/index.js';
import { WebPushSender, type SendFn } from '../src/push/web-push.js';
import { appApi } from './helpers/app-api.js';
import { EVERYONE } from './helpers/cancel-flow.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';

const PWA = 'https://pwa.example';
const sent: Array<{ endpoint: string; payload: string }> = [];
const transport: SendFn = async (sub, payload) => void sent.push({ endpoint: sub.endpoint, payload }); // the real sender, a recording transport
let h: Harness;
let sender: WebPushSender;
beforeAll(async () => {
  h = await startHarness({
    origins: [PWA],
    pushPublicKey: 'PUBLIC',
    makePush: (pool) => (sender = new WebPushSender({ pool, vapid: { publicKey: 'p', privateKey: 'k', subject: 'mailto:ops@example.com' }, send: transport, log: () => {} })),
  });
});
afterAll(() => h.stop());

const browserKeys = () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
};

it('the whole feature in one walk from the web app\'s origin: every change takes the next number with one valid event, Go never sees a UPI id, a contact detail or any event naming a budget amount, and exactly the expected notifications go out', async () => {
  const t = appApi(h);
  const statuses: string[] = [];
  const call = async (who: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, body?: unknown) => {
    const r = await t.api(t.as(who), method, url, body, { origin: PWA });
    if (r.status >= 300 || r.headers['access-control-allow-origin'] !== PWA) statuses.push(`${method} ${url}: ${r.status}`);
    return r;
  };
  const trip = '/app/v1/trips/t_goa';
  const endpointOf = new Map<string, string>();
  for (const who of EVERYONE) {
    const endpoint = `https://fcm.googleapis.com/fcm/send/${who}`;
    endpointOf.set(endpoint, who);
    await call(who, 'POST', '/app/v1/me/devices', { platform: 'web_push', web_push: { endpoint, keys: browserKeys() } });
  }
  // a vote, decided; a booking against it, updated; the group cancels it
  const vote = await call('p_priya', 'POST', `${trip}/decisions`, { client_id: 'v1', question: 'Where do we stay?', kind: 'choice', anonymous: false, options: [{ label: 'Villa Sol', price_minor: 5420000 }, { label: 'Casa Azul' }] });
  for (const who of EVERYONE) await call(who, 'PUT', `${trip}/decisions/${vote.body.decision.decision_id}/vote`, { option_index: 0 });
  const booking = await call('p_arjun', 'POST', `${trip}/bookings`, { kind: 'stay', title: 'Villa Sol', vendor: 'ixigo', ref: 'IXG-1', amount_minor: 5420000, payer_person_id: 'p_rahul', for_person_ids: EVERYONE, decision_id: vote.body.decision.decision_id });
  await call('p_meher', 'PATCH', `${trip}/bookings/${booking.body.booking_id}`, { ref: 'IXG-2' });
  const cancel = await call('p_priya', 'POST', `${trip}/bookings/${booking.body.booking_id}/cancel-vote`, {});
  for (const who of ['p_rahul', 'p_priya', 'p_arjun']) await call(who, 'PUT', `${trip}/decisions/${cancel.body.decision_id}/vote`, { option_index: 0 });
  await call('p_rahul', 'POST', `${trip}/decisions/${cancel.body.decision_id}/close`);
  // people change their own details, answers, budget and the trip
  await call('p_rahul', 'PATCH', '/app/v1/me', { name: 'Rahul K' });
  await call('p_priya', 'PUT', '/app/v1/me/upi', { upi_id: 'priya@okbank' });
  await call('p_arjun', 'PUT', `${trip}/me/join-answers`, { from_city: 'Delhi', know: ['Window seat'] });
  await call('p_kabir', 'PUT', `${trip}/me/budget`, { min_minor: 1234567, max_minor: 2345678 });
  await call('p_meher', 'PATCH', trip, { title: 'Goa, again', status: 'booked' });
  // money: an expense, whom Priya owes (with Rahul's UPI id), and a reminder
  await call('p_rahul', 'POST', `${trip}/expenses`, { paid_by_person_id: 'p_rahul', amount_minor: 100000, note: 'Dinner', category: 'food', split_person_ids: EVERYONE });
  const settle = await call('p_priya', 'GET', `${trip}/settle-up`);
  await call('p_rahul', 'POST', `${trip}/transfers/nudge`, { from_person_id: 'p_priya' });
  await h.flush();
  await sender.drain();

  const events = (await rows(h.pool, 'select body from outbox where trip_id = $1 order by seq', ['t_goa'])).map((r) => r.body);
  const snap = (await h.go.call('read_trip', { trip_id: 't_goa' })).result;
  const seen = JSON.stringify([events, snap]);
  const pushes = sent.map((s) => [endpointOf.get(s.endpoint), JSON.parse(s.payload)] as const);
  expect(statuses).toEqual([]); // every call succeeded and carried the origin's headers
  // 2, 3, 4... no gap, no repeat, once the server's own pills (poll anchors, "won", "booked": a change number, no event) are counted in
  const pills = (await rows(h.pool, `select seq from messages where trip_id = 't_goa' and author_kind = 'system' order by seq`)).map((p) => p.seq as number);
  expect([...events.map((e) => e.seq), ...pills].sort((a, b) => a - b)).toEqual(Array.from({ length: events.length + pills.length }, (_, i) => i + 2));
  expect(h.go.events.filter((e) => e.trip_id === 't_goa').map((e) => e.seq)).toEqual(events.map((e) => e.seq)); // and Go received each one, in order
  const label = (e: any) => e.type + (e.data.change ? `:${e.data.change}` : '') + (e.type === 'trip.updated' ? `:${e.data.by.kind}:${e.data.changed}` : '') + (e.type === 'person.updated' ? `:${e.data.changed}` : '');
  expect(events.map(label)).toEqual([
    'decision.opened', ...Array(5).fill('decision.voted'), 'decision.closed', 'record.changed:added', // the first vote, decided
    'booking.changed:added', 'record.changed:updated', 'booking.changed:updated', // a booking against it, updated
    'decision.opened', ...Array(3).fill('decision.voted'), 'decision.closed', 'booking.changed:cancelled', 'record.changed:added', // the group cancels it
    'person.updated:name', 'person.updated:has_upi', 'person.updated:from_city,know', // a rename, a UPI id (only that one exists), join answers
    'trip.updated:system:budget', 'trip.updated:person:title,status', // the budget names nobody; the trip edit names the person
    'expense.changed:added',
  ]);
  expect([snap.bookings[0].status, snap.title, snap.status, snap.people.find((p: any) => p.person_id === 'p_rahul').name, snap.people.find((p: any) => p.person_id === 'p_priya').has_upi]).toEqual(['cancelled', 'Goa, again', 'booked', 'Rahul K', true]);
  expect([events.every((e) => check('Event', e).ok), check('TripSnapshot', snap).ok, snap.seq === events.at(-1).seq]).toEqual([true, true, true]);
  // Go reads only the lowest band (with one answer, the band is that answer: by design), and no event carries an amount or a person for it.
  expect([/rahul@upi|priya@okbank|\+91p_|@mail\.test/.test(seen), /1234567|2345678/.test(JSON.stringify(events)), snap.budget]).toEqual([false, false, { lowest: { min_minor: 1234567, max_minor: 2345678, currency: 'INR' }, answered: 1, of: 5 }]);
  expect(settle.body.you_pay).toEqual([{ to_person_id: 'p_rahul', amount_minor: 20000, currency: 'INR', upi_id: 'rahul@upi' }]);
  expect(pushes.map(([who, p]) => [who, p.body]).sort()).toEqual([
    ['p_arjun', 'You owe Rahul K ₹200 for Dinner'], ['p_kabir', 'You owe Rahul K ₹200 for Dinner'], ['p_meher', 'You owe Rahul K ₹200 for Dinner'],
    ['p_priya', 'Rahul K reminded you: you owe ₹200'], ['p_priya', 'You owe Rahul K ₹200 for Dinner'],
  ]); // the four who owe, and the reminder; nothing for votes, bookings, edits or the cancellation
  // Every push is the contract's payload (§8): type, trip, title, body, deep link and tag, no absolute link; the money ones open the Expenses tab.
  expect(pushes.every(([, p]) => JSON.stringify(Object.keys(p)) === '["type","trip_id","title","body","deep_link","tag"]' && p.trip_id === 't_goa' && p.title === 'Goa, again' && p.deep_link === '/trips/t_goa/expenses' && !/https?:/.test(JSON.stringify(p)))).toBe(true);
  expect(pushes.map(([, p]) => p.type).sort()).toEqual(['nudge', 'owe', 'owe', 'owe', 'owe']); // the reminder still arrives in the older shape and is upgraded at delivery
});
