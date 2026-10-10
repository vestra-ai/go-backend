// §4.9 GET /trips/:trip/transactions: the Transactions page, one row per expense ("booking": what someone paid or booked)
// and per settlement ("payback": what someone paid someone back), newest first, with a filter and an opaque cursor. A
// trip's rows are bounded (the contract allows 500 expenses), so the page is cut from the whole list in memory, read in
// one repeatable-read transaction.
import type { Ctx } from '../context.js';
import { requireMember } from './actions.js';
import { invalid } from './errors.js';
import { loadExpenses, loadSettlements, type ExpenseView, type SettlementRow } from './ledger.js';
import { compact } from './mappers.js';
import { readOnly } from './money-view.js';

export const FILTERS = ['all', 'booking', 'payback', 'mine'] as const;
export type Filter = (typeof FILTERS)[number];

/** App contract §2 Transaction. */
export interface Transaction {
  transaction_id: string;
  kind: 'booking' | 'payback';
  occurred_at: string;
  payer_person_id: string;
  verb: 'paid' | 'booked_with';
  to: { kind: 'person'; person_id: string } | { kind: 'merchant'; name: string };
  amount_minor: number;
  currency: string;
  /** `card` only on an expense tied to a booking paid through the vault; a payback carries its settlement's method. */
  method?: 'upi' | 'cash' | 'card' | 'bank_transfer' | 'other';
  note?: string;
  /** I am the payer, a share-holder or the payee. */
  mine: boolean;
  expense_id?: string;
  booking_id?: string;
  settlement_id?: string;
}

export interface TransactionsPage {
  items: Transaction[];
  /** All of the trip's transactions, whatever the filter: the "All 7" chip. */
  total_count: number;
  next_cursor: string | null;
}

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 100;

/** The cursor is the last row's (occurred_at, id), base64url of a JSON pair: opaque to the app, cheap to check here. */
export const encodeCursor = (t: Pick<Transaction, 'occurred_at' | 'transaction_id'>): string => Buffer.from(JSON.stringify([t.occurred_at, t.transaction_id])).toString('base64url');

function decodeCursor(text: string): [string, string] {
  try {
    const v = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' && !Number.isNaN(Date.parse(v[0]))) return [v[0], v[1]];
  } catch {
    // fall through: not one of ours
  }
  throw invalid('before is not a cursor from this list', 'before');
}

/** Newest first; two rows at the same instant are ordered by id, so paging never skips or repeats one. */
const newestFirst = (a: Transaction, b: Transaction) => b.occurred_at.localeCompare(a.occurred_at) || b.transaction_id.localeCompare(a.transaction_id);

const afterCursor = ([at, id]: [string, string]) => (t: Transaction) => t.occurred_at < at || (t.occurred_at === at && t.transaction_id < id);

const matches = (filter: Filter) => (t: Transaction): boolean => {
  switch (filter) {
    case 'all': return true;
    case 'booking': return t.kind === 'booking';
    case 'payback': return t.kind === 'payback';
    case 'mine': return t.mine;
  }
};

export function expenseTransaction(e: ExpenseView, booking: { vendor: string; approval_id: string | null } | undefined, me: string): Transaction {
  return compact({
    transaction_id: e.expense_id,
    kind: 'booking',
    occurred_at: e.created_at,
    payer_person_id: e.paid_by_person_id,
    verb: e.booking_id ? 'booked_with' : 'paid',
    to: { kind: 'merchant', name: booking?.vendor ?? e.note },
    amount_minor: e.amount_minor,
    currency: e.currency,
    method: booking?.approval_id ? 'card' : undefined,
    note: e.note,
    mine: e.paid_by_person_id === me || e.split_person_ids.includes(me),
    expense_id: e.expense_id,
    booking_id: e.booking_id ?? undefined,
  }) as Transaction;
}

export function settlementTransaction(s: SettlementRow, me: string): Transaction {
  return compact({
    transaction_id: s.settlement_id,
    kind: 'payback',
    occurred_at: new Date(s.created_at).toISOString(),
    payer_person_id: s.from_person_id,
    verb: 'paid',
    to: { kind: 'person', person_id: s.to_person_id },
    amount_minor: s.amount_minor,
    currency: s.currency,
    method: s.method,
    note: s.note ?? undefined,
    mine: s.from_person_id === me || s.to_person_id === me,
    settlement_id: s.settlement_id,
  }) as Transaction;
}

export async function listTransactions(ctx: Ctx, tripId: string, personId: string, q: { filter: Filter; limit: number; before?: string }): Promise<TransactionsPage> {
  const cursor = q.before === undefined ? null : decodeCursor(q.before);
  return readOnly(ctx, async (db) => {
    await requireMember(db, tripId, personId);
    const expenses = await loadExpenses(db, tripId);
    const bookingIds = expenses.map((e) => e.booking_id).filter((id): id is string => !!id);
    const bookings = bookingIds.length ? (await db.query('select booking_id, vendor, approval_id from bookings where trip_id = $1 and booking_id = any($2)', [tripId, bookingIds])).rows : [];
    const bookingOf = new Map(bookings.map((b) => [b.booking_id as string, b as { vendor: string; approval_id: string | null }]));
    const all = [
      ...expenses.map((e) => expenseTransaction(e, e.booking_id ? bookingOf.get(e.booking_id) : undefined, personId)),
      ...(await loadSettlements(db, tripId)).map((s) => settlementTransaction(s, personId)),
    ].sort(newestFirst);
    let rows = all.filter(matches(q.filter));
    if (cursor) rows = rows.filter(afterCursor(cursor));
    const items = rows.slice(0, q.limit);
    return { items, total_count: all.length, next_cursor: rows.length > q.limit ? encodeCursor(items.at(-1)!) : null };
  });
}
