import type { Category, Money } from './types.js';

export type ExpenseStatus = 'pending' | 'approved' | 'disputed';

export interface MoneyExpense {
  paid_by_person_id: string;
  amount_minor: number;
  category: string;
  split_person_ids: string[];
  /** Missing means approved (rows from before approval existed, and callers that do not track it). */
  status?: ExpenseStatus;
}

/** A payment between two people outside Go (§4.9). Only its standing matters to the maths. */
export interface MoneySettlement {
  from_person_id: string;
  to_person_id: string;
  amount_minor: number;
  status: 'pending_confirmation' | 'confirmed' | 'disputed';
}

const CATEGORY_ORDER: Category[] = ['stay', 'food', 'getting_around', 'activities', 'other'];

/**
 * The rules (docs/APP-CONTRACT-CHANGES.md §4.9): a `pending` or `approved` expense counts in the totals and the transfers;
 * a `disputed` one is listed and marked but counts in neither until the payer fixes the split or removes it. A settlement
 * counts as soon as it is recorded (provisionally, while the payee has not answered) and stays counted once confirmed;
 * a disputed settlement puts the amount back.
 */
export const expenseCounts = (e: Pick<MoneyExpense, 'status'>): boolean => e.status !== 'disputed';
export const settlementCounts = (s: Pick<MoneySettlement, 'status'>): boolean => s.status !== 'disputed';

/**
 * Each person's share of one expense, in minor units: an equal split, where an amount that does not divide evenly gives
 * the extra paise, one each, to the first people in `order`, so the result is the same every time and always adds up.
 */
export function sharesOf(e: Pick<MoneyExpense, 'amount_minor' | 'split_person_ids'>, order: string[]): Map<string, number> {
  const rank = new Map(order.map((id, i) => [id, i]));
  const people = [...new Set(e.split_person_ids)].sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9) || a.localeCompare(b));
  const out = new Map<string, number>();
  if (people.length === 0) return out;
  const base = Math.floor(e.amount_minor / people.length);
  const extra = e.amount_minor - base * people.length;
  people.forEach((id, i) => out.set(id, base + (i < extra ? 1 : 0)));
  return out;
}

/**
 * Each person's balance in minor units: what they paid (expenses, and money they sent to settle up) minus their shares
 * (and money they received). Positive: owed money. Disputed expenses and disputed settlements are left out.
 */
export function balances(expenses: MoneyExpense[], order: string[], settlements: MoneySettlement[] = []): Map<string, number> {
  const net = new Map<string, number>();
  const add = (id: string, n: number) => net.set(id, (net.get(id) ?? 0) + n);
  for (const e of expenses) {
    if (!expenseCounts(e)) continue;
    const shares = sharesOf(e, order);
    if (shares.size === 0) continue;
    add(e.paid_by_person_id, e.amount_minor);
    for (const [id, share] of shares) add(id, -share);
  }
  for (const s of settlements) {
    if (!settlementCounts(s)) continue;
    add(s.from_person_id, s.amount_minor);
    add(s.to_person_id, -s.amount_minor);
  }
  return net;
}

/**
 * The fewest payments that square everyone up. Equal debts and credits are paired first (one
 * payment settles both), then the biggest debtor pays the biggest creditor until nothing is owed.
 */
export function transfers(net: Map<string, number>, order: string[], currency: string): Money['transfers'] {
  const rank = new Map(order.map((id, i) => [id, i]));
  const byRank = (a: [string, number], b: [string, number]) => b[1] - a[1] || (rank.get(a[0]) ?? 1e9) - (rank.get(b[0]) ?? 1e9) || a[0].localeCompare(b[0]);
  const debtors = [...net].filter(([, v]) => v < 0).map(([id, v]) => [id, -v] as [string, number]).sort(byRank);
  const creditors = [...net].filter(([, v]) => v > 0).sort(byRank);
  const out: Money['transfers'] = [];
  const pay = (d: [string, number], c: [string, number], amount: number) => {
    out.push({ from_person_id: d[0], to_person_id: c[0], amount_minor: amount, currency });
    d[1] -= amount;
    c[1] -= amount;
  };
  for (const d of debtors) {
    const c = creditors.find((x) => x[1] === d[1] && d[1] > 0);
    if (c) pay(d, c, d[1]);
  }
  for (const d of debtors) {
    while (d[1] > 0) {
      const c = creditors.filter((x) => x[1] > 0).sort(byRank)[0];
      if (!c) break;
      pay(d, c, Math.min(d[1], c[1]));
    }
  }
  return out;
}

/** Spending by category in the contract's order, for the expenses that count. */
export function byCategory<E extends MoneyExpense>(expenses: E[], amountOf: (e: E) => number = (e) => e.amount_minor): Money['by_category'] {
  const byCat = new Map<string, number>();
  for (const e of expenses) {
    if (!expenseCounts(e)) continue;
    const amount = amountOf(e);
    if (amount > 0) byCat.set(e.category, (byCat.get(e.category) ?? 0) + amount);
  }
  return CATEGORY_ORDER.filter((c) => (byCat.get(c) ?? 0) > 0).map((c) => ({ category: c, amount_minor: byCat.get(c)! }));
}

/** The trip's money as the Server works it out. Go reads it and never works it out itself. */
export function moneyOf(expenses: MoneyExpense[], order: string[], currency: string, planMinor: number | null, settlements: MoneySettlement[] = []): Money {
  const spent = expenses.filter(expenseCounts).reduce((sum, e) => sum + e.amount_minor, 0);
  return {
    currency,
    ...(planMinor !== null ? { plan_minor: planMinor } : {}),
    spent_minor: spent,
    by_category: byCategory(expenses),
    transfers: transfers(balances(expenses, order, settlements), order, currency),
  } as Money;
}
