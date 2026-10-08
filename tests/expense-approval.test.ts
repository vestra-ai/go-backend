// §4.9 expense approval (D6, phase 3): acceptance scenario 21 of docs/APP-CONTRACT-CHANGES.md §12, Go's add_expense, and the flag off.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check } from '../src/contract/index.js';
import { appApi } from './helpers/app-api.js';
import { startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
const trip = '/app/v1/trips/t_goa';
beforeAll(async () => {
  h = await startHarness(); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir, in that order
  t = appApi(h);
});
afterAll(() => h.stop());

const refusal = (r: { status: number; body: any }) => [r.status, r.body?.error?.code, r.body?.error?.field];
// The expense items of the person's strip, in a short form (the strip also carries settle_up items once money is owed).
const strip = async (who: string) =>
  ((await t.api(t.as(who), 'GET', `${trip}/needs-you`)).body.items as any[]).filter((i) => i.kind === 'expense').map((i) => ({ kind: i.kind, expense_id: i.target.expense_id, text: i.title }));
const changes = () => t.events('expense.changed');

describe('scenario 21: Priya adds an expense split 4 ways', () => {
  let cab: string;
  it('starts pending with one entry per split member other than the payer: three expense items in needs-you, one push each, and it already counts', async () => {
    h.push.sent.length = 0;
    const r = await t.api(t.as('p_priya'), 'POST', `${trip}/expenses`, { amount_minor: 680000, note: 'Airport cab', category: 'getting_around', split_person_ids: ['p_priya', 'p_rahul', 'p_kabir', 'p_meher'] });
    cab = r.body.expense_id;
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      paid_by_person_id: 'p_priya', added_by_person_id: 'p_priya', status: 'pending', seq: expect.any(Number),
      confirmations: [{ person_id: 'p_rahul', state: 'pending', at: expect.any(String) }, { person_id: 'p_kabir', state: 'pending' }, { person_id: 'p_meher', state: 'pending' }],
    });
    expect(h.push.sent.map((s) => [s.to, s.n.type, s.n.body]).sort()).toEqual([
      [['p_kabir'], 'expense', 'Priya added Airport cab · your share ₹1,700. Approve?'],
      [['p_meher'], 'expense', 'Priya added Airport cab · your share ₹1,700. Approve?'],
      [['p_rahul'], 'expense', 'Priya added Airport cab · your share ₹1,700. Approve?'],
    ]);
    expect([await strip('p_rahul'), await strip('p_priya'), await strip('p_arjun')]).toEqual([[{ kind: 'expense', expense_id: cab, text: 'Approve ₹1,700 · Airport cab' }], [], []]);
    expect((await t.api(t.as('p_kabir'), 'GET', trip)).body.needs_you_count).toBe(2); // the approval, and the settle-up with Priya it already creates
    expect((await t.api(t.as('p_kabir'), 'GET', `${trip}/expenses?status=pending`)).body.items.map((x: any) => x.expense_id)).toEqual([cab]);
    const money = (await t.api(t.as('p_rahul'), 'GET', `${trip}/money`)).body;
    expect([money.spent_minor, money.me.spent_minor, money.me.by_category, money.me.i_owe]).toEqual([
      680000, 170000, [{ category: 'getting_around', amount_minor: 170000 }], [{ from_person_id: 'p_rahul', to_person_id: 'p_priya', amount_minor: 170000, currency: 'INR' }],
    ]);
    await h.flush();
    expect(changes().at(-1)!.data).toMatchObject({ change: 'added', by: { kind: 'person', person_id: 'p_priya' }, expense: { expense_id: cab, status: 'pending' } });
  });

  it('Rahul approves his entry only; the payer and someone outside the split cannot answer (403); answering twice is 409', async () => {
    const r = await t.api(t.as('p_rahul'), 'POST', `${trip}/expenses/${cab}/approve`);
    expect([r.status, r.body.status, r.body.confirmations.map((c: any) => c.state)]).toEqual([200, 'pending', ['approved', 'pending', 'pending']]);
    expect(await strip('p_rahul')).toEqual([]);
    expect(refusal(await t.api(t.as('p_rahul'), 'POST', `${trip}/expenses/${cab}/approve`)).slice(0, 2)).toEqual([409, 'conflict']);
    expect(refusal(await t.api(t.as('p_priya'), 'POST', `${trip}/expenses/${cab}/approve`)).slice(0, 2)).toEqual([403, 'forbidden']);
    expect(refusal(await t.api(t.as('p_arjun'), 'POST', `${trip}/expenses/${cab}/dispute`, { reason: 'x' })).slice(0, 2)).toEqual([403, 'forbidden']);
    expect(refusal(await t.api(t.as('p_rahul'), 'POST', `${trip}/expenses/e_nope/approve`)).slice(0, 2)).toEqual([404, 'not_found']);
    expect(refusal(await t.api(t.as('p_kabir'), 'POST', `${trip}/expenses/${cab}/dispute`, { reason: 'x'.repeat(201) }))).toEqual([422, 'invalid', 'reason']);
    await h.flush();
    const e = changes().at(-1)!;
    expect(e.data).toMatchObject({ change: 'approved', by: { kind: 'person', person_id: 'p_rahul' }, by_person_id: 'p_rahul', expense: { expense_id: cab, status: 'pending' } });
    expect(check('Event', e)).toMatchObject({ ok: true });
  });

  it('Kabir disputes: the expense is disputed, leaves the totals and the transfers, stays listed with the badge, and the payer is pushed', async () => {
    h.push.sent.length = 0;
    const r = await t.api(t.as('p_kabir'), 'POST', `${trip}/expenses/${cab}/dispute`, { reason: 'I took the bus' });
    expect([r.status, r.body.status, r.body.confirmations[1]]).toEqual([200, 'disputed', { person_id: 'p_kabir', state: 'disputed', at: expect.any(String), reason: 'I took the bus' }]);
    expect(h.push.sent).toEqual([{ to: ['p_priya'], n: { type: 'expense', trip_id: 't_goa', title: 'Goa 🌴', body: 'Kabir disputed Airport cab: I took the bus. Fix the split or remove it.', deep_link: '/trips/t_goa/expenses', tag: `t_goa:expense:${cab}` } }]);
    const money = (await t.api(t.as('p_meher'), 'GET', `${trip}/money`)).body;
    expect([money.spent_minor, money.by_category, money.transfers, money.me.spent_minor, money.me.i_owe]).toEqual([0, [], [], 0, []]);
    expect((await h.go.call('read_trip', { trip_id: 't_goa' })).result.money.transfers).toEqual([]);
    expect((await t.api(t.as('p_meher'), 'GET', `${trip}/transactions?filter=disputed`)).body.items.map((x: any) => [x.expense_id, x.expense_status])).toEqual([[cab, 'disputed']]);
    expect((await t.api(t.as('p_meher'), 'GET', `${trip}/expenses?status=disputed`)).body.items.map((x: any) => x.expense_id)).toEqual([cab]);
    expect([await strip('p_kabir'), (await strip('p_meher')).length]).toEqual([[], 1]); // Meher is still asked
    await h.flush();
    expect(changes().at(-1)!.data).toMatchObject({ change: 'disputed', by_person_id: 'p_kabir', expense: { status: 'disputed' } });
  });

  it('Priya fixes the split without Kabir: the shares that moved are asked again (and pushed), Kabir\'s entry goes, and the expense counts again', async () => {
    h.push.sent.length = 0;
    const r = await t.api(t.as('p_priya'), 'PATCH', `${trip}/expenses/${cab}`, { split_person_ids: ['p_priya', 'p_rahul', 'p_meher'], note: 'Airport cab (3 of us)' });
    expect([r.status, r.body.status, r.body.note, r.body.split_person_ids, r.body.confirmations.map((c: any) => [c.person_id, c.state])]).toEqual([
      200, 'pending', 'Airport cab (3 of us)', ['p_priya', 'p_rahul', 'p_meher'], [['p_rahul', 'pending'], ['p_meher', 'pending']],
    ]);
    // The odd paisa goes to the first to have joined, so the shares add up to the amount.
    expect(h.push.sent.map((s) => [s.to, s.n.body]).sort()).toEqual([
      [['p_meher'], 'Priya added Airport cab (3 of us) · your share ₹2,266.66. Approve?'],
      [['p_rahul'], 'Priya added Airport cab (3 of us) · your share ₹2,266.67. Approve?'],
    ]);
    const money = (await t.api(t.as('p_priya'), 'GET', `${trip}/money`)).body;
    expect(money.transfers).toEqual([
      { from_person_id: 'p_rahul', to_person_id: 'p_priya', amount_minor: 226667, currency: 'INR' },
      { from_person_id: 'p_meher', to_person_id: 'p_priya', amount_minor: 226666, currency: 'INR' },
    ]);
    await h.flush();
    const e = changes().at(-1)!;
    expect([e.data.change, e.data.by_person_id, check('Event', e).ok]).toEqual(['updated', 'p_priya', true]);
  });

  it('a note-only fix keeps every answer; the organizer may fix or remove, anyone else may not (403); removing answers { seq } and the expense is gone', async () => {
    await t.api(t.as('p_rahul'), 'POST', `${trip}/expenses/${cab}/approve`);
    const r = await t.api(t.as('p_rahul'), 'PATCH', `${trip}/expenses/${cab}`, { split_person_ids: ['p_priya', 'p_rahul', 'p_meher'], note: 'Cab' }); // the organizer
    expect([r.status, r.body.note, r.body.confirmations.map((c: any) => [c.person_id, c.state])]).toEqual([200, 'Cab', [['p_rahul', 'approved'], ['p_meher', 'pending']]]);
    expect(refusal(await t.api(t.as('p_arjun'), 'PATCH', `${trip}/expenses/${cab}`, { split_person_ids: ['p_arjun'] })).slice(0, 2)).toEqual([403, 'forbidden']);
    expect(refusal(await t.api(t.as('p_arjun'), 'DELETE', `${trip}/expenses/${cab}`)).slice(0, 2)).toEqual([403, 'forbidden']);
    expect(refusal(await t.api(t.as('p_priya'), 'PATCH', `${trip}/expenses/${cab}`, { split_person_ids: ['p_ghost'] }))).toEqual([422, 'invalid', 'split_person_ids']);
    const gone = await t.api(t.as('p_priya'), 'DELETE', `${trip}/expenses/${cab}`);
    expect([gone.status, gone.body]).toEqual([200, { seq: expect.any(Number) }]);
    expect(refusal(await t.api(t.as('p_meher'), 'POST', `${trip}/expenses/${cab}/approve`)).slice(0, 2)).toEqual([404, 'not_found']);
    expect([await strip('p_meher'), (await t.api(t.as('p_meher'), 'GET', `${trip}/expenses`)).body.items]).toEqual([[], []]);
    await h.flush();
    expect(changes().at(-1)!.data.change).toBe('removed');
  });

  it('the payer alone in the split needs nobody: approved at once, no push', async () => {
    h.push.sent.length = 0;
    const r = await t.api(t.as('p_kabir'), 'POST', `${trip}/expenses`, { amount_minor: 1000, note: 'Water', category: 'food', split_person_ids: ['p_kabir'] });
    expect([r.status, r.body.status, r.body.confirmations, h.push.sent]).toEqual([201, 'approved', [], []]);
    await t.api(t.as('p_kabir'), 'DELETE', `${trip}/expenses/${r.body.expense_id}`);
  });
});

describe("Go's add_expense", () => {
  let n = 0;
  const go = (params: Record<string, unknown>) => h.go.call('add_expense', { request_id: `rq_ea_${++n}`, trip_id: 't_goa', currency: 'INR', category: 'stay', ...params });
  const expenseOf = async (id: string) => (await h.go.call('read_trip', { trip_id: 't_goa' })).result.expenses.find((x: any) => x.expense_id === id);

  it('creates a pending expense with confirmations and asks the split to approve; the snapshot still matches the contract (1.1 overlay)', async () => {
    h.push.sent.length = 0;
    const r = await go({ paid_by_person_id: 'p_rahul', amount_minor: 40000, note: 'Villa deposit', split_person_ids: ['p_rahul', 'p_priya'] });
    expect(r.error).toBeUndefined();
    const snap = (await h.go.call('read_trip', { trip_id: 't_goa' })).result;
    expect(snap.expenses.find((x: any) => x.expense_id === r.result.expense_id)).toMatchObject({ status: 'pending', confirmations: [{ person_id: 'p_priya', state: 'pending' }] });
    expect(check('TripSnapshot', snap)).toMatchObject({ ok: true });
    expect(h.push.sent).toEqual([{ to: ['p_priya'], n: { type: 'expense', trip_id: 't_goa', title: 'Goa 🌴', body: 'Rahul added Villa deposit · your share ₹200. Approve?', deep_link: '/trips/t_goa/expenses', tag: `t_goa:expense:${r.result.expense_id}` } }]);
    await t.api(t.as('p_rahul'), 'DELETE', `${trip}/expenses/${r.result.expense_id}`);
  });

  it('with an approval_id (a vault payment) the expense is approved at once and whoever owes is told, as before', async () => {
    h.push.sent.length = 0;
    const r = await go({ paid_by_person_id: 'p_rahul', amount_minor: 40000, note: 'Villa Sol', split_person_ids: ['p_rahul', 'p_priya'], approval_id: 'ap_villa' });
    expect(r.error).toBeUndefined();
    expect(await expenseOf(r.result.expense_id)).toMatchObject({ status: 'approved', confirmations: [{ person_id: 'p_priya', state: 'approved' }] });
    expect(h.push.sent).toEqual([{ to: ['p_priya'], n: { type: 'owe', trip_id: 't_goa', title: 'Goa 🌴', body: 'You owe Rahul ₹200 for Villa Sol', deep_link: '/trips/t_goa/expenses', tag: 't_goa:owe:p_rahul' } }]);
  });
});

describe('with features.expense_approval off', () => {
  let off: Harness;
  let a: ReturnType<typeof appApi>;
  beforeAll(async () => {
    off = await startHarness({ features: { expense_approval: false } });
    a = appApi(off);
  });
  afterAll(() => off.stop());

  it('every expense starts approved (the app\'s and Go\'s), the answer routes refuse (409), nothing waits in needs-you, and whoever owes is told', async () => {
    off.push.sent.length = 0;
    const r = await a.api(a.as('p_rahul'), 'POST', `${trip}/expenses`, { amount_minor: 1000, note: 'Tea', category: 'food', split_person_ids: ['p_rahul', 'p_priya'] });
    expect([r.status, r.body.status, r.body.confirmations.map((c: any) => c.state)]).toEqual([201, 'approved', ['approved']]);
    expect(off.push.sent).toEqual([{ to: ['p_priya'], n: { type: 'owe', trip_id: 't_goa', title: 'Goa 🌴', body: 'You owe Rahul ₹5 for Tea', deep_link: '/trips/t_goa/expenses', tag: 't_goa:owe:p_rahul' } }]);
    expect(refusal(await a.api(a.as('p_priya'), 'POST', `${trip}/expenses/${r.body.expense_id}/approve`)).slice(0, 2)).toEqual([409, 'conflict']);
    expect(refusal(await a.api(a.as('p_priya'), 'POST', `${trip}/expenses/${r.body.expense_id}/dispute`)).slice(0, 2)).toEqual([409, 'conflict']);
    const g = await off.go.call('add_expense', { request_id: 'rq_off_1', trip_id: 't_goa', paid_by_person_id: 'p_rahul', amount_minor: 1000, currency: 'INR', note: 'Coffee', category: 'food', split_person_ids: ['p_rahul', 'p_kabir'] });
    expect((await off.go.call('read_trip', { trip_id: 't_goa' })).result.expenses.find((x: any) => x.expense_id === g.result.expense_id).status).toBe('approved');
    expect((await a.api(a.as('p_priya'), 'GET', `${trip}/needs-you`)).body.items.filter((i: any) => i.kind === 'expense')).toEqual([]);
  });
});

describe('with GO_CONTRACT=1.0 (what the real Go spoke on 8 Oct 2026)', () => {
  let old: Harness;
  let a: ReturnType<typeof appApi>;
  beforeAll(async () => {
    old = await startHarness({ goContract: '1.0' });
    a = appApi(old);
  });
  afterAll(() => old.stop());

  it('an expense added or removed is sent; approved, disputed and re-split take a change number but no event (Go 1.0 knows only added|removed and reads the trip instead)', async () => {
    const r = await a.api(a.as('p_rahul'), 'POST', `${trip}/expenses`, { amount_minor: 30000, note: 'Scooters', category: 'getting_around', split_person_ids: ['p_rahul', 'p_priya', 'p_kabir'] });
    const approved = await a.api(a.as('p_priya'), 'POST', `${trip}/expenses/${r.body.expense_id}/approve`);
    const disputed = await a.api(a.as('p_kabir'), 'POST', `${trip}/expenses/${r.body.expense_id}/dispute`, { reason: 'walked' });
    const fixed = await a.api(a.as('p_rahul'), 'PATCH', `${trip}/expenses/${r.body.expense_id}`, { split_person_ids: ['p_rahul', 'p_priya'] });
    const removed = await a.api(a.as('p_rahul'), 'DELETE', `${trip}/expenses/${r.body.expense_id}`);
    expect([approved.status, disputed.status, fixed.status, removed.status]).toEqual([200, 200, 200, 200]);
    expect([approved.body.seq, disputed.body.seq, fixed.body.seq, removed.body.seq]).toEqual([r.body.seq + 1, r.body.seq + 2, r.body.seq + 3, r.body.seq + 4]); // each still takes its number
    await old.flush();
    const sent = old.go.events.filter((e) => e.type === 'expense.changed' && e.data.expense.expense_id === r.body.expense_id).map((e) => [e.seq, e.data.change]);
    expect(sent).toEqual([[r.body.seq, 'added'], [r.body.seq + 4, 'removed']]);
    expect((await old.go.call('read_trip', { trip_id: 't_goa' })).result.expenses.find((x: any) => x.expense_id === r.body.expense_id)).toBeUndefined(); // removed
  });
});
