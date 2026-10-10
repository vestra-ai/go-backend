// §4.9 (rev 4): an expense counts the moment it exists, nobody approves or disputes it, and only the person who added
// it may fix its split or remove it (the payer when Go added it or the adder has left; the organizer when neither is here).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appApi } from './helpers/app-api.js';
import { startHarness, type Harness } from './helpers/harness.js';
import { seedTrip } from './helpers/seed.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness(); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
  await seedTrip(h.pool, 't_left'); // the same five, for the cases where people leave
});
afterAll(() => h.stop());

const trip = '/app/v1/trips/t_goa';
const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) => t.api(t.as(who), method, url, body);
const refusal = (r: { status: number; body: any }) => [r.status, r.body?.error?.code, r.body?.error?.field ?? null];
/** Priya adds an expense that Kabir paid, split between Kabir and Arjun: the adder and the payer are different people. */
const cab = async (base = trip) => (await call('p_priya', 'POST', `${base}/expenses`, { paid_by_person_id: 'p_kabir', amount_minor: 60000, note: 'Airport cab', category: 'getting_around', split_person_ids: ['p_kabir', 'p_arjun'] })).body.expense_id as string;
const fix = (who: string, id: string, base = trip) => call(who, 'PATCH', `${base}/expenses/${id}`, { split_person_ids: ['p_kabir', 'p_arjun', 'p_meher'] });
const remove = (who: string, id: string, base = trip) => call(who, 'DELETE', `${base}/expenses/${id}`);
let rq = 0;
const goAdds = async (tripId = 't_goa') => (await h.go.call('add_expense', { request_id: `rq_rules_${++rq}`, trip_id: tripId, paid_by_person_id: 'p_kabir', amount_minor: 20000, currency: 'INR', note: 'Villa deposit', category: 'stay', split_person_ids: ['p_kabir', 'p_arjun'] })).result.expense_id as string;

describe('an expense counts at once', () => {
  it('is in the money straight away, and no read of it carries a standing or confirmations', async () => {
    const r = await call('p_priya', 'POST', `${trip}/expenses`, { amount_minor: 40000, note: 'Lunch', category: 'food', split_person_ids: ['p_priya', 'p_meher'] });
    const money = (await call('p_meher', 'GET', `${trip}/money`)).body;
    const listed = (await call('p_meher', 'GET', `${trip}/expenses`)).body.items.find((e: any) => e.expense_id === r.body.expense_id);
    const forGo = (await h.go.call('read_trip', { trip_id: 't_goa' })).result.expenses.find((e: any) => e.expense_id === r.body.expense_id);
    expect([r.status, money.spent_minor, money.me.i_owe]).toEqual([201, 40000, [{ from_person_id: 'p_meher', to_person_id: 'p_priya', amount_minor: 20000, currency: 'INR' }]]);
    expect([r.body, listed, forGo].map((e) => ['status' in e, 'confirmations' in e])).toEqual([[false, false], [false, false], [false, false]]);
  });

  it('asks nobody to approve it: nothing in "needs you" but the settle-up, and the home card follows the usual rule', async () => {
    const needs = (await call('p_meher', 'GET', `${trip}/needs-you`)).body.items;
    const home = (await call('p_meher', 'GET', '/app/v1/home')).body.trips.find((x: any) => x.trip_id === 't_goa');
    expect([needs.map((i: any) => i.kind), home.attention]).toEqual([['settle_up'], { kind: 'needs_you', count: 1 }]);
  });
});

describe('who may change an expense', () => {
  it('fix the split: the person who added it may; the payer, the organizer and another member may not', async () => {
    const id = await cab();
    expect([refusal(await fix('p_kabir', id)), refusal(await fix('p_rahul', id)), refusal(await fix('p_arjun', id))]).toEqual(Array(3).fill([403, 'forbidden', null]));
    const ok = await fix('p_priya', id);
    expect([ok.status, ok.body.split_person_ids]).toEqual([200, ['p_kabir', 'p_arjun', 'p_meher']]);
  });

  it('remove: the same four', async () => {
    const id = await cab();
    expect([refusal(await remove('p_kabir', id)), refusal(await remove('p_rahul', id)), refusal(await remove('p_arjun', id))]).toEqual(Array(3).fill([403, 'forbidden', null]));
    expect([(await remove('p_priya', id)).status, (await remove('p_priya', id)).status]).toEqual([200, 404]);
  });

  it('an expense Go added has no adder: the payer may, the organizer may not', async () => {
    const id = await goAdds();
    expect(refusal(await remove('p_rahul', id))).toEqual([403, 'forbidden', null]);
    expect([(await fix('p_kabir', id)).status, (await remove('p_kabir', id)).status]).toEqual([200, 200]);
  });

  let leftCab: string;
  it('when the person who added it has left, the payer may, and still not the organizer', async () => {
    const base = '/app/v1/trips/t_left';
    const id = (leftCab = await cab(base));
    expect((await call('p_priya', 'POST', `${base}/leave`)).status).toBe(204);
    expect(refusal(await fix('p_rahul', id, base))).toEqual([403, 'forbidden', null]);
    expect((await fix('p_kabir', id, base)).status).toBe(200);
  });

  it('when neither the adder nor the payer is in the trip, the organizer may, and nobody else', async () => {
    const base = '/app/v1/trips/t_left';
    const id = await goAdds('t_left'); // paid by Kabir, added by nobody
    expect((await call('p_kabir', 'POST', `${base}/leave`)).status).toBe(204);
    expect(refusal(await remove('p_arjun', id, base))).toEqual([403, 'forbidden', null]);
    expect((await remove('p_rahul', id, base)).status).toBe(200);
    // The cab there was added by Priya and paid by Kabir, and both have now left: the organizer fixes its split among the people still here.
    const fixed = await call('p_rahul', 'PATCH', `${base}/expenses/${leftCab}`, { split_person_ids: ['p_arjun', 'p_meher'] });
    expect([refusal(await call('p_arjun', 'PATCH', `${base}/expenses/${leftCab}`, { split_person_ids: ['p_arjun'] })), fixed.status, fixed.body.split_person_ids]).toEqual([[403, 'forbidden', null], 200, ['p_arjun', 'p_meher']]);
  });
});

describe('with a Go that speaks contract 1.0', () => {
  let old: Harness;
  beforeAll(async () => void (old = await startHarness({ goContract: '1.0' })));
  afterAll(() => old.stop());

  it('a fixed split takes its change number and sends no event; a payback sends one valid settlement.recorded', async () => {
    const o = appApi(old);
    const e = (await o.api(o.as('p_priya'), 'POST', `${trip}/expenses`, { amount_minor: 30000, note: 'Tea', category: 'food', split_person_ids: ['p_priya', 'p_arjun'] })).body;
    const fixed = await o.api(o.as('p_priya'), 'PATCH', `${trip}/expenses/${e.expense_id}`, { split_person_ids: ['p_priya', 'p_arjun', 'p_meher'] });
    const paid = await o.api(o.as('p_arjun'), 'POST', `${trip}/settlements`, { to_person_id: 'p_priya', amount_minor: 10000, currency: 'INR', method: 'upi' });
    await old.flush();
    const sent = old.go.events.filter((x) => x.trip_id === 't_goa').map((x) => [x.type, x.seq, (x.data as any).change]);
    expect([fixed.status, fixed.body.seq, paid.status]).toEqual([200, e.seq + 2, 201]); // +1 was the room's line for the new expense
    expect(sent).toEqual([['expense.changed', e.seq, 'added'], ['settlement.recorded', paid.body.seq, undefined]]); // nothing for the fixed split
    expect(old.go.refused).toEqual([]);
  });
});

describe('what is gone', () => {
  it('the approval and confirmation routes answer 404, and the old filters are refused naming the field', async () => {
    const id = await cab();
    const s = (await call('p_arjun', 'POST', `${trip}/settlements`, { to_person_id: 'p_kabir', amount_minor: 100, currency: 'INR', method: 'cash' })).body.settlement.settlement_id;
    const gone = [
      await call('p_arjun', 'POST', `${trip}/expenses/${id}/approve`),
      await call('p_arjun', 'POST', `${trip}/expenses/${id}/dispute`, { reason: 'not me' }),
      await call('p_kabir', 'POST', `${trip}/settlements/${s}/confirm`),
      await call('p_kabir', 'POST', `${trip}/settlements/${s}/dispute`),
    ];
    expect(gone.map((r) => [r.status, r.body.error.code])).toEqual(Array(4).fill([404, 'not_found']));
    expect([refusal(await call('p_arjun', 'GET', `${trip}/expenses?status=pending`)), refusal(await call('p_arjun', 'GET', `${trip}/transactions?filter=disputed`))]).toEqual([[422, 'invalid', 'status'], [422, 'invalid', 'filter']]);
    expect('expense_approval' in (await t.api(null, 'GET', '/app/v1/config')).body.features).toBe(false);
  });
});
