import type { Category, Money } from './types.js';

export interface MoneyExpense {
  paid_by_person_id: string;
  amount_minor: number;
  category: string;
  split_person_ids: string[];
}

const CATEGORY_ORDER: Category[] = ['stay', 'food', 'getting_around', 'activities', 'other'];

/**
 * Each person's balance in minor units: what they paid minus their share. Positive: owed money.
 * An amount that does not divide evenly gives the extra paise, one each, to the first people in
 * `order`, so the result is the same every time and always adds up to the amount.
 */
export function balances(expenses: MoneyExpense[], order: string[]): Map<string, number> {
  const rank = new Map(order.map((id, i) => [id, i]));
  const net = new Map<string, number>();
  const add = (id: string, n: number) => net.set(id, (net.get(id) ?? 0) + n);
  for (const e of expenses) {
    const people = [...new Set(e.split_person_ids)].sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9) || a.localeCompare(b));
    if (people.length === 0) continue;
    const base = Math.floor(e.amount_minor / people.length);
    const extra = e.amount_minor - base * people.length;
    add(e.paid_by_person_id, e.amount_minor);
    people.forEach((id, i) => add(id, -(base + (i < extra ? 1 : 0))));
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

/** The trip's money as the Server works it out. Go reads it and never works it out itself. */
export function moneyOf(expenses: MoneyExpense[], order: string[], currency: string, planMinor: number | null): Money {
  const byCat = new Map<string, number>();
  let spent = 0;
  for (const e of expenses) {
    spent += e.amount_minor;
    byCat.set(e.category, (byCat.get(e.category) ?? 0) + e.amount_minor);
  }
  const by_category = CATEGORY_ORDER.filter((c) => (byCat.get(c) ?? 0) > 0).map((c) => ({ category: c, amount_minor: byCat.get(c)! }));
  return {
    currency,
    ...(planMinor !== null ? { plan_minor: planMinor } : {}),
    spent_minor: spent,
    by_category,
    transfers: transfers(balances(expenses, order), order, currency),
  } as Money;
}
