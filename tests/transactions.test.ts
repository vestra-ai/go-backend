// §4.9 GET /trips/:trip/transactions (phase 3): both kinds of row, the filters, the cursor and total_count.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appApi } from './helpers/app-api.js';
import { EVERYONE } from './helpers/cancel-flow.js';
import { startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
const trip = '/app/v1/trips/t_goa';
const ids: Record<string, string> = {};
beforeAll(async () => {
  h = await startHarness(); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
  // A booking paid through the vault (the approval id is set directly; the vault flow itself is tested in money.test.ts), and Go's expense for it.
  const b = (await h.go.call('add_booking', { request_id: 'rq_tx_b', trip_id: 't_goa', kind: 'stay', title: 'Villa Sol', vendor: 'ixigo', ref: 'IXG-1', amount_minor: 500000, currency: 'INR', payer_person_id: 'p_rahul', for_person_ids: EVERYONE })).result;
  await h.pool.query(`update bookings set approval_id = 'ap_villa' where booking_id = $1`, [b.booking_id]);
  ids.booking = b.booking_id;
  ids.villa = (await h.go.call('add_expense', { request_id: 'rq_tx_e', trip_id: 't_goa', paid_by_person_id: 'p_rahul', amount_minor: 500000, currency: 'INR', note: 'Villa Sol', category: 'stay', split_person_ids: EVERYONE, booking_id: b.booking_id, approval_id: 'ap_villa' })).result.expense_id;
  ids.cab = (await t.api(t.as('p_kabir'), 'POST', `${trip}/expenses`, { amount_minor: 30000, note: 'Airport cab', category: 'getting_around', split_person_ids: ['p_kabir', 'p_arjun', 'p_meher'] })).body.expense_id;
  ids.s1 = (await t.api(t.as('p_priya'), 'POST', `${trip}/settlements`, { to_person_id: 'p_rahul', amount_minor: 50000, currency: 'INR', method: 'upi' })).body.settlement.settlement_id;
  ids.s2 = (await t.api(t.as('p_arjun'), 'POST', `${trip}/settlements`, { to_person_id: 'p_rahul', amount_minor: 100000, currency: 'INR', method: 'cash', note: 'all of it' })).body.settlement.settlement_id;
  await t.api(t.as('p_rahul'), 'POST', `${trip}/settlements/${ids.s2}/confirm`);
  ids.bus = (await t.api(t.as('p_meher'), 'POST', `${trip}/expenses`, { amount_minor: 1000, note: 'Bus', category: 'getting_around', split_person_ids: ['p_meher', 'p_priya'] })).body.expense_id;
  await t.api(t.as('p_priya'), 'POST', `${trip}/expenses/${ids.bus}/dispute`, { reason: 'walked' });
  // Spread the rows over the last hours so the order is known: villa, cab, s1, s2, then the bus just now.
  for (const [table, column, id, hours] of [['expenses', 'expense_id', ids.villa, 4], ['expenses', 'expense_id', ids.cab, 3], ['settlements', 'settlement_id', ids.s1, 2], ['settlements', 'settlement_id', ids.s2, 1]] as const) {
    await h.pool.query(`update ${table} set created_at = now() - make_interval(hours => $2) where ${column} = $1`, [id, hours]);
  }
});
afterAll(() => h.stop());

const list = async (who: string, query = '') => t.api(t.as(who), 'GET', `${trip}/transactions${query}`);
const idsOf = (r: { body: any }) => r.body.items.map((x: any) => x.transaction_id);
const refusal = (r: { status: number; body: any }) => [r.status, r.body?.error?.code, r.body?.error?.field];

describe('the rows', () => {
  it('lists every expense and settlement newest first, each as the contract\'s Transaction with our status badge, and says which are mine', async () => {
    const r = await list('p_priya');
    expect([r.status, r.body.total_count, r.body.next_cursor, idsOf(r)]).toEqual([200, 5, null, [ids.bus, ids.s2, ids.s1, ids.cab, ids.villa]]);
    const [bus, s2, s1, cab, villa] = r.body.items;
    expect(bus).toEqual({ transaction_id: ids.bus, kind: 'booking', occurred_at: expect.any(String), payer_person_id: 'p_meher', verb: 'paid', to: { kind: 'merchant', name: 'Bus' }, amount_minor: 1000, currency: 'INR', note: 'Bus', mine: true, expense_id: ids.bus, expense_status: 'disputed' });
    expect(s2).toEqual({ transaction_id: ids.s2, kind: 'payback', occurred_at: expect.any(String), payer_person_id: 'p_arjun', verb: 'paid', to: { kind: 'person', person_id: 'p_rahul' }, amount_minor: 100000, currency: 'INR', method: 'cash', note: 'all of it', mine: false, settlement_id: ids.s2, settlement_status: 'confirmed' });
    expect(s1).toMatchObject({ kind: 'payback', payer_person_id: 'p_priya', method: 'upi', mine: true, settlement_status: 'pending_confirmation' });
    expect(s1.note).toBeUndefined();
    expect(cab).toMatchObject({ kind: 'booking', payer_person_id: 'p_kabir', verb: 'paid', to: { kind: 'merchant', name: 'Airport cab' }, mine: false, expense_status: 'pending' });
    expect(cab.method).toBeUndefined();
    expect(villa).toEqual({ transaction_id: ids.villa, kind: 'booking', occurred_at: expect.any(String), payer_person_id: 'p_rahul', verb: 'booked_with', to: { kind: 'merchant', name: 'ixigo' }, amount_minor: 500000, currency: 'INR', method: 'card', note: 'Villa Sol', mine: true, expense_id: ids.villa, booking_id: ids.booking, expense_status: 'approved' });
    expect((await list('p_kabir')).body.items.map((x: any) => x.mine)).toEqual([false, false, false, true, true]);
  });

  it('filters by kind, by mine, by pending and by disputed, and total_count ignores the filter', async () => {
    const got = async (filter: string) => {
      const r = await list('p_priya', `?filter=${filter}`);
      return [r.body.total_count, idsOf(r)];
    };
    expect(await got('all')).toEqual([5, [ids.bus, ids.s2, ids.s1, ids.cab, ids.villa]]);
    expect(await got('booking')).toEqual([5, [ids.bus, ids.cab, ids.villa]]);
    expect(await got('payback')).toEqual([5, [ids.s2, ids.s1]]);
    expect(await got('mine')).toEqual([5, [ids.bus, ids.s1, ids.villa]]);
    expect(await got('pending')).toEqual([5, [ids.s1, ids.cab]]);
    expect(await got('disputed')).toEqual([5, [ids.bus]]);
  });

  it('pages with an opaque cursor that never skips or repeats a row, within a filter too', async () => {
    const first = await list('p_priya', '?limit=2');
    const second = await list('p_priya', `?limit=2&before=${encodeURIComponent(first.body.next_cursor)}`);
    const third = await list('p_priya', `?limit=2&before=${encodeURIComponent(second.body.next_cursor)}`);
    expect([idsOf(first), idsOf(second), idsOf(third), third.body.next_cursor, first.body.total_count]).toEqual([[ids.bus, ids.s2], [ids.s1, ids.cab], [ids.villa], null, 5]);
    expect(typeof first.body.next_cursor === 'string' && !first.body.next_cursor.includes(ids.s2)).toBe(true); // opaque
    const mine = await list('p_priya', '?filter=mine&limit=2');
    const mineRest = await list('p_priya', `?filter=mine&limit=2&before=${encodeURIComponent(mine.body.next_cursor)}`);
    expect([idsOf(mine), idsOf(mineRest), mineRest.body.next_cursor]).toEqual([[ids.bus, ids.s1], [ids.villa], null]);
    expect((await list('p_priya', '?limit=5')).body.next_cursor).toBeNull(); // exactly a page: nothing more
  });

  it('refuses an unknown filter, a bad limit or cursor (422 naming the field), and an outsider (403)', async () => {
    expect(refusal(await list('p_priya', '?filter=big'))).toEqual([422, 'invalid', 'filter']);
    expect(refusal(await list('p_priya', '?limit=0'))).toEqual([422, 'invalid', 'limit']);
    expect(refusal(await list('p_priya', '?limit=101'))).toEqual([422, 'invalid', 'limit']);
    expect(refusal(await list('p_priya', '?limit=ten'))).toEqual([422, 'invalid', 'limit']);
    expect(refusal(await list('p_priya', '?before=not-a-cursor'))).toEqual([422, 'invalid', 'before']);
    expect(refusal(await list('p_nobody')).slice(0, 2)).toEqual([403, 'forbidden']);
  });
});
