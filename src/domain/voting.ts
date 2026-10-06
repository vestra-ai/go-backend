import type pg from 'pg';
import type { AfterCommit } from '../db/pool.js';
import { newId } from '../db/ids.js';
import { change, nextSeq, emit } from '../db/write-change.js';
import type { Ctx } from '../context.js';
import { conflict, notFound } from './errors.js';
import { decisionOf, recordLineOf } from './mappers.js';
import type { DecisionRow, RecordLineRow, VoteRow } from './mappers.js';
import type { Decision } from './types.js';

export interface NewDecision {
  question: string;
  kind: 'choice' | 'yesno';
  anonymous: boolean;
  /** The options as they are kept and shown (labels, and for a priced option its price and the trip's currency). */
  options: unknown[];
  closesAt: string | null;
  openedBy: string;
}

/** Inserts an open vote. Its head count is the people in the trip now: everyone who can still vote. */
export async function openDecision(db: pg.PoolClient, tripId: string, d: NewDecision): Promise<DecisionRow> {
  const people = await db.query('select count(*)::int as n from trip_people where trip_id = $1 and left_at is null', [tripId]);
  const { rows } = await db.query<DecisionRow>(
    `insert into decisions (decision_id, trip_id, question, kind, anonymous, options, of_count, closes_at, opened_by_person_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
    [newId('d'), tripId, d.question, d.kind, d.anonymous, JSON.stringify(d.options), people.rows[0].n, d.closesAt, d.openedBy],
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

export async function votesOf(db: pg.PoolClient, decisionId: string): Promise<VoteRow[]> {
  const { rows } = await db.query<VoteRow>('select person_id, option_index from votes where decision_id = $1 order by voted_at, person_id', [decisionId]);
  return rows;
}

/** The option with the most votes. Nobody voted, or a tie at the top: no result. */
export function resultOf(optionCount: number, votes: VoteRow[]): number | null {
  const tally = Array.from({ length: optionCount }, (_, i) => votes.filter((v) => v.option_index === i).length);
  const top = Math.max(0, ...tally);
  if (top === 0) return null;
  const winners = tally.flatMap((n, i) => (n === top ? [i] : []));
  return winners.length === 1 ? winners[0]! : null;
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
  const votes = await votesOf(db, decisionId);
  const result = resultOf(row.options.length, votes);
  const closed = (await db.query<DecisionRow>(
    `update decisions set status = 'closed', closed_at = now(), result_index = $2 where decision_id = $1 returning *`,
    [decisionId, result],
  )).rows[0]!;
  const decision = decisionOf(closed, votes);
  const seq = await change(db, tripId, 'decision.closed', { decision, reason });
  let last = seq;
  if (result !== null) {
    const label = (row.options[result] as { label: string }).label;
    const line = (await db.query<RecordLineRow>(
      `insert into record_lines (line_id, trip_id, kind, text, decision_id, source) values ($1, $2, 'decided', $3, $4, 'vote') returning *`,
      [newId('r'), tripId, label.slice(0, 200), decisionId],
    )).rows[0]!;
    last = await nextSeq(db, tripId);
    await emit(db, tripId, last, 'record.changed', { line: recordLineOf(line), change: 'added', by: { kind: 'system' } });
  }
  after(() => ctx.live.publish(tripId, { kind: 'trip', seq: last }));
  return { decision, seq };
}
