// The money rows as the app and Go see them (§4.9): an Expense with its approval standing, and a Settlement. Reads only,
// on any connection, so a snapshot, a money view and the ledger all build from the same two loaders.
import type { Db } from '../db/pool.js';
import { compact, expenseOf, iso } from './mappers.js';
import type { ExpenseRow } from './mappers.js';
import type { ExpenseStatus } from './money.js';
import type { Expense } from './types.js';

export type ConfirmationState = 'pending' | 'approved' | 'disputed';

export interface ConfirmationRow {
  expense_id: string;
  person_id: string;
  state: ConfirmationState;
  at: Date;
  reason: string | null;
}

/** One person's answer to an expense they are in the split of (contract 1.1 ExpenseConfirmation). */
export interface Confirmation {
  person_id: string;
  state: ConfirmationState;
  at: string;
  reason?: string;
}

/** The contract's Expense plus the 1.1 fields: its standing and each split member's answer. */
export type ExpenseView = Expense & { status: ExpenseStatus; confirmations: Confirmation[] };

export type ExpenseStatusRow = ExpenseRow & { trip_id: string; status: ExpenseStatus; removed_at: Date | null };

/** `approved` when every entry is approved (or there is none: the payer alone), `disputed` when any is, else `pending`. */
export function statusOf(confirmations: Array<Pick<Confirmation, 'state'>>): ExpenseStatus {
  if (confirmations.some((c) => c.state === 'disputed')) return 'disputed';
  if (confirmations.every((c) => c.state === 'approved')) return 'approved';
  return 'pending';
}

export const confirmationOf = (r: ConfirmationRow): Confirmation => compact({ person_id: r.person_id, state: r.state, at: iso(r.at)!, reason: r.reason ?? undefined });

/** The expense with its confirmations in the split's order (the payer has no entry). The status is derived here, never trusted from the row alone. */
export function expenseView(row: ExpenseRow, confirmations: ConfirmationRow[]): ExpenseView {
  const rank = new Map(row.split_person_ids.map((id, i) => [id, i]));
  const confs = confirmations.filter((c) => c.expense_id === row.expense_id).sort((a, b) => (rank.get(a.person_id) ?? 1e9) - (rank.get(b.person_id) ?? 1e9)).map(confirmationOf);
  return { ...expenseOf(row), status: statusOf(confs), confirmations: confs };
}

/**
 * The trip's expenses that still stand, each with its confirmations, oldest first (newest first for a list the app
 * scrolls). `status` narrows to one standing.
 */
export async function loadExpenses(db: Db, tripId: string, opts: { status?: ExpenseStatus; newestFirst?: boolean } = {}): Promise<ExpenseView[]> {
  const order = opts.newestFirst ? 'created_at desc, expense_id desc' : 'created_at, expense_id';
  const rows = (await db.query<ExpenseStatusRow>(
    `select * from expenses where trip_id = $1 and removed_at is null ${opts.status ? 'and status = $2' : ''} order by ${order}`,
    opts.status ? [tripId, opts.status] : [tripId],
  )).rows;
  if (rows.length === 0) return [];
  const confs = (await db.query<ConfirmationRow>('select * from expense_confirmations where expense_id = any($1)', [rows.map((r) => r.expense_id)])).rows;
  return rows.map((r) => expenseView(r, confs));
}

export interface SettlementRow {
  settlement_id: string; trip_id: string; from_person_id: string; to_person_id: string; amount_minor: number; currency: string;
  method: 'upi' | 'cash' | 'bank_transfer' | 'other'; note: string | null; status: 'pending_confirmation' | 'confirmed' | 'disputed';
  created_at: Date; responded_at: Date | null; seq: number | null;
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
  status: SettlementRow['status'];
  created_at: string;
  responded_at?: string;
}

export const settlementOf = (r: SettlementRow): Settlement =>
  compact({
    settlement_id: r.settlement_id, from_person_id: r.from_person_id, to_person_id: r.to_person_id, amount_minor: r.amount_minor, currency: r.currency,
    method: r.method, note: r.note ?? undefined, status: r.status, created_at: iso(r.created_at)!, responded_at: iso(r.responded_at),
  });

/** Every settlement of the trip, oldest first, whatever its standing (the maths decides what counts). */
export async function loadSettlements(db: Db, tripId: string): Promise<SettlementRow[]> {
  return (await db.query<SettlementRow>('select * from settlements where trip_id = $1 order by created_at, settlement_id', [tripId])).rows;
}
