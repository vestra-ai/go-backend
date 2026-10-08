import type pg from 'pg';
import { notFound } from './errors.js';
import { loadExpenses, loadSettlements } from './ledger.js';
import { compact, bookingOf, decisionOf, iso, personForGo, recordLineOf } from './mappers.js';
import type { BookingRow, DecisionRow, PersonRow, RecordLineRow, VoteRow } from './mappers.js';
import { moneyOf } from './money.js';
import type { BudgetSummary, TripSnapshot } from './types.js';
import type { Db } from '../db/pool.js';

export const inviteUrl = (base: string, code: string) => `${base.replace(/\/+$/, '')}/j/${code}`;

/** People now in the trip, in the order they joined. Someone who left is not in the trip. */
export async function activePeople(db: Db, tripId: string): Promise<PersonRow[]> {
  const { rows } = await db.query(
    `select p.person_id, p.name, p.photo_url, p.upi_id, tp.role, tp.joined_at, tp.from_city, tp.earliest_leave, tp.know, tp.go_paused
       from trip_people tp join people p using (person_id)
      where tp.trip_id = $1 and tp.left_at is null
      order by tp.joined_at, p.person_id`,
    [tripId],
  );
  return rows;
}

/** The budget as Go may see it: the lowest band anyone picked and how many answered. Never anyone's own answer. */
export async function budgetSummary(db: Db, tripId: string, currency: string): Promise<BudgetSummary> {
  const { rows } = await db.query(
    `select budget_min_minor, budget_max_minor from trip_people
      where trip_id = $1 and left_at is null`,
    [tripId],
  );
  const answered = rows.filter((r) => r.budget_min_minor !== null);
  const lowest = [...answered].sort((a, b) => a.budget_min_minor - b.budget_min_minor)[0];
  return {
    ...(lowest
      ? { lowest: compact({ min_minor: lowest.budget_min_minor, max_minor: lowest.budget_max_minor ?? undefined, currency }) }
      : {}),
    answered: answered.length,
    of: rows.length,
  } as BudgetSummary;
}

export async function loadDecisions(db: Db, tripId: string, onlyId?: string) {
  const { rows } = await db.query<DecisionRow>(
    `select * from decisions where trip_id = $1 ${onlyId ? 'and decision_id = $2' : ''} order by opened_at, decision_id`,
    onlyId ? [tripId, onlyId] : [tripId],
  );
  if (rows.length === 0) return [];
  const votes = await db.query<VoteRow & { decision_id: string }>(
    'select decision_id, person_id, option_index from votes where decision_id = any($1) order by voted_at, person_id',
    [rows.map((r) => r.decision_id)],
  );
  return rows.map((r) => decisionOf(r, votes.rows.filter((v) => v.decision_id === r.decision_id)));
}

/** Builds the whole trip as Go may see it from one consistent read, at its current change number. */
export async function buildSnapshot(db: Db, tripId: string, publicBaseUrl: string): Promise<TripSnapshot> {
  const t = (await db.query('select * from trips where trip_id = $1', [tripId])).rows[0];
  if (!t) throw notFound(`trip ${tripId} does not exist`);
  const people = await activePeople(db, tripId);
  const order = people.map((p) => p.person_id);
  // One at a time: a transaction's connection runs one query at a time.
  const decisions = await loadDecisions(db, tripId);
  const bookings = await db.query<BookingRow>('select * from bookings where trip_id = $1 order by created_at, booking_id', [tripId]);
  const expenses = await loadExpenses(db, tripId); // with status and confirmations (1.1): Go sees the same fields as the app
  const settlements = await loadSettlements(db, tripId); // never in the snapshot itself; they only move `money.transfers`
  const record = await db.query<RecordLineRow>('select * from record_lines where trip_id = $1 order by created_at, line_id', [tripId]);
  const budget = await budgetSummary(db, tripId, t.currency);
  return compact({
    trip_id: t.trip_id,
    seq: t.seq,
    title: t.title,
    status: t.status,
    created_at: iso(t.created_at)!,
    organizer_person_id: t.organizer_person_id,
    invite_url: inviteUrl(publicBaseUrl, t.invite_code),
    destination: t.destination ?? undefined,
    dates: t.dates_start && t.dates_end ? { start: t.dates_start, end: t.dates_end } : undefined,
    vibe: t.vibe,
    stay: t.stay ?? undefined,
    budget,
    people: people.map(personForGo),
    decisions,
    bookings: bookings.rows.map(bookingOf),
    expenses,
    money: moneyOf(expenses, order, t.currency, t.plan_minor, settlements),
    itinerary: t.itinerary,
    record: record.rows.map(recordLineOf),
  }) as unknown as TripSnapshot;
}

/** `read_trip`: one transaction at repeatable read, so `seq` matches the data. */
export async function readSnapshot(pool: pg.Pool, tripId: string, publicBaseUrl: string): Promise<TripSnapshot> {
  const db = await pool.connect();
  try {
    await db.query('begin transaction isolation level repeatable read read only');
    const snap = await buildSnapshot(db, tripId, publicBaseUrl);
    await db.query('commit');
    return snap;
  } catch (err) {
    await db.query('rollback').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

/**
 * The trip as the app reads it: the same snapshot Go reads, in one repeatable-read transaction, plus one app-only field. A vote that asks
 * "cancel this booking?" carries `cancels_booking_id` (the booking it is about); every other vote has no such key. Go never receives it:
 * it is added here and nowhere in `buildSnapshot`, which Go's reads and the `trip.created` event share.
 */
export async function readSnapshotForApp(pool: pg.Pool, tripId: string, publicBaseUrl: string): Promise<TripSnapshot> {
  const db = await pool.connect();
  try {
    await db.query('begin transaction isolation level repeatable read read only');
    const snap = await buildSnapshot(db, tripId, publicBaseUrl);
    const links = await db.query('select decision_id, cancels_booking_id from decisions where trip_id = $1 and cancels_booking_id is not null', [tripId]);
    await db.query('commit');
    const bookingOf = new Map(links.rows.map((r) => [r.decision_id as string, r.cancels_booking_id as string]));
    return { ...snap, decisions: snap.decisions.map((d) => (bookingOf.has(d.decision_id) ? { ...d, cancels_booking_id: bookingOf.get(d.decision_id) } : d)) } as unknown as TripSnapshot;
  } catch (err) {
    await db.query('rollback').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}
