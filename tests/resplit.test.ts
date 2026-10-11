// 12 Oct 2026. Go's "Split evenly" used to add a second expense (Go could only add_expense), so the totals counted the
// cost twice: Go now re-splits in place with update_expense (the Server's overlay). And a friend added to a stay's split
// could not open its voucher: re-splitting an expense that pays for a booking now adds the new people to the booking, by a
// person or by Go, so they see it and its files; so does an expense first written for a booking with people it does not
// cover (Go's add_expense, a person's expense). (Who sees a booking at all is in people-bookings.test.ts.)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check } from '../src/contract/index.js';
import { settleDemoTickets } from '../src/demo/attach.js';
import { setPdfRenderer } from '../src/demo/pdf.js';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';
import { uuidFor } from './helpers/seed.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  setPdfRenderer(async () => ({ bytes: Buffer.from('%PDF-1.7 voucher'), pages: 1 })); // stands in for Chromium: every demo ticket renders
  h = await startHarness(); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
});
afterAll(async () => {
  setPdfRenderer(undefined);
  await h.stop();
});

const trip = '/app/v1/trips/t_goa';
let n = 0;
const call = (method: string, params: Record<string, unknown>) => h.go.call(method, { request_id: `rq_rs_${++n}`, trip_id: 't_goa', ...params });
const ok = async (method: string, params: Record<string, unknown>) => {
  const f = await call(method, params);
  if (f.error) throw new Error(`${method}: ${JSON.stringify(f.error)}`);
  return f.result;
};
const seqNow = async () => Number((await rows(h.pool, `select seq from trips where trip_id = 't_goa'`))[0].seq);
/** What Go heard from here on, once the queue is empty. */
const heardSince = async (mark: number) => {
  await h.flush();
  return h.go.events.slice(mark).filter((e) => e.trip_id === 't_goa') as any[];
};
const mark = async () => {
  await h.flush();
  return h.go.events.length;
};
const goAdds = (split: string[], over: Record<string, unknown> = {}) =>
  ok('add_expense', { paid_by_person_id: 'p_rahul', amount_minor: 120000, currency: 'INR', note: `Scooters ${++n}`, category: 'getting_around', split_person_ids: split, ...over });

describe("Go's update_expense", () => {
  it('re-splits in place: one expense, the new split, the totals counted once; Go hears expense.changed updated by Go, then the room line "Go changed the split of …"', async () => {
    const before = (await t.api(t.as('p_arjun'), 'GET', `${trip}/money`)).body;
    const added = await goAdds(['p_rahul', 'p_priya'], { note: 'Scooters' });
    const from = await mark();
    const liveMark = h.live.events.length;
    const r = await call('update_expense', { expense_id: added.expense_id, split_person_ids: ['p_rahul', 'p_priya', 'p_arjun', 'p_meher'] });
    expect([r.error, r.result, check('WriteResult', r.result).ok]).toEqual([undefined, { seq: expect.any(Number) }, true]);
    expect(await rows(h.pool, `select expense_id, split_person_ids, note from expenses where trip_id = 't_goa' and note = 'Scooters' and removed_at is null`))
      .toEqual([{ expense_id: added.expense_id, split_person_ids: ['p_rahul', 'p_priya', 'p_arjun', 'p_meher'], note: 'Scooters' }]);
    const after = (await t.api(t.as('p_arjun'), 'GET', `${trip}/money`)).body;
    expect([after.spent_minor - before.spent_minor, after.me.i_owe]).toEqual([120000, [{ from_person_id: 'p_arjun', to_person_id: 'p_rahul', amount_minor: 30000, currency: 'INR' }]]);

    const heard = await heardSince(from);
    expect(heard.map((e) => [e.type, e.seq])).toEqual([['expense.changed', r.result.seq], ['message.created', r.result.seq + 1]]);
    expect(check('Event', heard[0])).toMatchObject({ ok: true });
    expect(heard[0].data).toEqual({ expense: expect.objectContaining({ expense_id: added.expense_id, split_person_ids: ['p_rahul', 'p_priya', 'p_arjun', 'p_meher'], amount_minor: 120000 }), change: 'updated', by: { kind: 'go' } });
    expect(heard[1].data.message).toMatchObject({ author: { kind: 'system' }, text: 'Go changed the split of Scooters · ₹1,200 · 4 ways' });
    const [line] = await rows(h.pool, `select ledger from messages where trip_id = 't_goa' and seq = $1`, [r.result.seq + 1]);
    expect(line.ledger).toEqual({ kind: 'expense_changed', expense_id: added.expense_id });
    // Phones re-read the money, and everyone's home.
    const live = h.live.events.slice(liveMark).map((e) => e.event as any);
    expect(live.some((e) => e.kind === 'trip' && e.seq === r.result.seq && e.kinds.includes('expense'))).toBe(true);
    expect(new Set(live.filter((e) => e.kind === 'home').map((e) => e.person_id))).toEqual(new Set(['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir']));
  });

  it('is done once per request_id: the same request again answers the same and changes nothing', async () => {
    const { expense_id } = await goAdds(['p_rahul', 'p_priya']);
    const params = { request_id: 'rq_rs_once', trip_id: 't_goa', expense_id, split_person_ids: ['p_rahul', 'p_kabir'] };
    const first = await h.go.call('update_expense', params);
    const from = await mark();
    const seq = await seqNow();
    const again = await h.go.call('update_expense', params);
    expect([again.result, await seqNow(), (await heardSince(from)).length]).toEqual([first.result, seq, 0]);
  });

  it('the same people (in any order, an id repeated) and the same note: the current change number, nothing written, no event, no line', async () => {
    const { expense_id } = await goAdds(['p_rahul', 'p_priya', 'p_arjun']);
    const from = await mark();
    const seq = await seqNow();
    const same = await call('update_expense', { expense_id, split_person_ids: ['p_arjun', 'p_rahul', 'p_priya', 'p_arjun'] });
    const sameNote = await call('update_expense', { expense_id, split_person_ids: ['p_rahul', 'p_priya', 'p_arjun'], note: (await rows(h.pool, 'select note from expenses where expense_id = $1', [expense_id]))[0].note });
    expect([same.result, sameNote.result, await seqNow(), (await heardSince(from)).length]).toEqual([{ seq }, { seq }, seq, 0]);
  });

  it('a new note alone: expense.changed updated with the note, and no money line (the split did not move)', async () => {
    const { expense_id } = await goAdds(['p_rahul', 'p_priya']);
    const from = await mark();
    const r = await ok('update_expense', { expense_id, split_person_ids: ['p_priya', 'p_rahul'], note: 'Scooters for two' });
    const heard = await heardSince(from);
    expect(heard.map((e) => [e.type, e.seq, e.data.expense?.note])).toEqual([['expense.changed', r.seq, 'Scooters for two']]);
  });

  it('may re-split any expense that stands, also one a person added; the person route keeps its own rule', async () => {
    const added = (await t.api(t.as('p_priya'), 'POST', `${trip}/expenses`, { paid_by_person_id: 'p_kabir', amount_minor: 60000, note: 'Airport cab', category: 'getting_around', split_person_ids: ['p_kabir', 'p_priya'] })).body;
    expect((await call('update_expense', { expense_id: added.expense_id, split_person_ids: ['p_kabir', 'p_priya', 'p_meher'] })).error).toBeUndefined();
    expect((await rows(h.pool, 'select split_person_ids from expenses where expense_id = $1', [added.expense_id]))[0].split_person_ids).toEqual(['p_kabir', 'p_priya', 'p_meher']);
    expect((await t.api(t.as('p_arjun'), 'PATCH', `${trip}/expenses/${added.expense_id}`, { split_person_ids: ['p_arjun'] })).status).toBe(403); // still only the adder
  });

  it('refuses, writing nothing: 404 for an unknown or removed expense (or trip), 422 for someone not in the trip or who left, an empty or too long list, a note too long', async () => {
    const { expense_id } = await goAdds(['p_rahul', 'p_priya']);
    const removed = (await t.api(t.as('p_priya'), 'POST', `${trip}/expenses`, { amount_minor: 100, note: 'Gone', category: 'food', split_person_ids: ['p_priya'] })).body.expense_id;
    expect((await t.api(t.as('p_priya'), 'DELETE', `${trip}/expenses/${removed}`)).status).toBe(200);
    const seq = await seqNow();
    const refusals = [
      await call('update_expense', { expense_id: 'e_nope', split_person_ids: ['p_rahul'] }),
      await call('update_expense', { expense_id: removed, split_person_ids: ['p_priya'] }),
      await h.go.call('update_expense', { request_id: 'rq_rs_trip', trip_id: 't_nope', expense_id, split_person_ids: ['p_rahul'] }),
      await call('update_expense', { expense_id, split_person_ids: ['p_rahul', 'p_stranger'] }),
      await call('update_expense', { expense_id, split_person_ids: [] }),
      await call('update_expense', { expense_id, split_person_ids: Array.from({ length: 31 }, (_, i) => `p_${i}`) }),
      await call('update_expense', { expense_id, split_person_ids: ['p_rahul'], note: 'x'.repeat(121) }),
    ];
    expect(refusals.map((r) => [r.error?.code, r.error?.data?.code])).toEqual([
      [404, 'not_found'], [404, 'not_found'], [404, 'not_found'], [422, 'invalid'], [422, 'invalid'], [422, 'invalid'], [422, 'invalid'],
    ]);
    expect([await seqNow(), (await rows(h.pool, 'select split_person_ids from expenses where expense_id = $1', [expense_id]))[0].split_person_ids]).toEqual([seq, ['p_rahul', 'p_priya']]);
  });
});

// ---------------------------------------------------------------- a re-split stay: the friend added sees the voucher

const payCard = (cardId: string, approvalId: string, payer: string, amount: number, merchant: string) => ({
  card_id: cardId, kind: 'pay', fallback_text: 'Approve the payment', for_person_ids: [payer], approval_id: approvalId, payer_person_id: payer,
  amount_minor: amount, currency: 'INR', merchant, purpose: `${merchant}, 3 nights`, expires_at: new Date(Date.now() + 600_000).toISOString(), state: 'waiting',
  actions: [{ action_id: 'approve', label: 'Pay with ixigo money', style: 'primary', only_for_person_ids: [payer] }],
});

/** The group votes for a stay, Rahul pays for it with the demo payment: the booking covers everyone in the trip now, its voucher is rendered. */
const paidStay = async (name: string) => {
  const everyone = (await rows(h.pool, `select person_id from trip_people where trip_id = 't_goa' and left_at is null`)).map((r) => r.person_id as string);
  const did = (await ok('open_vote', { question: `Where do we stay, ${name}?`, kind: 'choice', anonymous: false, options: [{ label: name, price_minor: 5000000, currency: 'INR' }, { label: 'Casa Azul' }] })).decision_id as string;
  for (const p of everyone) expect((await t.api(t.as(p), 'PUT', `${trip}/decisions/${did}/vote`, { option_index: 0 })).status).toBe(200);
  await ok('set_mandate', { decision_id: did, choice_index: 0, cap_minor: 5500000, currency: 'INR', refundable_only: false, payer_person_id: 'p_rahul' });
  await t.api(t.as('p_rahul'), 'POST', `${trip}/decisions/${did}/mandate/confirm`);
  const approval = await ok('request_spend_approval', { amount_minor: 5000000, currency: 'INR', merchant: `ixigo: ${name}`, purpose: `${name}, 3 nights`, decision_id: did });
  const cardId = `c_pay_${name.replace(/\W/g, '')}`;
  await ok('post_message', { text: 'Ready to pay', card: payCard(cardId, approval.approval_id, 'p_rahul', 5000000, `ixigo: ${name}`) });
  expect((await t.api(t.as('p_rahul'), 'POST', `${trip}/cards/${cardId}/actions`, { action_id: 'approve' })).body).toEqual({ result: 'done' });
  await settleDemoTickets();
  const [booking] = await rows(h.pool, 'select booking_id, for_person_ids, passengers from bookings where approval_id = $1', [approval.approval_id]);
  const [expense] = await rows(h.pool, 'select expense_id, split_person_ids from expenses where booking_id = $1', [booking.booking_id]);
  const [voucher] = await rows(h.pool, 'select document_id from booking_documents where booking_id = $1', [booking.booking_id]);
  expect([...booking.for_person_ids].sort()).toEqual([...everyone].sort()); // the demo payment splits the expense across exactly the covered people
  expect([...expense.split_person_ids].sort()).toEqual([...everyone].sort());
  return { booking_id: booking.booking_id as string, expense_id: expense.expense_id as string, document_id: voucher.document_id as string, everyone, covered: booking.for_person_ids as string[], passengers: booking.passengers };
};

/** Someone joins after the stay was paid for (as by invite link, without the events). */
const joins = async (id: string, name: string) => {
  await h.pool.query(`insert into people (person_id, name, email, auth_user_id, auth_provider) values ($1, $2, $3, $4, 'google')`, [id, name, `${id}@mail.test`, uuidFor(id)]);
  await h.pool.query(`insert into trip_people (trip_id, person_id, role, joined_at) values ('t_goa', $1, 'member', now())`, [id]);
};

/** What one person can open of a booking: [in their list, the booking (status), the voucher (status)]. */
const sees = async (who: string, bookingId: string, documentId: string) => [
  (await t.api(t.as(who), 'GET', `${trip}/bookings`)).body.items.some((b: any) => b.booking_id === bookingId),
  (await t.api(t.as(who), 'GET', `${trip}/bookings/${bookingId}`)).status,
  (await t.api(t.as(who), 'GET', `${trip}/bookings/${bookingId}/documents/${documentId}`)).status,
];

describe("re-splitting a booking's expense adds the new people to the booking", () => {
  it('through Go: the friend who joined later is added to the stay, sees it and opens the voucher; Go hears booking.changed updated by Go; nobody is taken off', async () => {
    const stay = await paidStay('Villa Sol');
    await joins('p_zoya', 'Zoya');
    expect(await sees('p_zoya', stay.booking_id, stay.document_id)).toEqual([false, 404, 404]);
    const from = await mark();
    const liveMark = h.live.events.length;

    // Go re-splits among Zoya and three of the five: nobody leaves the booking, Zoya joins it.
    const r = await ok('update_expense', { expense_id: stay.expense_id, split_person_ids: ['p_rahul', 'p_priya', 'p_arjun', 'p_zoya'] });
    const [booking] = await rows(h.pool, 'select for_person_ids, passengers from bookings where booking_id = $1', [stay.booking_id]);
    expect([booking.for_person_ids, booking.passengers]).toEqual([[...stay.covered, 'p_zoya'], stay.passengers]);
    expect(await sees('p_zoya', stay.booking_id, stay.document_id)).toEqual([true, 200, 302]);
    const hers = (await t.api(t.as('p_zoya'), 'GET', `${trip}/bookings/${stay.booking_id}`)).body;
    expect(hers.documents.map((d: any) => [d.document_id, typeof d.url])).toEqual([[stay.document_id, 'string']]);
    expect(await sees('p_meher', stay.booking_id, stay.document_id)).toEqual([true, 200, 302]); // off the split, still on the booking

    const heard = await heardSince(from);
    expect(heard.map((e) => [e.type, e.seq])).toEqual([['expense.changed', r.seq], ['message.created', r.seq + 1], ['booking.changed', r.seq + 2]]);
    expect(check('Event', heard[2])).toMatchObject({ ok: true });
    expect(heard[2].data).toMatchObject({ change: 'updated', by: { kind: 'go' }, booking: { booking_id: stay.booking_id, for_person_ids: [...stay.covered, 'p_zoya'] } });
    const live = h.live.events.slice(liveMark).map((e) => e.event as any);
    expect(live.filter((e) => e.kind === 'trip' && e.seq === r.seq + 2)).toEqual([{ kind: 'trip', seq: r.seq + 2, kinds: ['booking'] }]);
    expect(live.some((e) => e.kind === 'home' && e.person_id === 'p_zoya')).toBe(true);
  });

  it('through the person route ("Fix split" by the payer): the same, with booking.changed by that person; a re-split that adds nobody new leaves the booking alone', async () => {
    const stay = await paidStay('Casa Luz');
    await joins('p_yash', 'Yash');
    expect(await sees('p_yash', stay.booking_id, stay.document_id)).toEqual([false, 404, 404]);
    const from = await mark();
    const fixed = await t.api(t.as('p_rahul'), 'PATCH', `${trip}/expenses/${stay.expense_id}`, { split_person_ids: [...stay.everyone, 'p_yash'] });
    expect(fixed.status).toBe(200);
    expect((await rows(h.pool, 'select for_person_ids from bookings where booking_id = $1', [stay.booking_id]))[0].for_person_ids).toEqual([...stay.covered, 'p_yash']);
    expect(await sees('p_yash', stay.booking_id, stay.document_id)).toEqual([true, 200, 302]);
    const heard = await heardSince(from);
    expect(heard.map((e) => [e.type, e.seq])).toEqual([['expense.changed', fixed.body.seq], ['message.created', fixed.body.seq + 1], ['booking.changed', fixed.body.seq + 2]]);
    expect(heard[2].data).toMatchObject({ change: 'updated', by: { kind: 'person', person_id: 'p_rahul' }, booking: { for_person_ids: [...stay.covered, 'p_yash'] } });

    // Fewer people again: nobody is taken off the booking, and Go hears no booking change.
    const again = await mark();
    expect((await t.api(t.as('p_rahul'), 'PATCH', `${trip}/expenses/${stay.expense_id}`, { split_person_ids: ['p_rahul', 'p_yash'] })).status).toBe(200);
    expect((await rows(h.pool, 'select for_person_ids from bookings where booking_id = $1', [stay.booking_id]))[0].for_person_ids).toEqual([...stay.covered, 'p_yash']);
    expect((await heardSince(again)).map((e) => e.type)).toEqual(['expense.changed', 'message.created']);
  });
});

describe('an expense first written for a booking, split with people it does not cover, adds them to the booking', () => {
  /** Go books a room for Rahul alone, with its voucher (a covered file). */
  const rahulsRoom = async (title: string) => {
    const booking_id = (await ok('add_booking', { kind: 'stay', title, vendor: 'ixigo', ref: 'IXG-9', amount_minor: 2000000, currency: 'INR', payer_person_id: 'p_rahul', for_person_ids: ['p_rahul'] })).booking_id as string;
    const document_id = `doc_${booking_id}`;
    await h.pool.query(`insert into booking_documents (document_id, booking_id, name, mime, size_bytes, visibility, path) values ($1, $2, 'Hotel voucher.pdf', 'application/pdf', 9, 'covered', $3)`, [document_id, booking_id, `bookings/t_goa/${booking_id}/voucher.pdf`]);
    return { booking_id, document_id };
  };

  it("through Go's add_expense: the friend it is split with sees the room and opens the voucher; Go hears booking.changed updated by Go after the expense and its line", async () => {
    const room = await rahulsRoom('Room at Villa Sol');
    expect(await sees('p_priya', room.booking_id, room.document_id)).toEqual([false, 404, 404]);
    const from = await mark();
    const liveMark = h.live.events.length;
    const added = await goAdds(['p_rahul', 'p_priya'], { booking_id: room.booking_id, category: 'stay', amount_minor: 2000000 });
    expect((await rows(h.pool, 'select for_person_ids from bookings where booking_id = $1', [room.booking_id]))[0].for_person_ids).toEqual(['p_rahul', 'p_priya']);
    expect(await sees('p_priya', room.booking_id, room.document_id)).toEqual([true, 200, 302]);
    const heard = await heardSince(from);
    expect(heard.map((e) => [e.type, e.seq])).toEqual([['expense.changed', added.seq], ['message.created', added.seq + 1], ['booking.changed', added.seq + 2]]);
    expect(heard[2].data).toMatchObject({ change: 'updated', by: { kind: 'go' }, booking: { booking_id: room.booking_id, for_person_ids: ['p_rahul', 'p_priya'] } });
    const live = h.live.events.slice(liveMark).map((e) => e.event as any);
    expect(live.filter((e) => e.kind === 'trip' && e.seq === added.seq + 2)).toEqual([{ kind: 'trip', seq: added.seq + 2, kinds: ['booking'] }]);
  });

  it("through a person's expense: the same, by that person; an expense its booking already covers changes nothing", async () => {
    const room = await rahulsRoom('Room at Casa Luz');
    const from = await mark();
    const own = await t.api(t.as('p_rahul'), 'POST', `${trip}/expenses`, { amount_minor: 2000000, note: 'Casa Luz', category: 'stay', split_person_ids: ['p_rahul', 'p_meher'], booking_id: room.booking_id });
    expect([own.status, (await rows(h.pool, 'select for_person_ids from bookings where booking_id = $1', [room.booking_id]))[0].for_person_ids]).toEqual([201, ['p_rahul', 'p_meher']]);
    expect(await sees('p_meher', room.booking_id, room.document_id)).toEqual([true, 200, 302]);
    expect((await heardSince(from)).find((e) => e.type === 'booking.changed').data).toMatchObject({ by: { kind: 'person', person_id: 'p_rahul' }, booking: { for_person_ids: ['p_rahul', 'p_meher'] } });

    const covered = await mark();
    expect((await t.api(t.as('p_rahul'), 'POST', `${trip}/expenses`, { amount_minor: 50000, note: 'Casa Luz breakfast', category: 'food', split_person_ids: ['p_meher', 'p_rahul'], booking_id: room.booking_id })).status).toBe(201);
    expect((await heardSince(covered)).map((e) => e.type)).toEqual(['expense.changed', 'message.created']);
  });
});
