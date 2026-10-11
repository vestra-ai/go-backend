// The guide's flow pages, end to end, against the real server code, a real Postgres and a mock Go over the real
// signed socket. Each describe follows one page step by step: what the app does, what the server stores, the
// events Go receives, the requests Go makes back, and what people see (live updates, the "needs you" strip).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check, verifySpendApproval } from '../src/contract/index.js';
import { SPEND_PUBLIC_KEY, rows, startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => (h = await startHarness({ seed: false })));
afterAll(() => h.stop());

type Who = { id: string; token: string; name: string };
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const api = async (who: Who | null, method: Method, url: string, payload?: unknown) => {
  const r = await h.app.inject({ method, url, payload: payload as any, headers: who ? { authorization: `Bearer ${who.token}` } : {} });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
/** Signs a new person in through the fake Supabase Auth, as the app does. */
const person = (name: string, extra: { email?: string; upi_id?: string } = {}): Promise<Who> => h.signIn(name, extra);
let rqN = 0;
const go = async (method: string, tripId: string, params: Record<string, unknown> = {}, request_id = `rq_flow_${++rqN}`) => {
  const f = await h.go.call(method, { request_id, trip_id: tripId, ...params });
  if (f.error) throw new Error(`${method}: ${JSON.stringify(f.error)}`);
  return f.result;
};
const goError = async (method: string, tripId: string, params: Record<string, unknown> = {}) =>
  (await h.go.call(method, { request_id: `rq_flow_${++rqN}`, trip_id: tripId, ...params })).error;
const read = async (method: string, params: Record<string, unknown>) => (await h.go.call(method, params)).result;
/** The events Go received for one trip, after a mark. Every one must match the contract. */
const eventsFor = (tripId: string, from = 0) => {
  const list = h.go.events.slice(from).filter((e) => e.trip_id === tripId);
  for (const e of list) expect(check('Event', e), `${e.type} matches the contract`).toMatchObject({ ok: true });
  return list;
};
const types = (list: Array<Record<string, any>>) => list.map((e) => e.type as string);
const tripSeq = async (tripId: string) => (await rows(h.pool, 'select seq from trips where trip_id = $1', [tripId]))[0].seq as number;
const strip = async (who: Who, tripId: string) => (await api(who, 'GET', `/app/v1/trips/${tripId}/needs-you`)).body.items as any[];
const liveFor = (tripId: string, from = 0) => h.live.events.slice(from).filter((e) => e.tripId === tripId).map((e) => e.event);
const outboxCount = async (tripId: string) => (await rows(h.pool, 'select count(*)::int as n from outbox where trip_id = $1', [tripId]))[0].n as number;

/** A new trip made through the app: the organizer creates it, everyone else joins by the invite link. */
async function newTrip(title: string, organizer: Who, others: Who[] = [], answers: Record<string, unknown> = {}) {
  const t = await api(organizer, 'POST', '/app/v1/trips', { title });
  const code = t.body.invite_url.split('/invite/')[1];
  for (const o of others) await api(o, 'POST', `/app/v1/invites/${code}/accept`, { join_answers: answers[o.id] ?? {} });
  await h.flush();
  return { id: t.body.trip_id as string, code: code as string };
}

const flightCard = (cardId: string) => ({
  card_id: cardId, kind: 'options', fallback_text: '3 flights from Delhi on Friday, from ₹5,920', title: 'Delhi to Goa, Friday', option_kind: 'flight', checked_at: new Date().toISOString(),
  options: [
    { option_id: 'opt_flight_1', title: 'IndiGo 6E 2134', price_minor: 592000, currency: 'INR', highlights: ['Non-stop', '7:05 pm'] },
    { option_id: 'opt_flight_2', title: 'Air India AI 883', price_minor: 615000, currency: 'INR', highlights: ['Non-stop'] },
  ],
  actions: [{ action_id: 'pick', label: 'Pick this', style: 'primary', per_option: true }, { action_id: 'vote', label: 'Vote on these', style: 'secondary' }],
});

// --------------------------------------------------------------------------------------------- F1
describe('F1. Go answers a question (guide: "Go answers a question")', () => {
  let rahul: Who, priya: Who, trip: string, question: string, mark: number, liveMark: number;

  it('1-3. Priya asks Go in the room: stored once, shown live, and sent to Go as message.created with mentions_go', async () => {
    rahul = await person('Rahul');
    priya = await person('Priya');
    trip = (await newTrip('Goa F1', rahul, [priya])).id;
    mark = h.go.events.length;
    liveMark = h.live.events.length;
    const r = await api(priya, 'POST', `/app/v1/trips/${trip}/messages`, { client_message_id: 'f1_q', text: '@Go flights on Friday from Delhi, under 6k?' });
    expect(r.status).toBe(201);
    question = r.body.message_id;
    expect(liveFor(trip, liveMark)).toContainEqual({ kind: 'message', message_id: question, updated_seq: r.body.seq });
    await h.flush();
    const e = eventsFor(trip, mark).find((x) => x.type === 'message.created')!;
    expect(e).toMatchObject({ seq: r.body.seq, data: { message: { message_id: question, mentions_go: true, author: { kind: 'person', person_id: priya.id } } } });
  });

  it('4. Go shows "Go is typing...": a live update for 10 seconds, nothing stored, no answer', async () => {
    const before = await tripSeq(trip);
    liveMark = h.live.events.length;
    h.go.notify('typing', { trip_id: trip, on: true });
    await new Promise((r) => setTimeout(r, 100));
    const typing = liveFor(trip, liveMark).find((e) => e.kind === 'typing') as any;
    expect(typing).toMatchObject({ kind: 'typing', who: { kind: 'go' }, on: true });
    const ms = Date.parse(typing.until) - Date.now();
    expect(ms).toBeGreaterThan(8_000);
    expect(ms).toBeLessThanOrEqual(10_000);
    expect(await tripSeq(trip)).toBe(before);
  });

  it('5. Go reads the trip: the snapshot is at the latest change and holds no contact details', async () => {
    const snap = await read('read_trip', { trip_id: trip });
    expect(check('TripSnapshot', snap)).toMatchObject({ ok: true });
    expect(snap.seq).toBe(await tripSeq(trip));
    expect(snap.people.map((p: any) => p.name)).toEqual(['Rahul', 'Priya']);
    expect(JSON.stringify(snap)).not.toMatch(/phone|email|upi_id/);
  });

  it('6-7. Go replies with a flights card: typing hidden, the card stored as sent, and message.created back to Go', async () => {
    liveMark = h.live.events.length;
    mark = h.go.events.length;
    const card = flightCard('c_flights_1');
    const r = await go('post_message', trip, { text: 'Priya, 2 non-stop flights under ₹6,200 on Friday:', reply_to: question, mentions: [priya.id], card }, 'rq_f1_reply');
    expect(r.seq).toBe((await tripSeq(trip)));
    const live = liveFor(trip, liveMark);
    expect(live).toContainEqual({ kind: 'message', message_id: r.message_id, updated_seq: r.seq });
    expect(live).toContainEqual({ kind: 'typing', who: { kind: 'go' }, on: false });
    const [stored] = await rows(h.pool, 'select card from messages where message_id = $1', [r.message_id]);
    expect(stored.card).toEqual(card);
    await h.flush();
    expect(eventsFor(trip, mark)).toEqual([expect.objectContaining({ type: 'message.created', seq: r.seq, data: { message: expect.objectContaining({ author: { kind: 'go' }, card, mentions_go: false }) } })]);
    // The app's room shows Go's message as Go, with its card.
    const room = (await api(rahul, 'GET', `/app/v1/trips/${trip}/messages?after_seq=0`)).body.messages;
    expect(room.at(-1)).toMatchObject({ message_id: r.message_id, author: { kind: 'go' }, card: { card_id: 'c_flights_1' } });
  });

  it('a repeat of the same request_id changes nothing: same answer, no second message', async () => {
    const seq = await tripSeq(trip);
    const again = await go('post_message', trip, { text: 'Priya, 2 non-stop flights under ₹6,200 on Friday:', mentions: [priya.id], card: flightCard('c_flights_1') }, 'rq_f1_reply');
    expect(again.seq).toBe(seq);
    expect(await tripSeq(trip)).toBe(seq);
  });

  it('8. Priya taps "Pick this": the tap reaches Go with a tap id, and Go\'s toast comes back', async () => {
    const r = await api(priya, 'POST', `/app/v1/trips/${trip}/cards/c_flights_1/actions`, { action_id: 'pick', option_id: 'opt_flight_1', press_id: 'press_1' });
    expect(r).toEqual({ status: 200, body: { result: 'done', toast: 'Noted. Go will reply in the room.' } });
    const sent = h.go.requests.at(-1)!;
    expect(sent.method).toBe('card_tap');
    expect(check('CardTap', sent.params)).toMatchObject({ ok: true });
    expect(sent.params).toMatchObject({ trip_id: trip, card_id: 'c_flights_1', action_id: 'pick', option_id: 'opt_flight_1', person_id: priya.id });
  });

  it('a tap with an action id the contract refuses is 422; a tap Go never answers is a refusal toast after its 3 seconds (app contract §4.7)', async () => {
    expect((await api(priya, 'POST', `/app/v1/trips/${trip}/cards/c_flights_1/actions`, { action_id: 'Pick' })).status).toBe(422);
    h.go.answers.card_tap = () => null;
    const r = await api(priya, 'POST', `/app/v1/trips/${trip}/cards/c_flights_1/actions`, { action_id: 'pick' });
    expect(r).toEqual({ status: 200, body: { result: 'refused', toast: "Go didn't answer. Try again." } });
    h.go.answers.card_tap = () => ({ result: { result: 'done', toast: 'Noted. Go will reply in the room.' } });
  }, 10_000);
});

// --------------------------------------------------------------------------------------------- F2
describe('F2. A trip starts (guide: "A trip starts")', () => {
  let rahul: Who, priya: Who, trip: string, code: string, decision: string;

  it('1-2. Rahul creates the trip: trip.created is change 1, with one person and no contact details', async () => {
    rahul = await person('Rahul', { email: 'r@x.test', upi_id: 'rahul@upi' });
    const mark = h.go.events.length;
    const t = await api(rahul, 'POST', '/app/v1/trips', { title: 'Goa 🌴 F2' });
    expect(t.status).toBe(201);
    expect(t.body.invite_url).toMatch(/\/invite\/[A-Za-z0-9_-]+$/);
    trip = t.body.trip_id;
    code = t.body.invite_url.split('/invite/')[1];
    await h.flush();
    const [created, pill] = eventsFor(trip, mark);
    expect(pill).toMatchObject({ type: 'message.created', seq: 2, data: { message: { seq: 2, author: { kind: 'system' }, text: 'Trip created · Rahul joined' } } }); // the room's pill, change 2
    expect(created).toMatchObject({ type: 'trip.created', seq: 1, data: { trip: { seq: 1, budget: { answered: 0, of: 1 } } } });
    expect(created!.data.trip.people).toEqual([expect.objectContaining({ person_id: rahul.id, role: 'organizer', has_upi: true })]);
    expect(JSON.stringify(created)).not.toMatch(/\+919999|r@x\.test|rahul@upi/);
  });

  it('3-4. Go opens "When can everyone go?" and posts the vote card: changes 3 and 4 (2 was the room\'s "Trip created" pill, sent as message.created)', async () => {
    const mark = h.go.events.length;
    expect((await rows(h.pool, 'select seq, author_kind, text from messages where trip_id = $1', [trip]))).toEqual([{ seq: 2, author_kind: 'system', text: 'Trip created · Rahul joined' }]);
    const o = await go('open_vote', trip, { question: 'When can everyone go?', kind: 'choice', anonymous: false, options: [{ label: '6-9 Nov' }, { label: '13-16 Nov' }] });
    expect(o.seq).toBe(3);
    decision = o.decision_id;
    const m = await go('post_message', trip, { text: 'Hi all, I\'m Go. First: when can everyone go?', card: { card_id: 'c_when_vote', kind: 'vote', decision_id: decision, fallback_text: 'Vote: when can everyone go?' } });
    expect(m.seq).toBe(4);
    await h.flush();
    const list = eventsFor(trip, mark);
    expect(types(list)).toEqual(['decision.opened', 'message.created']);
    expect(list[0]!.data).toMatchObject({ by: { kind: 'go' }, decision: { decision_id: decision, status: 'open', voted: 0, of: 1 } });
  });

  it('5. The invite link shows a preview without signing in', async () => {
    expect((await api(null, 'GET', `/app/v1/invites/${code}`)).body).toMatchObject({ state: 'pending', trip: { trip_id: trip, title: 'Goa 🌴 F2' }, inviter: { person_id: rahul.id }, joined_count: 1 });
  });

  it('6. Priya joins with her answers: person.joined, then her pill as message.created, no budget event; the open vote now waits for 2; she lands in the chat Go started', async () => {
    priya = await person('Priya');
    const mark = h.go.events.length;
    const r = await api(priya, 'POST', `/app/v1/invites/${code}/accept`, { join_answers: { from_city: 'Delhi', know: ['Vegetarian', 'Window seat'] } });
    expect(r.body).toEqual({ trip_id: trip, seq: 6, landing: 'chat' }); // the trip's change number after the join: her "joined" line (6), after person.joined (5)
    await h.flush();
    const list = eventsFor(trip, mark);
    expect(list.map((e) => [e.type, e.seq])).toEqual([['person.joined', 5], ['message.created', 6]]);
    expect((await rows(h.pool, 'select seq, text from messages where trip_id = $1 and author_kind = $2 order by seq', [trip, 'system'])).at(-1)).toEqual({ seq: 6, text: 'Priya joined' }); // the pill, after the event
    expect(list[1]!.data.message).toMatchObject({ seq: 6, author: { kind: 'system' }, text: 'Priya joined' });
    expect(list[0]!.data.person).toMatchObject({ person_id: priya.id, from_city: 'Delhi', know: ['Vegetarian', 'Window seat'] });
    const snap = await read('read_trip', { trip_id: trip });
    expect(snap.decisions[0]).toMatchObject({ decision_id: decision, of: 2 });
    expect(snap.budget).toEqual({ answered: 0, of: 2 }); // no group budget set
  });

  it('7-8. The vote is in both strips; both vote; it closes by itself and the decided line follows, then the "won" pill', async () => {
    expect(await strip(priya, trip)).toContainEqual(expect.objectContaining({ item_id: `vote:${decision}:${priya.id}`, kind: 'vote', title: 'When can everyone go?', cta_label: 'Vote', target: expect.objectContaining({ decision_id: decision }) }));
    const mark = h.go.events.length;
    await api(rahul, 'PUT', `/app/v1/trips/${trip}/decisions/${decision}/vote`, { option_index: 0 });
    await api(priya, 'PUT', `/app/v1/trips/${trip}/decisions/${decision}/vote`, { option_index: 0 });
    await h.flush();
    const list = eventsFor(trip, mark);
    expect(types(list)).toEqual(['decision.voted', 'decision.voted', 'decision.closed', 'record.changed', 'message.created']);
    expect(list[4]).toMatchObject({ seq: list[3]!.seq + 1, data: { message: { author: { kind: 'system' }, text: '6-9 Nov won · 2 votes' } } });
    expect(list[2]!.data).toMatchObject({ reason: 'everyone_voted', decision: { result_index: 0, tally: [2, 0] } });
    expect(list[3]!.data).toMatchObject({ change: 'added', by: { kind: 'system' }, line: { kind: 'decided', text: '6-9 Nov', source: 'vote' } });
    expect(await strip(priya, trip)).toEqual([]);
  });
});

// --------------------------------------------------------------------------------------------- F3
describe('F3. The group agrees in the chat without a vote (guide: "The group agrees...")', () => {
  let rahul: Who, priya: Who, arjun: Who, kabir: Who, trip: string, m1: string, m2: string, line: string;

  it('1. Priya and Arjun agree in the chat: two message.created, not for Go', async () => {
    [rahul, priya, arjun, kabir] = [await person('Rahul'), await person('Priya'), await person('Arjun'), await person('Kabir')];
    trip = (await newTrip('Goa F3', rahul, [priya, arjun, kabir])).id;
    const mark = h.go.events.length;
    m1 = (await api(priya, 'POST', `/app/v1/trips/${trip}/messages`, { client_message_id: 'f3_1', text: "Let's do North Goa, it's livelier" })).body.message_id;
    m2 = (await api(arjun, 'POST', `/app/v1/trips/${trip}/messages`, { client_message_id: 'f3_2', text: 'Yes, North. South is too quiet' })).body.message_id;
    await h.flush();
    expect(eventsFor(trip, mark).map((e) => [e.type, e.data.message.mentions_go])).toEqual([['message.created', false], ['message.created', false]]);
  });

  it('2. Rahul 👍s Priya\'s message: reaction.added with his id, and the message moves to a new change number', async () => {
    const mark = h.go.events.length;
    const r = await api(rahul, 'PUT', `/app/v1/trips/${trip}/messages/${m1}/reaction`, { emoji: '👍' });
    expect(r.body.updated_seq).toBeGreaterThan(r.body.seq);
    await h.flush();
    expect(eventsFor(trip, mark)).toEqual([expect.objectContaining({ type: 'reaction.added', data: { message_id: m1, reaction: { emoji: '👍', person_id: rahul.id } } })]);
    const page = await read('read_messages', { trip_id: trip, after_seq: r.body.updated_seq - 1 });
    expect(page.messages[0]).toMatchObject({ message_id: m1, updated_seq: r.body.updated_seq, reactions: [{ emoji: '👍', person_id: rahul.id }] });
  });

  it('3. Go writes the agreed line with proof: record.changed added by Go', async () => {
    const mark = h.go.events.length;
    const r = await go('add_record_line', trip, { kind: 'agreed', text: 'North Goa, not South', proof: [{ message_id: m1, person_id: priya.id }, { message_id: m2, person_id: arjun.id }], person_ids: [priya.id, arjun.id] });
    line = r.line_id;
    await h.flush();
    expect(eventsFor(trip, mark)).toEqual([expect.objectContaining({ type: 'record.changed', seq: r.seq, data: expect.objectContaining({ change: 'added', by: { kind: 'go' } }) })]);
    expect(await goError('add_record_line', trip, { kind: 'agreed', text: 'no proof', proof: [], person_ids: [] })).toMatchObject({ code: 422 });
    expect(await goError('add_record_line', trip, { kind: 'decided', text: 'Go cannot decide', proof: [{ message_id: m1 }], person_ids: [] })).toMatchObject({ code: 422 });
  });

  it('4. Go reacts ✅ quietly: a reaction with no person; the same ✅ again is a 409', async () => {
    const mark = h.go.events.length;
    const liveMark = h.live.events.length;
    await go('add_reaction', trip, { message_id: m1, emoji: '✅' });
    expect(liveFor(trip, liveMark)).toContainEqual(expect.objectContaining({ kind: 'message', message_id: m1 }));
    await h.flush();
    expect(eventsFor(trip, mark)).toEqual([expect.objectContaining({ type: 'reaction.added', data: { message_id: m1, reaction: { emoji: '✅' } } })]);
    expect(await goError('add_reaction', trip, { message_id: m1, emoji: '✅' })).toMatchObject({ code: 409 });
    const shown = (await api(priya, 'GET', `/app/v1/trips/${trip}/messages?after_seq=0`)).body.messages.find((m: any) => m.message_id === m1);
    expect(shown.reactions).toEqual(expect.arrayContaining([{ emoji: '✅' }, { emoji: '👍', person_id: rahul.id }]));
  });

  it('5. Kabir undoes the line: record.changed undone by Kabir; a second undo changes nothing; Go cannot write it back', async () => {
    const mark = h.go.events.length;
    expect((await api(kabir, 'POST', `/app/v1/trips/${trip}/record/${line}/undo`)).body).toMatchObject({ line_id: line, status: 'undone' });
    expect((await api(kabir, 'POST', `/app/v1/trips/${trip}/record/${line}/undo`)).body).toMatchObject({ line_id: line, status: 'undone' }); // a second undo changes nothing
    await h.flush();
    expect(eventsFor(trip, mark)).toEqual([expect.objectContaining({ type: 'record.changed', data: expect.objectContaining({ change: 'undone', by: { kind: 'person', person_id: kabir.id }, line: expect.objectContaining({ status: 'undone' }) }) })]);
    expect(await goError('update_record_line', trip, { line_id: line, text: 'North Goa after all' })).toMatchObject({ code: 409 });
    expect(await goError('update_record_line', trip, { line_id: line, status: 'undone' })).toMatchObject({ code: 422 });
  });
});

// --------------------------------------------------------------------------------------------- F4
describe('F4. From a vote to a booking (guides: "From a vote to a booking", "Money and the vault")', () => {
  let rahul: Who, priya: Who, arjun: Who, meher: Who, kabir: Who, all: Who[], trip: string, villa: string;
  let approval: { approval_id: string; approval: string; expires_at: string };
  const spend = (request_id: string, over: Record<string, unknown> = {}) =>
    h.go.call('request_spend_approval', { request_id, trip_id: trip, decision_id: villa, amount_minor: 5420000, currency: 'INR', merchant: 'ixigo: Villa Sol, Anjuna', purpose: 'Villa Sol, 3 nights', refundable_until: new Date(Date.now() + 30 * 86_400_000).toISOString(), ...over }).then((f) => f.result);
  const mandate = { choice_index: 0, cap_minor: 5500000, currency: 'INR', refundable_only: true };

  it('1. Five people vote on where to stay; the last vote closes it and writes the decided line, then the "won" pill', async () => {
    [rahul, priya, arjun, meher, kabir] = [await person('Rahul', { upi_id: 'rahul@upi' }), await person('Priya'), await person('Arjun'), await person('Meher'), await person('Kabir')];
    all = [rahul, priya, arjun, meher, kabir];
    trip = (await newTrip('Goa F4', rahul, [priya, arjun, meher, kabir])).id;
    const o = await go('open_vote', trip, { question: 'Where do we stay?', kind: 'choice', anonymous: false, options: [
      { label: 'Villa Sol', price_minor: 5420000, currency: 'INR' }, { label: 'Casa Azul', price_minor: 6180000, currency: 'INR' }, { label: 'Beach Hut', price_minor: 3900000, currency: 'INR' },
    ] });
    villa = o.decision_id;
    const mark = h.go.events.length;
    for (const w of [rahul, priya, arjun, meher]) await api(w, 'PUT', `/app/v1/trips/${trip}/decisions/${villa}/vote`, { option_index: 0 });
    await api(kabir, 'PUT', `/app/v1/trips/${trip}/decisions/${villa}/vote`, { option_index: 1 });
    await h.flush();
    const list = eventsFor(trip, mark);
    expect(types(list).slice(-3)).toEqual(['decision.closed', 'record.changed', 'message.created']);
    expect(list.at(-3)!.data).toMatchObject({ reason: 'everyone_voted', decision: { result_index: 0, tally: [4, 1, 0] } });
    expect(list.at(-2)!.data).toMatchObject({ by: { kind: 'system' }, line: { kind: 'decided', text: 'Villa Sol' } });
    expect(list.at(-1)!.data.message).toMatchObject({ author: { kind: 'system' }, text: 'Villa Sol won · 4 votes' });
  });

  it('2-3. A mandate card needs a mandate first; Go sets the mandate and it shows in Rahul\'s strip', async () => {
    const card = { card_id: 'c_villa_mandate', kind: 'mandate', decision_id: villa, fallback_text: 'Rahul, book Villa Sol up to ₹55,000?' };
    expect(await goError('post_message', trip, { card })).toMatchObject({ code: 409 });
    const mark = h.go.events.length;
    await go('set_mandate', trip, { decision_id: villa, ...mandate, payer_person_id: rahul.id });
    await h.flush();
    expect(eventsFor(trip, mark)[0]).toMatchObject({ type: 'mandate.set', data: { decision_id: villa, mandate: { payer_person_id: rahul.id, cap_minor: 5500000 } } });
    expect(eventsFor(trip, mark)[0]!.data.mandate.confirmed_at).toBeUndefined();
    expect(await strip(rahul, trip)).toContainEqual(expect.objectContaining({ item_id: `mandate:${villa}`, kind: 'mandate', title: 'Yes, book it? Villa Sol, up to ₹55,000', subtitle: 'Where do we stay?', cta_label: 'Yes, book it', target: expect.objectContaining({ decision_id: villa }) }));
    expect(await strip(priya, trip)).toEqual([]);
    await go('post_message', trip, { text: 'Rahul, shall I book Villa Sol?', card });
  });

  it('4-5. The spend check waits for the payer: "not confirmed", only Rahul can answer, "Not now", then "Yes, book it"', async () => {
    expect(await spend('rq_spend_1')).toMatchObject({ status: 'denied', reason: 'payer_has_not_confirmed' });
    expect((await api(priya, 'POST', `/app/v1/trips/${trip}/decisions/${villa}/mandate/confirm`)).status).toBe(403);
    await h.flush();
    const mark = h.go.events.length;
    await api(rahul, 'POST', `/app/v1/trips/${trip}/decisions/${villa}/mandate/decline`);
    expect(await spend('rq_spend_declined')).toMatchObject({ status: 'denied', reason: 'payer_declined' });
    await api(rahul, 'POST', `/app/v1/trips/${trip}/decisions/${villa}/mandate/confirm`);
    await h.flush();
    expect(eventsFor(trip, mark).map((e) => [e.type, e.data])).toEqual([
      ['mandate.declined', { decision_id: villa, person_id: rahul.id }],
      ['mandate.confirmed', { decision_id: villa, person_id: rahul.id }],
    ]);
    expect((await strip(rahul, trip)).find((x) => x.kind === 'mandate')).toBeUndefined();
  });

  it('a price over the cap is denied with the exact detail; a new mandate clears the yes', async () => {
    expect(await spend('rq_spend_over', { amount_minor: 5640000 })).toEqual({ status: 'denied', reason: 'over_cap', detail: '5640000 INR is above the cap of 5500000 INR' });
    await go('set_mandate', trip, { decision_id: villa, ...mandate, payer_person_id: rahul.id });
    expect(await spend('rq_spend_after_new')).toMatchObject({ reason: 'payer_has_not_confirmed' });
    expect(await strip(rahul, trip)).toContainEqual(expect.objectContaining({ kind: 'mandate' }));
    await api(rahul, 'POST', `/app/v1/trips/${trip}/decisions/${villa}/mandate/confirm`);
  });

  it('6. The spend approval: signed for Rahul, 10 minutes, the same for a repeat, and only one at a time; not a trip change', async () => {
    await h.flush();
    const seq = await tripSeq(trip);
    const outbox = await outboxCount(trip);
    approval = await spend('rq_spend_2');
    expect(approval).toMatchObject({ status: 'approved', approval_id: expect.stringMatching(/^ap_[0-9a-f]{16}$/) });
    expect(check('SpendApprovalResult', approval)).toMatchObject({ ok: true });
    const v = verifySpendApproval(approval.approval, SPEND_PUBLIC_KEY);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.claims).toMatchObject({ iss: 'server', aud: 'go-vault', jti: approval.approval_id, trip_id: trip, decision_id: villa, payer_person_id: rahul.id, amount_minor: 5420000, currency: 'INR' });
      expect(v.claims.exp - v.claims.iat).toBe(600);
    }
    expect(await spend('rq_spend_2')).toEqual(approval);
    expect(await spend('rq_spend_3')).toMatchObject({ status: 'denied', reason: 'approval_outstanding' });
    expect(await tripSeq(trip)).toBe(seq);
    expect(await outboxCount(trip)).toBe(outbox);
  });

  it('7. Go posts the pay card for Rahul: it is in his strip', async () => {
    const r = await go('post_message', trip, { text: 'Ready to pay', card: {
      card_id: 'c_villa_pay', kind: 'pay', fallback_text: 'Rahul, approve ₹54,200 for Villa Sol', for_person_ids: [rahul.id], approval_id: approval.approval_id,
      payer_person_id: rahul.id, amount_minor: 5420000, currency: 'INR', merchant: 'ixigo: Villa Sol, Anjuna', purpose: 'Villa Sol, 3 nights', expires_at: approval.expires_at, state: 'waiting',
      actions: [{ action_id: 'approve', label: 'Approve', style: 'primary', only_for_person_ids: [rahul.id] }, { action_id: 'decline', label: 'Not now', style: 'secondary', only_for_person_ids: [rahul.id] }],
    } });
    expect(await strip(rahul, trip)).toContainEqual({ item_id: 'card:c_villa_pay', kind: 'card', title: 'Rahul, approve ₹54,200 for Villa Sol', cta_label: 'Approve', since: expect.any(String), target: { card_id: 'c_villa_pay', message_id: r.message_id } });
  });

  it('8. Rahul taps Approve: the demo takes the payment as done, the tap never reaches Go, and the card is paid (docs/GO-TEAM-DEMO-PAYMENT.md)', async () => {
    const [decided] = await rows(h.pool, "select line_id from record_lines where decision_id = $1 and kind = 'decided'", [villa]);
    await h.flush();
    const [mark, taps] = [h.go.events.length, h.go.requests.filter((q) => q.method === 'card_tap').length];
    const r = await api(rahul, 'POST', `/app/v1/trips/${trip}/cards/c_villa_pay/actions`, { action_id: 'approve', press_id: 'tap_0457' });
    expect([r.status, r.body]).toEqual([200, { result: 'done' }]);
    expect(h.go.requests.filter((q) => q.method === 'card_tap').length).toBe(taps);
    expect((await rows(h.pool, 'select card from messages where card_id = $1', ['c_villa_pay']))[0].card).toMatchObject({ state: 'paid', actions: null });
    const [b] = await rows(h.pool, 'select booking_id, title from bookings where trip_id = $1 and approval_id = $2', [trip, approval.approval_id]);
    expect((await rows(h.pool, 'select used_at, booking_id from spend_approvals where approval_id = $1', [approval.approval_id]))[0]).toMatchObject({ used_at: expect.any(Date), booking_id: b.booking_id });
    await h.flush();
    const list = eventsFor(trip, mark);
    expect(list.map((e) => e.type)).toEqual(['booking.changed', 'record.changed', 'expense.changed', 'payment.completed', 'message.created', 'message.created']);
    expect(list[1]!.data).toMatchObject({ change: 'updated', by: { kind: 'system' }, line: { line_id: decided.line_id, kind: 'booked', booking_id: b.booking_id } });
    expect(list[3]!.data).toMatchObject({ approval_id: approval.approval_id, card_id: 'c_villa_pay', decision_id: villa, booking_id: b.booking_id, method: 'demo' });
    expect(list[4]!.data.message).toMatchObject({ author: { kind: 'system' }, text: `${b.title} booked` });
  });

  it('9. Go does not book it again: add_booking with that approval is refused', async () => {
    const params = { kind: 'stay', title: 'Villa Sol, 3 nights', vendor: 'ixigo', ref: 'IXG-7Q2K9', amount_minor: 5420000, currency: 'INR', payer_person_id: rahul.id, for_person_ids: all.map((p) => p.id), decision_id: villa, approval_id: approval.approval_id };
    expect(await goError('add_booking', trip, params)).toMatchObject({ code: 409 });
  });

  it('10. Go posts the ticket card for the Server\'s booking', async () => {
    const [b] = await rows(h.pool, 'select booking_id, approval_id from bookings where trip_id = $1', [trip]);
    expect(await goError('post_message', trip, { card: { card_id: 'c_ticket_bad', kind: 'ticket', booking_id: 'b_nope', fallback_text: 'x' } })).toMatchObject({ code: 422 });
    await go('post_message', trip, { text: 'Booked!', card: { card_id: 'c_villa_ticket', kind: 'ticket', booking_id: b.booking_id, fallback_text: 'Villa Sol is booked' } });
  });

  it('12. Go marks the pay card paid with replace_card: a change number (updated_seq) but no event, and Rahul\'s strip is clear', async () => {
    await h.flush();
    const seq = await tripSeq(trip);
    const outbox = await outboxCount(trip);
    const liveMark = h.live.events.length;
    const r = await read('replace_card', { trip_id: trip, card: {
      card_id: 'c_villa_pay', kind: 'pay', fallback_text: 'Paid ₹54,200 for Villa Sol', for_person_ids: [], approval_id: approval.approval_id, payer_person_id: rahul.id,
      amount_minor: 5420000, currency: 'INR', merchant: 'ixigo: Villa Sol, Anjuna', purpose: 'Villa Sol, 3 nights', expires_at: approval.expires_at, state: 'paid', actions: [],
    } });
    expect(r.message_id).toBeTruthy();
    expect(await tripSeq(trip)).toBe(seq + 1); // the replaced card takes a change number (D9) so an offline phone can fetch it...
    expect(await outboxCount(trip)).toBe(outbox); // ...but no event: Go replaced it itself
    expect(liveFor(trip, liveMark)).toContainEqual({ kind: 'card', message_id: r.message_id });
    expect((await strip(rahul, trip)).find((x) => x.kind === 'card')).toBeUndefined();
  });

  it('branch: a booked vote gets no second approval (it would charge twice) until its booking is cancelled', async () => {
    const again = await spend('rq_spend_booked');
    expect(again).toMatchObject({ status: 'denied', reason: 'already_booked', detail: expect.stringMatching(/^this vote is already booked/) });
    expect(check('SpendApprovalResult', again)).toMatchObject({ ok: true });
    // The stay falls through: Go cancels the booking, and the vote can be booked again (the branches below need that).
    const [b] = await rows(h.pool, "select booking_id from bookings where trip_id = $1 and decision_id = $2 and status = 'confirmed'", [trip, villa]);
    await go('update_booking', trip, { booking_id: b.booking_id, status: 'cancelled' });
  });

  it('branch: "Not now" on the pay card: Go cancels the approval (safe twice), it cannot be booked, and a new one is approved', async () => {
    // The villa's booking was cancelled in the branch above; without that the vote is already booked and gets no new approval.
    const second = await spend('rq_spend_4');
    expect(second.status).toBe('approved'); // the used approval no longer counts as outstanding
    expect(await go('cancel_spend_approval', trip, { approval_id: second.approval_id, reason: 'payer_declined' })).toEqual({ ok: true });
    expect(await go('cancel_spend_approval', trip, { approval_id: second.approval_id, reason: 'payer_declined' })).toEqual({ ok: true });
    expect(await goError('add_booking', trip, { kind: 'stay', title: 'x', vendor: 'x', ref: 'x', amount_minor: 5420000, currency: 'INR', payer_person_id: rahul.id, for_person_ids: [rahul.id], decision_id: villa, approval_id: second.approval_id })).toMatchObject({ code: 409 });
    // Cancelling the approval that was used changes nothing.
    expect(await go('cancel_spend_approval', trip, { approval_id: approval.approval_id, reason: 'other' })).toEqual({ ok: true });
    expect((await rows(h.pool, 'select cancelled_at from spend_approvals where approval_id = $1', [approval.approval_id]))[0].cancelled_at).toBeNull();
    expect((await spend('rq_spend_5')).status).toBe('approved');
  });

  it('branch: an approval that expired no longer counts as outstanding', async () => {
    await h.pool.query("update spend_approvals set expires_at = now() - interval '1 second' where trip_id = $1 and used_at is null and cancelled_at is null", [trip]);
    expect((await spend('rq_spend_6')).status).toBe('approved');
  });
});

// --------------------------------------------------------------------------------------------- F5
describe('F5. A phone call (guide: "A phone call")', () => {
  let rahul: Who, arjun: Who, priya: Who, trip: string, ask: string, announce: string, call: string;
  const callCard = (state: string, extra: Record<string, unknown> = {}) => ({
    card_id: 'c_villa_call', kind: 'call', fallback_text: 'Go is calling Villa Sol about a late check-in', call_id: 'call_1', business: 'Villa Sol', goal: 'Late check-in on the 6th', state,
    actions: state === 'ended' ? [] : [{ action_id: 'stop', label: 'Stop', style: 'secondary' }], ...extra,
  });

  it('1-2. Arjun asks Go to call; Go announces the call as a reply', async () => {
    [rahul, arjun, priya] = [await person('Rahul'), await person('Arjun'), await person('Priya')];
    trip = (await newTrip('Goa F5', rahul, [arjun, priya])).id;
    const mark = h.go.events.length;
    ask = (await api(arjun, 'POST', `/app/v1/trips/${trip}/messages`, { client_message_id: 'f5_ask', text: '@Go I land late on the 6th, can you ask Villa Sol about a late check-in?' })).body.message_id;
    await h.flush();
    expect(eventsFor(trip, mark)[0]!.data.message.mentions_go).toBe(true);
    announce = (await go('post_message', trip, { text: "I'll call Villa Sol now about a late check-in. Say stop in the next 30 seconds if you'd rather I didn't.", reply_to: ask })).message_id;
  });

  it('3. Priya replies to Go without naming it: still for Go', async () => {
    await h.flush();
    const mark = h.go.events.length;
    await api(priya, 'POST', `/app/v1/trips/${trip}/messages`, { client_message_id: 'f5_reply', text: 'also ask about parking', reply_to: announce });
    await h.flush();
    expect(eventsFor(trip, mark)[0]!.data.message).toMatchObject({ mentions_go: true, reply_to: announce });
  });

  it('4-5. The call card: dialing, then talking, then ended, each replaced in place with only live updates', async () => {
    call = (await go('post_message', trip, { card: callCard('dialing') })).message_id;
    await h.flush();
    const seq = await tripSeq(trip);
    const outbox = await outboxCount(trip);
    const liveMark = h.live.events.length;
    await read('replace_card', { trip_id: trip, card: callCard('talking', { started_at: new Date().toISOString(), last_line: { who: 'them', text: 'Yes, we can hold the key for you.' } }) });
    await read('replace_card', { trip_id: trip, card: callCard('ended', { ended_at: new Date().toISOString(), outcome: 'Late check-in is fine, ₹2,000 off if we pay the deposit this week', transcript: [{ who: 'go', text: 'Hi, calling for Arjun...' }, { who: 'them', text: 'Yes, we can hold the key for you.' }] }) });
    expect(await tripSeq(trip)).toBe(seq + 2); // one change number per replaced card (D9), no event
    expect(await outboxCount(trip)).toBe(outbox);
    expect(liveFor(trip, liveMark).filter((e) => e.kind === 'card')).toHaveLength(2);
    const [stored] = await rows(h.pool, 'select card from messages where message_id = $1', [call]);
    expect(stored.card).toMatchObject({ state: 'ended', outcome: expect.stringContaining('₹2,000 off') });
  });

  it('6. Stop on the call card is a Go button: the tap reaches Go while the call is live; once it has ended the card has no Stop', async () => {
    // The first call ended in 4-5 (its card has no buttons now), so Go's second call to Villa Sol is the live one here.
    await go('post_message', trip, { card: callCard('dialing', { card_id: 'c_villa_call_2', call_id: 'call_2', goal: 'Ask about parking' }) });
    const r = await api(arjun, 'POST', `/app/v1/trips/${trip}/cards/c_villa_call_2/actions`, { action_id: 'stop' });
    expect(r.status).toBe(200);
    expect(h.go.requests.at(-1)).toMatchObject({ method: 'card_tap', params: { card_id: 'c_villa_call_2', action_id: 'stop', person_id: arjun.id } });
    expect((await read('replace_card', { trip_id: trip, card: callCard('ended', { card_id: 'c_villa_call_2', call_id: 'call_2', goal: 'Ask about parking', ended_at: new Date().toISOString(), outcome: 'Stopped by Arjun' }) }))?.message_id).toBeTruthy();
    // Stop on the ended call is refused and never reaches Go.
    const sent = h.go.requests.length;
    const late = await api(arjun, 'POST', `/app/v1/trips/${trip}/cards/c_villa_call/actions`, { action_id: 'stop' });
    expect([late.status, late.body.error.code, late.body.error.field]).toEqual([422, 'invalid', 'action_id']);
    expect(h.go.requests.length).toBe(sent);
  });

  it('7-8. Go posts the outcome naming Rahul and writes the open question for him in the record (his strip)', async () => {
    const text = 'Late check-in is fine. Rahul, Villa Sol offers ₹2,000 off if we pay the deposit this week. Shall we?';
    const m = await go('post_message', trip, { text, reply_to: ask, mentions: [rahul.id] });
    const mark = h.go.events.length;
    const l = await go('add_record_line', trip, { kind: 'open', text: '₹2,000 off Villa Sol: pay the deposit this week?', proof: [{ message_id: call }], person_ids: [rahul.id], due_at: new Date(Date.now() + 5 * 86_400_000).toISOString() });
    await h.flush();
    expect(eventsFor(trip, mark).at(-1)).toMatchObject({ type: 'record.changed', data: { change: 'added', by: { kind: 'go' }, line: { kind: 'open' } } });
    expect(await strip(rahul, trip)).toContainEqual(expect.objectContaining({ item_id: `record_line:${l.line_id}`, kind: 'record_line', title: '₹2,000 off Villa Sol: pay the deposit this week?', subtitle: expect.stringMatching(/^due \d{4}-\d{2}-\d{2}$/), target: { line_id: l.line_id } }));
  });
});

// --------------------------------------------------------------------------------------------- F6
describe('F6. Someone opens the room after a while (guide: "Someone opens the room after a while")', () => {
  let rahul: Who, meher: Who, trip: string;
  beforeAll(() => (h.ctx.limits = { messagesPerMinute: 1000 })); // Rahul posts 38 messages in a minute here; the 30-a-minute rule is tested in tests/messages-paging.test.ts
  afterAll(() => delete h.ctx.limits);
  const post = async (n: number, prefix: string) => {
    for (let i = 0; i < n; i++) expect((await api(rahul, 'POST', `/app/v1/trips/${trip}/messages`, { client_message_id: `${prefix}_${i}`, text: `message ${prefix} ${i}` })).status).toBe(201);
  };

  it('1-3. Meher was away 6 hours with 23 unread: the room loads at once, then the catch-up is asked of Go and shown only to her', async () => {
    [rahul, meher] = [await person('Rahul'), await person('Meher')];
    trip = (await newTrip('Goa F6', rahul, [meher])).id;
    await h.pool.query("update trip_people set last_seen_at = now() - interval '6 hours' where trip_id = $1 and person_id = $2", [trip, meher.id]);
    await post(23, 'f6a');
    const [seen] = await rows(h.pool, 'select last_seen_at from trip_people where trip_id = $1 and person_id = $2', [trip, meher.id]);
    expect((await api(meher, 'GET', `/app/v1/trips/${trip}`)).status).toBe(200);
    expect((await api(meher, 'GET', `/app/v1/trips/${trip}/messages?after_seq=0`)).body.messages.filter((m: any) => m.author.kind === 'person')).toHaveLength(23);
    await h.flush();
    const seq = await tripSeq(trip);
    const outbox = await outboxCount(trip);
    const r = await api(meher, 'GET', `/app/v1/trips/${trip}/catch-up`);
    expect([r.status, r.body]).toEqual([200, expect.objectContaining({ summary: expect.any(String), items: expect.any(Array) })]);
    const asked = h.go.requests.at(-1)!;
    expect(asked).toEqual({ method: 'catch_up', params: { trip_id: trip, person_id: meher.id, since: seen.last_seen_at.toISOString() } });
    expect(check('CatchUpRequest', asked.params)).toMatchObject({ ok: true });
    expect(await tripSeq(trip)).toBe(seq); // nothing posted to the room
    expect(await outboxCount(trip)).toBe(outbox);
  });

  it('15 unread is enough even when she was here a moment ago', async () => {
    await api(meher, 'POST', `/app/v1/trips/${trip}/read`);
    await post(14, 'f6b');
    const before = h.go.requests.length;
    expect((await api(meher, 'GET', `/app/v1/trips/${trip}/catch-up`)).status).toBe(204);
    expect(h.go.requests.length).toBe(before); // Go is not asked
    await post(1, 'f6c');
    expect((await api(meher, 'GET', `/app/v1/trips/${trip}/catch-up`)).status).toBe(200);
  });

  it('after "seen" there is nothing to catch up on, and Go is not asked', async () => {
    await api(meher, 'POST', `/app/v1/trips/${trip}/read`);
    const before = h.go.requests.length;
    expect((await api(meher, 'GET', `/app/v1/trips/${trip}/catch-up`)).status).toBe(204);
    expect(h.go.requests.length).toBe(before);
  });

  it('Go not answering a catch-up is 204 after its 3 seconds (nothing to show); the room itself never waited for it', async () => {
    h.go.answers.catch_up = () => null;
    const r = await api(meher, 'GET', `/app/v1/trips/${trip}/catch-up?force=1`);
    expect([r.status, r.body]).toEqual([204, null]);
    h.go.answers.catch_up = () => ({ result: { summary: 'While you were away, Villa Sol won the vote.', items: [{ kind: 'decided', text: 'Villa Sol won, 4 to 1' }] } });
  }, 10_000);
});

// --------------------------------------------------------------------------------------------- F7
describe('F7. Forget me (guides: "Forget me", "People and privacy")', () => {
  let rahul: Who, kabir: Who, tripA: string, tripB: string;
  const answersOf = async (trip: string) => (await rows(h.pool, 'select from_city, earliest_leave, know from trip_people where trip_id = $1 and person_id = $2', [trip, kabir.id]))[0];

  it('setup: Kabir is in two trips with his join answers, and has written in one', async () => {
    [rahul, kabir] = [await person('Rahul'), await person('Kabir')];
    const join = { from_city: 'Pune', earliest_leave: 'Fri 5 pm', know: ['Allergic to nuts'] };
    tripA = (await newTrip('Goa F7 A', rahul, [kabir], { [kabir.id]: join })).id;
    tripB = (await newTrip('Goa F7 B', rahul, [kabir], { [kabir.id]: join })).id;
    await api(kabir, 'POST', `/app/v1/trips/${tripA}/messages`, { client_message_id: 'f7_m', text: 'I booked the cab' });
    expect(await answersOf(tripA)).toEqual({ from_city: 'Pune', earliest_leave: 'Fri 5 pm', know: ['Allergic to nuts'] });
  });

  it('"What Go knows about you" asks Go for the signed-in person only', async () => {
    const r = await api(kabir, 'GET', '/app/v1/me/go');
    expect(r.body).toEqual({ person_id: kabir.id, carry_over: false, facts: [] });
    expect(h.go.requests.at(-1)).toEqual({ method: 'get_person', params: { person_id: kabir.id } });
  });

  it('forget in one trip: Go first, then only that trip\'s answers are cleared and Go hears person.updated; messages stay', async () => {
    const mark = h.go.events.length;
    const r = await api(kabir, 'DELETE', `/app/v1/me/go?trip_id=${tripA}`);
    expect(r.body).toEqual({ deleted_facts: 3, remaining_facts: 0 });
    expect(h.go.requests.at(-1)).toEqual({ method: 'forget_person', params: { person_id: kabir.id, trip_id: tripA } });
    expect(await answersOf(tripA)).toEqual({ from_city: null, earliest_leave: null, know: [] });
    expect(await answersOf(tripB)).toEqual({ from_city: 'Pune', earliest_leave: 'Fri 5 pm', know: ['Allergic to nuts'] });
    await h.flush();
    const list = h.go.events.slice(mark).filter((e) => e.type === 'person.updated');
    expect(list.map((e) => e.trip_id)).toEqual([tripA]);
    expect(list[0]!.data.changed).toEqual(['from_city', 'earliest_leave', 'know']);
    expect((await rows(h.pool, 'select count(*)::int as n from messages where author_person_id = $1', [kabir.id]))[0].n).toBe(1);
  });

  it('forget everywhere: person.updated in each trip that still had answers (trip A was already cleared)', async () => {
    const mark = h.go.events.length;
    await api(kabir, 'DELETE', '/app/v1/me/go');
    expect(h.go.requests.at(-1)).toEqual({ method: 'forget_person', params: { person_id: kabir.id } });
    await h.flush();
    expect(h.go.events.slice(mark).filter((e) => e.type === 'person.updated').map((e) => e.trip_id)).toEqual([tripB]);
    expect(await answersOf(tripB)).toEqual({ from_city: null, earliest_leave: null, know: [] });
  });

  it('Go says facts are left: 502 and nothing is cleared; Go silent: 504', async () => {
    h.go.answers.forget_person = () => ({ result: { deleted_facts: 1, remaining_facts: 2 } });
    expect((await api(kabir, 'DELETE', `/app/v1/me/go?trip_id=${tripA}`)).status).toBe(502);
    h.go.answers.forget_person = () => null;
    expect((await api(kabir, 'DELETE', `/app/v1/me/go?trip_id=${tripA}`)).status).toBe(504);
    h.go.answers.forget_person = () => ({ result: { deleted_facts: 3, remaining_facts: 0 } });
  }, 10_000);

  it('carry-over and deleting one fact are asked of Go for him', async () => {
    await api(kabir, 'PATCH', '/app/v1/me/go', { carry_over: true });
    expect(h.go.requests.at(-1)).toEqual({ method: 'update_person', params: { person_id: kabir.id, carry_over: true } });
    await api(kabir, 'DELETE', '/app/v1/me/go/facts/f_nuts');
    expect(h.go.requests.at(-1)).toEqual({ method: 'delete_fact', params: { person_id: kabir.id, fact_id: 'f_nuts' } });
  });

  it('pausing Go: person.updated go_paused, and his next words are withheld from Go but shown to the room', async () => {
    const mark = h.go.events.length;
    await api(kabir, 'PATCH', `/app/v1/trips/${tripA}/me`, { go_paused: true });
    const m = await api(kabir, 'POST', `/app/v1/trips/${tripA}/messages`, { client_message_id: 'f7_secret', text: 'a surprise for Rahul' });
    await h.flush();
    const list = eventsFor(tripA, mark);
    expect(list[0]).toMatchObject({ type: 'person.updated', data: { changed: ['go_paused'], person: { go_paused: true } } });
    expect(list[1]!.data.message).toMatchObject({ message_id: m.body.message_id, withheld: true });
    expect(JSON.stringify(list[1])).not.toContain('surprise');
    const room = (await api(rahul, 'GET', `/app/v1/trips/${tripA}/messages?after_seq=0`)).body.messages;
    expect(room.find((x: any) => x.message_id === m.body.message_id).text).toBe('a surprise for Rahul');
  });
});

// --------------------------------------------------------------------------------------------- F8
describe('F8. Go misses an event (guide: "Go misses an event")', () => {
  let rahul: Who, priya: Who, trip: string, m1: string;

  it('Go refuses one event: the server marks it failed and goes on; Go catches up with read_trip and read_messages', async () => {
    [rahul, priya] = [await person('Rahul'), await person('Priya')];
    trip = (await newTrip('Goa F8', rahul, [priya])).id;
    const first = await api(rahul, 'POST', `/app/v1/trips/${trip}/messages`, { client_message_id: 'f8_1', text: 'North Goa?' });
    m1 = first.body.message_id;
    await h.flush();
    const n = first.body.seq;
    h.go.onEvent = (e) => (e.type === 'reaction.added' && e.trip_id === trip ? { error: { code: 422, message: 'cannot use it', data: { code: 'invalid' } } } : { result: { accepted: true, duplicate: false } });
    const react = await api(priya, 'PUT', `/app/v1/trips/${trip}/messages/${m1}/reaction`, { emoji: '👍' });
    const next = await api(rahul, 'POST', `/app/v1/trips/${trip}/messages`, { client_message_id: 'f8_2', text: 'Booking it' });
    expect([react.body.updated_seq, next.body.seq]).toEqual([n + 1, n + 2]);
    await h.flush();
    h.go.onEvent = () => ({ result: { accepted: true, duplicate: false } });
    const states = await rows(h.pool, 'select seq, status from outbox where trip_id = $1 and seq > $2 order by seq', [trip, n]);
    expect(states).toEqual([{ seq: n + 1, status: 'failed' }, { seq: n + 2, status: 'sent' }]);
    // Go sees a gap (n, then n+2), so it reads the trip and the messages since n.
    const snap = await read('read_trip', { trip_id: trip });
    expect(snap.seq).toBe(n + 2);
    const page = await read('read_messages', { trip_id: trip, after_seq: n });
    expect(page.messages.map((m: any) => [m.message_id, m.updated_seq])).toEqual([[m1, n + 1], [next.body.message_id, n + 2]]);
    expect(page.messages[0].reactions).toEqual([{ emoji: '👍', person_id: priya.id }]);
    expect(page.has_more).toBe(false);
  });

  it('Go answering duplicate: true for an event it already has counts as sent', async () => {
    h.go.onEvent = () => ({ result: { accepted: true, duplicate: true } });
    const r = await api(rahul, 'POST', `/app/v1/trips/${trip}/messages`, { client_message_id: 'f8_3', text: 'again' });
    await h.flush();
    h.go.onEvent = () => ({ result: { accepted: true, duplicate: false } });
    expect((await rows(h.pool, 'select status from outbox where trip_id = $1 and seq = $2', [trip, r.body.seq]))[0].status).toBe('sent');
  });
});
