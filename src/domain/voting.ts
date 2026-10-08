import type pg from 'pg';
import type { AfterCommit, Db } from '../db/pool.js';
import { newId } from '../db/ids.js';
import { change, nextSeq, emit } from '../db/write-change.js';
import type { Ctx } from '../context.js';
import type { ChangeKind } from '../live/live.js';
import { conflict, notFound } from './errors.js';
import { bookingOf, decisionOf, recordLineOf, tallyOf } from './mappers.js';
import type { BookingRow, DecisionRow, RecordLineRow, VoteRow } from './mappers.js';
import { decidedText, postSystemMessage } from './system-messages.js';
import type { Decision } from './types.js';

export interface NewDecision {
  question: string;
  kind: 'choice' | 'yesno';
  anonymous: boolean;
  /** The options as they are kept and shown (labels, and for a priced option its price and the trip's currency). */
  options: unknown[];
  closesAt: string | null;
  openedBy: string;
  /** A vote about cancelling this booking. */
  cancelsBookingId?: string;
}

/** Inserts an open vote. Its head count is the people in the trip now: everyone who can still vote. */
export async function openDecision(db: pg.PoolClient, tripId: string, d: NewDecision): Promise<DecisionRow> {
  const people = await db.query('select count(*)::int as n from trip_people where trip_id = $1 and left_at is null', [tripId]);
  const { rows } = await db.query<DecisionRow>(
    `insert into decisions (decision_id, trip_id, question, kind, anonymous, options, of_count, closes_at, opened_by_person_id, cancels_booking_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
    [newId('d'), tripId, d.question, d.kind, d.anonymous, JSON.stringify(d.options), people.rows[0].n, d.closesAt, d.openedBy, d.cancelsBookingId ?? null],
  );
  return rows[0]!;
}

export type CloseReason = 'time' | 'everyone_voted' | 'closed_by_person' | 'closed_by_go';

/** Locks the vote's row. Take row locks like this one before `nextSeq`, which locks the trip row. */
export async function lockDecision(db: pg.PoolClient, tripId: string, decisionId: string): Promise<DecisionRow> {
  const { rows } = await db.query<DecisionRow>('select * from decisions where decision_id = $1 and trip_id = $2 for update', [decisionId, tripId]);
  if (!rows[0]) throw notFound(`decision ${decisionId} does not exist in trip ${tripId}`);
  return rows[0];
}

/**
 * Locks the booking row. Lock order, always: person row, then vote rows, then booking rows, then the trip's change
 * number (`nextSeq`). A path that closes a vote about a booking must hold the booking before it takes a change number.
 */
export async function lockBooking(db: pg.PoolClient, tripId: string, bookingId: string): Promise<BookingRow | undefined> {
  const { rows } = await db.query<BookingRow>('select * from bookings where trip_id = $1 and booking_id = $2 for update', [tripId, bookingId]);
  return rows[0];
}

export async function votesOf(db: Db, decisionId: string): Promise<VoteRow[]> {
  const { rows } = await db.query<VoteRow>('select person_id, option_index, flexible from votes where decision_id = $1 order by voted_at, person_id', [decisionId]);
  return rows;
}

/** The option with the most votes. Nobody voted, or a tie at the top: no result. Flexible votes name no option and never decide. */
export function resultOf(optionCount: number, votes: VoteRow[]): number | null {
  const tally = tallyOf(optionCount, votes);
  const top = Math.max(0, ...tally);
  if (top === 0) return null;
  const winners = tally.flatMap((n, i) => (n === top ? [i] : []));
  return winners.length === 1 ? winners[0]! : null;
}

/**
 * The result of a vote about cancelling a booking (option 0 is "Cancel", option 1 is "Keep"). "Cancel" wins only with
 * more than half of the vote's head count when it closes: people who did not vote count against, a tie does not cancel,
 * and a person who voted and then left stays in the tally and the head count. "Keep" wins when it has more votes than
 * "Cancel". Otherwise there is no result, even when "Cancel" leads, so a closed vote never reports "Cancel" while the
 * booking stands. (One person closing early must not be able to cancel alone, so the rule is not "most votes cast".)
 */
export function cancellationResultOf(headCount: number, votes: VoteRow[]): number | null {
  const cancel = votes.filter((v) => v.option_index === 0).length;
  const keep = votes.filter((v) => v.option_index === 1).length;
  if (cancel * 2 > headCount) return 0;
  return keep > cancel ? 1 : null;
}

/**
 * Closes a vote: `decision.closed`, and when there is a winner the decided line in the trip record,
 * which is its own change with its own change number and its own `record.changed` event.
 * Returns the vote as it ended and the change number of `decision.closed`.
 */
export async function closeDecision(
  ctx: Ctx,
  db: pg.PoolClient,
  after: AfterCommit,
  tripId: string,
  decisionId: string,
  reason: CloseReason,
): Promise<{ decision: Decision; seq: number }> {
  const row = await lockDecision(db, tripId, decisionId);
  if (row.status !== 'open') throw conflict(`decision ${decisionId} is already ${row.status}`);
  // A vote about cancelling a booking: take the booking right after the vote and before any change number (see lockBooking).
  const booking = row.cancels_booking_id ? await lockBooking(db, tripId, row.cancels_booking_id) : undefined;
  const votes = await votesOf(db, decisionId);
  const result = row.cancels_booking_id ? cancellationResultOf(row.of_count, votes) : resultOf(row.options.length, votes);
  const closed = (await db.query<DecisionRow>(
    `update decisions set status = 'closed', closed_at = now(), result_index = $2 where decision_id = $1 returning *`,
    [decisionId, result],
  )).rows[0]!;
  const decision = decisionOf(closed, votes);
  const seq = await change(db, tripId, 'decision.closed', { decision, reason });
  let last = seq;
  const kinds: ChangeKind[] = ['decision'];
  // The group decided to cancel: the booking is cancelled in this same transaction, as the next change after the vote closed.
  // If it was already cancelled meanwhile (Go cancelled it), nothing more happens to it and no booking event is sent.
  if (booking && result === 0 && booking.status === 'confirmed') {
    const cancelled = (await db.query<BookingRow>(`update bookings set status = 'cancelled' where booking_id = $1 returning *`, [booking.booking_id])).rows[0]!;
    last = await change(db, tripId, 'booking.changed', { booking: bookingOf(cancelled), change: 'cancelled', by: { kind: 'system' } });
    kinds.push('booking');
  }
  if (result !== null) {
    const label = (row.options[result] as { label: string }).label;
    const line = (await db.query<RecordLineRow>(
      `insert into record_lines (line_id, trip_id, kind, text, decision_id, source) values ($1, $2, 'decided', $3, $4, 'vote') returning *`,
      [newId('r'), tripId, label.slice(0, 200), decisionId],
    )).rows[0]!;
    last = await nextSeq(db, tripId);
    await emit(db, tripId, last, 'record.changed', { line: recordLineOf(line), change: 'added', by: { kind: 'system' } });
    kinds.push('record');
    // The room's pill, "Villa Sol won · 4 votes" (decision D8): after the events, no event of its own.
    await postSystemMessage(ctx, db, after, tripId, decidedText(label, decision.tally[result] ?? 0));
  }
  after(() => ctx.live.publish(tripId, { kind: 'trip', seq: last, kinds }));
  return { decision, seq };
}
