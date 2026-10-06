import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check } from '../src/contract/index.js';
import { signSession } from '../src/api/auth.js';
import { tapIdFor } from '../src/domain/ask-go.js';
import { closeDueVotes, pushClosingSoon } from '../src/jobs/votes.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => (h = await startHarness({ seed: false })));
afterAll(() => h.stop());

type Who = { id: string; token: string };
const api = async (who: Who | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
  const r = await h.app.inject({ method, url, payload: payload as any, headers: who ? { authorization: `Bearer ${who.token}` } : {} });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const person = async (name: string, extra: Record<string, unknown> = {}): Promise<Who> => {
  const r = await api(null, 'POST', '/app/people', { name, ...extra });
  return { id: r.body.person_id, token: r.body.token };
};
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
    rahul = await person('Rahul', { phone: '+911111', email: 'rahul@x.test', upi_id: 'rahul@upi' });
    priya = await person('Priya');
    kabir = await person('Kabir');
    const r = await api(rahul, 'POST', '/app/trips', { title: 'Goa 🌴', destination: { name: 'Goa' }, dates: { start: '2026-11-06', end: '2026-11-09' }, plan_minor: 7500000 });
    expect(r.status).toBe(201);
    trip = r.body.trip_id;
    code = r.body.invite_url.split('/j/')[1];
    await h.flush();
    const e = events('trip.created')[0]!;
    expect(e).toMatchObject({ trip_id: trip, seq: 1 });
    expect(check('Event', e)).toMatchObject({ ok: true });
    expect(e.data.trip.people).toHaveLength(1);
    expect(JSON.stringify(e)).not.toMatch(/\+911111|rahul@x\.test|rahul@upi/); // contact details never go to Go
  });

  it('shows a join preview without signing in, and refuses a bad link', async () => {
    const r = await api(null, 'GET', `/app/join/${code}`);
    expect(r.body).toMatchObject({ trip_id: trip, title: 'Goa 🌴', people: 1 });
    expect((await api(null, 'GET', '/app/join/nope')).status).toBe(404);
  });

  it('joining sends person.joined with the join answers but never the budget answer, then trip.updated by the system', async () => {
    const r = await api(priya, 'POST', `/app/join/${code}`, {
      from_city: 'Delhi', earliest_leave: 'Fri after 6 pm', know: ['Vegetarian', 'Window seat'], budget: { min_minor: 1500000, max_minor: 2000000 },
    });
    expect(r.body).toEqual({ trip_id: trip, already: false });
    await h.flush();
    const joined = events('person.joined').at(-1)!;
    expect(joined.data.person).toMatchObject({ person_id: priya.id, name: 'Priya', from_city: 'Delhi', know: ['Vegetarian', 'Window seat'], role: 'member', go_paused: false });
    expect(JSON.stringify(joined)).not.toMatch(/budget|1500000/);
    const updated = events('trip.updated').at(-1)!;
    expect(updated.data).toEqual({ by: { kind: 'system' }, changed: ['budget'] });
    expect(updated.seq).toBe(joined.seq + 1);
    const snap = (await h.go.call('read_trip', { trip_id: trip })).result;
    expect(snap.budget).toEqual({ lowest: { min_minor: 1500000, max_minor: 2000000, currency: 'INR' }, answered: 1, of: 2 });
    expect((await api(priya, 'POST', `/app/join/${code}`, {})).body.already).toBe(true);
    await api(kabir, 'POST', `/app/join/${code}`, { budget: { min_minor: 1000000 } });
    const snap2 = (await h.go.call('read_trip', { trip_id: trip })).result;
    expect(snap2.budget.lowest.min_minor).toBe(1000000);
  });

  it('refuses requests with no sign-in, a forged token, an expired token, and someone outside the trip', async () => {
    expect((await api(null, 'GET', `/app/trips/${trip}`)).status).toBe(401);
    expect((await api({ id: 'x', token: 'garbage' }, 'GET', `/app/trips/${trip}`)).status).toBe(401);
    expect((await api({ id: rahul.id, token: rahul.token.slice(0, -2) + 'xx' }, 'GET', `/app/trips/${trip}`)).status).toBe(401);
    expect((await api({ id: rahul.id, token: signSession(rahul.id, h.sessionSecret, 1000, 10) }, 'GET', `/app/trips/${trip}`)).status).toBe(401);
    const stranger = await person('Stranger');
    expect((await api(stranger, 'GET', `/app/trips/${trip}`)).status).toBe(403);
    expect((await api(stranger, 'POST', `/app/trips/${trip}/messages`, { client_id: 'c1', text: 'hi' })).status).toBe(403);
  });
});

describe('messages', () => {
  it('stores a message and tells Go: mentions_go when it names Go, once per client id', async () => {
    const a = await api(rahul, 'POST', `/app/trips/${trip}/messages`, { client_id: 'c1', text: '@Go can you find flights?' });
    expect(a.status).toBe(200);
    const again = await api(rahul, 'POST', `/app/trips/${trip}/messages`, { client_id: 'c1', text: '@Go can you find flights?' });
    expect(again.body).toEqual(a.body); // a retry does not post twice
    await h.flush();
    const e = events('message.created').filter((x) => x.data.message.message_id === a.body.message_id);
    expect(e).toHaveLength(1);
    expect(e[0]!.data.message).toMatchObject({ mentions_go: true, withheld: false, text: '@Go can you find flights?', author: { kind: 'person', person_id: rahul.id } });
    expect(check('Event', e[0]!)).toMatchObject({ ok: true });
    const plain = await api(priya, 'POST', `/app/trips/${trip}/messages`, { client_id: 'c2', text: "let's go to the beach" });
    await h.flush();
    expect(events('message.created').find((x) => x.data.message.message_id === plain.body.message_id)!.data.message.mentions_go).toBe(false);
  });

  it('a reply to one of Go\'s messages is for Go, even without its name', async () => {
    const go = await goCall('post_message', { text: 'Here are 3 flights', card: { card_id: 'c_fl', kind: 'notice', fallback_text: 'flights', title: 'Flights', body: 'x', tone: 'info' } }, trip);
    const reply = await api(priya, 'POST', `/app/trips/${trip}/messages`, { client_id: 'c3', text: 'the second one', reply_to: go.message_id });
    await h.flush();
    expect(events('message.created').find((x) => x.data.message.message_id === reply.body.message_id)!.data.message.mentions_go).toBe(true);
  });

  it('a person who paused Go: Go gets the change number but no words; the room still sees them', async () => {
    const p = await api(priya, 'POST', `/app/trips/${trip}/go-paused`, { paused: true });
    expect(p.status).toBe(200);
    await h.flush();
    expect(events('person.updated').at(-1)!.data).toMatchObject({ changed: ['go_paused'], person: { person_id: priya.id, go_paused: true } });
    const m = await api(priya, 'POST', `/app/trips/${trip}/messages`, { client_id: 'c4', text: 'a secret plan @Go' });
    await h.flush();
    const e = events('message.created').find((x) => x.data.message.message_id === m.body.message_id)!;
    expect(e.data.message).toMatchObject({ withheld: true, attachments: [], mentions_go: false });
    expect(e.data.message.text).toBeUndefined();
    expect(JSON.stringify(e)).not.toContain('secret plan');
    const roomView = await api(rahul, 'GET', `/app/trips/${trip}/messages?after_seq=0`);
    const shown = roomView.body.messages.find((x: any) => x.message_id === m.body.message_id);
    expect(shown.text).toBe('a secret plan @Go');
    expect(shown.withheld).toBe(false);
    const viaGo = (await h.go.call('read_messages', { trip_id: trip, after_seq: 0 })).result.messages.find((x: any) => x.message_id === m.body.message_id);
    expect(viaGo).toMatchObject({ withheld: true });
    expect(viaGo.text).toBeUndefined();
    await api(priya, 'POST', `/app/trips/${trip}/go-paused`, { paused: false });
  });

  it('edits and deletes only your own message, and Go hears about both', async () => {
    const m = await api(kabir, 'POST', `/app/trips/${trip}/messages`, { client_id: 'c5', text: 'orginal' });
    expect((await api(priya, 'PATCH', `/app/trips/${trip}/messages/${m.body.message_id}`, { text: 'hacked' })).status).toBe(403);
    expect((await api(kabir, 'PATCH', `/app/trips/${trip}/messages/${m.body.message_id}`, { text: 'original' })).status).toBe(200);
    expect((await api(kabir, 'DELETE', `/app/trips/${trip}/messages/${m.body.message_id}`)).status).toBe(200);
    await h.flush();
    expect(events('message.edited').at(-1)!.data.message).toMatchObject({ text: 'original' });
    expect(events('message.deleted').at(-1)!.data).toEqual({ message_id: m.body.message_id });
    const viaGo = (await h.go.call('read_messages', { trip_id: trip, after_seq: 0 })).result.messages.find((x: any) => x.message_id === m.body.message_id);
    expect(viaGo).toMatchObject({ deleted: true });
    expect(viaGo.text).toBeUndefined();
  });

  it('words written while Go is paused do not reach Go, even in an edit of an older message', async () => {
    const m = await api(kabir, 'POST', `/app/trips/${trip}/messages`, { client_id: 'c_edit', text: 'old words' });
    await api(kabir, 'POST', `/app/trips/${trip}/go-paused`, { paused: true });
    await api(kabir, 'PATCH', `/app/trips/${trip}/messages/${m.body.message_id}`, { text: 'new private words' });
    await h.flush();
    const e = events('message.edited').at(-1)!;
    expect(e.data.message).toMatchObject({ message_id: m.body.message_id, withheld: true });
    expect(JSON.stringify(e)).not.toContain('new private words');
    const viaGo = (await h.go.call('read_messages', { trip_id: trip, after_seq: 0 })).result.messages.find((x: any) => x.message_id === m.body.message_id);
    expect(viaGo.text).toBeUndefined();
    expect((await api(rahul, 'GET', `/app/trips/${trip}/messages?after_seq=0`)).body.messages.find((x: any) => x.message_id === m.body.message_id).text).toBe('new private words');
    await api(kabir, 'POST', `/app/trips/${trip}/go-paused`, { paused: false });
  });

  it('reactions by people carry their id, and are taken back', async () => {
    const m = await api(rahul, 'POST', `/app/trips/${trip}/messages`, { client_id: 'c6', text: 'North Goa?' });
    await api(priya, 'POST', `/app/trips/${trip}/messages/${m.body.message_id}/reactions`, { emoji: '👍' });
    await api(priya, 'DELETE', `/app/trips/${trip}/messages/${m.body.message_id}/reactions/${encodeURIComponent('👍')}`);
    await h.flush();
    expect(events('reaction.added').at(-1)!.data).toEqual({ message_id: m.body.message_id, reaction: { emoji: '👍', person_id: priya.id } });
    expect(events('reaction.removed').at(-1)!.data.reaction.person_id).toBe(priya.id);
  });
});

describe('votes, mandate and the "needs you" strip', () => {
  let decision: string;
  it('shows an open vote to everyone who has not voted', async () => {
    const o = await goCall('open_vote', { question: 'Where do we stay?', kind: 'choice', anonymous: false, options: [{ label: 'Villa Sol', price_minor: 5420000, currency: 'INR' }, { label: 'Casa Azul' }] }, trip);
    decision = o.decision_id;
    const strip = await api(rahul, 'GET', `/app/trips/${trip}/needs-you`);
    expect(strip.body).toContainEqual({ kind: 'vote', decision_id: decision, text: 'Where do we stay?' });
    await api(rahul, 'POST', `/app/trips/${trip}/decisions/${decision}/vote`, { option_index: 0 });
    expect((await api(rahul, 'GET', `/app/trips/${trip}/needs-you`)).body.find((x: any) => x.kind === 'vote')).toBeUndefined();
    expect((await api(priya, 'GET', `/app/trips/${trip}/needs-you`)).body.find((x: any) => x.kind === 'vote')).toBeTruthy();
  });

  it('a vote event names who voted for what; the vote closes by itself when everyone has voted', async () => {
    await api(priya, 'POST', `/app/trips/${trip}/decisions/${decision}/vote`, { option_index: 0 });
    await api(priya, 'POST', `/app/trips/${trip}/decisions/${decision}/vote`, { option_index: 0 }); // changing/repeating is fine
    expect((await api(kabir, 'POST', `/app/trips/${trip}/decisions/${decision}/vote`, { option_index: 9 })).status).toBe(422);
    await api(kabir, 'POST', `/app/trips/${trip}/decisions/${decision}/vote`, { option_index: 1 });
    await h.flush();
    const voted = events('decision.voted').filter((e) => e.data.decision_id === decision);
    expect(voted[0]!.data).toMatchObject({ person_id: rahul.id, option_index: 0, voted: 1, of: 3, tally: [1, 0] });
    const closed = events('decision.closed').find((e) => e.data.decision.decision_id === decision)!;
    expect(closed.data.reason).toBe('everyone_voted');
    expect(closed.data.decision).toMatchObject({ status: 'closed', result_index: 0, tally: [2, 1] });
    const line = events('record.changed').find((e) => e.data.line.decision_id === decision)!;
    expect(line.seq).toBe(closed.seq + 1);
    expect((await api(rahul, 'POST', `/app/trips/${trip}/decisions/${decision}/vote`, { option_index: 0 })).status).toBe(409);
  });

  it('an anonymous vote event has totals only', async () => {
    const o = await goCall('open_vote', { question: 'Secret?', kind: 'yesno', anonymous: true, options: [{ label: 'Yes' }, { label: 'No' }] }, trip);
    await api(rahul, 'POST', `/app/trips/${trip}/decisions/${o.decision_id}/vote`, { option_index: 1 });
    await h.flush();
    const e = events('decision.voted').find((x) => x.data.decision_id === o.decision_id)!;
    expect(e.data).toEqual({ decision_id: o.decision_id, voted: 1, of: 3, tally: [0, 1] });
    expect(check('Event', e)).toMatchObject({ ok: true });
    await api(rahul, 'POST', `/app/trips/${trip}/decisions/${o.decision_id}/cancel`);
    await h.flush();
    expect(events('decision.cancelled').at(-1)!.data).toEqual({ decision_id: o.decision_id, by: { kind: 'person', person_id: rahul.id } });
  });

  it('only the payer can answer the mandate; "Yes, book it" opens the spend check', async () => {
    await goCall('set_mandate', { decision_id: decision, choice_index: 0, cap_minor: 5500000, currency: 'INR', refundable_only: true, payer_person_id: rahul.id }, trip);
    expect((await api(rahul, 'GET', `/app/trips/${trip}/needs-you`)).body).toContainEqual({ kind: 'mandate', decision_id: decision, text: 'Yes, book it? Villa Sol, up to ₹55,000', question: 'Where do we stay?' });
    expect((await api(priya, 'POST', `/app/trips/${trip}/decisions/${decision}/mandate/confirm`)).status).toBe(403);
    const ask = () => h.go.call('request_spend_approval', {
      request_id: `rq_sp_${Math.random()}`, trip_id: trip, decision_id: decision, amount_minor: 5420000, currency: 'INR', merchant: 'ixigo', purpose: 'Villa', refundable_until: '2099-01-01T00:00:00Z',
    });
    expect((await ask()).result.reason).toBe('payer_has_not_confirmed');
    await api(rahul, 'POST', `/app/trips/${trip}/decisions/${decision}/mandate/decline`);
    expect((await ask()).result.reason).toBe('payer_declined');
    await api(rahul, 'POST', `/app/trips/${trip}/decisions/${decision}/mandate/confirm`);
    await h.flush();
    expect(events('mandate.declined').at(-1)!.data).toEqual({ decision_id: decision, person_id: rahul.id });
    expect(events('mandate.confirmed').at(-1)!.data).toEqual({ decision_id: decision, person_id: rahul.id });
    expect((await ask()).result.status).toBe('approved');
    expect((await api(rahul, 'GET', `/app/trips/${trip}/needs-you`)).body.find((x: any) => x.kind === 'mandate')).toBeUndefined();
  });

  it('a person undoes a record line, and Go hears it', async () => {
    const m = await api(rahul, 'POST', `/app/trips/${trip}/messages`, { client_id: 'c7', text: 'north goa' });
    const l = await goCall('add_record_line', { kind: 'open', text: 'Scuba on Saturday?', proof: [{ message_id: m.body.message_id }], person_ids: [priya.id] }, trip);
    expect((await api(priya, 'GET', `/app/trips/${trip}/needs-you`)).body).toContainEqual({ kind: 'record', line_id: l.line_id, text: 'Scuba on Saturday?' });
    await api(kabir, 'POST', `/app/trips/${trip}/record/${l.line_id}/undo`);
    await h.flush();
    expect(events('record.changed').at(-1)!.data).toMatchObject({ change: 'undone', by: { kind: 'person', person_id: kabir.id }, line: { line_id: l.line_id, status: 'undone' } });
    expect((await api(priya, 'GET', `/app/trips/${trip}/needs-you`)).body.find((x: any) => x.kind === 'record')).toBeUndefined();
  });

  it('a Go card that names you is in your strip until Go removes you with replace_card', async () => {
    await goCall('post_message', { text: 'Rahul, approve?', card: { card_id: 'c_pay', kind: 'notice', fallback_text: 'Rahul, approve', title: 'Approve', body: 'x', tone: 'heads_up', for_person_ids: [rahul.id] } }, trip);
    expect((await api(rahul, 'GET', `/app/trips/${trip}/needs-you`)).body.find((x: any) => x.kind === 'card')).toMatchObject({ card_id: 'c_pay' });
    await h.go.call('replace_card', { trip_id: trip, card: { card_id: 'c_pay', kind: 'notice', fallback_text: 'done', title: 'Done', body: 'x', tone: 'heads_up', for_person_ids: [] } });
    expect((await api(rahul, 'GET', `/app/trips/${trip}/needs-you`)).body.find((x: any) => x.kind === 'card')).toBeUndefined();
  });
});

describe('leaving a trip', () => {
  it('a vote that was only waiting for the person who left closes: everyone left has voted', async () => {
    const leaver = await person('Leaver');
    await api(leaver, 'POST', `/app/join/${code}`, {});
    const o = await goCall('open_vote', { question: 'Last call?', kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }] }, trip);
    for (const w of [rahul, priya, kabir]) await api(w, 'POST', `/app/trips/${trip}/decisions/${o.decision_id}/vote`, { option_index: 0 });
    expect((await rows(h.pool, 'select status from decisions where decision_id = $1', [o.decision_id]))[0].status).toBe('open'); // waiting for the leaver
    await api(leaver, 'POST', `/app/trips/${trip}/leave`);
    expect((await rows(h.pool, 'select status from decisions where decision_id = $1', [o.decision_id]))[0].status).toBe('closed');
    await h.flush();
    expect(events('decision.closed').find((e) => e.data.decision.decision_id === o.decision_id)!.data.reason).toBe('everyone_voted');
    expect(events('person.left').at(-1)!.data).toEqual({ person_id: leaver.id });
  });
});

describe('expenses', () => {
  it('a person adds an expense: Go hears it, and the people who owe are pushed', async () => {
    h.push.sent.length = 0;
    const r = await api(kabir, 'POST', `/app/trips/${trip}/expenses`, { paid_by_person_id: kabir.id, amount_minor: 340000, note: 'Airport cab', category: 'getting_around', split_person_ids: [rahul.id, priya.id, kabir.id] });
    expect(r.status).toBe(200);
    await h.flush();
    expect(events('expense.changed').at(-1)!.data).toMatchObject({ change: 'added', by: { kind: 'person', person_id: kabir.id }, expense: { amount_minor: 340000, added_by_person_id: kabir.id } });
    const owed = h.push.sent.flatMap((s) => s.to);
    expect(owed.sort()).toEqual([priya.id, rahul.id].sort());
    // From money.transfers: the extra paisa of ₹3,400 / 3 goes to the first person who joined, so the shares add up.
    const body = (id: string) => h.push.sent.find((s) => s.to[0] === id)!.n.body;
    expect(body(rahul.id)).toBe('You owe Kabir ₹1,133.34 for Airport cab');
    expect(body(priya.id)).toBe('You owe Kabir ₹1,133.33 for Airport cab');
    const snap = (await h.go.call('read_trip', { trip_id: trip })).result;
    expect(snap.money.transfers).toEqual(expect.arrayContaining([
      { from_person_id: rahul.id, to_person_id: kabir.id, amount_minor: 113334, currency: 'INR' },
      { from_person_id: priya.id, to_person_id: kabir.id, amount_minor: 113333, currency: 'INR' },
    ]));
    await api(kabir, 'DELETE', `/app/trips/${trip}/expenses/${r.body.expense_id}`);
    await h.flush();
    expect(events('expense.changed').at(-1)!.data.change).toBe('removed');
  });
});

describe('asking Go', () => {
  const tap = (who: Who, body: Record<string, unknown>) => api(who, 'POST', `/app/trips/${trip}/card-taps`, body);

  it('sends a tap on a Go card to Go with a tap id, and gives its answer to the app', async () => {
    await goCall('post_message', { text: 'Flights', card: { card_id: 'c_opts', kind: 'options', fallback_text: 'flights', title: 'Flights', option_kind: 'flight', checked_at: '2026-10-05T06:49:30Z', options: [{ option_id: 'o1', title: 'IndiGo', price_minor: 592000, currency: 'INR', highlights: ['Non-stop'] }], actions: [{ action_id: 'pick', label: 'Pick', style: 'primary', per_option: true }] } }, trip);
    const r = await tap(priya, { card_id: 'c_opts', action_id: 'pick', option_id: 'o1', tap_id: 'tap_press_1' });
    expect(r.body).toEqual({ result: 'done', toast: 'Noted. Go will reply in the room.' });
    const priyaTap = tapIdFor(priya.id, 'tap_press_1');
    expect(h.go.requests.at(-1)).toEqual({ method: 'card_tap', params: { tap_id: priyaTap, trip_id: trip, card_id: 'c_opts', action_id: 'pick', person_id: priya.id, option_id: 'o1' } });
    await tap(priya, { card_id: 'c_opts', action_id: 'pick', option_id: 'o1', tap_id: 'tap_press_1' });
    expect(h.go.requests.at(-1)!.params.tap_id).toBe(priyaTap); // the same press keeps its id
    // Someone else replaying Priya's press id is a different tap: they can never get Priya's answer from Go.
    await tap(rahul, { card_id: 'c_opts', action_id: 'pick', option_id: 'o1', tap_id: 'tap_press_1' });
    expect(h.go.requests.at(-1)!.params.tap_id).not.toBe(priyaTap);
  });

  it('makes a tap id when the app sent none, and refuses record cards, unknown cards and strangers', async () => {
    await tap(rahul, { card_id: 'c_opts', action_id: 'vote' });
    expect(h.go.requests.at(-1)!.params.tap_id).toMatch(/^tap_/);
    await goCall('post_message', { text: 'Vote', card: { card_id: 'c_vote', kind: 'vote', decision_id: (await rows(h.pool, 'select decision_id from decisions limit 1'))[0].decision_id, fallback_text: 'Vote' } }, trip);
    expect((await tap(rahul, { card_id: 'c_vote', action_id: 'x' })).status).toBe(422); // the Server handles record cards
    expect((await tap(rahul, { card_id: 'c_nope', action_id: 'x' })).status).toBe(404);
    expect((await tap(await person('Stranger2'), { card_id: 'c_opts', action_id: 'x' })).status).toBe(403);
  });

  it('tells the person when Go does not answer, is busy, or refuses', async () => {
    const before = h.go.requests.length;
    h.go.answers.card_tap = () => ({ error: { code: 429, message: 'slow', data: { code: 'rate_limited', retry_after_seconds: 5 } } });
    const busy = await h.app.inject({ method: 'POST', url: `/app/trips/${trip}/card-taps`, payload: { card_id: 'c_opts', action_id: 'pick' }, headers: { authorization: `Bearer ${priya.token}` } });
    expect(busy.statusCode).toBe(429);
    expect(busy.headers['retry-after']).toBe('5');
    h.go.answers.card_tap = () => ({ error: { code: 503, message: 'deploy', data: { code: 'unavailable' } } });
    expect((await tap(priya, { card_id: 'c_opts', action_id: 'pick' })).status).toBe(503);
    h.go.answers.card_tap = () => ({ result: { result: 'banana' } }); // not a valid answer
    expect((await tap(priya, { card_id: 'c_opts', action_id: 'pick' })).status).toBe(502);
    // not sent again on its own: one request each
    expect(h.go.requests.length - before).toBe(3);
    h.go.answers.card_tap = () => ({ result: { result: 'refused', toast: 'Only Rahul can approve' } });
    expect((await tap(priya, { card_id: 'c_opts', action_id: 'approve' })).body).toEqual({ result: 'refused', toast: 'Only Rahul can approve' });
  });

  it('asks Go for a catch-up only when the person was away 3 hours or has 15 unread', async () => {
    await api(priya, 'POST', `/app/trips/${trip}/seen`);
    expect((await api(priya, 'POST', `/app/trips/${trip}/catch-up`)).body).toEqual({ needed: false });
    await h.pool.query("update trip_people set last_seen_at = now() - interval '4 hours' where person_id = $1", [priya.id]);
    const r = await api(priya, 'POST', `/app/trips/${trip}/catch-up`);
    expect(r.body).toMatchObject({ needed: true, summary: expect.any(String), items: [{ kind: 'decided' }] });
    expect(h.go.requests.at(-1)!.method).toBe('catch_up');
    expect(h.go.requests.at(-1)!.params).toMatchObject({ trip_id: trip, person_id: priya.id });
    expect(check('CatchUpRequest', h.go.requests.at(-1)!.params)).toMatchObject({ ok: true });
  });
});

describe('the You screen', () => {
  it('shows what Go knows, turns carry-over on, deletes one fact, and opens the vault', async () => {
    expect((await api(priya, 'GET', '/app/me/go-knows')).body).toEqual({ person_id: priya.id, carry_over: false, facts: [] });
    expect((await api(priya, 'PUT', '/app/me/carry-over', { carry_over: true })).body).toEqual({ ok: true });
    expect(h.go.requests.at(-1)).toEqual({ method: 'update_person', params: { person_id: priya.id, carry_over: true } });
    await api(priya, 'DELETE', '/app/me/facts/f_1');
    expect(h.go.requests.at(-1)).toEqual({ method: 'delete_fact', params: { person_id: priya.id, fact_id: 'f_1' } });
    const v = await api(priya, 'POST', '/app/me/vault-link', { start: 'add_card' });
    expect(v.body.url).toContain('/vault/');
    expect(h.go.requests.at(-1)).toEqual({ method: 'vault_link', params: { kind: 'vault', person_id: priya.id, start: 'add_card' } });
  });

  it('asks only for the signed-in person: nobody can read another person\'s page', async () => {
    await api(priya, 'GET', '/app/me/go-knows');
    expect(h.go.requests.at(-1)!.params.person_id).toBe(priya.id);
    expect((await api(null, 'GET', '/app/me/go-knows')).status).toBe(401);
  });

  it('forget me: Go forgets, then the Server clears the join answers in the trip and Go hears person.updated', async () => {
    const r = await api(priya, 'POST', '/app/me/forget', { trip_id: trip });
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
    await api(priya, 'POST', '/app/me/forget', {});
    expect(h.go.requests.at(-1)).toEqual({ method: 'forget_person', params: { person_id: priya.id } });
  });

  it('refuses to forget when Go says facts are left', async () => {
    h.go.answers.forget_person = () => ({ result: { deleted_facts: 1, remaining_facts: 2 } });
    expect((await api(priya, 'POST', '/app/me/forget', {})).status).toBe(502);
  });
});

describe('background jobs', () => {
  it('closes a vote whose time ran out (reason: time), once, and pushes people who have not voted when it is about to close', async () => {
    const soon = await goCall('open_vote', { question: 'Brunch where?', kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }], closes_at: new Date(Date.now() + 30 * 60_000).toISOString() }, trip);
    await api(rahul, 'POST', `/app/trips/${trip}/decisions/${soon.decision_id}/vote`, { option_index: 0 });
    h.push.sent.length = 0;
    expect(await pushClosingSoon(h.ctx)).toBe(1);
    expect(await pushClosingSoon(h.ctx)).toBe(0); // once per vote
    expect(h.push.sent[0]!.to.sort()).toEqual([kabir.id, priya.id].sort());
    expect(h.push.sent[0]!.n.body).toMatch(/^Brunch where\? closes in \d+ minutes$/);
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

  it('streams events to a member over server-sent events and refuses a non-member', async () => {
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (h.app.server.address() as any).port;
    const res = await fetch(`http://127.0.0.1:${port}/app/trips/${trip}/live`, { headers: { authorization: `Bearer ${rahul.token}` } });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const read = async () => new TextDecoder().decode((await reader.read()).value);
    expect(await read()).toContain('event: hello');
    await goCall('post_message', { text: 'live!' }, trip);
    let got = '';
    for (let i = 0; i < 5 && !got.includes('live!'); i++) got += await read();
    expect(got).toContain('event: message');
    expect(got).toContain('"text":"live!"');
    await reader.cancel();
    const stranger = await person('Stranger3');
    const denied = await fetch(`http://127.0.0.1:${port}/app/trips/${trip}/live`, { headers: { authorization: `Bearer ${stranger.token}` } });
    expect(denied.status).toBe(403);
  });
});
