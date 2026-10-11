// §4.9 expenses. An expense counts in the totals and the transfers from the moment it exists until it is removed: nobody
// approves it and nobody disputes it. Whoever added it is the one who may fix its split or remove it (see `mayChange`).
import { goContractOf, type Ctx } from '../context.js';
import { check } from '../contract/index.js';
import { newId } from '../db/ids.js';
import type pg from 'pg';
import type { Db } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { change, nextSeq } from '../db/write-change.js';
import type { LiveEvent } from '../live/live.js';
import { Forbidden, publishHomeAll, requireMember } from './actions.js';
import { coverSplit } from './bookings.js';
import { invalid, notFound } from './errors.js';
import { expenseView, loadExpenses, type ExpenseStoredRow, type ExpenseView } from './ledger.js';
import { postExpenseAdded, postExpenseRemoved, postSplitChanged } from './ledger-lines.js';
import { readOnly } from './money-view.js';

/**
 * `expense.changed` with change `updated`, which Go 1.0 does not know (its enum is added|removed, as the real Go answered
 * on 8 Oct 2026). On GO_CONTRACT=1.0 the change takes its number with no event, and Go sees the new split on its next
 * read_trip; on 1.1 (docs/GO-CHANGES.md B4) the event is sent.
 */
async function expenseUpdated(ctx: Ctx, db: Db, tripId: string, data: { expense: ExpenseView; change: 'updated'; by: Actor; by_person_id?: string }): Promise<number> {
  return goContractOf(ctx) === '1.1' ? change(db, tripId, 'expense.changed', data) : nextSeq(db, tripId);
}

/**
 * Money moved: the app re-reads the money view and the expenses. `kinds` is the §3 `trip_changed` list; the WebSocket
 * carries it to the app. Everyone's home too: what they owe (`owes`, the settle-up items) may have changed.
 */
export async function moneyChanged(ctx: Ctx, tripId: string, seq: number): Promise<void> {
  const notice = { kind: 'trip' as const, seq, kinds: ['settlement', 'expense'] };
  await ctx.live.publish(tripId, notice as LiveEvent);
  await publishHomeAll(ctx, tripId);
}

export interface ExpenseFields {
  paid_by_person_id: string;
  amount_minor: number;
  currency: string;
  note: string;
  category: string;
  split_person_ids: string[];
  booking_id?: string | null;
  added_by_person_id?: string | null;
}

/**
 * The rules an expense meets, whoever writes it: a known category, people who are in the trip, a booking of this trip.
 * `paid_by_person_id` is null when a split is being fixed: the payer was checked when the expense was added and may have
 * left since, which must not stop the split being fixed.
 */
export async function checkExpenseFields(db: Db, tripId: string, f: { paid_by_person_id: string | null; category: string; split_person_ids: string[]; booking_id?: string | null }): Promise<void> {
  if (!check('Category', f.category).ok) throw invalid('category must be stay, food, getting_around, activities or other', 'category');
  const ids = [...new Set([...(f.paid_by_person_id ? [f.paid_by_person_id] : []), ...f.split_person_ids])];
  const found = await db.query('select person_id from trip_people where trip_id = $1 and left_at is null and person_id = any($2)', [tripId, ids]);
  if (found.rowCount !== ids.length) throw invalid('paid_by_person_id/split_person_ids: someone is not in the trip', 'split_person_ids');
  if (f.booking_id) {
    const b = await db.query('select 1 from bookings where trip_id = $1 and booking_id = $2', [tripId, f.booking_id]);
    if (!b.rowCount) throw invalid(`booking_id: ${f.booking_id} is not a booking in this trip`, 'booking_id');
  }
}

/** Writes the expense. It counts at once. */
export async function insertExpense(db: Db, tripId: string, f: ExpenseFields): Promise<ExpenseView> {
  const row = (await db.query<ExpenseStoredRow>(
    `insert into expenses (expense_id, trip_id, paid_by_person_id, amount_minor, currency, note, category, split_person_ids, booking_id, added_by_person_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [newId('e'), tripId, f.paid_by_person_id, f.amount_minor, f.currency, f.note, f.category, JSON.stringify(f.split_person_ids), f.booking_id ?? null, f.added_by_person_id ?? null],
  )).rows[0]!;
  return expenseView(row);
}

/** The expense, held for the rest of the transaction. 404 when it is not in this trip or was removed. */
export async function lockExpense(db: Db, tripId: string, expenseId: string): Promise<ExpenseStoredRow> {
  const row = (await db.query<ExpenseStoredRow>('select * from expenses where trip_id = $1 and expense_id = $2 and removed_at is null for update', [tripId, expenseId])).rows[0];
  if (!row) throw notFound(`expense ${expenseId} does not exist`);
  return row;
}

/**
 * Who may fix the split of an expense or remove it (403 for anyone else):
 *  1. the person who added it, while they are in the trip;
 *  2. when nobody added it (Go did) or the adder has left: the payer, while they are in the trip;
 *  3. when neither is in the trip: the organizer.
 * Being the organizer gives no right of its own, and nor does being named as the payer by someone else.
 */
async function mayChange(db: Db, tripId: string, row: ExpenseStoredRow, personId: string, role: string, what: string): Promise<void> {
  const candidates = [row.added_by_person_id, row.paid_by_person_id].filter((id): id is string => !!id);
  const here = new Set((await db.query('select person_id from trip_people where trip_id = $1 and left_at is null and person_id = any($2)', [tripId, candidates])).rows.map((r) => r.person_id as string));
  const owner = candidates.find((id) => here.has(id)); // the adder first, else the payer
  const allowed = owner ? owner === personId : role === 'organizer';
  if (!allowed) throw new Forbidden(`only the person responsible for this expense can ${what} it`);
}

/** The same people, whatever the order and however often an id is repeated. */
const sameIds = (a: string[], b: string[]) => {
  const [x, y] = [new Set(a), new Set(b)];
  return x.size === y.size && [...x].every((id) => y.has(id));
};

// ---------------------------------------------------------------- what people do

export interface NewExpense {
  /** Who paid: the caller when not given ("Add a payment"). */
  paid_by_person_id?: string;
  amount_minor: number;
  note: string;
  category: string;
  split_person_ids: string[];
  booking_id?: string;
}

/** A person adds an expense by hand. */
export async function createExpense(ctx: Ctx, tripId: string, personId: string, input: NewExpense): Promise<ExpenseView & { seq: number }> {
  return withTx(ctx.pool, async (db) => {
    await requireMember(db, tripId, personId);
    const trip = (await db.query('select currency from trips where trip_id = $1', [tripId])).rows[0];
    const fields: ExpenseFields = { ...input, paid_by_person_id: input.paid_by_person_id ?? personId, currency: trip.currency, added_by_person_id: personId };
    await checkExpenseFields(db, tripId, fields);
    await coverSplit(ctx, db, tripId, fields.booking_id, fields.split_person_ids, { kind: 'person', person_id: personId });
    const expense = await insertExpense(db, tripId, fields);
    const seq = await change(db, tripId, 'expense.changed', { expense, change: 'added', by: { kind: 'person', person_id: personId } });
    await moneyChanged(ctx, tripId, seq);
    await postExpenseAdded({ ctx, db, tripId }, expense, { kind: 'person', person_id: personId }); // the room's line: the next change number, no event
    return { ...expense, seq };
  });
}

/** Removes an expense (see `mayChange`). Nothing of it counts any more. */
export async function removeExpense(ctx: Ctx, tripId: string, personId: string, expenseId: string): Promise<{ seq: number }> {
  return withTx(ctx.pool, async (db) => {
    const member = await requireMember(db, tripId, personId);
    const row = await lockExpense(db, tripId, expenseId);
    await mayChange(db, tripId, row, personId, member.role, 'remove');
    const removed = (await db.query<ExpenseStoredRow>('update expenses set removed_at = now() where expense_id = $1 returning *', [expenseId])).rows[0]!;
    const seq = await change(db, tripId, 'expense.changed', { expense: expenseView(removed), change: 'removed', by: { kind: 'person', person_id: personId } });
    await moneyChanged(ctx, tripId, seq);
    await postExpenseRemoved({ ctx, db, tripId }, expenseView(removed), personId);
    return { seq };
  });
}

export interface ExpenseSplitEdit {
  split_person_ids: string[];
  note?: string;
}

/** Who changes an expense: a person in the App, or Go (its `update_expense`). */
type Actor = { kind: 'person'; person_id: string } | { kind: 'go' };

/**
 * The new split, and a new note if given, on an expense already locked: everyone named must be in the trip. Go hears
 * `expense.changed` with change `updated` on contract 1.1; the room's line goes only when the split itself moved (a new
 * note alone is not a money movement). The App's Fix the split and Go's `update_expense` both come here.
 */
export async function changeExpenseSplit(ctx: Ctx, db: pg.PoolClient, tripId: string, row: ExpenseStoredRow, input: ExpenseSplitEdit, by: Actor): Promise<ExpenseView & { seq: number }> {
  const ids = [...new Set(input.split_person_ids)];
  await checkExpenseFields(db, tripId, { paid_by_person_id: null, category: row.category, split_person_ids: ids, booking_id: null });
  await coverSplit(ctx, db, tripId, row.booking_id, ids, by);
  const updated = (await db.query<ExpenseStoredRow>('update expenses set split_person_ids = $2, note = $3 where expense_id = $1 returning *', [row.expense_id, JSON.stringify(ids), input.note ?? row.note])).rows[0]!;
  const expense = expenseView(updated);
  // by_person_id names a person only: Go's change leaves it out, as the Server leaves out every empty member.
  const seq = await expenseUpdated(ctx, db, tripId, { expense, change: 'updated', by, ...(by.kind === 'person' ? { by_person_id: by.person_id } : {}) });
  await moneyChanged(ctx, tripId, seq);
  if (!sameIds(row.split_person_ids, ids)) await postSplitChanged({ ctx, db, tripId }, expense, by);
  return { ...expense, seq };
}

/** "Fix split" (see `mayChange`): the new split, and a new note if given (`changeExpenseSplit`). */
export async function updateExpenseSplit(ctx: Ctx, tripId: string, personId: string, expenseId: string, input: ExpenseSplitEdit): Promise<ExpenseView & { seq: number }> {
  return withTx(ctx.pool, async (db) => {
    const member = await requireMember(db, tripId, personId);
    const row = await lockExpense(db, tripId, expenseId);
    await mayChange(db, tripId, row, personId, member.role, 'change');
    return changeExpenseSplit(ctx, db, tripId, row, input, { kind: 'person', person_id: personId });
  });
}

/** GET …/expenses: the expenses that stand, newest first, at one change number. */
export async function listExpenses(ctx: Ctx, tripId: string, personId: string): Promise<{ items: ExpenseView[]; seq: number }> {
  return readOnly(ctx, async (db) => {
    await requireMember(db, tripId, personId);
    const { seq } = (await db.query('select seq from trips where trip_id = $1', [tripId])).rows[0];
    return { items: await loadExpenses(db, tripId, { newestFirst: true }), seq: seq as number };
  });
}
