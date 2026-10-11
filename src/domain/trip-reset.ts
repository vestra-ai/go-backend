// POST /internal/v1/trips/:trip_id/reset: the App team's way to throw a test trip away. Destructive and for test trips
// only: the trip and every row that belongs to it are hard-deleted in one transaction, children before parents (the
// foreign keys have no cascade), the outbox's unsent events included, so nothing about the trip is ever sent to Go again.
// Go learns it is gone the next time it asks: read_trip answers not_found, which the contract reads as "this trip no
// longer exists". The people stay (they may be in other trips), and so do their uploads and any files in Storage.
import type { Ctx } from '../context.js';
import { withTx } from '../db/pool.js';
import { publishHome } from './actions.js';
import { notFound } from './errors.js';

/**
 * Every table that holds a trip's rows, in the order they are deleted: rows that point at a decision, booking or message
 * of the trip first, then the rows that carry `trip_id` themselves, then the trip. tests/internal.test.ts checks that
 * every table with a `trip_id` column is in this list, so a new table cannot be forgotten.
 */
export const TRIP_TABLES = [
  'votes', 'reactions', 'checkins', 'booking_documents',
  'record_lines', 'spend_approvals', 'option_picks', 'option_details', 'settlements', 'expenses', 'bookings', 'decisions', 'messages',
  'invites', 'outbox', 'go_requests', 'trip_people', 'trips',
] as const;

/** Each table's delete. The first four reach the trip through their parent row. */
const DELETES: Record<(typeof TRIP_TABLES)[number], string> = {
  votes: 'delete from votes where decision_id in (select decision_id from decisions where trip_id = $1)',
  reactions: 'delete from reactions where trip_id = $1',
  checkins: 'delete from checkins where booking_id in (select booking_id from bookings where trip_id = $1)',
  booking_documents: 'delete from booking_documents where booking_id in (select booking_id from bookings where trip_id = $1)',
  record_lines: 'delete from record_lines where trip_id = $1',
  spend_approvals: 'delete from spend_approvals where trip_id = $1',
  option_picks: 'delete from option_picks where trip_id = $1', // after spend_approvals, which point at a pick (014)
  option_details: 'delete from option_details where trip_id = $1',
  settlements: 'delete from settlements where trip_id = $1',
  expenses: 'delete from expenses where trip_id = $1',
  bookings: 'delete from bookings where trip_id = $1',
  decisions: 'delete from decisions where trip_id = $1',
  messages: 'delete from messages where trip_id = $1',
  invites: 'delete from invites where trip_id = $1',
  outbox: 'delete from outbox where trip_id = $1',
  go_requests: 'delete from go_requests where trip_id = $1',
  trip_people: 'delete from trip_people where trip_id = $1',
  trips: 'delete from trips where trip_id = $1',
};

/** Deletes the trip and everything in it. 404 for a trip that does not exist. Everyone who was in it gets `home_changed`. */
export async function resetTrip(ctx: Ctx, tripId: string): Promise<{ deleted: true }> {
  return withTx(ctx.pool, async (db) => {
    // The trip row first, locked: every change to a trip takes this lock (nextSeq), so none is half-way through meanwhile.
    const trip = await db.query('select 1 from trips where trip_id = $1 for update', [tripId]);
    if (!trip.rowCount) throw notFound(`trip ${tripId} does not exist`);
    const people = (await db.query('select person_id from trip_people where trip_id = $1 and left_at is null', [tripId])).rows.map((r) => r.person_id as string);
    // Only the tables this database has: a table that a later migration brings is listed here ahead of it.
    const present = new Set((await db.query(`select table_name from information_schema.tables where table_schema = current_schema()`)).rows.map((r) => r.table_name as string));
    for (const table of TRIP_TABLES) if (present.has(table)) await db.query(DELETES[table], [tripId]);
    await publishHome(ctx, tripId, people); // their home loses the trip; a trip screen still open gets 403 on its next read
    return { deleted: true as const };
  });
}
