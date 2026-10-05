import type { Ctx } from '../context.js';
import { once } from '../db/once.js';
import { nextSeq, emit } from '../db/write-change.js';
import { conflict, notFound } from '../domain/errors.js';
import { tripOf } from './guards.js';

async function messageOf(db: import('pg').PoolClient, tripId: string, messageId: string) {
  const { rows } = await db.query('select message_id, deleted from messages where trip_id = $1 and message_id = $2', [tripId, messageId]);
  if (!rows[0]) throw notFound(`message ${messageId} does not exist in trip ${tripId}`);
  return rows[0] as { message_id: string; deleted: boolean };
}

export const addReaction = (ctx: Ctx) => async (p: { request_id: string; trip_id: string; message_id: string; emoji: string }) =>
  once(ctx.pool, p.trip_id, p.request_id, async (db, after) => {
    await tripOf(db, p.trip_id);
    const message = await messageOf(db, p.trip_id, p.message_id);
    if (message.deleted) throw conflict(`message ${p.message_id} is deleted`);
    const have = await db.query('select 1 from reactions where message_id = $1 and person_id is null and emoji = $2', [p.message_id, p.emoji]);
    if (have.rowCount) throw conflict(`Go already reacted with ${p.emoji} to ${p.message_id}`);
    const seq = await nextSeq(db, p.trip_id);
    await db.query('insert into reactions (trip_id, message_id, person_id, emoji) values ($1, $2, null, $3)', [p.trip_id, p.message_id, p.emoji]);
    await db.query('update messages set updated_seq = $1 where message_id = $2', [seq, p.message_id]);
    // A reaction Go made has no person_id, because no person made it. No push.
    await emit(db, p.trip_id, seq, 'reaction.added', { message_id: p.message_id, reaction: { emoji: p.emoji } });
    after(() => ctx.live.publish(p.trip_id, { kind: 'message', message_id: p.message_id, updated_seq: seq }));
    return { seq };
  });

export const removeReaction = (ctx: Ctx) => async (p: { request_id: string; trip_id: string; message_id: string; emoji: string }) =>
  once(ctx.pool, p.trip_id, p.request_id, async (db, after) => {
    await tripOf(db, p.trip_id);
    await messageOf(db, p.trip_id, p.message_id);
    const gone = await db.query('delete from reactions where message_id = $1 and person_id is null and emoji = $2', [p.message_id, p.emoji]);
    if (!gone.rowCount) throw conflict(`Go has no ${p.emoji} reaction on ${p.message_id}`);
    const seq = await nextSeq(db, p.trip_id);
    await db.query('update messages set updated_seq = $1 where message_id = $2', [seq, p.message_id]);
    await emit(db, p.trip_id, seq, 'reaction.removed', { message_id: p.message_id, reaction: { emoji: p.emoji } });
    after(() => ctx.live.publish(p.trip_id, { kind: 'message', message_id: p.message_id, updated_seq: seq }));
    return { seq };
  });
