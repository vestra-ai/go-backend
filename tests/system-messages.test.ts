// The server's own messages in the room (decision D8, app contract §4.6): author { kind: "system" }, a change number
// each, never an outbox event; and the anchor message that carries the vote card of a person-opened poll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check } from '../src/contract/index.js';
import { appApi } from './helpers/app-api.js';
import { EVERYONE } from './helpers/cancel-flow.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness({ seed: false });
  t = appApi(h);
});
afterAll(() => h.stop());

type Who = Awaited<ReturnType<Harness['signIn']>>;
let rahul: Who, priya: Who, kabir: Who, trip: string, code: string;
const pills = async (tripId: string) => (await rows(h.pool, `select seq, text, card from messages where trip_id = $1 and author_kind = 'system' order by seq`, [tripId])).map((r) => ({ seq: r.seq as number, text: r.text as string, card: r.card }));
const outboxSeqs = async (tripId: string) => (await rows(h.pool, 'select seq from outbox where trip_id = $1 order by seq', [tripId])).map((r) => r.seq as number);

describe('trip created, joined, left', () => {
  it('"Trip created · Rahul joined" is change 2 (after trip.created), "Priya joined" follows her events; neither has an outbox row', async () => {
    [rahul, priya, kabir] = [await h.signIn('Rahul'), await h.signIn('Priya'), await h.signIn('Kabir')];
    const r = await t.api(rahul, 'POST', '/app/v1/trips', { title: 'Goa' });
    trip = r.body.trip_id;
    code = r.body.invite_url.split('/j/')[1];
    await t.api(priya, 'POST', `/app/v1/invites/${code}/accept`, { join_answers: { from_city: 'Delhi' } });
    await t.api(kabir, 'POST', `/app/v1/invites/${code}/accept`, {});
    expect(await pills(trip)).toEqual([{ seq: 2, text: 'Trip created · Rahul joined', card: null }, { seq: 4, text: 'Priya joined', card: null }, { seq: 6, text: 'Kabir joined', card: null }]);
    expect(await outboxSeqs(trip)).toEqual([1, 3, 5]); // trip.created; person.joined; person.joined (no budget event)
    const room = (await t.api(rahul, 'GET', `/app/v1/trips/${trip}/messages`)).body.messages;
    expect(room.map((m: any) => [m.author, m.text])).toEqual([[{ kind: 'system' }, 'Trip created · Rahul joined'], [{ kind: 'system' }, 'Priya joined'], [{ kind: 'system' }, 'Kabir joined']]);
    for (const m of room) expect(check('Message', m)).toMatchObject({ ok: true });
    expect(h.live.events.filter((e) => e.tripId === trip && e.event.kind === 'message')).toHaveLength(3); // shown live like any message
  });

  it('Go sees them in read_messages (author.kind system passes the contract) and was never sent an event for them', async () => {
    await h.flush();
    const page = (await h.go.call('read_messages', { trip_id: trip, after_seq: 0 })).result;
    expect(check('MessagesPage', page)).toMatchObject({ ok: true });
    expect(page.messages.map((m: any) => [m.seq, m.author.kind])).toEqual([[2, 'system'], [4, 'system'], [6, 'system']]);
    expect(h.go.events.filter((e) => e.trip_id === trip).map((e) => e.seq)).toEqual([1, 3, 5]);
  });

  it('"Kabir left" after person.left', async () => {
    await t.api(kabir, 'POST', `/app/v1/trips/${trip}/leave`);
    expect((await pills(trip)).at(-1)).toMatchObject({ seq: 8, text: 'Kabir left' });
    expect((await outboxSeqs(trip)).at(-1)).toBe(7);
  });
});

describe('a person-opened vote, a decided vote, a booking', () => {
  let decision: string;
  it('POST /decisions answers the decision and the anchor message carrying the vote card, which is in the room at once and never an event', async () => {
    const outbox = (await outboxSeqs(trip)).length;
    const r = await t.api(priya, 'POST', `/app/v1/trips/${trip}/decisions`, { client_id: 'poll-1', question: 'Where do we stay?', kind: 'choice', anonymous: false, options: [{ label: 'Villa Sol' }, { label: 'Casa Azul' }] });
    expect(r.status).toBe(201);
    decision = r.body.decision.decision_id;
    expect(r.body.decision).toMatchObject({ decision_id: decision, opened_by_person_id: priya.id, status: 'open', of: 2, my_vote: null });
    expect(r.body.message).toMatchObject({ author: { kind: 'system' }, text: 'Where do we stay?', card: { kind: 'vote', card_id: expect.stringMatching(/^c_/), decision_id: decision, fallback_text: 'Where do we stay?' }, attachments: [], mentions_go: false });
    expect(check('Message', r.body.message)).toMatchObject({ ok: true });
    expect(check('Card', r.body.message.card)).toMatchObject({ ok: true });
    await h.flush();
    expect((await outboxSeqs(trip)).length).toBe(outbox + 1); // decision.opened only
    expect(h.go.events.filter((e) => e.trip_id === trip).at(-1)).toMatchObject({ type: 'decision.opened', seq: r.body.message.seq - 1 });
    // A repeat of the same press answers the same two objects.
    const again = await t.api(priya, 'POST', `/app/v1/trips/${trip}/decisions`, { client_id: 'poll-1', question: 'Where do we stay?', kind: 'choice', anonymous: false, options: [{ label: 'Villa Sol' }, { label: 'Casa Azul' }] });
    expect([again.status, again.body.message.message_id, again.body.decision.decision_id]).toEqual([201, r.body.message.message_id, decision]);
    // The vote card is the server's: a tap on it is not for Go.
    expect((await t.api(rahul, 'POST', `/app/v1/trips/${trip}/cards/${r.body.message.card.card_id}/actions`, { action_id: 'vote' })).status).toBe(404);
  });

  it('"Villa Sol won · 2 votes" after decision.closed and the decided line, no event; a tie writes no pill', async () => {
    await t.api(rahul, 'PUT', `/app/v1/trips/${trip}/decisions/${decision}/vote`, { option_index: 0 });
    await t.api(priya, 'PUT', `/app/v1/trips/${trip}/decisions/${decision}/vote`, { option_index: 0 }); // everyone voted: it closes
    await h.flush();
    const closed = h.go.events.find((e) => e.type === 'decision.closed' && e.data.decision.decision_id === decision)!;
    const line = h.go.events.find((e) => e.type === 'record.changed' && e.data.line.decision_id === decision)!;
    expect((await pills(trip)).at(-1)).toEqual({ seq: line.seq + 1, text: 'Villa Sol won · 2 votes', card: null });
    expect(line.seq).toBe(closed.seq + 1);
    const tie = (await t.api(priya, 'POST', `/app/v1/trips/${trip}/decisions`, { client_id: 'poll-2', question: 'Tie?', kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }] })).body.decision.decision_id;
    await t.api(rahul, 'PUT', `/app/v1/trips/${trip}/decisions/${tie}/vote`, { option_index: 0 });
    await t.api(priya, 'PUT', `/app/v1/trips/${trip}/decisions/${tie}/vote`, { option_index: 1 });
    expect((await pills(trip)).at(-1)!.text).toBe('Tie?'); // the anchor; no "won"
  });

  it('"Villa Sol booked" after a booking a person adds, and after one Go adds', async () => {
    const r = await t.api(rahul, 'POST', `/app/v1/trips/${trip}/bookings`, { kind: 'stay', title: 'Villa Sol', vendor: 'ixigo', ref: 'R', amount_minor: 100, payer_person_id: rahul.id, for_person_ids: [rahul.id, priya.id] });
    expect(r.status).toBe(201);
    expect((await pills(trip)).at(-1)!.text).toBe('Villa Sol booked');
    await h.go.call('add_booking', { request_id: 'rq_sm_book', trip_id: trip, kind: 'cab', title: 'Airport cab', vendor: 'Kabir Cabs', ref: 'c1', amount_minor: 100000, currency: 'INR', payer_person_id: rahul.id, for_person_ids: [rahul.id] });
    expect((await pills(trip)).at(-1)!.text).toBe('Airport cab booked');
    await h.flush();
    // Every pill took a change number; no pill has an event; every event has its own number: together, no gaps.
    const seqs = [...await outboxSeqs(trip), ...(await pills(trip)).map((p) => p.seq)].sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('a cancellation vote a person proposes gets its anchor too', async () => {
    const [b] = await rows(h.pool, 'select booking_id from bookings where trip_id = $1 order by created_at limit 1', [trip]);
    const r = await t.api(priya, 'POST', `/app/v1/trips/${trip}/bookings/${b.booking_id}/cancel-vote`, {});
    expect(r.status).toBe(201);
    expect((await pills(trip)).at(-1)).toMatchObject({ text: 'Cancel this booking? Villa Sol', card: { kind: 'vote', decision_id: r.body.decision_id } });
    expect(EVERYONE.length).toBe(5); // the seeded names are not in this trip; just a guard that the import is used as elsewhere
  });
});
