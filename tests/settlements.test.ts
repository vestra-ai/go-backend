// §4.9 "Record a payment" (phase 3): a settlement counts the moment it is recorded, the payee confirms or disputes, and
// Go hears only of a confirmed one.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check } from '../src/contract/index.js';
import { appApi } from './helpers/app-api.js';
import { EVERYONE } from './helpers/cancel-flow.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
const trip = '/app/v1/trips/t_goa';
beforeAll(async () => {
  h = await startHarness(); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
  // Rahul pays ₹1,000 for everyone: each of the four owes him ₹200 (the expense is pending approval, which already counts).
  await t.api(t.as('p_rahul'), 'POST', `${trip}/expenses`, { amount_minor: 100000, note: 'Dinner', category: 'food', split_person_ids: EVERYONE });
});
afterAll(() => h.stop());

const refusal = (r: { status: number; body: any }) => [r.status, r.body?.error?.code, r.body?.error?.field];
const owed = (transfers: any[], from: string, to: string) => transfers.find((x) => x.from_person_id === from && x.to_person_id === to)?.amount_minor ?? 0;
const goTransfers = async () => (await h.go.call('read_trip', { trip_id: 't_goa' })).result.money.transfers as any[];
const recorded = () => h.go.events.filter((e) => e.type === 'settlement.recorded');
const record = (who: string, body: Record<string, unknown>) => t.api(t.as(who), 'POST', `${trip}/settlements`, { to_person_id: 'p_rahul', currency: 'INR', method: 'upi', ...body });

describe('recording a payment', () => {
  let first: string;
  it('answers 201 with the settlement (pending), the transfers with the amount already taken off, and a change number; the payee is pushed and the room told; Go hears nothing yet', async () => {
    h.push.sent.length = 0;
    const mark = h.live.events.length;
    const r = await record('p_priya', { amount_minor: 15000, note: 'part of dinner' });
    first = r.body.settlement?.settlement_id;
    expect(r.status).toBe(201);
    expect(r.body.settlement).toEqual({ settlement_id: expect.stringMatching(/^st_/), from_person_id: 'p_priya', to_person_id: 'p_rahul', amount_minor: 15000, currency: 'INR', method: 'upi', note: 'part of dinner', status: 'pending_confirmation', created_at: expect.any(String) });
    expect([owed(r.body.transfers, 'p_priya', 'p_rahul'), owed(r.body.transfers, 'p_arjun', 'p_rahul'), typeof r.body.seq]).toEqual([5000, 20000, 'number']);
    expect(h.push.sent).toEqual([{ to: ['p_rahul'], n: { type: 'settlement', body: 'Priya says they paid you ₹150. Got it?', data: { trip_id: 't_goa' } } }]);
    expect(h.live.events.slice(mark).map((e) => e.event)).toEqual([{ kind: 'trip', seq: r.body.seq, kinds: ['settlement', 'expense'] }]);
    // The same maths for Go: provisional counting, and no event for this change number.
    expect(owed(await goTransfers(), 'p_priya', 'p_rahul')).toBe(5000);
    await h.flush();
    expect([recorded().length, (await rows(h.pool, 'select 1 from outbox where trip_id = $1 and seq = $2', ['t_goa', r.body.seq])).length]).toEqual([0, 0]);
    // and the ledger shows it as mine, pending
    const money = await t.api(t.as('p_priya'), 'GET', `${trip}/money`);
    expect([money.headers['cache-control'], money.body.me.i_owe, money.body.seq]).toEqual(['private, no-store', [{ from_person_id: 'p_priya', to_person_id: 'p_rahul', amount_minor: 5000, currency: 'INR' }], r.body.seq]);
  });

  it('refuses paying yourself, someone outside the trip, another currency, a zero amount and an unknown method (422), and an outsider (403)', async () => {
    expect(refusal(await record('p_rahul', { amount_minor: 100 }))).toEqual([422, 'invalid', 'to_person_id']);
    expect(refusal(await record('p_priya', { to_person_id: 'p_ghost', amount_minor: 100 }))).toEqual([422, 'invalid', 'to_person_id']);
    expect(refusal(await record('p_priya', { amount_minor: 100, currency: 'USD' }))).toEqual([422, 'invalid', 'currency']);
    expect(refusal(await record('p_priya', { amount_minor: 0 }))).toEqual([422, 'invalid', 'amount_minor']);
    expect(refusal(await record('p_priya', { amount_minor: 100, method: 'card' }))).toEqual([422, 'invalid', 'method']);
    expect(refusal(await record('p_nobody', { amount_minor: 100 })).slice(0, 2)).toEqual([403, 'forbidden']);
  });

  it('only the payee answers (403 for the payer and anyone else); confirming sends Go settlement.recorded, once; a second answer is 409', async () => {
    expect(refusal(await t.api(t.as('p_priya'), 'POST', `${trip}/settlements/${first}/confirm`)).slice(0, 2)).toEqual([403, 'forbidden']);
    expect(refusal(await t.api(t.as('p_arjun'), 'POST', `${trip}/settlements/${first}/dispute`)).slice(0, 2)).toEqual([403, 'forbidden']);
    expect(refusal(await t.api(t.as('p_rahul'), 'POST', `${trip}/settlements/st_nope/confirm`)).slice(0, 2)).toEqual([404, 'not_found']);
    const r = await t.api(t.as('p_rahul'), 'POST', `${trip}/settlements/${first}/confirm`);
    expect([r.status, r.body.status, typeof r.body.responded_at]).toEqual([200, 'confirmed', 'string']);
    await h.flush();
    const e = recorded().at(-1)!;
    expect(e.data).toEqual({ settlement_id: first, from_person_id: 'p_priya', to_person_id: 'p_rahul', amount_minor: 15000, currency: 'INR', method: 'upi', note: 'part of dinner', status: 'confirmed', recorded_at: expect.any(String), confirmed_at: r.body.responded_at });
    expect([check('Event', e).ok, e.seq, (await rows(h.pool, 'select seq from settlements where settlement_id = $1', [first]))[0].seq]).toEqual([true, expect.any(Number), e.seq]);
    expect(refusal(await t.api(t.as('p_rahul'), 'POST', `${trip}/settlements/${first}/confirm`)).slice(0, 2)).toEqual([409, 'conflict']);
    expect(refusal(await t.api(t.as('p_rahul'), 'POST', `${trip}/settlements/${first}/dispute`)).slice(0, 2)).toEqual([409, 'conflict']);
    expect(owed(await goTransfers(), 'p_priya', 'p_rahul')).toBe(5000); // confirmed: still counted
  });

  it('a dispute puts the amount back, takes a change number and tells Go nothing', async () => {
    const r = await record('p_priya', { amount_minor: 5000, method: 'cash' });
    expect([r.status, owed(r.body.transfers, 'p_priya', 'p_rahul')]).toEqual([201, 0]); // squared up, provisionally
    const d = await t.api(t.as('p_rahul'), 'POST', `${trip}/settlements/${r.body.settlement.settlement_id}/dispute`);
    expect([d.status, d.body.status, d.body.method]).toEqual([200, 'disputed', 'cash']);
    expect(owed(await goTransfers(), 'p_priya', 'p_rahul')).toBe(5000);
    await h.flush();
    const seqs = (await rows(h.pool, 'select seq from settlements where settlement_id = $1', [r.body.settlement.settlement_id]))[0].seq;
    expect([recorded().length, seqs > r.body.seq, (await rows(h.pool, 'select 1 from outbox where trip_id = $1 and seq = any($2)', ['t_goa', [r.body.seq, seqs]])).length]).toEqual([1, true, 0]);
    const ledger = await t.api(t.as('p_priya'), 'GET', `${trip}/transactions?filter=payback`);
    expect(ledger.body.items.map((x: any) => [x.kind, x.settlement_status, x.method, x.mine])).toEqual([['payback', 'disputed', 'cash', true], ['payback', 'confirmed', 'upi', true]]);
  });

  it('paying more than is owed puts the payer in credit: the fewest-payments list then routes the others\' debts to them', async () => {
    const r = await record('p_arjun', { amount_minor: 30000, method: 'bank_transfer' });
    const toArjun = r.body.transfers.filter((x: any) => x.to_person_id === 'p_arjun');
    expect([owed(r.body.transfers, 'p_arjun', 'p_rahul'), toArjun.reduce((s: number, x: any) => s + x.amount_minor, 0), toArjun.every((x: any) => x.from_person_id !== 'p_rahul')]).toEqual([0, 10000, true]); // Rahul is still in credit, so he pays nobody
    const money = (await t.api(t.as('p_arjun'), 'GET', `${trip}/money`)).body;
    expect([money.me.i_owe, money.me.owed_to_me]).toEqual([[], toArjun]);
  });
});
