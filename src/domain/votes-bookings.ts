// What people do with votes and bookings that Go does on their behalf elsewhere. Each action is one transaction:
// the change, its event for Go and the trip's next change number commit together, and the person must be in the
// trip inside that same transaction. Creates run once per (person, client_id).
import type { Ctx } from '../context.js';
import { newId } from '../db/ids.js';
import { once } from '../db/once.js';
import { withTx } from '../db/pool.js';
import { change, emit, nextSeq } from '../db/write-change.js';
import type { AddBookingBody, OpenVoteBody, UpdateBookingBody } from '../api/bodies.js';
import { assertPeopleInTrip } from '../requests/guards.js';
import { conflict, invalid, notFound } from './errors.js';
import { bookingOf, compact, decisionOf, recordLineOf } from './mappers.js';
import type { BookingRow, RecordLineRow } from './mappers.js';
import { openDecision } from './voting.js';
import { requireMember } from './actions.js';

/**
 * A checked date-time as an instant. The contract's format admits timezone offsets Postgres refuses, leap seconds
 * JavaScript cannot read, and times that fall outside years 1 to 9999 once the offset is applied; each would otherwise
 * become a 500 or a time that is silently not checked.
 */
export function instant(value: string, field: string): Date {
  const at = new Date(value);
  // After the offset is applied the instant must still be a year Postgres reads back: ISO text for year 10000 or year 0 is refused by it.
  if (Number.isNaN(at.getTime()) || at.getUTCFullYear() < 1 || at.getUTCFullYear() > 9999) throw invalid(`${field} is not a time that can be stored`);
  return at;
}

/** A member opens a vote. Go hears `decision.opened` by that person; the server posts no card (Go does). */
export async function openPersonVote(ctx: Ctx, tripId: string, personId: string, input: OpenVoteBody) {
  return once(ctx.pool, tripId, `app:vote:${personId}:${input.client_id}`, async (db, after) => {
    await requireMember(db, tripId, personId);
    const closesAt = input.closes_at ? instant(input.closes_at, 'closes_at') : null;
    if (closesAt && closesAt.getTime() <= Date.now()) throw invalid('closes_at must be in the future');
    const currency = (await db.query('select currency from trips where trip_id = $1', [tripId])).rows[0]!.currency as string;
    const options = input.options.map((o) =>
      compact({ label: o.label, image_url: o.image_url, price_minor: o.price_minor, currency: o.price_minor === undefined ? undefined : currency, note: o.note }));
    const row = await openDecision(db, tripId, {
      question: input.question, kind: input.kind, anonymous: input.anonymous, options, closesAt: closesAt?.toISOString() ?? null, openedBy: personId,
    });
    const seq = await change(db, tripId, 'decision.opened', { decision: decisionOf(row, []), by: { kind: 'person', person_id: personId } });
    after(() => ctx.live.publish(tripId, { kind: 'trip', seq }));
    return { decision_id: row.decision_id, seq };
  });
}

const by = (personId: string) => ({ kind: 'person', person_id: personId });
const endsBeforeStarts = (starts: Date | null, ends: Date | null) => !!starts && !!ends && ends.getTime() < starts.getTime();

/**
 * A member adds a booking they made. It is stored as confirmed, in the trip's currency, with no approval and no
 * expense. Go hears `booking.changed` (added, by the person) and then the booked line in the record as its own change,
 * as on Go's path. Where the booking names a vote that has already been decided, that decided line becomes the booked line.
 */
export async function addPersonBooking(ctx: Ctx, tripId: string, personId: string, input: AddBookingBody) {
  return once(ctx.pool, tripId, `app:booking:${personId}:${input.client_id}`, async (db, after) => {
    await requireMember(db, tripId, personId);
    const currency = (await db.query('select currency from trips where trip_id = $1', [tripId])).rows[0]!.currency as string;
    await assertPeopleInTrip(db, tripId, [input.payer_person_id, ...input.for_person_ids], 'payer_person_id/for_person_ids');
    const refundableUntil = input.refundable_until ? instant(input.refundable_until, 'refundable_until') : null;
    const startsAt = input.starts_at ? instant(input.starts_at, 'starts_at') : null;
    const endsAt = input.ends_at ? instant(input.ends_at, 'ends_at') : null;
    if (endsBeforeStarts(startsAt, endsAt)) throw invalid('ends_at must not be before starts_at');
    if (input.decision_id) {
      const d = (await db.query('select status, cancels_booking_id from decisions where trip_id = $1 and decision_id = $2', [tripId, input.decision_id])).rows[0];
      if (!d) throw invalid(`decision_id: ${input.decision_id} is not a vote in this trip`);
      if (d.status !== 'closed') throw invalid(`decision_id: ${input.decision_id} is not a closed vote`);
      if (d.cancels_booking_id) throw invalid(`decision_id: ${input.decision_id} is a vote about cancelling a booking`);
    }
    // Row locks before the change number (which locks the trip row), as on Go's path: a person undoing this line at the same moment must not deadlock with us.
    const decided = input.decision_id
      ? (await db.query<RecordLineRow>(`select * from record_lines where trip_id = $1 and decision_id = $2 and kind = 'decided' for update`, [tripId, input.decision_id])).rows[0]
      : undefined;
    const booking = (await db.query<BookingRow>(
      `insert into bookings (booking_id, trip_id, kind, title, vendor, ref, amount_minor, currency, payer_person_id, for_person_ids,
                             refundable_until, starts_at, ends_at, journey, place, image_url, decision_id, added_by_person_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning *`,
      [newId('b'), tripId, input.kind, input.title, input.vendor, input.ref, input.amount_minor, currency, input.payer_person_id, JSON.stringify(input.for_person_ids),
       refundableUntil?.toISOString() ?? null, startsAt?.toISOString() ?? null, endsAt?.toISOString() ?? null,
       input.journey ? JSON.stringify(input.journey) : null, input.place ? JSON.stringify(input.place) : null, input.image_url ?? null, input.decision_id ?? null, personId],
    )).rows[0]!;
    const seq = await change(db, tripId, 'booking.changed', { booking: bookingOf(booking), change: 'added', by: by(personId) });
    const line = decided
      ? (await db.query<RecordLineRow>(
          `update record_lines set kind = 'booked', text = $2, booking_id = $3, source = 'booking', updated_at = now() where line_id = $1 returning *`,
          [decided.line_id, input.title.slice(0, 200), booking.booking_id],
        )).rows[0]!
      : (await db.query<RecordLineRow>(
          `insert into record_lines (line_id, trip_id, kind, text, booking_id, decision_id, source) values ($1, $2, 'booked', $3, $4, $5, 'booking') returning *`,
          [newId('r'), tripId, input.title.slice(0, 200), booking.booking_id, input.decision_id ?? null],
        )).rows[0]!;
    const lineSeq = await nextSeq(db, tripId);
    await emit(db, tripId, lineSeq, 'record.changed', { line: recordLineOf(line), change: decided ? 'updated' : 'added', by: { kind: 'system' } });
    after(() => ctx.live.publish(tripId, { kind: 'trip', seq: lineSeq }));
    return { booking_id: booking.booking_id, seq };
  });
}

/**
 * A member updates a booking's reference or dates (any member, any booking). It locks the booking row, then compares:
 * only what differs is written, and when nothing differs there is no change number and no event (`seq: null`).
 * `null` clears a date. The ends-before-starts rule is checked on the merged result.
 */
export async function updatePersonBooking(ctx: Ctx, tripId: string, personId: string, bookingId: string, input: UpdateBookingBody) {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    const current = (await db.query<BookingRow>('select * from bookings where trip_id = $1 and booking_id = $2 for update', [tripId, bookingId])).rows[0];
    if (!current) throw notFound(`booking ${bookingId} does not exist in trip ${tripId}`);
    if (current.status === 'cancelled') throw conflict(`booking ${bookingId} is cancelled and cannot change`);
    const time = (field: 'refundable_until' | 'starts_at' | 'ends_at'): Date | null => {
      const sent = input[field];
      if (sent === undefined) return current[field] ? new Date(current[field]!) : null;
      return sent === null ? null : instant(sent, field);
    };
    const next = { ref: input.ref ?? current.ref, refundable_until: time('refundable_until'), starts_at: time('starts_at'), ends_at: time('ends_at') };
    if (endsBeforeStarts(next.starts_at, next.ends_at)) throw invalid('ends_at must not be before starts_at');
    const ms = (d: Date | string | null) => (d === null ? null : new Date(d).getTime());
    // Only the fields that differ are written: a time the caller did not send keeps exactly the value (and precision) it had.
    const changes: Array<[string, string | null]> = [];
    if (next.ref !== current.ref) changes.push(['ref', next.ref]);
    for (const field of ['refundable_until', 'starts_at', 'ends_at'] as const) {
      if (ms(next[field]) !== ms(current[field])) changes.push([field, next[field]?.toISOString() ?? null]);
    }
    if (changes.length === 0) return { seq: null };
    const updated = (await db.query<BookingRow>(
      `update bookings set ${changes.map(([column], i) => `${column} = $${i + 2}`).join(', ')} where booking_id = $1 returning *`,
      [bookingId, ...changes.map(([, value]) => value)],
    )).rows[0]!;
    const seq = await change(db, tripId, 'booking.changed', { booking: bookingOf(updated), change: 'updated', by: by(personId) });
    after(() => ctx.live.publish(tripId, { kind: 'trip', seq }));
    return { seq };
  });
}
