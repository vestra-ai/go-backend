// Messages the server itself posts in the room (decision D8, app contract §4.6): "Trip created · Rahul joined",
// "Priya joined", "Priya left", "Villa Sol won · 4 votes", "Villa Sol booked", and the message that carries the vote
// card of a person-opened poll. `author` is { kind: "system" }, the app draws them as centred pills. Each takes the
// trip's next change number like any message, but writes NO outbox event: Go already received `person.joined`,
// `decision.closed`, `booking.changed` or `decision.opened` for the same thing, and sees these in `read_messages`.
import type pg from 'pg';
import type { Ctx } from '../context.js';
import { newId } from '../db/ids.js';
import type { AfterCommit, Db } from '../db/pool.js';
import { nextSeq } from '../db/write-change.js';
import type { MessageRow } from './mappers.js';

/** A card the server puts on a system message: today only the `vote` card of a person-opened poll. */
export interface SystemCard { card_id: string; kind: 'vote'; decision_id: string; fallback_text: string }

/** Posts a system message as the trip's next change (no event), and shows it live after the commit. Returns the row. */
export async function postSystemMessage(ctx: Ctx, db: pg.PoolClient, after: AfterCommit, tripId: string, text: string, card?: SystemCard): Promise<MessageRow> {
  const seq = await nextSeq(db, tripId);
  const row = (await db.query<MessageRow>(
    `insert into messages (message_id, trip_id, seq, updated_seq, author_kind, text, card, card_id)
     values ($1, $2, $3, $3, 'system', $4, $5, $6) returning *`,
    [newId('m'), tripId, seq, text.slice(0, 4000), card ? JSON.stringify(card) : null, card?.card_id ?? null],
  )).rows[0]!;
  after(() => ctx.live.publish(tripId, { kind: 'message', message_id: row.message_id, updated_seq: seq }));
  return row;
}

/** The vote card the server draws for a poll a person opened (Go posts its own for the votes it opens). */
export const voteCardFor = (decisionId: string, question: string): SystemCard => ({ card_id: newId('c'), kind: 'vote', decision_id: decisionId, fallback_text: question.slice(0, 300) });

export async function personName(db: Db, personId: string): Promise<string> {
  const { rows } = await db.query('select name from people where person_id = $1', [personId]);
  return (rows[0]?.name as string | undefined) ?? 'Someone';
}

// The wording, in one place.
export const tripCreatedText = (name: string) => `Trip created · ${name} joined`;
export const joinedText = (name: string) => `${name} joined`;
export const leftText = (name: string) => `${name} left`;
export const decidedText = (label: string, votes: number) => `${label} won · ${votes} ${votes === 1 ? 'vote' : 'votes'}`;
export const bookedText = (title: string) => `${title} booked`;
