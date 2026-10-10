// §4.9 "Record a payment": a settlement counts the moment it is recorded, for good, and Go hears of it then.
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
  // Rahul pays ₹1,000 for everyone: each of the four owes him ₹200 (an expense counts at once).
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
  it('answers 201 with the settlement (no standing), the transfers with the amount already taken off, and a change number; the room is told; Go hears settlement.recorded for that same change', async () => {
    const mark = h.live.events.length;
    const r = await record('p_priya', { amount_minor: 15000, note: 'part of dinner' });
    first = r.body.settlement?.settlement_id;
    expect(r.status).toBe(201);
    expect(r.body.settlement).toEqual({ settlement_id: expect.stringMatching(/^st_/), from_person_id: 'p_priya', to_person_id: 'p_rahul', amount_minor: 15000, currency: 'INR', method: 'upi', note: 'part of dinner', created_at: expect.any(String) });
    expect([owed(r.body.transfers, 'p_priya', 'p_rahul'), owed(r.body.transfers, 'p_arjun', 'p_rahul'), typeof r.body.seq]).toEqual([5000, 20000, 'number']);
    expect(h.live.events.slice(mark).map((e) => e.event)).toEqual([{ kind: 'trip', seq: r.body.seq, kinds: ['settlement', 'expense'] }, { kind: 'message', message_id: expect.any(String), updated_seq: r.body.seq + 1 }]); // the money notice, then the room's line: change numbers in order
    expect(owed(await goTransfers(), 'p_priya', 'p_rahul')).toBe(5000); // the same maths for Go
    // One event, written with the payment (the outbox row carries the payment's own change number), valid against the contract.
    expect((await rows(h.pool, `select body->>'type' as type from outbox where trip_id = $1 and seq = $2`, ['t_goa', r.body.seq])).map((x) => x.type)).toEqual(['settlement.recorded']);
    await h.flush();
    const e = recorded().at(-1)!;
    // Contract 1.1's shape: the settlement (always confirmed: recorded is the whole of it, so both times are the same) and who recorded it.
    expect(e.data).toEqual({
      settlement: { settlement_id: first, from_person_id: 'p_priya', to_person_id: 'p_rahul', amount_minor: 15000, currency: 'INR', method: 'upi', note: 'part of dinner', status: 'confirmed', recorded_at: r.body.settlement.created_at, confirmed_at: r.body.settlement.created_at },
      by: { kind: 'person', person_id: 'p_priya' },
    });
    expect([recorded().length, check('Event', e).ok, e.seq]).toEqual([1, true, r.body.seq]);
    // The room's line follows at the next change number, and reaches Go as message.created (a system message).
    expect(h.go.events.find((x) => x.trip_id === 't_goa' && x.seq === r.body.seq + 1)).toMatchObject({ type: 'message.created', data: { message: { seq: r.body.seq + 1, author: { kind: 'system' } } } });
    const money = await t.api(t.as('p_priya'), 'GET', `${trip}/money`);
    expect([money.headers['cache-control'], money.body.me.i_owe, money.body.seq]).toEqual(['private, no-store', [{ from_person_id: 'p_priya', to_person_id: 'p_rahul', amount_minor: 5000, currency: 'INR' }], r.body.seq + 1]); // the line took the next change number
  });

  it('a retry with the same Idempotency-Key returns the first answer and records nothing more: one settlement, one event', async () => {
    const key = { 'idempotency-key': '6f1c1b5e-0d7a-4a55-9a51-3d1c2a9f7b10' };
    const send = () => t.api(t.as('p_meher'), 'POST', `${trip}/settlements`, { to_person_id: 'p_rahul', amount_minor: 5000, currency: 'INR', method: 'cash' }, key);
    const a = await send();
    const b = await send();
    await h.flush();
    expect([a.status, b.status, b.headers['idempotent-replayed'], b.body]).toEqual([201, 201, 'true', a.body]);
    expect([(await rows(h.pool, `select 1 from settlements where trip_id = 't_goa' and from_person_id = 'p_meher'`)).length, recorded().filter((e) => e.data.settlement.from_person_id === 'p_meher').length]).toEqual([1, 1]);
  });

  it('refuses paying yourself, someone outside the trip, another currency, a zero amount and an unknown method (422), and an outsider (403)', async () => {
    expect(refusal(await record('p_rahul', { amount_minor: 100 }))).toEqual([422, 'invalid', 'to_person_id']);
    expect(refusal(await record('p_priya', { to_person_id: 'p_ghost', amount_minor: 100 }))).toEqual([422, 'invalid', 'to_person_id']);
    expect(refusal(await record('p_priya', { amount_minor: 100, currency: 'USD' }))).toEqual([422, 'invalid', 'currency']);
    expect(refusal(await record('p_priya', { amount_minor: 0 }))).toEqual([422, 'invalid', 'amount_minor']);
    expect(refusal(await record('p_priya', { amount_minor: 100, method: 'card' }))).toEqual([422, 'invalid', 'method']);
    expect(refusal(await record('p_nobody', { amount_minor: 100 })).slice(0, 2)).toEqual([403, 'forbidden']);
  });

  it('paying more than is owed puts the payer in credit: the fewest-payments list then routes the others\' debts to them', async () => {
    const r = await record('p_arjun', { amount_minor: 30000, method: 'bank_transfer' });
    const toArjun = r.body.transfers.filter((x: any) => x.to_person_id === 'p_arjun');
    expect([owed(r.body.transfers, 'p_arjun', 'p_rahul'), toArjun.reduce((s: number, x: any) => s + x.amount_minor, 0), toArjun.every((x: any) => x.from_person_id !== 'p_rahul')]).toEqual([0, 10000, true]); // Rahul is still in credit, so he pays nobody
    const money = (await t.api(t.as('p_arjun'), 'GET', `${trip}/money`)).body;
    expect([money.me.i_owe, money.me.owed_to_me]).toEqual([[], toArjun]);
  });
});
