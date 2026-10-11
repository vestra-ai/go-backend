import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check } from '../src/contract/index.js';
import { tapIdFor } from '../src/domain/ask-go.js';
import { closeDueVotes } from '../src/jobs/votes.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => (h = await startHarness({ seed: false })));
afterAll(() => h.stop());

type Who = { id: string; token: string };
const api = async (who: Who | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
  const r = await h.app.inject({ method, url, payload: payload as any, headers: who ? { authorization: `Bearer ${who.token}` } : {} });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
/** Signs a new person in through the fake Supabase Auth, as the app does (the person is created on the first request). */
const person = (name: string, extra: { email?: string; upi_id?: string } = {}): Promise<Who> => h.signIn(name, extra);
const events = (type: string) => h.go.events.filter((e) => e.type === type);
const goCall = async (method: string, params: Record<string, unknown>, tripId: string) => {
  const f = await h.go.call(method, { request_id: `rq_${Math.random().toString(36).slice(2)}`, trip_id: tripId, ...params });
  if (f.error) throw new Error(JSON.stringify(f.error));
  return f.result;
};

let rahul: Who, priya: Who, kabir: Who;
let trip: string, code: string;

describe('creating and joining a trip', () => {
  it('creates a trip and sends trip.created as change 1 with the whole trip', async () => {
    rahul = await person('Rahul', { email: 'rahul@x.test', upi_id: 'rahul@upi' });
    priya = await person('Priya');
    kabir = await person('Kabir');
    const r = await api(rahul, 'POST', '/app/v1/trips', { title: 'Goa 🌴', destination: { name: 'Goa' }, dates: { start: '2026-11-06', end: '2026-11-09' }, plan_minor: 7500000 });
    expect(r.status).toBe(201);
    trip = r.body.trip_id;
    code = r.body.invite_url.split('/invite/')[1];
    await h.flush();
    const e = events('trip.created')[0]!;
    expect(e).toMatchObject({ trip_id: trip, seq: 1 });
    expect(check('Event', e)).toMatchObject({ ok: true });
    expect(e.data.trip.people).toHaveLength(1);
    expect(JSON.stringify(e)).not.toMatch(/rahul@x\.test|rahul@upi/); // contact details never go to Go
  });

  it('shows a join preview without signing in, and refuses a bad link', async () => {
    const r = await api(null, 'GET', `/app/v1/invites/${code}`);
    expect(r.body).toMatchObject({ code, state: 'pending', trip: { trip_id: trip, title: 'Goa 🌴', destination: { name: 'Goa' } }, inviter: { person_id: rahul.id, name: 'Rahul' }, joined_count: 1 });
    expect((await api(null, 'GET', '/app/v1/invites/nope')).status).toBe(404);
  });

  it('joining sends person.joined with the join answers and nothing else: no trip.updated follows', async () => {
    const r = await api(priya, 'POST', `/app/v1/invites/${code}/accept`, {
      join_answers: { from_city: 'Delhi', earliest_leave: 'Fri after 6 pm', know: ['Vegetarian', 'Window seat'] },
    });
    expect(r.body).toEqual({ trip_id: trip, seq: expect.any(Number), landing: 'trip_home' }); // nobody has spoken yet
    await h.flush();
    const joined = events('person.joined').at(-1)!;
    expect(joined.data.person).toMatchObject({ person_id: priya.id, name: 'Priya', from_city: 'Delhi', know: ['Vegetarian', 'Window seat'], role: 'member', go_paused: false });
    expect(events('trip.updated').filter((e) => e.trip_id === trip)).toEqual([]);
    expect(r.body.seq).toBe(joined.seq + 1); // the trip's change number after the join: the "Priya joined" line
    expect((await api(priya, 'POST', `/app/v1/invites/${code}/accept`, {})).body).toEqual({ trip_id: trip, seq: joined.seq + 1, landing: 'trip_home' }); // already in: nothing happens; the trip's seq is the "Priya joined" pill
    await api(kabir, 'POST', `/app/v1/invites/${code}/accept`, {});
    const snap = (await h.go.call('read_trip', { trip_id: trip })).result;
    expect(snap.budget).toEqual({ answered: 0, of: 3 }); // no group budget set: nobody has answered
  });

  it('refuses requests with no sign-in, a forged token, an expired token, and someone outside the trip', async () => {
    expect((await api(null, 'GET', `/app/v1/trips/${trip}`)).status).toBe(401);
    expect((await api({ id: 'x', token: 'garbage' }, 'GET', `/app/v1/trips/${trip}`)).status).toBe(401);
    expect((await api({ id: rahul.id, token: rahul.token.slice(0, -2) + 'xx' }, 'GET', `/app/v1/trips/${trip}`)).status).toBe(401);
    expect((await api({ id: rahul.id, token: await h.fakeAuth!.mint({ name: 'Rahul', email: 'rahul@x.test' }, { expiresIn: -120 }) }, 'GET', `/app/v1/trips/${trip}`)).status).toBe(401);
    const stranger = await person('Stranger');
    expect((await api(stranger, 'GET', `/app/v1/trips/${trip}`)).status).toBe(403);
    expect((await api(stranger, 'POST', `/app/v1/trips/${trip}/messages`, { client_message_id: 'c1', text: 'hi' })).status).toBe(403);
  });
});

describe('messages', () => {
  it('stores a message and tells Go: mentions_go when it names Go, once per client_message_id, answering the stored Message', async () => {
    const a = await api(rahul, 'POST', `/app/v1/trips/${trip}/messages`, { client_message_id: 'c1', text: '@Go can you find flights?' });
    expect(a.status).toBe(201);
    expect(check('Message', a.body)).toMatchObject({ ok: true });
    expect(a.body).toMatchObject({ author: { kind: 'person', person_id: rahul.id }, text: '@Go can you find flights?', mentions_go: true, withheld: false, reactions: [] });
    expect((await api(rahul, 'POST', `/app/v1/trips/${trip}/messages`, { text: 'no press key' })).status).toBe(422); // client_message_id is required
    const again = await api(rahul, 'POST', `/app/v1/trips/${trip}/messages`, { client_message_id: 'c1', text: '@Go can you find flights?' });
    expect([again.status, again.body]).toEqual([201, a.body]); // a retry does not post twice
    await h.flush();
    const e = events('message.created').filter((x) => x.data.message.message_id === a.body.message_id);
    expect(e).toHaveLength(1);
    expect(e[0]!.data.message).toMatchObject({ mentions_go: true, withheld: false, text: '@Go can you find flights?', author: { kind: 'person', person_id: rahul.id } });
    expect(check('Event', e[0]!)).toMatchObject({ ok: true });
    const plain = await api(priya, 'POST', `/app/v1/trips/${trip}/messages`, { client_message_id: 'c2', text: "let's go to the beach" });
    await h.flush();
    expect(events('message.created').find((x) => x.data.message.message_id === plain.body.message_id)!.data.message.mentions_go).toBe(false);
  });

  it('a reply to one of Go\'s messages is for Go, even without its name', async () => {
    const go = await goCall('post_message', { text: 'Here are 3 flights', card: { card_id: 'c_fl', kind: 'notice', fallback_text: 'flights', title: 'Flights', body: 'x', tone: 'info' } }, trip);
    const reply = await api(priya, 'POST', `/app/v1/trips/${trip}/messages`, { client_message_id: 'c3', text: 'the second one', reply_to: go.message_id });
    await h.flush();
    expect(events('message.created').find((x) => x.data.message.message_id === reply.body.message_id)!.data.message.mentions_go).toBe(true);
  });

  it('a person who paused Go: Go gets the change number but no words; the room still sees them', async () => {
    const p = await api(priya, 'PATCH', `/app/v1/trips/${trip}/me`, { go_paused: true });
    const { seq: pauseSeq, ...pausedPerson } = p.body;
    expect([p.status, typeof pauseSeq, check('Person', pausedPerson).ok]).toEqual([200, 'number', true]); // the answer is her own Person, whole, plus seq
    expect(pausedPerson).toMatchObject({ person_id: priya.id, name: 'Priya', role: 'member', go_paused: true });
    await h.flush();
    expect(events('person.updated').at(-1)!.data).toMatchObject({ changed: ['go_paused'], person: { person_id: priya.id, go_paused: true } });
    const m = await api(priya, 'POST', `/app/v1/trips/${trip}/messages`, { client_message_id: 'c4', text: 'a secret plan @Go' });
    await h.flush();
    const e = events('message.created').find((x) => x.data.message.message_id === m.body.message_id)!;
    expect(e.data.message).toMatchObject({ withheld: true, attachments: [], mentions_go: false });
    expect(e.data.message.text).toBeUndefined();
    expect(JSON.stringify(e)).not.toContain('secret plan');
    const roomView = await api(rahul, 'GET', `/app/v1/trips/${trip}/messages?after_seq=0`);
    const shown = roomView.body.messages.find((x: any) => x.message_id === m.body.message_id);
    expect(shown.text).toBe('a secret plan @Go');
    expect(shown.withheld).toBe(false);
    const viaGo = (await h.go.call('read_messages', { trip_id: trip, after_seq: 0 })).result.messages.find((x: any) => x.message_id === m.body.message_id);
    expect(viaGo).toMatchObject({ withheld: true });
    expect(viaGo.text).toBeUndefined();
    await api(priya, 'PATCH', `/app/v1/trips/${trip}/me`, { go_paused: false });
  });

  it('edits and deletes only your own message, and Go hears about both', async () => {
    const m = await api(kabir, 'POST', `/app/v1/trips/${trip}/messages`, { client_message_id: 'c5', text: 'orginal' });
    expect((await api(priya, 'PATCH', `/app/v1/trips/${trip}/messages/${m.body.message_id}`, { text: 'hacked' })).status).toBe(403);
    const edited = await api(kabir, 'PATCH', `/app/v1/trips/${trip}/messages/${m.body.message_id}`, { text: 'original' });
    expect([edited.status, edited.body.text, typeof edited.body.edited_at, edited.body.updated_seq > m.body.seq]).toEqual([200, 'original', 'string', true]); // the Message, as it is now
    const deleted = await api(kabir, 'DELETE', `/app/v1/trips/${trip}/messages/${m.body.message_id}`);
    expect([deleted.status, deleted.body.deleted, deleted.body.text, deleted.body.attachments]).toEqual([200, true, undefined, []]);
    await h.flush();
    expect(events('message.edited').at(-1)!.data.message).toMatchObject({ text: 'original' });
    expect(events('message.deleted').at(-1)!.data).toEqual({ message_id: m.body.message_id });
    const viaGo = (await h.go.call('read_messages', { trip_id: trip, after_seq: 0 })).result.messages.find((x: any) => x.message_id === m.body.message_id);
    expect(viaGo).toMatchObject({ deleted: true });
    expect(viaGo.text).toBeUndefined();
  });

  it('words written while Go is paused do not reach Go, even in an edit of an older message', async () => {
    const m = await api(kabir, 'POST', `/app/v1/trips/${trip}/messages`, { client_message_id: 'c_edit', text: 'old words' });
    await api(kabir, 'PATCH', `/app/v1/trips/${trip}/me`, { go_paused: true });
    await api(kabir, 'PATCH', `/app/v1/trips/${trip}/messages/${m.body.message_id}`, { text: 'new private words' });
    await h.flush();
    const e = events('message.edited').at(-1)!;
    expect(e.data.message).toMatchObject({ message_id: m.body.message_id, withheld: true });
    expect(JSON.stringify(e)).not.toContain('new private words');
    const viaGo = (await h.go.call('read_messages', { trip_id: trip, after_seq: 0 })).result.messages.find((x: any) => x.message_id === m.body.message_id);
    expect(viaGo.text).toBeUndefined();
    expect((await api(rahul, 'GET', `/app/v1/trips/${trip}/messages?after_seq=0`)).body.messages.find((x: any) => x.message_id === m.body.message_id).text).toBe('new private words');
    await api(kabir, 'PATCH', `/app/v1/trips/${trip}/me`, { go_paused: false });
  });

  it('one reaction per person: it carries their id, a new emoji replaces it (removed, then added, for Go), null takes it back', async () => {
    const m = await api(rahul, 'POST', `/app/v1/trips/${trip}/messages`, { client_message_id: 'c6', text: 'North Goa?' });
    const react = (who: Who, emoji: string | null) => api(who, 'PUT', `/app/v1/trips/${trip}/messages/${m.body.message_id}/reaction`, { emoji });
    const first = await react(priya, '👍');
    expect([first.status, first.body.reactions]).toEqual([200, [{ emoji: '👍', person_id: priya.id }]]);
    const same = await react(priya, '👍');
    expect(same.body.updated_seq).toBe(first.body.updated_seq); // nothing changed
    const moved = await react(priya, '🔥');
    expect([moved.body.reactions, moved.body.updated_seq]).toEqual([[{ emoji: '🔥', person_id: priya.id }], first.body.updated_seq + 2]); // two changes: removed, added
    const gone = await react(priya, null);
    expect(gone.body.reactions).toEqual([]);
    await h.flush();
    const mine = h.go.events.filter((e) => (e.type === 'reaction.added' || e.type === 'reaction.removed') && e.data.message_id === m.body.message_id);
    expect(mine.map((e) => [e.type, e.data.reaction])).toEqual([
      ['reaction.added', { emoji: '👍', person_id: priya.id }], ['reaction.removed', { emoji: '👍', person_id: priya.id }], ['reaction.added', { emoji: '🔥', person_id: priya.id }], ['reaction.removed', { emoji: '🔥', person_id: priya.id }],
    ]);
  });
});

describe('votes, mandate and the "needs you" strip', () => {
  let decision: string;
  it('shows an open vote to everyone who has not voted', async () => {
    const o = await goCall('open_vote', { question: 'Where do we stay?', kind: 'choice', anonymous: false, options: [{ label: 'Villa Sol', price_minor: 5420000, currency: 'INR' }, { label: 'Casa Azul' }] }, trip);
    decision = o.decision_id;
    const strip = await api(rahul, 'GET', `/app/v1/trips/${trip}/needs-you`);
    expect(strip.body.items).toContainEqual(expect.objectContaining({ item_id: `vote:${decision}:${rahul.id}`, kind: 'vote', title: 'Where do we stay?', cta_label: 'Vote', target: { decision_id: decision } }));
    await api(rahul, 'PUT', `/app/v1/trips/${trip}/decisions/${decision}/vote`, { option_index: 0 });
    expect((await api(rahul, 'GET', `/app/v1/trips/${trip}/needs-you`)).body.items.find((x: any) => x.kind === 'vote')).toBeUndefined();
    expect((await api(priya, 'GET', `/app/v1/trips/${trip}/needs-you`)).body.items.find((x: any) => x.kind === 'vote')).toBeTruthy();
  });

  it('a vote event names who voted for what; the vote closes by itself when everyone has voted', async () => {
    await api(priya, 'PUT', `/app/v1/trips/${trip}/decisions/${decision}/vote`, { option_index: 0 });
    await api(priya, 'PUT', `/app/v1/trips/${trip}/decisions/${decision}/vote`, { option_index: 0 }); // changing/repeating is fine
    expect((await api(kabir, 'PUT', `/app/v1/trips/${trip}/decisions/${decision}/vote`, { option_index: 9 })).status).toBe(422);
    await api(kabir, 'PUT', `/app/v1/trips/${trip}/decisions/${decision}/vote`, { option_index: 1 });
    await h.flush();
    const voted = events('decision.voted').filter((e) => e.data.decision_id === decision);
    expect(voted[0]!.data).toMatchObject({ person_id: rahul.id, option_index: 0, voted: 1, of: 3, tally: [1, 0] });
    const closed = events('decision.closed').find((e) => e.data.decision.decision_id === decision)!;
    expect(closed.data.reason).toBe('everyone_voted');
    expect(closed.data.decision).toMatchObject({ status: 'closed', result_index: 0, tally: [2, 1] });
    const line = events('record.changed').find((e) => e.data.line.decision_id === decision)!;
    expect(line.seq).toBe(closed.seq + 1);
    expect((await api(rahul, 'PUT', `/app/v1/trips/${trip}/decisions/${decision}/vote`, { option_index: 0 })).status).toBe(409);
  });

  it('an anonymous vote event has totals only', async () => {
    const o = await goCall('open_vote', { question: 'Secret?', kind: 'yesno', anonymous: true, options: [{ label: 'Yes' }, { label: 'No' }] }, trip);
    await api(rahul, 'PUT', `/app/v1/trips/${trip}/decisions/${o.decision_id}/vote`, { option_index: 1 });
    await h.flush();
    const e = events('decision.voted').find((x) => x.data.decision_id === o.decision_id)!;
    expect(e.data).toEqual({ decision_id: o.decision_id, voted: 1, of: 3, tally: [0, 1] });
    expect(check('Event', e)).toMatchObject({ ok: true });
    await api(rahul, 'POST', `/app/v1/trips/${trip}/decisions/${o.decision_id}/cancel`);
    await h.flush();
    expect(events('decision.cancelled').at(-1)!.data).toEqual({ decision_id: o.decision_id, by: { kind: 'person', person_id: rahul.id } });
  });

  it('only the payer can answer the mandate; "Yes, book it" opens the spend check', async () => {
    await goCall('set_mandate', { decision_id: decision, choice_index: 0, cap_minor: 5500000, currency: 'INR', refundable_only: true, payer_person_id: rahul.id }, trip);
    expect((await api(rahul, 'GET', `/app/v1/trips/${trip}/needs-you`)).body.items).toContainEqual({ item_id: `mandate:${decision}`, kind: 'mandate', title: 'Yes, book it? Villa Sol, up to ₹55,000', subtitle: 'Where do we stay?', cta_label: 'Yes, book it', since: expect.any(String), target: { decision_id: decision } });
    expect((await api(priya, 'POST', `/app/v1/trips/${trip}/decisions/${decision}/mandate/confirm`)).status).toBe(403);
    const ask = () => h.go.call('request_spend_approval', {
      request_id: `rq_sp_${Math.random()}`, trip_id: trip, decision_id: decision, amount_minor: 5420000, currency: 'INR', merchant: 'ixigo', purpose: 'Villa', refundable_until: '2099-01-01T00:00:00Z',
    });
    expect((await ask()).result.reason).toBe('payer_has_not_confirmed');
    await api(rahul, 'POST', `/app/v1/trips/${trip}/decisions/${decision}/mandate/decline`);
    expect((await ask()).result.reason).toBe('payer_declined');
    await api(rahul, 'POST', `/app/v1/trips/${trip}/decisions/${decision}/mandate/confirm`);
    await h.flush();
    expect(events('mandate.declined').at(-1)!.data).toEqual({ decision_id: decision, person_id: rahul.id });
    expect(events('mandate.confirmed').at(-1)!.data).toEqual({ decision_id: decision, person_id: rahul.id });
    expect((await ask()).result.status).toBe('approved');
    expect((await api(rahul, 'GET', `/app/v1/trips/${trip}/needs-you`)).body.items.find((x: any) => x.kind === 'mandate')).toBeUndefined();
  });

  it('a person undoes a record line, and Go hears it', async () => {
    const m = await api(rahul, 'POST', `/app/v1/trips/${trip}/messages`, { client_message_id: 'c7', text: 'north goa' });
    const l = await goCall('add_record_line', { kind: 'open', text: 'Scuba on Saturday?', proof: [{ message_id: m.body.message_id }], person_ids: [priya.id] }, trip);
    expect((await api(priya, 'GET', `/app/v1/trips/${trip}/needs-you`)).body.items).toContainEqual({ item_id: `record_line:${l.line_id}`, kind: 'record_line', title: 'Scuba on Saturday?', since: expect.any(String), target: { line_id: l.line_id } });
    const undone = await api(kabir, 'POST', `/app/v1/trips/${trip}/record/${l.line_id}/undo`);
    expect(undone.body).toMatchObject({ line_id: l.line_id, status: 'undone' }); // the RecordLine
    await h.flush();
    expect(events('record.changed').at(-1)!.data).toMatchObject({ change: 'undone', by: { kind: 'person', person_id: kabir.id }, line: { line_id: l.line_id, status: 'undone' } });
    expect((await api(priya, 'GET', `/app/v1/trips/${trip}/needs-you`)).body.items.find((x: any) => x.kind === 'record_line')).toBeUndefined();
    const redone = await api(priya, 'POST', `/app/v1/trips/${trip}/record/${l.line_id}/redo`);
    expect(redone.body).toMatchObject({ line_id: l.line_id, status: 'active' });
    await h.flush();
    expect(events('record.changed').at(-1)!.data).toMatchObject({ change: 'updated', by: { kind: 'person', person_id: priya.id }, line: { line_id: l.line_id, status: 'active' } });
    expect((await api(priya, 'POST', `/app/v1/trips/${trip}/record/${l.line_id}/redo`)).status).toBe(409);
    expect((await api(priya, 'GET', `/app/v1/trips/${trip}/record`)).body.lines.find((x: any) => x.line_id === l.line_id).status).toBe('active');
  });

  it('a Go card that names you is in your strip until Go removes you with replace_card', async () => {
    await goCall('post_message', { text: 'Rahul, approve?', card: { card_id: 'c_pay', kind: 'notice', fallback_text: 'Rahul, approve', title: 'Approve', body: 'x', tone: 'heads_up', for_person_ids: [rahul.id], actions: [{ action_id: 'approve', label: 'Approve', style: 'primary' }] } }, trip);
    expect((await api(rahul, 'GET', `/app/v1/trips/${trip}/needs-you`)).body.items.find((x: any) => x.kind === 'card')).toMatchObject({ item_id: 'card:c_pay', title: 'Rahul, approve', subtitle: 'Approve', target: { card_id: 'c_pay' } });
    await h.go.call('replace_card', { trip_id: trip, card: { card_id: 'c_pay', kind: 'notice', fallback_text: 'done', title: 'Done', body: 'x', tone: 'heads_up', for_person_ids: [] } });
    expect((await api(rahul, 'GET', `/app/v1/trips/${trip}/needs-you`)).body.items.find((x: any) => x.kind === 'card')).toBeUndefined();
  });
});

describe('leaving a trip', () => {
  it('a vote that was only waiting for the person who left closes: everyone left has voted', async () => {
    const leaver = await person('Leaver');
    await api(leaver, 'POST', `/app/v1/invites/${code}/accept`, {});
    const o = await goCall('open_vote', { question: 'Last call?', kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }] }, trip);
    for (const w of [rahul, priya, kabir]) await api(w, 'PUT', `/app/v1/trips/${trip}/decisions/${o.decision_id}/vote`, { option_index: 0 });
    expect((await rows(h.pool, 'select status from decisions where decision_id = $1', [o.decision_id]))[0].status).toBe('open'); // waiting for the leaver
    const left = await api(leaver, 'POST', `/app/v1/trips/${trip}/leave`);
    expect([left.status, left.body]).toEqual([204, null]);
    expect((await rows(h.pool, 'select status from decisions where decision_id = $1', [o.decision_id]))[0].status).toBe('closed');
    await h.flush();
    expect(events('decision.closed').find((e) => e.data.decision.decision_id === o.decision_id)!.data.reason).toBe('everyone_voted');
    expect(events('person.left').at(-1)!.data).toEqual({ person_id: leaver.id });
  });
});

describe('expenses', () => {
  it('a person adds an expense: Go hears it, and it counts at once', async () => {
    const r = await api(kabir, 'POST', `/app/v1/trips/${trip}/expenses`, { paid_by_person_id: kabir.id, amount_minor: 340000, note: 'Airport cab', category: 'getting_around', split_person_ids: [rahul.id, priya.id, kabir.id] });
    expect(r.status).toBe(201);
    expect([typeof r.body.expense_id, 'status' in r.body, 'confirmations' in r.body]).toEqual(['string', false, false]);
    await h.flush();
    expect(events('expense.changed').at(-1)!.data).toMatchObject({ change: 'added', by: { kind: 'person', person_id: kabir.id }, expense: { amount_minor: 340000, added_by_person_id: kabir.id } });
    const snap = (await h.go.call('read_trip', { trip_id: trip })).result;
    expect(snap.money.transfers).toEqual(expect.arrayContaining([
      { from_person_id: rahul.id, to_person_id: kabir.id, amount_minor: 113334, currency: 'INR' },
      { from_person_id: priya.id, to_person_id: kabir.id, amount_minor: 113333, currency: 'INR' },
    ]));
    await api(kabir, 'DELETE', `/app/v1/trips/${trip}/expenses/${r.body.expense_id}`);
    await h.flush();
    expect(events('expense.changed').at(-1)!.data.change).toBe('removed');
  });
});

describe('asking Go', () => {
  const tap = (who: Who, { card_id, ...body }: Record<string, unknown>) => api(who, 'POST', `/app/v1/trips/${trip}/cards/${card_id}/actions`, body);

  it('sends a tap on a Go card to Go with a tap id, and gives its answer to the app', async () => {
    await goCall('post_message', { text: 'Flights', card: { card_id: 'c_opts', kind: 'options', fallback_text: 'flights', title: 'Flights', option_kind: 'flight', checked_at: '2026-10-05T06:49:30Z', options: [{ option_id: 'o1', title: 'IndiGo', price_minor: 592000, currency: 'INR', highlights: ['Non-stop'] }], actions: [{ action_id: 'pick', label: 'Pick', style: 'primary', per_option: true }] } }, trip);
    const r = await tap(priya, { card_id: 'c_opts', action_id: 'pick', option_id: 'o1', press_id: 'tap_press_1' });
    expect(r.body).toEqual({ result: 'done', toast: 'Noted. Go will reply in the room.' });
    const priyaTap = tapIdFor(priya.id, 'tap_press_1');
    expect(h.go.requests.at(-1)).toEqual({ method: 'card_tap', params: { tap_id: priyaTap, trip_id: trip, card_id: 'c_opts', action_id: 'pick', person_id: priya.id, option_id: 'o1' } });
    await tap(priya, { card_id: 'c_opts', action_id: 'pick', option_id: 'o1', press_id: 'tap_press_1', payload: { trip: 'round' } });
    expect(h.go.requests.at(-1)!.params).toMatchObject({ tap_id: priyaTap, payload: { trip: 'round' } }); // the same press keeps its id; the payload goes through (GO-CHANGES 1.2)
    expect((await tap(priya, { card_id: 'c_opts', action_id: 'pick', tap_id: 'tap_press_1' })).status).toBe(422); // the older name is gone
    // Someone else replaying Priya's press id is a different tap: they can never get Priya's answer from Go.
    await tap(rahul, { card_id: 'c_opts', action_id: 'pick', option_id: 'o1', press_id: 'tap_press_1' });
    expect(h.go.requests.at(-1)!.params.tap_id).not.toBe(priyaTap);
  });

  it('makes a tap id when the app sent none, and refuses record cards, unknown cards and strangers', async () => {
    const sent = h.go.requests.length;
    expect((await tap(rahul, { card_id: 'c_opts', action_id: 'pick', option_id: 'o1' })).status).toBe(200); // a button the card has
    expect(h.go.requests.length).toBe(sent + 1);
    expect(h.go.requests.at(-1)!.params.tap_id).toMatch(/^tap_/);
    await goCall('post_message', { text: 'Vote', card: { card_id: 'c_vote', kind: 'vote', decision_id: (await rows(h.pool, 'select decision_id from decisions limit 1'))[0].decision_id, fallback_text: 'Vote' } }, trip);
    expect((await tap(rahul, { card_id: 'c_vote', action_id: 'x' })).status).toBe(422); // the Server handles record cards
    expect((await tap(rahul, { card_id: 'c_nope', action_id: 'x' })).status).toBe(404);
    expect((await tap(await person('Stranger2'), { card_id: 'c_opts', action_id: 'x' })).status).toBe(403);
  });

  it('when Go is busy, down or answers badly the person sees a refusal toast and taps again (app contract §4.7); Go\'s own refusal passes through', async () => {
    const before = h.go.requests.length;
    const unanswered = { status: 200, body: { result: 'refused', toast: "Go didn't answer. Try again." } };
    h.go.answers.card_tap = () => ({ error: { code: 429, message: 'slow', data: { code: 'rate_limited', retry_after_seconds: 5 } } });
    expect(await tap(priya, { card_id: 'c_opts', action_id: 'pick' })).toEqual(unanswered);
    h.go.answers.card_tap = () => ({ error: { code: 503, message: 'deploy', data: { code: 'unavailable' } } });
    expect(await tap(priya, { card_id: 'c_opts', action_id: 'pick' })).toEqual(unanswered);
    h.go.answers.card_tap = () => ({ result: { result: 'banana' } }); // not a valid answer
    expect(await tap(priya, { card_id: 'c_opts', action_id: 'pick' })).toEqual(unanswered);
    // not sent again on its own: one request each
    expect(h.go.requests.length - before).toBe(3);
    // Go's own refusal passes through. The tap names a button the card has (a tap on a button that is not there never reaches Go).
    h.go.answers.card_tap = () => ({ result: { result: 'refused', toast: 'Only Rahul can pick' } });
    expect((await tap(priya, { card_id: 'c_opts', action_id: 'pick' })).body).toEqual({ result: 'refused', toast: 'Only Rahul can pick' });
    expect(h.go.requests.length - before).toBe(4);
    h.go.answers.card_tap = () => ({ result: { result: 'done', toast: 'Noted. Go will reply in the room.' } });
  });

  it('a tap must name a button the card has now: the old Approve on a pay card replaced without buttons is refused (422 action_id) and never reaches Go', async () => {
    const pay = (over: Record<string, unknown>) => ({
      card_id: 'c_pay_tap', kind: 'pay', fallback_text: 'Rahul, approve ₹54,200 for Villa Sol', for_person_ids: [rahul.id], approval_id: 'ap_00000000000000aa',
      payer_person_id: rahul.id, amount_minor: 5420000, currency: 'INR', merchant: 'ixigo: Villa Sol, Anjuna', purpose: 'Villa Sol, 3 nights',
      expires_at: new Date(Date.now() + 600_000).toISOString(), state: 'waiting',
      actions: [{ action_id: 'approve', label: 'Approve', style: 'primary', only_for_person_ids: [rahul.id] }, { action_id: 'decline', label: 'Not now', style: 'secondary', only_for_person_ids: [rahul.id] }],
      ...over,
    });
    await goCall('post_message', { text: 'Ready to pay', card: pay({}) }, trip);
    // While the card has the button, the tap reaches Go.
    let sent = h.go.requests.length;
    // (Not now: the payer's Approve on a waiting pay card is the demo's payment and stays with the Server, tests/demo-payment.test.ts.)
    expect((await tap(rahul, { card_id: 'c_pay_tap', action_id: 'decline', press_id: 'tap_pay_1' })).status).toBe(200);
    expect(h.go.requests.length).toBe(sent + 1);
    expect(h.go.requests.at(-1)).toMatchObject({ method: 'card_tap', params: { card_id: 'c_pay_tap', action_id: 'decline', person_id: rahul.id } });
    // A button that was never on the card is refused too.
    sent = h.go.requests.length;
    const never = await tap(rahul, { card_id: 'c_pay_tap', action_id: 'pay_twice' });
    expect([never.status, never.body.error.code, never.body.error.field]).toEqual([422, 'invalid', 'action_id']);
    expect(h.go.requests.length).toBe(sent);
    // Go replaces the card as expired, with no buttons: the old Approve (a stale screen, a second press) is refused and Go gets nothing.
    const replaced = await h.go.call('replace_card', { trip_id: trip, card: pay({ fallback_text: 'This approval expired', for_person_ids: [], state: 'expired', actions: [] }) });
    expect(replaced.error).toBeUndefined();
    sent = h.go.requests.length;
    for (const action_id of ['approve', 'decline']) {
      const r = await tap(rahul, { card_id: 'c_pay_tap', action_id, press_id: `tap_pay_${action_id}` });
      expect([r.status, r.body.error.code, r.body.error.field]).toEqual([422, 'invalid', 'action_id']);
    }
    expect(h.go.requests.length).toBe(sent);
    expect(h.go.requests.filter((x) => x.method === 'card_tap' && x.params.card_id === 'c_pay_tap')).toHaveLength(1);
    // A real button on another card still reaches Go.
    expect((await tap(priya, { card_id: 'c_opts', action_id: 'pick', option_id: 'o1' })).status).toBe(200);
    expect(h.go.requests.at(-1)).toMatchObject({ method: 'card_tap', params: { card_id: 'c_opts', action_id: 'pick', person_id: priya.id } });
  });

  it('asks Go for a catch-up only when the person was away 3 hours or has 15 unread', async () => {
    await api(priya, 'POST', `/app/v1/trips/${trip}/read`, { up_to_seq: 3 });
    expect((await rows(h.pool, 'select last_read_seq from trip_people where trip_id = $1 and person_id = $2', [trip, priya.id]))[0].last_read_seq).toBe(3);
    expect((await api(priya, 'GET', `/app/v1/trips/${trip}/catch-up`)).status).toBe(204);
    await h.pool.query("update trip_people set last_seen_at = now() - interval '4 hours' where person_id = $1", [priya.id]);
    const r = await api(priya, 'GET', `/app/v1/trips/${trip}/catch-up`);
    expect([r.status, r.body]).toEqual([200, expect.objectContaining({ summary: expect.any(String), items: [{ kind: 'decided', text: expect.any(String) }] })]);
    expect(check('CatchUp', r.body)).toMatchObject({ ok: true });
    expect(h.go.requests.at(-1)!.method).toBe('catch_up');
    expect(h.go.requests.at(-1)!.params).toMatchObject({ trip_id: trip, person_id: priya.id });
    expect(check('CatchUpRequest', h.go.requests.at(-1)!.params)).toMatchObject({ ok: true });
  });
});

describe('the You screen', () => {
  it('shows what Go knows, turns carry-over on, deletes one fact, and opens the vault', async () => {
    expect((await api(priya, 'GET', '/app/v1/me/go')).body).toEqual({ person_id: priya.id, carry_over: false, facts: [] });
    expect((await api(priya, 'PATCH', '/app/v1/me/go', { carry_over: true })).body).toEqual({ ok: true });
    expect(h.go.requests.at(-1)).toEqual({ method: 'update_person', params: { person_id: priya.id, carry_over: true } });
    await api(priya, 'DELETE', '/app/v1/me/go/facts/f_1');
    expect(h.go.requests.at(-1)).toEqual({ method: 'delete_fact', params: { person_id: priya.id, fact_id: 'f_1' } });
    const v = await api(priya, 'POST', '/app/v1/me/vault-link', { start: 'add_card' });
    expect(v.body.url).toContain('/vault/');
    expect(h.go.requests.at(-1)).toEqual({ method: 'vault_link', params: { kind: 'vault', person_id: priya.id, start: 'add_card' } });
  });

  it('opens the vault inside the app (display embedded, 1.3) for its home only; another page is refused before Go is asked', async () => {
    for (const body of [{ display: 'embedded' }, { start: 'home', display: 'embedded' }]) {
      expect((await api(priya, 'POST', '/app/v1/me/vault-link', body)).status).toBe(200);
      expect(h.go.requests.at(-1)).toEqual({ method: 'vault_link', params: { kind: 'vault', person_id: priya.id, ...body } });
    }
    const asked = h.go.requests.length;
    const refused = await api(priya, 'POST', '/app/v1/me/vault-link', { start: 'add_card', display: 'embedded' });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'invalid', field: 'display' });
    expect(h.go.requests).toHaveLength(asked);
    expect((await api(priya, 'POST', '/app/v1/me/vault-link', { display: 'popup' })).status).toBe(422);
    // The link is never cached, and never kept for a replay: the same Idempotency-Key again asks Go for a fresh one.
    const send = () => h.app.inject({ method: 'POST', url: '/app/v1/me/vault-link', payload: { display: 'embedded' }, headers: { authorization: `Bearer ${priya.token}`, 'idempotency-key': 'vault-key-1' } });
    const first = await send();
    expect(first.headers['cache-control']).toBe('no-store');
    const before = h.go.requests.length;
    expect((await send()).headers['idempotent-replayed']).toBeUndefined();
    expect(h.go.requests).toHaveLength(before + 1);
    expect((await h.pool.query(`select 1 from idempotency_keys where path = '/app/v1/me/vault-link'`)).rowCount).toBe(0);
  });

  it('asks only for the signed-in person: nobody can read another person\'s page', async () => {
    await api(priya, 'GET', '/app/v1/me/go');
    expect(h.go.requests.at(-1)!.params.person_id).toBe(priya.id);
    expect((await api(null, 'GET', '/app/v1/me/go')).status).toBe(401);
  });

  it('forget me: Go forgets, then the Server clears the join answers in the trip and Go hears person.updated', async () => {
    const r = await api(priya, 'DELETE', `/app/v1/me/go?trip_id=${trip}`);
    expect(r.body).toEqual({ deleted_facts: 3, remaining_facts: 0 });
    expect(h.go.requests.at(-1)).toEqual({ method: 'forget_person', params: { person_id: priya.id, trip_id: trip } });
    const [tp] = await rows(h.pool, 'select from_city, earliest_leave, know from trip_people where person_id = $1', [priya.id]);
    expect(tp).toEqual({ from_city: null, earliest_leave: null, know: [] });
    await h.flush();
    expect(events('person.updated').at(-1)!.data).toMatchObject({ changed: ['from_city', 'earliest_leave', 'know'], person: { person_id: priya.id } });
    expect(events('person.updated').at(-1)!.data.person.from_city).toBeUndefined();
    // the room's messages stay
    expect((await rows(h.pool, 'select count(*)::int as n from messages where author_person_id = $1', [priya.id]))[0].n).toBeGreaterThan(0);
  });

  it('forget me everywhere: no trip id is sent to Go', async () => {
    await api(priya, 'DELETE', '/app/v1/me/go');
    expect(h.go.requests.at(-1)).toEqual({ method: 'forget_person', params: { person_id: priya.id } });
  });

  it('refuses to forget when Go says facts are left', async () => {
    h.go.answers.forget_person = () => ({ result: { deleted_facts: 1, remaining_facts: 2 } });
    expect((await api(priya, 'DELETE', '/app/v1/me/go')).status).toBe(502);
  });
});

describe('background jobs', () => {
  it('closes a vote whose time ran out (reason: time), once', async () => {
    const soon = await goCall('open_vote', { question: 'Brunch where?', kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }], closes_at: new Date(Date.now() + 30 * 60_000).toISOString() }, trip);
    await api(rahul, 'PUT', `/app/v1/trips/${trip}/decisions/${soon.decision_id}/vote`, { option_index: 0 });
    await h.pool.query("update decisions set closes_at = now() - interval '1 second' where decision_id = $1", [soon.decision_id]);
    const [first, second] = await Promise.all([closeDueVotes(h.ctx), closeDueVotes(h.ctx)]); // two instances at once
    expect(first + second).toBe(1);
    await h.flush();
    const closed = events('decision.closed').filter((e) => e.data.decision.decision_id === soon.decision_id);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.data.reason).toBe('time');
    expect(closed[0]!.data.decision.result_index).toBe(0);
  });
});

describe('the live connection', () => {
  it('carries Go\'s typing and messages to people in the room', async () => {
    const seen: string[] = [];
    const unsubscribe = h.ctx.live.subscribe((id, e) => id === trip && seen.push(e.kind));
    h.go.notify('typing', { trip_id: trip, on: true });
    await goCall('post_message', { text: 'hello room' }, trip);
    await new Promise((r) => setTimeout(r, 150));
    unsubscribe();
    expect(seen).toEqual(expect.arrayContaining(['typing', 'message']));
  });

  it('carries messages to a member over the WebSocket and refuses a non-member\'s subscription (the socket itself is in tests/live-ws.test.ts)', async () => {
    const base = await h.listen();
    const open = async (who: Who) => {
      const ticket = (await api(who, 'POST', '/app/v1/live/ticket', {})).body.ticket;
      const ws = new WebSocket(`${base.replace('http', 'ws')}/app/v1/live?ticket=${ticket}`);
      const frames: any[] = [];
      ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
      await new Promise((r) => ws.once('open', r));
      const until = async (pick: (f: any) => boolean) => {
        for (let i = 0; i < 100 && !frames.some(pick); i++) await new Promise((r) => setTimeout(r, 20));
        return frames.find(pick);
      };
      return { ws, frames, until };
    };
    const me = await open(rahul);
    expect(await me.until((f) => f.type === 'hello')).toMatchObject({ person_id: rahul.id, heartbeat_seconds: 25 });
    me.ws.send(JSON.stringify({ type: 'subscribe', trips: [{ trip_id: trip, since_seq: 1_000_000 }] }));
    await new Promise((r) => setTimeout(r, 100));
    await goCall('post_message', { text: 'live!' }, trip);
    expect(await me.until((f) => f.type === 'message' && f.message.text === 'live!')).toMatchObject({ trip_id: trip, message: { author: { kind: 'go' } } });
    me.ws.close();
    const stranger = await open(await person('Stranger3'));
    stranger.ws.send(JSON.stringify({ type: 'subscribe', trips: [{ trip_id: trip, since_seq: 0 }] }));
    expect(await stranger.until((f) => f.type === 'error')).toEqual({ type: 'error', trip_id: trip, code: 'forbidden' });
    stranger.ws.close();
  });
});
