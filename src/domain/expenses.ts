// §4.9 expenses and their approval (D6, docs/APP-CONTRACT-CHANGES.md §4.9, docs/GO-CHANGES.md 2.5). Every expense that
// is not a vault payment needs the people in its split to agree: each of them (never the payer) has a confirmation
// entry, and the expense is `pending` until all approve, `disputed` as soon as one disputes. A disputed expense is listed
// and marked but counts in nothing until the payer fixes the split (which resets the changed shares) or removes it.
// Behind `features.expense_approval`: off, every expense starts approved and the answer routes refuse (409).
import { FEATURE_DEFAULTS } from '../config.js';
import { goContractOf, type Ctx } from '../context.js';
import { check } from '../contract/index.js';
import { newId } from '../db/ids.js';
import type { Db } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { change, nextSeq } from '../db/write-change.js';
import type { LiveEvent } from '../live/live.js';
import { sendPush } from '../push/send.js';
import { Forbidden, formatMoney, pushOwed, requireMember } from './actions.js';
import { conflict, invalid, notFound } from './errors.js';
import { expenseView, loadExpenses, type ConfirmationRow, type ExpenseStatusRow, type ExpenseView } from './ledger.js';
import { readOnly } from './money-view.js';
import { sharesOf, type ExpenseStatus } from './money.js';
import { activePeople } from './snapshot.js';

/** The flag as this server runs: on by default (the app document says so from day one). */
export const approvalOn = (ctx: Ctx): boolean => ctx.features?.expense_approval ?? FEATURE_DEFAULTS.expense_approval;

/**
 * `expense.changed` with a change Go 1.0 does not know (`approved`, `disputed`, `updated`: its enum is added|removed, as
 * the real Go answered on 8 Oct 2026). On GO_CONTRACT=1.0 the change takes its number with no event, and Go sees the
 * expense's state on its next read_trip; on 1.1 (docs/GO-CHANGES.md B4) the event is sent.
 */
async function expenseChanged(ctx: Ctx, db: Db, tripId: string, data: { expense: ExpenseView; change: 'approved' | 'disputed' | 'updated'; by: { kind: 'person'; person_id: string }; by_person_id: string }): Promise<number> {
  return goContractOf(ctx) === '1.1' ? change(db, tripId, 'expense.changed', data) : nextSeq(db, tripId);
}

/**
 * Money moved: the app re-reads the money view and the expenses. `kinds` is the §3 `trip_changed` list; the WebSocket
 * (phase 2) carries it to the app and the SSE stream of today ignores it, so it travels as an extra member of the notice.
 */
export function moneyChanged(ctx: Ctx, tripId: string, seq: number): Promise<void> {
  const notice = { kind: 'trip' as const, seq, kinds: ['settlement', 'expense'] };
  return ctx.live.publish(tripId, notice as LiveEvent);
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

/** The rules every new expense meets, whoever adds it: a known category, people who are in the trip, a booking of this trip. */
export async function checkExpenseFields(db: Db, tripId: string, f: Pick<ExpenseFields, 'paid_by_person_id' | 'category' | 'split_person_ids' | 'booking_id'>): Promise<void> {
  if (!check('Category', f.category).ok) throw invalid('category must be stay, food, getting_around, activities or other', 'category');
  const ids = [...new Set([f.paid_by_person_id, ...f.split_person_ids])];
  const found = await db.query('select person_id from trip_people where trip_id = $1 and left_at is null and person_id = any($2)', [tripId, ids]);
  if (found.rowCount !== ids.length) throw invalid('paid_by_person_id/split_person_ids: someone is not in the trip', 'split_person_ids');
  if (f.booking_id) {
    const b = await db.query('select 1 from bookings where trip_id = $1 and booking_id = $2', [tripId, f.booking_id]);
    if (!b.rowCount) throw invalid(`booking_id: ${f.booking_id} is not a booking in this trip`, 'booking_id');
  }
}

/**
 * Writes the expense and one confirmation entry per split member other than the payer. `startApproved` (a vault payment,
 * or the flag off) writes the entries as approved; otherwise they are pending and the expense is too. The payer alone in
 * the split needs nobody's approval.
 */
export async function insertExpense(db: Db, tripId: string, f: ExpenseFields, startApproved: boolean): Promise<ExpenseView> {
  const others = [...new Set(f.split_person_ids)].filter((id) => id !== f.paid_by_person_id);
  const state = startApproved || others.length === 0 ? 'approved' : 'pending';
  const row = (await db.query<ExpenseStatusRow>(
    `insert into expenses (expense_id, trip_id, paid_by_person_id, amount_minor, currency, note, category, split_person_ids, booking_id, added_by_person_id, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [newId('e'), tripId, f.paid_by_person_id, f.amount_minor, f.currency, f.note, f.category, JSON.stringify(f.split_person_ids), f.booking_id ?? null, f.added_by_person_id ?? null, state],
  )).rows[0]!;
  const confs = others.length
    ? (await db.query<ConfirmationRow>('insert into expense_confirmations (expense_id, person_id, state) select $1, unnest($2::text[]), $3 returning *', [row.expense_id, others, state])).rows
    : [];
  return expenseView(row, confs);
}

/** The expense, held for the rest of the transaction. 404 when it is not in this trip or was removed. */
async function lockExpense(db: Db, tripId: string, expenseId: string): Promise<ExpenseStatusRow> {
  const row = (await db.query<ExpenseStatusRow>('select * from expenses where trip_id = $1 and expense_id = $2 and removed_at is null for update', [tripId, expenseId])).rows[0];
  if (!row) throw notFound(`expense ${expenseId} does not exist`);
  return row;
}

/** Re-reads the entries, derives the standing, writes it on the row (so lists can filter by it) and returns the view. */
async function refresh(db: Db, row: ExpenseStatusRow): Promise<ExpenseView> {
  const confs = (await db.query<ConfirmationRow>('select * from expense_confirmations where expense_id = $1', [row.expense_id])).rows;
  const view = expenseView(row, confs);
  if (view.status !== row.status) await db.query('update expenses set status = $2 where expense_id = $1', [row.expense_id, view.status]);
  return view;
}

const payerOrOrganizer = (row: ExpenseStatusRow, personId: string, role: string, what: string) => {
  if (row.paid_by_person_id !== personId && role !== 'organizer') throw new Forbidden(`only the payer or the organizer can ${what} an expense`);
};

// ---------------------------------------------------------------- pushes (§8 `expense`, tagged by the expense)

/** "<payer> added <note> · your share ₹1,700. Approve?" to the people whose entry is pending (each their own share, so one push each). */
export async function pushApprovals(ctx: Ctx, tripId: string, expense: ExpenseView, to: string[]): Promise<void> {
  if (to.length === 0) return;
  const people = await activePeople(ctx.pool, tripId);
  const names = new Map(people.map((p) => [p.person_id, p.name]));
  const shares = sharesOf(expense, people.map((p) => p.person_id));
  const payer = names.get(expense.paid_by_person_id) ?? 'Someone';
  for (const id of to) {
    await sendPush(ctx, tripId, [id], { type: 'expense', body: `${payer} added ${expense.note} · your share ${formatMoney(shares.get(id) ?? 0, expense.currency)}. Approve?`, id: expense.expense_id });
  }
}

/** After a new expense: the approvers hear "approve?", or, when nothing waits, whoever now owes hears "you owe" (as before approval existed). */
export async function tellSplit(ctx: Ctx, tripId: string, expense: ExpenseView): Promise<void> {
  const pending = expense.confirmations.filter((c) => c.state === 'pending').map((c) => c.person_id);
  if (pending.length) await pushApprovals(ctx, tripId, expense, pending);
  else await pushOwed(ctx, tripId, expense);
}

/** "<name> disputed <note>: <reason>. Fix the split or remove it." to the payer. */
async function pushDispute(ctx: Ctx, tripId: string, expense: ExpenseView, byPersonId: string, reason: string | undefined): Promise<void> {
  const who = (await ctx.pool.query('select name from people where person_id = $1', [byPersonId])).rows[0]?.name ?? 'Someone';
  const body = `${who} disputed ${expense.note}${reason ? `: ${reason}` : ''}. Fix the split or remove it.`;
  await sendPush(ctx, tripId, [expense.paid_by_person_id], { type: 'expense', body, id: expense.expense_id });
}

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

/** A person adds an expense by hand. Starts pending (the split must agree) unless the flag is off or the payer is the only one in the split. */
export async function createExpense(ctx: Ctx, tripId: string, personId: string, input: NewExpense): Promise<ExpenseView & { seq: number }> {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    const trip = (await db.query('select currency from trips where trip_id = $1', [tripId])).rows[0];
    const fields: ExpenseFields = { ...input, paid_by_person_id: input.paid_by_person_id ?? personId, currency: trip.currency, added_by_person_id: personId };
    await checkExpenseFields(db, tripId, fields);
    const expense = await insertExpense(db, tripId, fields, !approvalOn(ctx));
    const seq = await change(db, tripId, 'expense.changed', { expense, change: 'added', by: { kind: 'person', person_id: personId } });
    after(() => moneyChanged(ctx, tripId, seq));
    after(() => tellSplit(ctx, tripId, expense));
    return { ...expense, seq };
  });
}

/**
 * Approve or dispute: only someone with an entry (403: the payer, or a person outside the split), 409 when the entry is
 * already in that state or the flag is off. Go hears `expense.changed` with the answer; a dispute also pushes the payer.
 */
export async function answerExpense(ctx: Ctx, tripId: string, personId: string, expenseId: string, state: 'approved' | 'disputed', reason?: string): Promise<ExpenseView & { seq: number }> {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    if (!approvalOn(ctx)) throw conflict('expense approval is off (features.expense_approval): nothing to answer');
    const row = await lockExpense(db, tripId, expenseId);
    const mine = (await db.query<ConfirmationRow>('select * from expense_confirmations where expense_id = $1 and person_id = $2 for update', [expenseId, personId])).rows[0];
    if (!mine) throw new Forbidden(`${personId} has nothing to answer on expense ${expenseId}`);
    if (mine.state === state) throw conflict(`you already ${state} expense ${expenseId}`);
    await db.query('update expense_confirmations set state = $3, at = now(), reason = $4 where expense_id = $1 and person_id = $2', [expenseId, personId, state, state === 'disputed' ? reason ?? null : null]);
    const expense = await refresh(db, row);
    const seq = await expenseChanged(ctx, db, tripId, { expense, change: state, by: { kind: 'person', person_id: personId }, by_person_id: personId });
    after(() => moneyChanged(ctx, tripId, seq));
    if (state === 'disputed') after(() => pushDispute(ctx, tripId, expense, personId, reason));
    return { ...expense, seq };
  });
}

/** The payer or the organizer removes an expense (403 otherwise). Its entries stay with the removed row; nothing counts any more. */
export async function removeExpense(ctx: Ctx, tripId: string, personId: string, expenseId: string): Promise<{ seq: number }> {
  return withTx(ctx.pool, async (db, after) => {
    const member = await requireMember(db, tripId, personId);
    const row = await lockExpense(db, tripId, expenseId);
    payerOrOrganizer(row, personId, member.role, 'remove');
    const removed = (await db.query<ExpenseStatusRow>('update expenses set removed_at = now() where expense_id = $1 returning *', [expenseId])).rows[0]!;
    const expense = await refresh(db, removed);
    const seq = await change(db, tripId, 'expense.changed', { expense, change: 'removed', by: { kind: 'person', person_id: personId } });
    after(() => moneyChanged(ctx, tripId, seq));
    return { seq };
  });
}

export interface ExpenseSplitEdit {
  split_person_ids: string[];
  note?: string;
}

/**
 * "Fix split" (payer or organizer): the new split, and a new note if given. Anyone whose share changed, or who is new to
 * the split, is asked again (their entry goes back to pending, and they are pushed); someone taken out loses their entry;
 * a share that did not move keeps its answer. Go hears `expense.changed` with change `updated`.
 */
export async function updateExpenseSplit(ctx: Ctx, tripId: string, personId: string, expenseId: string, input: ExpenseSplitEdit): Promise<ExpenseView & { seq: number }> {
  return withTx(ctx.pool, async (db, after) => {
    const member = await requireMember(db, tripId, personId);
    const row = await lockExpense(db, tripId, expenseId);
    payerOrOrganizer(row, personId, member.role, 'change');
    const ids = [...new Set(input.split_person_ids)];
    await checkExpenseFields(db, tripId, { paid_by_person_id: row.paid_by_person_id, category: row.category, split_person_ids: ids, booking_id: null });
    const order = (await activePeople(db, tripId)).map((p) => p.person_id);
    const before = sharesOf(row, order);
    const now = sharesOf({ amount_minor: row.amount_minor, split_person_ids: ids }, order);
    const others = ids.filter((id) => id !== row.paid_by_person_id);
    const asked = others.filter((id) => before.get(id) !== now.get(id)); // new to the split, or a share that moved
    const updated = (await db.query<ExpenseStatusRow>('update expenses set split_person_ids = $2, note = $3 where expense_id = $1 returning *', [expenseId, JSON.stringify(ids), input.note ?? row.note])).rows[0]!;
    await db.query('delete from expense_confirmations where expense_id = $1 and not (person_id = any($2))', [expenseId, others]);
    const state: ExpenseStatus = approvalOn(ctx) ? 'pending' : 'approved';
    if (asked.length) {
      await db.query(
        `insert into expense_confirmations (expense_id, person_id, state) select $1, unnest($2::text[]), $3
         on conflict (expense_id, person_id) do update set state = excluded.state, at = now(), reason = null`,
        [expenseId, asked, state],
      );
    }
    const expense = await refresh(db, updated);
    const seq = await expenseChanged(ctx, db, tripId, { expense, change: 'updated', by: { kind: 'person', person_id: personId }, by_person_id: personId });
    after(() => moneyChanged(ctx, tripId, seq));
    if (state === 'pending') after(() => pushApprovals(ctx, tripId, expense, asked));
    return { ...expense, seq };
  });
}

/** GET …/expenses?status=: the expenses in one standing (or all), newest first, at one change number. */
export async function listExpenses(ctx: Ctx, tripId: string, personId: string, status?: ExpenseStatus): Promise<{ items: ExpenseView[]; seq: number }> {
  return readOnly(ctx, async (db) => {
    await requireMember(db, tripId, personId);
    const { seq } = (await db.query('select seq from trips where trip_id = $1', [tripId])).rows[0];
    return { items: await loadExpenses(db, tripId, { status, newestFirst: true }), seq: seq as number };
  });
}
