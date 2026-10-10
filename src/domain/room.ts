// Reading the room for the app (app contract §4.6): one message by id, and the two paging modes of
// GET /trips/:trip/messages. Every attachment link is signed again on the way out (src/domain/attachments.ts).
// Every read is for one person: a message whose `visible_to_person_ids` does not name them is not there at all.
import type { Db } from '../db/pool.js';
import type { Ctx } from '../context.js';
import { freshenAttachments } from './attachments.js';
import { invalid, notFound } from './errors.js';
import { messageForApp, visibleSql, visibleTo } from './mappers.js';
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

/**
 * Of the people who wrote these messages or reacted to them, the ones no longer in the trip: they left it, or deleted their
 * account. One query for the whole page.
 */
async function formerIn(db: Db, rows: MessageRow[], reactions: ReactionRow[]): Promise<Set<string>> {
  const tripOf = new Map(rows.map((m) => [m.message_id, m.trip_id]));
  const pairs = new Map<string, [trip: string, person: string]>();
  for (const m of rows) if (m.author_person_id) pairs.set(`${m.trip_id}:${m.author_person_id}`, [m.trip_id, m.author_person_id]);
  for (const r of reactions) if (r.person_id) pairs.set(`${tripOf.get(r.message_id)}:${r.person_id}`, [tripOf.get(r.message_id)!, r.person_id]);
  if (pairs.size === 0) return new Set();
  const list = [...pairs.values()];
  const { rows: active } = await db.query(
    `select tp.trip_id, tp.person_id from trip_people tp join people p using (person_id)
      where tp.left_at is null and p.deleted_at is null and (tp.trip_id, tp.person_id) in (select * from unnest($1::text[], $2::text[]))`,
    [list.map(([t]) => t), list.map(([, p]) => p)],
  );
  const here = new Set(active.map((r) => `${r.trip_id}:${r.person_id}`));
  // Rows of one call are from one trip (a page, a replay, one message), so a set of person ids is enough for the mapper.
  return new Set(list.filter(([t, p]) => !here.has(`${t}:${p}`)).map(([, p]) => p));
}

/** The rows as the app sees them, with fresh attachment links and former members marked. The caller has already left out what the reader may not see. */
export async function messagesForApp(ctx: Ctx, db: Db, rows: MessageRow[]): Promise<Message[]> {
  const reactions = await reactionsFor(db, rows);
  const former = await formerIn(db, rows, reactions);
  return freshenAttachments(ctx, db, rows.map((m) => messageForApp(m, reactions.filter((r) => r.message_id === m.message_id), former)));
}

/** One message as this person may see it: 404 when it does not exist, and when it is not for them. */
export async function loadMessageForApp(ctx: Ctx, db: Db, tripId: string, messageId: string, personId: string): Promise<Message> {
  const row = (await db.query<MessageRow>('select * from messages where trip_id = $1 and message_id = $2', [tripId, messageId])).rows[0];
  if (!row || !visibleTo(row, personId)) throw notFound(`message ${messageId} does not exist`);
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
 * transaction, so `seq` matches the page. Only the messages this person may see count, for the page and for `has_more`.
 */
export async function pageMessages(ctx: Ctx, tripId: string, personId: string, q: MessagesQuery): Promise<MessagesPage> {
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
      ? await db.query<MessageRow>(`select * from messages where trip_id = $1 and updated_seq > $2 and ${visibleSql('$4')} order by updated_seq limit $3`, [tripId, q.after_seq, limit + 1, personId])
      : await db.query<MessageRow>(
        `select * from messages where trip_id = $1 and ${visibleSql('$3')} ${q.before_seq !== undefined ? 'and seq < $4' : ''} order by seq desc limit $2`,
        q.before_seq !== undefined ? [tripId, limit + 1, personId, q.before_seq] : [tripId, limit + 1, personId],
      );
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
