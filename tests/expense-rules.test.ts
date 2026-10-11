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

  it('a fixed split takes its change number and sends no event (its room line still goes as message.created); a payback sends one valid settlement.recorded', async () => {
    const o = appApi(old);
    const e = (await o.api(o.as('p_priya'), 'POST', `${trip}/expenses`, { amount_minor: 30000, note: 'Tea', category: 'food', split_person_ids: ['p_priya', 'p_arjun'] })).body;
    const fixed = await o.api(o.as('p_priya'), 'PATCH', `${trip}/expenses/${e.expense_id}`, { split_person_ids: ['p_priya', 'p_arjun', 'p_meher'] });
    const paid = await o.api(o.as('p_arjun'), 'POST', `${trip}/settlements`, { to_person_id: 'p_priya', amount_minor: 10000, currency: 'INR', method: 'upi' });
    await old.flush();
    const sent = old.go.events.filter((x) => x.trip_id === 't_goa').map((x) => [x.type, x.seq, (x.data as any).change]);
    expect([fixed.status, fixed.body.seq, paid.status]).toEqual([200, e.seq + 2, 201]); // +1 was the room's line for the new expense
    // Each room line is a system message, sent as message.created at its own number; nothing at the fixed split's number (e.seq + 2).
    expect(sent).toEqual([
      ['expense.changed', e.seq, 'added'], ['message.created', e.seq + 1, undefined],
      ['message.created', e.seq + 3, undefined],
      ['settlement.recorded', paid.body.seq, undefined], ['message.created', paid.body.seq + 1, undefined],
    ]);
    expect(old.go.events.filter((x) => x.type === 'message.created').every((x) => x.data.message.author.kind === 'system')).toBe(true);
    expect(old.go.events.find((x) => x.type === 'settlement.recorded')!.data).toMatchObject({ settlement: { from_person_id: 'p_arjun', to_person_id: 'p_priya', amount_minor: 10000, status: 'confirmed' }, by: { kind: 'person', person_id: 'p_arjun' } });
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

describe("a booking's cost shared with people it does not cover", () => {
  it('covers them too, so they see it and open its voucher: Go\'s add_expense and update_expense, an expense a person adds, and a fixed split; only ever adds; Go hears booking.changed updated first; a split it covers changes nothing', async () => {
    /** Go books a villa for Rahul alone, with its voucher (a covered file). */
    const villa = async () => {
      const b = (await h.go.call('add_booking', { request_id: `rq_rules_${++rq}`, trip_id: 't_goa', kind: 'stay', title: 'Villa Sol', vendor: 'ixigo', ref: 'IXG-9', amount_minor: 2000000, currency: 'INR', payer_person_id: 'p_rahul', for_person_ids: ['p_rahul'] })).result.booking_id as string;
      await h.pool.query(`insert into booking_documents (document_id, booking_id, name, mime, size_bytes, visibility, path) values ($1, $2, 'Hotel voucher.pdf', 'application/pdf', 9, 'covered', $3)`, [`doc_${b}`, b, `bookings/t_goa/${b}/voucher.pdf`]);
      return b;
    };
    const covered = async (b: string) => (await h.pool.query('select for_person_ids from bookings where booking_id = $1', [b])).rows[0].for_person_ids;
    const voucher = (who: string, b: string) => call(who, 'GET', `${trip}/bookings/${b}/documents/doc_${b}`);
    const listed = async (who: string, b: string) => (await call(who, 'GET', `${trip}/bookings`)).body.items.find((x: any) => x.booking_id === b);

    // Go splits the villa with Priya (the prod case, 12 Oct: the friend could not open the voucher).
    const byGo = await villa();
    expect([await listed('p_priya', byGo), refusal(await voucher('p_priya', byGo))]).toEqual([undefined, [403, 'forbidden', null]]);
    await h.flush();
    const mark = h.go.events.length;
    const live = h.live.events.length;
    const added = await h.go.call('add_expense', { request_id: `rq_rules_${++rq}`, trip_id: 't_goa', paid_by_person_id: 'p_rahul', amount_minor: 2000000, currency: 'INR', note: 'Villa Sol', category: 'stay', split_person_ids: ['p_rahul', 'p_priya'], booking_id: byGo });
    expect(added.error).toBeUndefined();
    expect(await covered(byGo)).toEqual(['p_rahul', 'p_priya']);
    expect([(await listed('p_priya', byGo)).documents.map((d: any) => d.name), (await voucher('p_priya', byGo)).status]).toEqual([['Hotel voucher.pdf'], 302]);
    await h.flush();
    const heard = h.go.events.slice(mark).filter((e) => e.trip_id === 't_goa');
    expect(heard.slice(0, 2).map((e) => [e.type, (e.data as any).change])).toEqual([['booking.changed', 'updated'], ['expense.changed', 'added']]);
    expect((heard[0]!.data as any)).toMatchObject({ booking: { booking_id: byGo, for_person_ids: ['p_rahul', 'p_priya'] }, by: { kind: 'go' } });
    expect(h.live.events.slice(live).some((e) => (e.event as any).kind === 'trip' && (e.event as any).kinds?.includes('booking') && (e.event as any).seq === heard[0]!.seq)).toBe(true);

    // Go's update_expense on it does the same, by Go.
    await h.flush();
    const regoMark = h.go.events.length;
    const resplit = await h.go.call('update_expense', { request_id: `rq_rules_${++rq}`, trip_id: 't_goa', expense_id: added.result.expense_id, split_person_ids: ['p_rahul', 'p_priya', 'p_kabir'] });
    expect([resplit.error, await covered(byGo)]).toEqual([undefined, ['p_rahul', 'p_priya', 'p_kabir']]);
    await h.flush();
    expect(h.go.events.slice(regoMark).find((e) => e.type === 'booking.changed')!.data).toMatchObject({ change: 'updated', by: { kind: 'go' }, booking: { for_person_ids: ['p_rahul', 'p_priya', 'p_kabir'] } });

    // A person's own expense for it, and then Fix the split, each add who they name; taking someone out of the split leaves them covered.
    const byHand = await villa();
    const own = await call('p_rahul', 'POST', `${trip}/expenses`, { amount_minor: 2000000, note: 'Villa Sol', category: 'stay', split_person_ids: ['p_rahul', 'p_arjun'], booking_id: byHand });
    expect([own.status, await covered(byHand)]).toEqual([201, ['p_rahul', 'p_arjun']]);
    const fixed = await call('p_rahul', 'PATCH', `${trip}/expenses/${own.body.expense_id}`, { split_person_ids: ['p_rahul', 'p_meher'] });
    expect([fixed.status, await covered(byHand), (await voucher('p_meher', byHand)).status]).toEqual([200, ['p_rahul', 'p_arjun', 'p_meher'], 302]);

    // A split the booking covers already: no booking change at all.
    await h.flush();
    const quiet = h.go.events.length;
    await call('p_rahul', 'PATCH', `${trip}/expenses/${own.body.expense_id}`, { split_person_ids: ['p_meher', 'p_rahul'] });
    await h.flush();
    expect(h.go.events.slice(quiet).filter((e) => e.type === 'booking.changed')).toEqual([]);
  });
});
