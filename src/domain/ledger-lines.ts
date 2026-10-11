// §5.3 (rev 4): money shows in the room. Every money movement, whoever makes it (Go included), gets a system message
// in the same transaction as the change: a centred pill with the amount, not unread, no event to Go, its own change
// number. The app-only `ledger` member names the movement and the row, so the app can draw it and open it.
import type pg from 'pg';
import type { Ctx } from '../context.js';
import { formatMoney } from './actions.js';
import type { ExpenseView, Settlement } from './ledger.js';
import { personName, postSystemMessage } from './system-messages.js';

export type LedgerKind = 'expense_added' | 'expense_changed' | 'expense_removed' | 'payback';
/** What the app reads beside the text. */
export interface Ledger { kind: LedgerKind; expense_id?: string; settlement_id?: string }

const ways = (e: Pick<ExpenseView, 'split_person_ids'>) => {
  const n = new Set(e.split_person_ids).size;
  return `${n} ${n === 1 ? 'way' : 'ways'}`;
};

// The wording, in one place.
export const addedText = (who: string, e: ExpenseView, payer: string | null) => `${who} added ${e.note} · ${formatMoney(e.amount_minor, e.currency)}${payer ? ` · paid by ${payer}` : ''} · split ${ways(e)}`;
export const splitChangedText = (who: string, e: ExpenseView) => `${who} changed the split of ${e.note} · ${formatMoney(e.amount_minor, e.currency)} · ${ways(e)}`;
export const removedText = (who: string, e: ExpenseView) => `${who} removed ${e.note} · ${formatMoney(e.amount_minor, e.currency)}`;
export const paybackText = (from: string, to: string, s: Pick<Settlement, 'amount_minor' | 'currency'>) => `${from} paid ${to} ${formatMoney(s.amount_minor, s.currency)}`;

type Tx = { ctx: Ctx; db: pg.PoolClient; tripId: string };

/** "Priya added Airport cab · ₹1,700 · split 4 ways"; "· paid by Kabir" when the payer is not the adder; "Go added …" names the payer always. */
export async function postExpenseAdded(tx: Tx, e: ExpenseView, by: { kind: 'person'; person_id: string } | { kind: 'go' }): Promise<void> {
  const who = by.kind === 'go' ? 'Go' : await personName(tx.db, by.person_id);
  const payer = by.kind === 'go' || by.person_id !== e.paid_by_person_id ? await personName(tx.db, e.paid_by_person_id) : null;
  await postSystemMessage(tx.ctx, tx.db, tx.tripId, addedText(who, e, payer), undefined, { kind: 'expense_added', expense_id: e.expense_id });
}

/** "Priya changed the split of Airport cab · ₹1,700 · 3 ways"; "Go changed the split of …" when Go re-split it (update_expense). */
export async function postSplitChanged(tx: Tx, e: ExpenseView, by: { kind: 'person'; person_id: string } | { kind: 'go' }): Promise<void> {
  const who = by.kind === 'go' ? 'Go' : await personName(tx.db, by.person_id);
  await postSystemMessage(tx.ctx, tx.db, tx.tripId, splitChangedText(who, e), undefined, { kind: 'expense_changed', expense_id: e.expense_id });
}

export async function postExpenseRemoved(tx: Tx, e: ExpenseView, personId: string): Promise<void> {
  await postSystemMessage(tx.ctx, tx.db, tx.tripId, removedText(await personName(tx.db, personId), e), undefined, { kind: 'expense_removed', expense_id: e.expense_id });
}

export async function postPayback(tx: Tx, s: Settlement): Promise<void> {
  const [from, to] = [await personName(tx.db, s.from_person_id), await personName(tx.db, s.to_person_id)];
  await postSystemMessage(tx.ctx, tx.db, tx.tripId, paybackText(from, to, s), undefined, { kind: 'payback', settlement_id: s.settlement_id });
}
