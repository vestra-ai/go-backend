// Go's update_expense (contract/extensions-1.1.json): Go changes who an existing expense is split between, the App's
// Fix the split done by Go. Saket's trip, 11 Oct: on "Yes, split evenly" Go could only add_expense, so it added a second
// ₹24,846 beside the ₹49,692 stay split to Saket alone, and the trip's spend went from ₹66,983 to ₹91,829.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check } from '../src/contract/index.js';
import { startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => (h = await startHarness())); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
afterAll(() => h.stop());

let n = 0;
const rq = () => `rq_upd_${++n}`;
const call = (method: string, params: Record<string, unknown>) => h.go.call(method, { trip_id: 't_goa', ...params });
const ok = async (method: string, params: Record<string, unknown>) => {
  const f = await call(method, { request_id: rq(), ...params });
  if (f.error) throw new Error(`${method}: ${JSON.stringify(f.error)}`);
  return f.result;
};
const everyone = ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir'];
/** The stay Rahul paid, split to him alone: what Go wrote before anyone said how to split it. */
const stay = async () =>
  (await ok('add_expense', { paid_by_person_id: 'p_rahul', amount_minor: 4969200, currency: 'INR', note: 'Villa Sol, 3 nights', category: 'stay', split_person_ids: ['p_rahul'] })).expense_id as string;
const spent = async () => (await call('read_trip', {})).result.money.spent_minor as number;

describe("Go's update_expense", () => {
  it('splits the expense that stands evenly, never a second one: the spend is the same, the transfers change', async () => {
    const id = await stay();
    const before = await spent();
    const r = await ok('update_expense', { expense_id: id, split_person_ids: everyone });
    expect(check('UpdateExpenseResult', r)).toMatchObject({ ok: true });
    expect(r.expense).toMatchObject({ expense_id: id, amount_minor: 4969200, split_person_ids: everyone, note: 'Villa Sol, 3 nights' });
    const snap = (await call('read_trip', {})).result;
    expect(snap.money.spent_minor).toBe(before);
    expect(snap.expenses.filter((e: any) => e.note === 'Villa Sol, 3 nights')).toHaveLength(1);
    expect(snap.money.transfers.filter((t: any) => t.to_person_id === 'p_rahul').map((t: any) => t.from_person_id).sort()).toEqual(['p_arjun', 'p_kabir', 'p_meher', 'p_priya']);
  });

  it("sends expense.changed updated by Go, and the room's line says Go changed the split", async () => {
    const id = await stay();
    const r = await ok('update_expense', { expense_id: id, split_person_ids: ['p_rahul', 'p_priya'] });
    await h.flush();
    const changed = h.go.events.filter((e) => e.type === 'expense.changed' && (e.data as any).expense.expense_id === id).at(-1)!;
    expect(changed.seq).toBe(r.seq);
    expect(changed.data).toMatchObject({ change: 'updated', by: { kind: 'go' }, expense: { split_person_ids: ['p_rahul', 'p_priya'] } });
    expect((changed.data as any).by_person_id).toBeUndefined();
    const line = h.go.events.filter((e) => e.type === 'message.created').at(-1)!;
    expect((line.data as any).message).toMatchObject({ author: { kind: 'system' }, text: expect.stringMatching(/^Go changed the split of Villa Sol, 3 nights · /) });
    expect(h.go.refused).toEqual([]);
  });

  it('is idempotent by request_id: the same answer, and the trip changes once', async () => {
    const id = await stay();
    const params = { request_id: 'rq_upd_same', expense_id: id, split_person_ids: everyone };
    const first = (await call('update_expense', params)).result;
    const seq = (await call('read_trip', {})).result.seq;
    const again = (await call('update_expense', params)).result;
    expect(again).toEqual(first);
    expect((await call('read_trip', {})).result.seq).toBe(seq);
  });

  it('changes the note when given, and keeps it when not', async () => {
    const id = await stay();
    expect((await ok('update_expense', { expense_id: id, split_person_ids: everyone, note: 'Villa Sol, split 5 ways' })).expense.note).toBe('Villa Sol, split 5 ways');
    expect((await ok('update_expense', { expense_id: id, split_person_ids: ['p_rahul'] })).expense.note).toBe('Villa Sol, split 5 ways');
  });

  it('refuses someone outside the trip (422), an expense that is not there or was removed (404), and a missing split (422)', async () => {
    const id = await stay();
    expect((await call('update_expense', { request_id: rq(), expense_id: id, split_person_ids: ['p_rahul', 'p_ghost'] })).error).toMatchObject({ code: 422 });
    expect((await call('update_expense', { request_id: rq(), expense_id: 'e_nope', split_person_ids: everyone })).error).toMatchObject({ code: 404 });
    expect((await call('update_expense', { request_id: rq(), expense_id: id })).error).toMatchObject({ code: 422 });
    await h.pool.query('update expenses set removed_at = now() where expense_id = $1', [id]);
    expect((await call('update_expense', { request_id: rq(), expense_id: id, split_person_ids: everyone })).error).toMatchObject({ code: 404 });
  });
});
