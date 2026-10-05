import { conflict, invalid, notFound } from '../domain/errors.js';
import type { Db } from '../db/pool.js';

export interface TripRow {
  trip_id: string;
  currency: string;
  seq: number;
  title: string;
}

export async function tripOf(db: Db, tripId: string): Promise<TripRow> {
  const { rows } = await db.query('select trip_id, currency, seq, title from trips where trip_id = $1', [tripId]);
  if (!rows[0]) throw notFound(`trip ${tripId} does not exist`);
  return rows[0];
}

/** Every id must be a person who is in the trip now (someone who left is not). */
export async function assertPeopleInTrip(db: Db, tripId: string, ids: Array<string | undefined>, field: string): Promise<void> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (wanted.length === 0) return;
  const { rows } = await db.query('select person_id from trip_people where trip_id = $1 and left_at is null and person_id = any($2)', [tripId, wanted]);
  const have = new Set(rows.map((r) => r.person_id as string));
  const missing = wanted.find((id) => !have.has(id));
  if (missing) throw invalid(`${field}: ${missing} is not in trip ${tripId}`);
}

export async function assertMessagesInTrip(db: Db, tripId: string, ids: Array<string | undefined>, field: string): Promise<void> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (wanted.length === 0) return;
  const { rows } = await db.query('select message_id from messages where trip_id = $1 and message_id = any($2)', [tripId, wanted]);
  const have = new Set(rows.map((r) => r.message_id as string));
  const missing = wanted.find((id) => !have.has(id));
  if (missing) throw invalid(`${field}: ${missing} is not a message of trip ${tripId}`);
}

/** A trip has one currency, and every amount in a request uses it. */
export function assertCurrency(trip: TripRow, currency: string | undefined, field = 'currency'): void {
  if (currency !== undefined && currency !== trip.currency) throw invalid(`${field} must be ${trip.currency}, the trip's currency`);
}

export const requireSomething = (params: Record<string, unknown>, besides: string[]): void => {
  if (!Object.keys(params).some((k) => !besides.includes(k) && params[k] !== undefined)) {
    throw invalid(`send at least one field besides ${besides.join(', ')}`);
  }
};

export { conflict, invalid, notFound };
