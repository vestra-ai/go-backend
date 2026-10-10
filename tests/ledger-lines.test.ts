// §5.3 and §5.4 (rev 4): every money movement shows as a line in the room (a system message with the amount, its own
// change number, a `message.created` to Go with the text only, an app-only `ledger` member), and the home screen lists what I owe.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check } from '../src/contract/index.js';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';
import { seedTrip } from './helpers/seed.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness(); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
});
afterAll(() => h.stop());

const trip = '/app/v1/trips/t_goa';
const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) => t.api(t.as(who), method, url, body);
/** The room's money lines as the app reads them, oldest first. */
const lines = async (who = 'p_priya') => ((await call(who, 'GET', `${trip}/messages`)).body.messages as any[]).filter((m) => m.ledger).map((m) => ({ seq: m.seq, kind: m.author.kind, text: m.text.replace(/ /g, ' '), ledger: m.ledger }));
const seqOf = async (tripId = 't_goa') => (await rows(h.pool, 'select seq from trips where trip_id = $1', [tripId]))[0].seq as number;
let cab: string;

describe('money lines in the room', () => {
  it('adding an expense posts "<who> added <note> · <amount> · split N ways" as the next change, with the ledger member and a live frame; "paid by" appears when the payer is someone else', async () => {
    const mark = h.live.events.length;
    const r = await call('p_priya', 'POST', `${trip}/expenses`, { amount_minor: 170000, note: 'Airport cab', category: 'getting_around', split_person_ids: ['p_priya', 'p_arjun', 'p_kabir', 'p_rahul'] });
    cab = r.body.expense_id;
    const other = await call('p_priya', 'POST', `${trip}/expenses`, { paid_by_person_id: 'p_kabir', amount_minor: 40000, note: 'Lunch', category: 'food', split_person_ids: ['p_kabir', 'p_arjun'] });
    expect(await lines()).toEqual([
      { seq: r.body.seq + 1, kind: 'system', text: 'Priya added Airport cab · ₹1,700 · split 4 ways', ledger: { kind: 'expense_added', expense_id: cab } },
      { seq: other.body.seq + 1, kind: 'system', text: 'Priya added Lunch · ₹400 · paid by Kabir · split 2 ways', ledger: { kind: 'expense_added', expense_id: other.body.expense_id } },
    ]);
    expect(h.live.events.slice(mark).filter((e) => e.event.kind !== 'home').slice(0, 2).map((e) => e.event)).toEqual([{ kind: 'trip', seq: r.body.seq, kinds: ['settlement', 'expense'] }, { kind: 'message', message_id: expect.any(String), updated_seq: r.body.seq + 1 }]); // change numbers reach the app in order
  });

  it('fixing a split and removing an expense each post their line; a new note alone posts none', async () => {
    const fixed = await call('p_priya', 'PATCH', `${trip}/expenses/${cab}`, { split_person_ids: ['p_priya', 'p_arjun', 'p_kabir'] });
    const count = (await lines()).length;
    await call('p_priya', 'PATCH', `${trip}/expenses/${cab}`, { split_person_ids: ['p_kabir', 'p_arjun', 'p_priya'], note: 'Airport cab' }); // the same people
    expect((await lines()).length).toBe(count);
    const removed = await call('p_priya', 'DELETE', `${trip}/expenses/${cab}`);
    expect((await lines()).slice(-2)).toEqual([
      { seq: fixed.body.seq + 1, kind: 'system', text: 'Priya changed the split of Airport cab · ₹1,700 · 3 ways', ledger: { kind: 'expense_changed', expense_id: cab } },
      { seq: removed.body.seq + 1, kind: 'system', text: 'Priya removed Airport cab · ₹1,700', ledger: { kind: 'expense_removed', expense_id: cab } },
    ]);
  });

  it('a payback posts "<from> paid <to> <amount>", and an expense Go adds posts "Go added …" naming the payer; Go\'s answer keeps the expense\'s own change number', async () => {
    const paid = await call('p_arjun', 'POST', `${trip}/settlements`, { to_person_id: 'p_kabir', amount_minor: 10000, currency: 'INR', method: 'upi' });
    const go = (await h.go.call('add_expense', { request_id: 'rq_line_1', trip_id: 't_goa', paid_by_person_id: 'p_rahul', amount_minor: 5420000, currency: 'INR', note: 'Villa Sol', category: 'stay', split_person_ids: ['p_rahul', 'p_priya', 'p_arjun', 'p_kabir'] })).result;
    expect((await lines()).slice(-2)).toEqual([
      { seq: paid.body.seq + 1, kind: 'system', text: 'Arjun paid Kabir ₹100', ledger: { kind: 'payback', settlement_id: paid.body.settlement.settlement_id } },
      { seq: go.seq + 1, kind: 'system', text: 'Go added Villa Sol · ₹54,200 · paid by Rahul · split 4 ways', ledger: { kind: 'expense_added', expense_id: go.expense_id } },
    ]);
    // A repeat of Go's request is answered from the first: no second expense and no second line.
    const again = (await h.go.call('add_expense', { request_id: 'rq_line_1', trip_id: 't_goa', paid_by_person_id: 'p_rahul', amount_minor: 5420000, currency: 'INR', note: 'Villa Sol', category: 'stay', split_person_ids: ['p_rahul', 'p_priya', 'p_arjun', 'p_kabir'] })).result;
    expect([again, (await lines()).filter((l) => l.text.startsWith('Go added')).length]).toEqual([go, 1]);
  });

  it('a refused action posts nothing and takes no change number', async () => {
    const [before, count] = [await seqOf(), (await lines()).length];
    const refused = [
      await call('p_rahul', 'DELETE', `${trip}/expenses/${cab}`), // already removed: 404
      await call('p_priya', 'POST', `${trip}/expenses`, { amount_minor: 100, note: 'x', category: 'food', split_person_ids: ['p_ghost'] }), // 422
      await call('p_arjun', 'POST', `${trip}/settlements`, { to_person_id: 'p_arjun', amount_minor: 100, currency: 'INR', method: 'cash' }), // 422
    ];
    expect([refused.map((r) => r.status), await seqOf(), (await lines()).length]).toEqual([[404, 422, 422], before, count]);
  });

  it('a line is a record, not a message to anyone: Go gets it as message.created at its change number (text only, no ledger), but it is not unread and not the chat preview', async () => {
    const appLines = await lines();
    const events = (await rows(h.pool, 'select seq, body from outbox where trip_id = $1 and seq = any($2) order by seq', ['t_goa', appLines.map((l) => l.seq)])).map((r) => r.body);
    // One event per line, at the line's own number: the message as Go reads it, author system, the text, and no ledger member.
    expect(events.map((e) => [e.seq, e.type, e.data.message.seq, e.data.message.author, e.data.message.text.replace(/ /g, ' ')]))
      .toEqual(appLines.map((l) => [l.seq, 'message.created', l.seq, { kind: 'system' }, l.text]));
    expect(events.some((e) => 'ledger' in e.data.message)).toBe(false);
    for (const e of events) expect(check('Event', e)).toMatchObject({ ok: true });
    const view = (await call('p_meher', 'GET', trip)).body; // Meher has read nothing and nobody has written a message
    expect([view.me.unread_count, view.chat.last_message ?? null]).toEqual([0, null]);
    // Enough lines to pass the catch-up's unread mark, were they messages: Go is still not asked.
    for (let i = 0; i < 16; i++) await call('p_priya', 'POST', `${trip}/expenses`, { amount_minor: 100, note: `Tea ${i}`, category: 'food', split_person_ids: ['p_priya'] });
    expect([(await call('p_meher', 'GET', `${trip}/catch-up`)).status, h.go.requests.filter((x) => x.method === 'catch_up').length]).toEqual([204, 0]);
  });

  it('Go reads the line as text only: no ledger member, and the message is valid against the contract', async () => {
    const forGo = ((await h.go.call('read_messages', { trip_id: 't_goa', after_seq: 0 })).result.messages as any[]).filter((m) => m.author.kind === 'system' && /added|paid|removed|changed/.test(m.text ?? ''));
    expect([forGo.length, forGo.some((m) => 'ledger' in m), forGo.every((m) => check('Message', m).ok), forGo[0].text.replace(/ /g, ' ')]).toEqual([(await lines()).length, false, true, 'Priya added Airport cab · ₹1,700 · split 4 ways']);
  });
});

describe('what I owe, on home', () => {
  const home = async (who: string) => (await call(who, 'GET', '/app/v1/home')).body;

  it('lists every transfer where I pay, across my active trips and then the ones that are over', async () => {
    await seedTrip(h.pool, 't_now');
    await seedTrip(h.pool, 't_old');
    await call('p_rahul', 'POST', '/app/v1/trips/t_now/expenses', { amount_minor: 100000, note: 'Dinner', category: 'food', split_person_ids: ['p_rahul', 'p_meher'] });
    await call('p_kabir', 'POST', '/app/v1/trips/t_old/expenses', { amount_minor: 60000, note: 'Cab', category: 'getting_around', split_person_ids: ['p_kabir', 'p_meher'] });
    await call('p_rahul', 'PATCH', '/app/v1/trips/t_old', { status: 'over' });
    const titleOf = async (id: string) => (await rows(h.pool, 'select title from trips where trip_id = $1', [id]))[0].title as string;
    expect((await home('p_meher')).owes).toEqual([
      { trip_id: 't_now', trip_title: await titleOf('t_now'), to: { person_id: 'p_rahul', name: 'Rahul' }, amount_minor: 50000, currency: 'INR' },
      { trip_id: 't_old', trip_title: await titleOf('t_old'), to: { person_id: 'p_kabir', name: 'Kabir' }, amount_minor: 30000, currency: 'INR' },
    ]);
  });

  it('drops a debt once it is paid back, still names someone who has left the trip, and is empty for someone who owes nothing', async () => {
    await call('p_meher', 'POST', '/app/v1/trips/t_now/settlements', { to_person_id: 'p_rahul', amount_minor: 50000, currency: 'INR', method: 'upi' });
    expect((await call('p_kabir', 'POST', '/app/v1/trips/t_old/leave')).status).toBe(204);
    expect([(await home('p_meher')).owes.map((o: any) => [o.trip_id, o.to, o.amount_minor]), (await home('p_arjun')).owes.filter((o: any) => o.trip_id !== 't_goa')]).toEqual([[['t_old', { person_id: 'p_kabir', name: 'Kabir' }, 30000]], []]);
  });
});
