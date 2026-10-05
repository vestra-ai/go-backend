import type { Ctx } from '../context.js';
import { newId } from '../db/ids.js';
import { once } from '../db/once.js';
import { nextSeq, emit } from '../db/write-change.js';
import { conflict, invalid, notFound } from '../domain/errors.js';
import { messageForGo } from '../domain/mappers.js';
import type { MessageRow } from '../domain/mappers.js';
import { assertMessagesInTrip, assertPeopleInTrip, tripOf } from './guards.js';

/** A card id from Go's card, for the record cards that are drawn from our own rows. */
const RECORD_CARD_IDS: Array<[key: string, table: string, column: string]> = [
  ['decision_id', 'decisions', 'decision_id'],
  ['booking_id', 'bookings', 'booking_id'],
  ['expense_id', 'expenses', 'expense_id'],
];

type RawCard = Record<string, unknown> & { card_id: string; kind: string; fallback_text: string; for_person_ids?: string[] };

export const postMessage = (ctx: Ctx) => async (p: any, raw: Record<string, unknown>) =>
  once(ctx.pool, p.trip_id, p.request_id, async (db, after) => {
    const trip = await tripOf(db, p.trip_id);
    if (!p.text && !p.card) throw invalid('text or card is required');
    const mentions: string[] = [...new Set<string>(p.mentions ?? [])];
    await assertPeopleInTrip(db, trip.trip_id, mentions, 'mentions');
    await assertMessagesInTrip(db, trip.trip_id, [p.reply_to], 'reply_to');

    // The card goes in as one JSON value, exactly as it arrived (raw.card), never rebuilt from the checked params.
    const card = (raw.card ?? null) as RawCard | null;
    if (card) {
      for (const [key, table, column] of RECORD_CARD_IDS) {
        const id = card[key];
        if (typeof id !== 'string') continue;
        const found = await db.query(`select 1 from ${table} where trip_id = $1 and ${column} = $2`, [trip.trip_id, id]);
        if (found.rowCount === 0) throw invalid(`card.${key}: ${id} is not in trip ${trip.trip_id}`);
      }
      if (card.kind === 'mandate') {
        const d = await db.query('select mandate from decisions where trip_id = $1 and decision_id = $2', [trip.trip_id, card.decision_id]);
        if (!d.rows[0]?.mandate) throw conflict(`decision ${card.decision_id} has no mandate`);
      }
      const dup = await db.query('select 1 from messages where trip_id = $1 and card_id = $2', [trip.trip_id, card.card_id]);
      if (dup.rowCount) throw conflict(`card ${card.card_id} is already in the room: use replace_card to change it`);
    }

    const seq = await nextSeq(db, trip.trip_id);
    const row = (await db.query<MessageRow>(
      `insert into messages (message_id, trip_id, seq, updated_seq, author_kind, text, reply_to, mentions_go, mentions, card, card_id)
       values ($1, $2, $3, $3, 'go', $4, $5, false, $6, $7, $8) returning *`,
      [newId('m'), trip.trip_id, seq, p.text ?? null, p.reply_to ?? null, JSON.stringify(mentions), card ? JSON.stringify(card) : null, card?.card_id ?? null],
    )).rows[0]!;
    await emit(db, trip.trip_id, seq, 'message.created', { message: messageForGo(row, []) });

    after(async () => {
      await ctx.live.publish(trip.trip_id, { kind: 'message', message_id: row.message_id, updated_seq: seq });
      await ctx.live.publish(trip.trip_id, { kind: 'typing', who: { kind: 'go' }, on: false });
      // People Go names get Go's text. People a new card needs get its fallback_text. Once each.
      if (mentions.length) await ctx.push.send(mentions, { body: p.text ?? card?.fallback_text ?? '', data: { trip_id: trip.trip_id, message_id: row.message_id } });
      const needed = (card?.for_person_ids ?? []).filter((id) => !mentions.includes(id));
      if (card && needed.length) {
        const inTrip = await ctx.pool.query('select person_id from trip_people where trip_id = $1 and left_at is null and person_id = any($2)', [trip.trip_id, needed]);
        await ctx.push.send(inTrip.rows.map((r) => r.person_id), { body: card.fallback_text, data: { trip_id: trip.trip_id, message_id: row.message_id } });
      }
    });
    return { message_id: row.message_id, seq };
  });

/** Not a change to the trip: no change number, no event, no push. Safe to repeat. */
export const replaceCard = (ctx: Ctx) => async (p: { trip_id: string }, raw: Record<string, unknown>) => {
  await tripOf(ctx.pool, p.trip_id);
  const card = raw.card as RawCard;
  const { rows } = await ctx.pool.query(
    `update messages set card = $3 where trip_id = $1 and card_id = $2 and author_kind = 'go' returning message_id, updated_seq`,
    [p.trip_id, card.card_id, JSON.stringify(card)],
  );
  if (!rows[0]) throw notFound(`card ${card.card_id} is not on one of Go's messages in trip ${p.trip_id}`);
  await ctx.live.publish(p.trip_id, { kind: 'message', message_id: rows[0].message_id, updated_seq: rows[0].updated_seq });
  return { message_id: rows[0].message_id as string };
};

/** A notification: never answered. Shows or hides "Go is typing..." for everyone in the room. */
export const typing = (ctx: Ctx) => async (p: { trip_id: string; on: boolean }) => {
  const found = await ctx.pool.query('select 1 from trips where trip_id = $1', [p.trip_id]);
  if (found.rowCount === 0) return void console.warn(`typing dropped: trip ${p.trip_id} does not exist`);
  await ctx.live.publish(p.trip_id, {
    kind: 'typing',
    who: { kind: 'go' },
    on: p.on,
    ...(p.on ? { until: new Date(Date.now() + 10_000).toISOString() } : {}),
  });
};
