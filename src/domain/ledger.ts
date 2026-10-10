// The money rows as the app and Go see them (§4.9): an Expense and a Settlement. Reads only, on any connection, so a
// snapshot, a money view and the ledger all build from the same two loaders.
import type { Db } from '../db/pool.js';
import { compact, expenseOf, iso } from './mappers.js';
import type { ExpenseRow } from './mappers.js';
import type { Expense } from './types.js';

/** The contract's Expense: it carries no standing, because every expense that exists counts. */
export type ExpenseView = Expense;

export type ExpenseStoredRow = ExpenseRow & { trip_id: string; removed_at: Date | null };

export const expenseView = (row: ExpenseRow): ExpenseView => expenseOf(row);

/** The trip's expenses that still stand, oldest first (newest first for a list the app scrolls). */
export async function loadExpenses(db: Db, tripId: string, opts: { newestFirst?: boolean } = {}): Promise<ExpenseView[]> {
  const order = opts.newestFirst ? 'created_at desc, expense_id desc' : 'created_at, expense_id';
  const rows = (await db.query<ExpenseStoredRow>(`select * from expenses where trip_id = $1 and removed_at is null order by ${order}`, [tripId])).rows;
  return rows.map(expenseView);
}

export interface SettlementRow {
  settlement_id: string; trip_id: string; from_person_id: string; to_person_id: string; amount_minor: number; currency: string;
  method: 'upi' | 'cash' | 'bank_transfer' | 'other'; note: string | null;
  created_at: Date; seq: number | null;
}

/** App contract §2 Settlement. */
export interface Settlement {
  settlement_id: string;
  from_person_id: string;
  to_person_id: string;
  amount_minor: number;
  currency: string;
  method: SettlementRow['method'];
  note?: string;
  created_at: string;
}

export const settlementOf = (r: SettlementRow): Settlement =>
  compact({
    settlement_id: r.settlement_id, from_person_id: r.from_person_id, to_person_id: r.to_person_id, amount_minor: r.amount_minor, currency: r.currency,
    method: r.method, note: r.note ?? undefined, created_at: iso(r.created_at)!,
  });

/** Every settlement of the trip, oldest first. Each one counts. */
export async function loadSettlements(db: Db, tripId: string): Promise<SettlementRow[]> {
  return (await db.query<SettlementRow>('select * from settlements where trip_id = $1 order by created_at, settlement_id', [tripId])).rows;
}
