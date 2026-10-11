// GET /trips/:trip/needs-you v2 (app contract §4.11): every kind with its stable item_id, title, subtitle, cta_label,
// since and target; settle_up from money.transfers; the expense kind read from phase 3's table only when it exists.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closesIn } from '../src/domain/actions.js';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness(); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
});
afterAll(() => h.stop());

const strip = async (who: string) => (await t.api(t.as(who), 'GET', '/app/v1/trips/t_goa/needs-you')).body as { items: any[]; seq: number };
const ofKind = async (who: string, kind: string) => (await strip(who)).items.filter((x) => x.kind === kind);
const ISO = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/);

describe('the shape', () => {
  it('answers { items, seq } with the trip\'s change number; an empty strip is items: []; 403 outside the trip, 401 unsigned', async () => {
    const r = await t.api(t.as('p_rahul'), 'GET', '/app/v1/trips/t_goa/needs-you');
    expect([r.status, r.body, (await rows(h.pool, `select seq from trips where trip_id = 't_goa'`))[0].seq]).toEqual([200, { items: [], seq: 1 }, 1]);
    expect((await t.api(t.as('p_stranger'), 'GET', '/app/v1/trips/t_goa/needs-you')).status).toBe(403);
    expect((await t.api(null, 'GET', '/app/v1/trips/t_goa/needs-you')).status).toBe(401);
  });

  it('vote: for each person who has not voted, with the closing time or the count, the vote card\'s message, and the cancellation link when the vote is about a booking; gone once they vote', async () => {
    const soon = new Date(Date.now() + 90 * 60_000).toISOString();
    const timed = (await h.go.call('open_vote', { request_id: 'rq_ny_v1', trip_id: 't_goa', question: 'Pick dates', kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }], closes_at: soon })).result.decision_id;
    const posted = (await h.go.call('post_message', { request_id: 'rq_ny_m1', trip_id: 't_goa', text: 'Vote!', card: { card_id: 'c_ny_vote', kind: 'vote', decision_id: timed, fallback_text: 'Pick dates' } })).result.message_id;
    const open = (await t.api(t.as('p_priya'), 'POST', '/app/v1/trips/t_goa/decisions', { client_id: 'ny-open', question: 'Where to eat?', kind: 'yesno', anonymous: false, options: [{ label: 'Yes' }, { label: 'No' }] })).body;
    await t.api(t.as('p_priya'), 'PUT', `/app/v1/trips/t_goa/decisions/${open.decision.decision_id}/vote`, { option_index: 0 });
    const votes = await ofKind('p_kabir', 'vote');
    expect(votes).toEqual([
      { item_id: `vote:${timed}:p_kabir`, kind: 'vote', title: 'Pick dates', subtitle: 'closes in 2 hours', cta_label: 'Vote', since: ISO, target: { decision_id: timed, message_id: posted } },
      { item_id: `vote:${open.decision.decision_id}:p_kabir`, kind: 'vote', title: 'Where to eat?', subtitle: '1 of 5 voted', cta_label: 'Vote', since: ISO, target: { decision_id: open.decision.decision_id, message_id: open.message.message_id } },
    ]);
    expect((await ofKind('p_priya', 'vote')).map((x) => x.item_id)).toEqual([`vote:${timed}:p_priya`]); // she voted in the second
    expect((await t.api(t.as('p_kabir'), 'GET', '/app/v1/trips/t_goa')).body.needs_you_count).toBe(2);
    // The same vote, read again: the same item_id (stable), and the same seq as the trip's.
    const again = await strip('p_kabir');
    expect([again.items.map((x) => x.item_id), again.seq]).toEqual([votes.map((x) => x.item_id), (await rows(h.pool, `select seq from trips where trip_id = 't_goa'`))[0].seq]);
    expect([closesIn(new Date(Date.now() + 30_000)), closesIn(new Date(Date.now() + 25 * 60_000)), closesIn(new Date(Date.now() + 60 * 60_000)), closesIn(new Date(Date.now() + 3 * 86_400_000))]).toEqual(['closes in 1 minute', 'closes in 25 minutes', 'closes in 1 hour', 'closes in 3 days']);
    // A cancellation vote carries the booking it is about.
    const bid = (await t.api(t.as('p_arjun'), 'POST', '/app/v1/trips/t_goa/bookings', { kind: 'stay', title: 'Villa Sol', vendor: 'ixigo', ref: 'R', amount_minor: 100, payer_person_id: 'p_rahul', for_person_ids: ['p_rahul'] })).body.booking_id;
    const cancel = (await t.api(t.as('p_priya'), 'POST', `/app/v1/trips/t_goa/bookings/${bid}/cancel-vote`, {})).body.decision_id;
    expect((await ofKind('p_kabir', 'vote')).find((x) => x.target.decision_id === cancel)).toMatchObject({ title: 'Cancel this booking? Villa Sol', subtitle: 'closes in 24 hours', target: { decision_id: cancel, cancels_booking_id: bid } });
    for (const did of [timed, open.decision.decision_id, cancel]) await t.api(t.as('p_rahul'), 'POST', `/app/v1/trips/t_goa/decisions/${did}/cancel`);
    expect(await ofKind('p_kabir', 'vote')).toEqual([]);
  });

  it('mandate: the payer, with "Yes, book it? <label>, up to <amount>" as the title and the question as the subtitle, the mandate card when Go posted one; gone once answered', async () => {
    const did = (await h.go.call('open_vote', { request_id: 'rq_ny_v2', trip_id: 't_goa', question: 'Where do we stay?', kind: 'choice', anonymous: false, options: [{ label: 'Villa Sol', price_minor: 5420000, currency: 'INR' }, { label: 'Casa Azul' }] })).result.decision_id;
    for (const p of ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir']) await t.api(t.as(p), 'PUT', `/app/v1/trips/t_goa/decisions/${did}/vote`, { option_index: 0 });
    await h.go.call('set_mandate', { request_id: 'rq_ny_m', trip_id: 't_goa', decision_id: did, choice_index: 0, cap_minor: 5500000, currency: 'INR', refundable_only: true, payer_person_id: 'p_rahul' });
    const card = (await h.go.call('post_message', { request_id: 'rq_ny_m2', trip_id: 't_goa', text: 'Rahul?', card: { card_id: 'c_ny_mandate', kind: 'mandate', decision_id: did, fallback_text: 'Yes, book Villa Sol?' } })).result;
    expect(await ofKind('p_rahul', 'mandate')).toEqual([{ item_id: `mandate:${did}`, kind: 'mandate', title: 'Yes, book it? Villa Sol, up to ₹55,000', subtitle: 'Where do we stay?', cta_label: 'Yes, book it', since: ISO, target: { decision_id: did, card_id: 'c_ny_mandate', message_id: card.message_id } }]);
    expect(await ofKind('p_priya', 'mandate')).toEqual([]);
    await t.api(t.as('p_rahul'), 'POST', `/app/v1/trips/t_goa/decisions/${did}/mandate/decline`);
    expect(await ofKind('p_rahul', 'mandate')).toEqual([]);
    // A new mandate clears the answer: it shows again.
    await h.go.call('set_mandate', { request_id: 'rq_ny_m3', trip_id: 't_goa', decision_id: did, choice_index: 0, cap_minor: 5600000, currency: 'INR', refundable_only: true, payer_person_id: 'p_rahul' });
    expect((await ofKind('p_rahul', 'mandate')).map((x) => [x.item_id, x.title])).toEqual([[`mandate:${did}`, 'Yes, book it? Villa Sol, up to ₹56,000']]);
    await t.api(t.as('p_rahul'), 'POST', `/app/v1/trips/t_goa/decisions/${did}/mandate/confirm`);
  });

  it('card: the people in a Go card\'s for_person_ids, with the fallback text, the card\'s title and its first button; gone when replace_card drops them', async () => {
    const m = (await h.go.call('post_message', { request_id: 'rq_ny_c1', trip_id: 't_goa', text: 'Cab?', card: { card_id: 'c_ny_cab', kind: 'notice', fallback_text: 'Airport cab to Villa Sol', title: 'Fri 9:55 pm · with Arjun', body: 'x', tone: 'heads_up', for_person_ids: ['p_rahul', 'p_arjun'], actions: [{ action_id: 'book', label: 'Book ₹1,600', style: 'primary' }] } })).result;
    expect(await ofKind('p_arjun', 'card')).toEqual([{ item_id: 'card:c_ny_cab', kind: 'card', title: 'Airport cab to Villa Sol', subtitle: 'Fri 9:55 pm · with Arjun', cta_label: 'Book ₹1,600', since: ISO, target: { card_id: 'c_ny_cab', message_id: m.message_id } }]);
    expect(await ofKind('p_priya', 'card')).toEqual([]);
    await h.go.call('replace_card', { trip_id: 't_goa', card: { card_id: 'c_ny_cab', kind: 'notice', fallback_text: 'Booked', title: 'Booked', body: 'x', tone: 'heads_up', for_person_ids: ['p_rahul'], actions: [{ action_id: 'pay', label: 'Pay', style: 'primary' }] } });
    expect([(await ofKind('p_arjun', 'card')).length, (await ofKind('p_rahul', 'card')).map((x) => x.title)]).toEqual([0, ['Booked']]);
    // Still naming Rahul, but nothing left to press: information, not a to-do.
    await h.go.call('replace_card', { trip_id: 't_goa', card: { card_id: 'c_ny_cab', kind: 'notice', fallback_text: 'Booked', title: 'Booked', body: 'x', tone: 'heads_up', for_person_ids: ['p_rahul'], actions: [] } });
    expect(await ofKind('p_rahul', 'card')).toEqual([]);
    await h.go.call('replace_card', { trip_id: 't_goa', card: { card_id: 'c_ny_cab', kind: 'notice', fallback_text: 'Booked', title: 'Booked', body: 'x', tone: 'heads_up' } });
  });

  it('record_line: an open, active line naming them, with the due date; gone when done, undone, agreed or doing', async () => {
    const l = (await h.go.call('add_record_line', { request_id: 'rq_ny_l1', trip_id: 't_goa', kind: 'open', text: 'Scuba on Saturday?', proof: [], person_ids: ['p_priya'], due_at: '2026-11-07T10:00:00Z' })).result;
    expect(await ofKind('p_priya', 'record_line')).toEqual([{ item_id: `record_line:${l.line_id}`, kind: 'record_line', title: 'Scuba on Saturday?', subtitle: 'due 2026-11-07', since: ISO, target: { line_id: l.line_id } }]);
    await h.go.call('update_record_line', { request_id: 'rq_ny_l2', trip_id: 't_goa', line_id: l.line_id, kind: 'doing' });
    expect(await ofKind('p_priya', 'record_line')).toEqual([]);
  });

  it('settle_up: one per net transfer where I owe, "Settle up with <name>", the amount left, cta Record, and the transfer as the target; gone when squared', async () => {
    const r = await t.api(t.as('p_kabir'), 'POST', '/app/v1/trips/t_goa/expenses', { paid_by_person_id: 'p_kabir', amount_minor: 1740000, note: 'Villa deposit', category: 'stay', split_person_ids: ['p_kabir', 'p_priya', 'p_meher'] });
    expect(r.status).toBe(201);
    expect(await ofKind('p_priya', 'settle_up')).toEqual([{ item_id: 'settle:p_kabir', kind: 'settle_up', title: 'Settle up with Kabir', subtitle: '₹5,800 left of your share', cta_label: 'Record', since: ISO, target: { transfer: { to_person_id: 'p_kabir', amount_minor: 580000, currency: 'INR' } } }]);
    expect(await ofKind('p_kabir', 'settle_up')).toEqual([]); // the payee owes nobody
    expect((await t.api(t.as('p_priya'), 'GET', '/app/v1/trips/t_goa')).body.needs_you_count).toBe(1); // the settle-up only: nobody approves an expense
    // Priya pays Kabir's share of something else: the transfer shrinks, then goes.
    await t.api(t.as('p_priya'), 'POST', '/app/v1/trips/t_goa/expenses', { paid_by_person_id: 'p_priya', amount_minor: 400000, note: 'Dinner', category: 'food', split_person_ids: ['p_kabir'] });
    expect((await ofKind('p_priya', 'settle_up'))[0]).toMatchObject({ item_id: 'settle:p_kabir', subtitle: '₹1,800 left of your share' });
    await t.api(t.as('p_priya'), 'POST', '/app/v1/trips/t_goa/expenses', { paid_by_person_id: 'p_priya', amount_minor: 180000, note: 'Cab back', category: 'getting_around', split_person_ids: ['p_kabir'] });
    expect(await ofKind('p_priya', 'settle_up')).toEqual([]);
  });
});
