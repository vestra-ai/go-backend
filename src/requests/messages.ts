import type { Ctx } from '../context.js';
import { newId } from '../db/ids.js';
import { once } from '../db/once.js';
import { withTx } from '../db/pool.js';
import { nextSeq, emit } from '../db/write-change.js';
import { noteCheckinSignal } from '../domain/checkin.js';
import { conflict, invalid, notFound } from '../domain/errors.js';
import { messageForGo } from '../domain/mappers.js';
import type { MessageRow } from '../domain/mappers.js';
import { sendPush } from '../push/send.js';
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
    // Quick replies (GO-CHANGES 1.3) are kept as they arrived too, and go back to the app and to Go unchanged.
    const row = (await db.query<MessageRow>(
      `insert into messages (message_id, trip_id, seq, updated_seq, author_kind, text, reply_to, mentions_go, mentions, card, card_id, quick_replies)
       values ($1, $2, $3, $3, 'go', $4, $5, false, $6, $7, $8, $9) returning *`,
      [newId('m'), trip.trip_id, seq, p.text ?? null, p.reply_to ?? null, JSON.stringify(mentions), card ? JSON.stringify(card) : null, card?.card_id ?? null,
       Array.isArray(raw.quick_replies) && raw.quick_replies.length ? JSON.stringify(raw.quick_replies) : null],
    )).rows[0]!;
    await emit(db, trip.trip_id, seq, 'message.created', { message: messageForGo(row, []) });

    after(async () => {
      await ctx.live.publish(trip.trip_id, { kind: 'message', message_id: row.message_id, updated_seq: seq });
      await ctx.live.publish(trip.trip_id, { kind: 'typing', who: { kind: 'go' }, on: false });
      // A notice card linking go://…/checkin/<booking> is Go saying "check-in is open" (§4.12): those people get the `checkin` push instead of the card's.
      const opened = card ? await noteCheckinSignal(ctx, trip.trip_id, card) : [];
      // People Go names get Go's text (`mention`). People a new card needs get its fallback_text (`card`). Once each.
      if (mentions.length) await sendPush(ctx, trip.trip_id, mentions, { type: 'mention', body: p.text ?? card?.fallback_text ?? '', message_id: row.message_id });
      const needed = (card?.for_person_ids ?? []).filter((id) => !mentions.includes(id) && !opened.includes(id));
      if (card && needed.length) {
        const inTrip = await ctx.pool.query('select person_id from trip_people where trip_id = $1 and left_at is null and person_id = any($2)', [trip.trip_id, needed]);
        await sendPush(ctx, trip.trip_id, inTrip.rows.map((r) => r.person_id), { type: 'card', body: card.fallback_text, message_id: row.message_id });
      }
    });
    return { message_id: row.message_id, seq };
  });

/**
 * Replaces a card in place. No event and no push, as the contract says; but the message does take the trip's next change
 * number as its `updated_seq` (decision D9, GO-CHANGES clarification 2), so a phone that was offline finds the replaced
 * card with `GET …/messages?after_seq=`. The live `card` frame itself carries no seq. Safe to repeat.
 */
export const replaceCard = (ctx: Ctx) => async (p: { trip_id: string }, raw: Record<string, unknown>) =>
  withTx(ctx.pool, async (db, after) => {
    await tripOf(db, p.trip_id);
    const card = raw.card as RawCard;
    const found = await db.query('select message_id from messages where trip_id = $1 and card_id = $2 and author_kind = $3 for update', [p.trip_id, card.card_id, 'go']);
    if (!found.rows[0]) throw notFound(`card ${card.card_id} is not on one of Go's messages in trip ${p.trip_id}`);
    const seq = await nextSeq(db, p.trip_id);
    await db.query('update messages set card = $2, updated_seq = $3 where message_id = $1', [found.rows[0].message_id, JSON.stringify(card), seq]);
    const message_id = found.rows[0].message_id as string;
    after(() => ctx.live.publish(p.trip_id, { kind: 'card', message_id }));
    after(async () => void (await noteCheckinSignal(ctx, p.trip_id, card))); // a notice replaced into the "check-in is open" signal counts too
    return { message_id };
  });

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
