import type pg from 'pg';
import { notFound } from './errors.js';
import { loadExpenses, loadSettlements } from './ledger.js';
import { compact, bookingOf, decisionOf, iso, personForGo, recordLineOf } from './mappers.js';
import type { BookingRow, DecisionRow, PersonRow, RecordLineRow, VoteRow } from './mappers.js';
import { moneyOf } from './money.js';
import type { BudgetSummary, TripSnapshot } from './types.js';
import type { Db } from '../db/pool.js';

export const inviteUrl = (base: string, code: string) => `${base.replace(/\/+$/, '')}/invite/${code}`;

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

/**
 * The group's budget as Go and the app read it (rev 4 §5.1): one amount per person, the same for everyone. The contract's
 * 1.0 shape is kept so a 1.0 Go still understands it ("everyone answered the same band"); `per_person_minor` is the one
 * 1.1 member, and the only one the app reads. Not set: nobody has answered.
 */
export function budgetOf(perPersonMinor: number | null, peopleCount: number, currency: string): BudgetSummary {
  if (perPersonMinor === null) return { answered: 0, of: peopleCount } as BudgetSummary;
  return { lowest: { min_minor: perPersonMinor, max_minor: perPersonMinor, currency }, answered: peopleCount, of: peopleCount, per_person_minor: perPersonMinor } as unknown as BudgetSummary;
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
  const expenses = await loadExpenses(db, tripId);
  const settlements = await loadSettlements(db, tripId); // never in the snapshot itself; they only move `money.transfers`
  const record = await db.query<RecordLineRow>('select * from record_lines where trip_id = $1 order by created_at, line_id', [tripId]);
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
    budget: budgetOf(t.budget_per_person_minor ?? null, people.length, t.currency),
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
