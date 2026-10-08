// Reading the room for the app (app contract §4.6): one message by id, and the two paging modes of
// GET /trips/:trip/messages. Every attachment link is signed again on the way out (src/domain/attachments.ts).
import type { Db } from '../db/pool.js';
import type { Ctx } from '../context.js';
import { freshenAttachments } from './attachments.js';
import { invalid, notFound } from './errors.js';
import { messageForApp } from './mappers.js';
import type { MessageRow, ReactionRow } from './mappers.js';
import type { Message } from './types.js';

export const HISTORY_DEFAULT = 50;
export const HISTORY_MAX = 100;
export const CHANGES_DEFAULT = 200;
export const CHANGES_MAX = 200;

async function reactionsFor(db: Db, rows: MessageRow[]): Promise<ReactionRow[]> {
  if (rows.length === 0) return [];
  return (await db.query<ReactionRow>('select message_id, person_id, emoji from reactions where message_id = any($1) order by created_at', [rows.map((m) => m.message_id)])).rows;
}

/** The rows as the app sees them, with fresh attachment links. */
export async function messagesForApp(ctx: Ctx, db: Db, rows: MessageRow[]): Promise<Message[]> {
  const reactions = await reactionsFor(db, rows);
  return freshenAttachments(ctx, db, rows.map((m) => messageForApp(m, reactions.filter((r) => r.message_id === m.message_id))));
}

export async function loadMessageForApp(ctx: Ctx, db: Db, tripId: string, messageId: string): Promise<Message> {
  const row = (await db.query<MessageRow>('select * from messages where trip_id = $1 and message_id = $2', [tripId, messageId])).rows[0];
  if (!row) throw notFound(`message ${messageId} does not exist`);
  return (await messagesForApp(ctx, db, [row]))[0]!;
}

export interface MessagesQuery {
  before_seq?: number;
  after_seq?: number;
  limit?: number;
}

export interface MessagesPage {
  messages: Message[];
  has_more: boolean;
  /** The trip's change number this page is consistent with (read in the same transaction). */
  seq: number;
}

/**
 * History mode (no cursor, or `before_seq`): the newest `limit` messages posted before the cursor, oldest first, by
 * `seq`; `has_more` says older ones exist. Changes mode (`after_seq`): the first `limit` messages posted or changed
 * after it, by `updated_seq`; `has_more` says more changes exist. Both cursors together is 422. One repeatable-read
 * transaction, so `seq` matches the page.
 */
export async function pageMessages(ctx: Ctx, tripId: string, q: MessagesQuery): Promise<MessagesPage> {
  if (q.before_seq !== undefined && q.after_seq !== undefined) throw invalid('send before_seq (history) or after_seq (changes), not both', 'after_seq');
  const changes = q.after_seq !== undefined;
  const max = changes ? CHANGES_MAX : HISTORY_MAX;
  const limit = q.limit ?? (changes ? CHANGES_DEFAULT : HISTORY_DEFAULT);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) throw invalid(`limit must be from 1 to ${max} in ${changes ? 'changes' : 'history'} mode`, 'limit');
  const db = await ctx.pool.connect();
  try {
    await db.query('begin transaction isolation level repeatable read read only');
    const trip = (await db.query('select seq from trips where trip_id = $1', [tripId])).rows[0];
    if (!trip) throw notFound(`trip ${tripId} does not exist`);
    const { rows } = changes
      ? await db.query<MessageRow>('select * from messages where trip_id = $1 and updated_seq > $2 order by updated_seq limit $3', [tripId, q.after_seq, limit + 1])
      : await db.query<MessageRow>(`select * from messages where trip_id = $1 ${q.before_seq !== undefined ? 'and seq < $3' : ''} order by seq desc limit $2`, q.before_seq !== undefined ? [tripId, limit + 1, q.before_seq] : [tripId, limit + 1]);
    const page = rows.slice(0, limit);
    if (!changes) page.reverse(); // newest `limit`, then oldest first in the page
    const messages = await messagesForApp(ctx, db, page);
    await db.query('commit');
    return { messages, has_more: rows.length > limit, seq: trip.seq as number };
  } catch (err) {
    await db.query('rollback').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}
