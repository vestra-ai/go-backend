// What people do with votes and bookings that Go does on their behalf elsewhere. Each action is one transaction:
// the change, its event for Go and the trip's next change number commit together, and the person must be in the
// trip inside that same transaction. A person-opened vote runs once per (person, client_id) when the app sends that
// press key; bookings and cancellation votes have no press key, the Idempotency-Key header (src/api/idempotency.ts)
// covers them.
import type { Ctx } from '../context.js';
import { newId } from '../db/ids.js';
import { onceIfKeyed } from '../db/once.js';
import { withTx } from '../db/pool.js';
import { change, emit, nextSeq } from '../db/write-change.js';
import type { AddBookingBody, CancelVoteBody, OpenVoteBody, UpdateBookingBody } from '../api/bodies.js';
import { assertPeopleInTrip } from '../requests/guards.js';
import { bookingForApp, type BookingForApp } from './bookings.js';
import { conflict, invalid, notFound } from './errors.js';
import { bookingOf, compact, decisionOf, recordLineOf } from './mappers.js';
import type { BookingRow, RecordLineRow } from './mappers.js';
import { loadMessageForApp } from './room.js';
import { bookedText, postSystemMessage, voteCardFor } from './system-messages.js';
import { fillTripFromBookings } from './trip-from-booking.js';
import type { Message } from './types.js';
import { lockBooking, openDecision } from './voting.js';
import { decisionForPerson, publishHomeAll, requireMember, type DecisionForPerson } from './actions.js';

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

/**
 * A member opens a vote (the composer's "Poll"). Go hears `decision.opened` by that person; Go posts no card for a
 * vote it did not open, so the server posts a system message carrying the `vote` card (decision D8) and answers both.
 */
export async function openPersonVote(ctx: Ctx, tripId: string, personId: string, input: OpenVoteBody): Promise<{ decision: DecisionForPerson; message: Message }> {
  const made = await onceIfKeyed(ctx.pool, tripId, input.client_id && `app:vote:${personId}:${input.client_id}`, async (db) => {
    await requireMember(db, tripId, personId);
    const closesAt = input.closes_at ? instant(input.closes_at, 'closes_at') : null;
    if (closesAt && closesAt.getTime() <= Date.now()) throw invalid('closes_at must be in the future', 'closes_at');
    const currency = (await db.query('select currency from trips where trip_id = $1', [tripId])).rows[0]!.currency as string;
    const options = input.options.map((o) =>
      compact({ label: o.label, image_url: o.image_url, price_minor: o.price_minor, currency: o.price_minor === undefined ? undefined : currency, note: o.note }));
    const row = await openDecision(db, tripId, {
      question: input.question, kind: input.kind, anonymous: input.anonymous, options, closesAt: closesAt?.toISOString() ?? null, openedBy: personId,
    });
    const seq = await change(db, tripId, 'decision.opened', { decision: decisionOf(row, []), by: { kind: 'person', person_id: personId } });
    await ctx.live.publish(tripId, { kind: 'trip', seq, kinds: ['decision'] }); // before the anchor's notice: live frames in change-number order
    const message = await postSystemMessage(ctx, db, tripId, input.question, voteCardFor(row.decision_id, input.question));
    await publishHomeAll(ctx, tripId, db); // a new open item for everyone, with its card
    return { decision_id: row.decision_id, message_id: message.message_id };
  });
  const [decision, message] = await Promise.all([
    ctx.pool.query('select * from decisions where decision_id = $1', [made.decision_id]).then((r) => decisionForPerson(r.rows[0], [], personId)),
    loadMessageForApp(ctx, ctx.pool, tripId, made.message_id, personId),
  ]);
  return { decision, message };
}

const by = (personId: string) => ({ kind: 'person', person_id: personId });
const endsBeforeStarts = (starts: Date | null, ends: Date | null) => !!starts && !!ends && ends.getTime() < starts.getTime();

/**
 * A member adds a booking they made. It is stored as confirmed, in the trip's currency, with no approval and no
 * expense. Go hears `booking.changed` (added, by the person) and then the booked line in the record as its own change,
 * as on Go's path. Where the booking names a vote that has already been decided, that decided line becomes the booked line.
 * The 1.1 fields (`details`, `return_journey`, `passengers`) are stored as sent; each passenger must be a covered person.
 * Answers the stored Booking as the person may see it (§1.7: passengers only when it covers them; it has no documents yet)
 * plus the change number of `booking.changed`.
 */
export async function addPersonBooking(ctx: Ctx, tripId: string, personId: string, input: AddBookingBody): Promise<BookingForApp & { seq: number }> {
  return withTx(ctx.pool, async (db) => {
    await requireMember(db, tripId, personId);
    const currency = (await db.query('select currency from trips where trip_id = $1', [tripId])).rows[0]!.currency as string;
    await assertPeopleInTrip(db, tripId, [input.payer_person_id, ...input.for_person_ids], 'payer_person_id/for_person_ids');
    const covered = new Set(input.for_person_ids);
    const stranger = (input.passengers ?? []).findIndex((p) => !covered.has(p.person_id));
    if (stranger >= 0) throw invalid(`passengers[${stranger}].person_id must be one of for_person_ids`, `passengers[${stranger}].person_id`);
    const refundableUntil = input.refundable_until ? instant(input.refundable_until, 'refundable_until') : null;
    const startsAt = input.starts_at ? instant(input.starts_at, 'starts_at') : null;
    const endsAt = input.ends_at ? instant(input.ends_at, 'ends_at') : null;
    if (endsBeforeStarts(startsAt, endsAt)) throw invalid('ends_at must not be before starts_at');
    if (input.decision_id) {
      const d = (await db.query('select status, cancels_booking_id from decisions where trip_id = $1 and decision_id = $2', [tripId, input.decision_id])).rows[0];
      if (!d) throw invalid(`decision_id: ${input.decision_id} is not a vote in this trip`, 'decision_id');
      if (d.status !== 'closed') throw invalid(`decision_id: ${input.decision_id} is not a closed vote`, 'decision_id');
      if (d.cancels_booking_id) throw invalid(`decision_id: ${input.decision_id} is a vote about cancelling a booking`, 'decision_id');
    }
    // Row locks before the change number (which locks the trip row), as on Go's path: a person undoing this line at the same moment must not deadlock with us.
    const decided = input.decision_id
      ? (await db.query<RecordLineRow>(`select * from record_lines where trip_id = $1 and decision_id = $2 and kind = 'decided' for update`, [tripId, input.decision_id])).rows[0]
      : undefined;
    const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
    const booking = (await db.query<BookingRow>(
      `insert into bookings (booking_id, trip_id, kind, title, vendor, ref, amount_minor, currency, payer_person_id, for_person_ids,
                             refundable_until, starts_at, ends_at, journey, place, image_url, decision_id, added_by_person_id, details, return_journey, passengers)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) returning *`,
      [newId('b'), tripId, input.kind, input.title, input.vendor, input.ref, input.amount_minor, currency, input.payer_person_id, JSON.stringify(input.for_person_ids),
       refundableUntil?.toISOString() ?? null, startsAt?.toISOString() ?? null, endsAt?.toISOString() ?? null,
       json(input.journey), json(input.place), input.image_url ?? null, input.decision_id ?? null, personId, json(input.details), json(input.return_journey), json(input.passengers)],
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
    await ctx.live.publish(tripId, { kind: 'trip', seq: lineSeq, kinds: ['booking', 'record'] }); // before the pill's notice
    await postSystemMessage(ctx, db, tripId, bookedText(input.title)); // the room's pill (D8), after the events
    await fillTripFromBookings(ctx, db, tripId); // the trip's empty place, stay and dates from what is now booked
    return { ...bookingForApp(bookingOf(booking), [], personId), seq };
  });
}

/**
 * A member updates a booking's reference or dates (any member, any booking). It locks the booking row, then compares:
 * only what differs is written, and when nothing differs there is no change number and no event (`seq: null`).
 * `null` clears a date. The ends-before-starts rule is checked on the merged result.
 */
export async function updatePersonBooking(ctx: Ctx, tripId: string, personId: string, bookingId: string, input: UpdateBookingBody) {
  return withTx(ctx.pool, async (db) => {
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
    await ctx.live.publish(tripId, { kind: 'trip', seq, kinds: ['booking'] });
    return { seq };
  });
}

/** The first `max` characters (code points, as the contract counts them), never half of a pair. */
const cut = (text: string, max: number) => Array.from(text).slice(0, max).join('');
export const CANCEL_VOTE_HOURS = 24;

/**
 * A member proposes cancelling a booking: the server opens a yes/no vote (not anonymous, closing in 24 hours) worded
 * with the booking's title cut to fit the contract's limits. It locks the booking row first, then checks it, so of two
 * proposals at the same moment the second sees the first's vote and answers 409 naming it. The vote carries a
 * server-side link to the booking (never sent to Go). Whether the booking is cancelled is decided when the vote closes
 * (see `closeDecision`). Cancelling records the group's decision only: nothing is cancelled with the vendor.
 */
export async function proposeCancelBooking(ctx: Ctx, tripId: string, personId: string, bookingId: string, _input: CancelVoteBody) {
  return withTx(ctx.pool, async (db) => {
    await requireMember(db, tripId, personId);
    const booking = await lockBooking(db, tripId, bookingId);
    if (!booking) throw notFound(`booking ${bookingId} does not exist in trip ${tripId}`);
    if (booking.status === 'cancelled') throw conflict(`booking ${bookingId} is already cancelled`);
    if (booking.approval_id) throw conflict(`booking ${bookingId} was paid through Go's vault and cannot be cancelled by a vote`);
    const open = (await db.query(`select decision_id from decisions where cancels_booking_id = $1 and status = 'open'`, [bookingId])).rows[0];
    if (open) throw conflict(`a vote to cancel booking ${bookingId} is already open: ${open.decision_id}`);
    const row = await openDecision(db, tripId, {
      question: `Cancel this booking? ${booking.title}`,
      kind: 'yesno',
      anonymous: false,
      options: [{ label: `Cancel: ${cut(booking.title, 112)}` }, { label: `Keep: ${cut(booking.title, 112)}` }],
      closesAt: new Date(Date.now() + CANCEL_VOTE_HOURS * 3_600_000).toISOString(),
      openedBy: personId,
      cancelsBookingId: bookingId,
    });
    const seq = await change(db, tripId, 'decision.opened', { decision: decisionOf(row, []), by: by(personId) });
    await ctx.live.publish(tripId, { kind: 'trip', seq, kinds: ['decision'] }); // before the anchor's notice: live frames in change-number order
    await postSystemMessage(ctx, db, tripId, row.question, voteCardFor(row.decision_id, row.question)); // the poll's anchor in the room (D8)
    await publishHomeAll(ctx, tripId, db);
    return { decision_id: row.decision_id, seq };
  });
}
