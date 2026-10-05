import { randomUUID } from 'node:crypto';
import type { Db } from './pool.js';
import { check } from '../contract/index.js';
import { notFound } from '../domain/errors.js';
import { SocketCallError } from '../go/go-socket.js';

/**
 * The trip's next change number. The update also locks the trip row until the transaction ends,
 * so two changes to one trip always commit in change-number order.
 */
export async function nextSeq(db: Db, tripId: string): Promise<number> {
  const { rows } = await db.query('update trips set seq = seq + 1 where trip_id = $1 returning seq', [tripId]);
  if (!rows[0]) throw notFound(`trip ${tripId} does not exist`);
  return rows[0].seq as number;
}

export interface Emitted {
  event_id: string;
  trip_id: string;
  seq: number;
  occurred_at: string;
  type: string;
  data: Record<string, unknown>;
}

/**
 * Puts the event for a change in the outbox. Call it in the same transaction as the change, with the
 * number from `nextSeq`. The event is checked against the contract here: an event Go would refuse
 * (422) is never sent again, so a bug is caught before it commits, not after.
 */
export async function emit(db: Db, tripId: string, seq: number, type: string, data: Record<string, unknown>, at: Date = new Date()): Promise<Emitted> {
  const candidate = { event_id: `ev_${randomUUID()}`, trip_id: tripId, seq, occurred_at: at.toISOString(), type, data };
  const checked = check<Emitted>('Event', candidate);
  if (!checked.ok) throw new SocketCallError(500, `event ${type} does not match the contract: ${checked.message}`, 'internal');
  // The event is stored as built, not as the checked copy: a card inside it stays exactly as it arrived.
  await db.query('insert into outbox (event_id, trip_id, seq, body) values ($1, $2, $3, $4)', [candidate.event_id, tripId, seq, JSON.stringify(candidate)]);
  return candidate;
}

/** The two steps almost every change ends with: take the next change number and write its event. */
export async function change(db: Db, tripId: string, type: string, data: Record<string, unknown>, at?: Date): Promise<number> {
  const seq = await nextSeq(db, tripId);
  await emit(db, tripId, seq, type, data, at);
  return seq;
}
