// §4.9 GET /trips/:trip/money: the contract's Money (what Go reads too) plus the caller's own corner, from one
// repeatable-read transaction so `seq` matches every number. `me.budget` is the caller's private answer (the group
// only ever sees the lowest band); `me.spent_minor` and `me.by_category` are the caller's shares of the expenses that
// count, by each expense's equal split; `owed_to_me` and `i_owe` are the caller's lines of the fewest-payments list.
import type pg from 'pg';
import type { Ctx } from '../context.js';
import type { Db } from '../db/pool.js';
import { Forbidden } from './actions.js';
import { notFound } from './errors.js';
import { loadExpenses, loadSettlements, type ExpenseView, type SettlementRow } from './ledger.js';
import type { PersonRow } from './mappers.js';
import { byCategory, expenseCounts, moneyOf, sharesOf } from './money.js';
import { activePeople } from './snapshot.js';
import type { Money } from './types.js';

export type Transfer = Money['transfers'][number];

export interface MoneyView extends Money {
  me: {
    budget: { min_minor: number; max_minor: number | null; currency: string } | null;
    spent_minor: number;
    by_category: Money['by_category'];
    owed_to_me: Transfer[];
    i_owe: Transfer[];
  };
  seq: number;
}

/** Runs `work` in one read-only transaction at repeatable read, so the change number matches the data it read. */
export async function readOnly<T>(ctx: Ctx, work: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await ctx.pool.connect();
  try {
    await db.query('begin transaction isolation level repeatable read read only');
    const out = await work(db);
    await db.query('commit');
    return out;
  } catch (err) {
    await db.query('rollback').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

export interface TripMoney {
  trip: { currency: string; plan_minor: number | null; seq: number; title: string };
  people: PersonRow[];
  /** The people's ids in the order they joined: the order the maths uses for odd paise. */
  order: string[];
  expenses: ExpenseView[];
  settlements: SettlementRow[];
  money: Money;
}

/** The rows the money maths needs and the result, on the given connection (a write path reads it after its own change). */
export async function tripMoney(db: Db, tripId: string): Promise<TripMoney> {
  const trip = (await db.query('select currency, plan_minor, seq, title from trips where trip_id = $1', [tripId])).rows[0];
  if (!trip) throw notFound(`trip ${tripId} does not exist`);
  const people = await activePeople(db, tripId);
  const order = people.map((p) => p.person_id);
  const expenses = await loadExpenses(db, tripId);
  const settlements = await loadSettlements(db, tripId);
  return { trip, people, order, expenses, settlements, money: moneyOf(expenses, order, trip.currency, trip.plan_minor, settlements) };
}

export async function readMoneyView(ctx: Ctx, tripId: string, personId: string): Promise<MoneyView> {
  return readOnly(ctx, async (db) => {
    const membership = (await db.query('select budget_min_minor, budget_max_minor from trip_people where trip_id = $1 and person_id = $2 and left_at is null', [tripId, personId])).rows[0];
    if (!membership) throw new Forbidden(`${personId} is not in trip ${tripId}`);
    const m = await tripMoney(db, tripId);
    const myShare = (e: ExpenseView) => sharesOf(e, m.order).get(personId) ?? 0;
    return {
      ...m.money,
      me: {
        budget: membership.budget_min_minor === null ? null : { min_minor: membership.budget_min_minor, max_minor: membership.budget_max_minor, currency: m.trip.currency },
        spent_minor: m.expenses.filter(expenseCounts).reduce((sum, e) => sum + myShare(e), 0),
        by_category: byCategory(m.expenses, myShare),
        owed_to_me: m.money.transfers.filter((t) => t.to_person_id === personId),
        i_owe: m.money.transfers.filter((t) => t.from_person_id === personId),
      },
      seq: m.trip.seq,
    };
  });
}
