import type { Ctx } from '../context.js';
import { newId } from '../db/ids.js';
import { once } from '../db/once.js';
import { withTx } from '../db/pool.js';
import { nextSeq, emit } from '../db/write-change.js';
import { publishHome, publishHomeAll } from '../domain/actions.js';
import { noteCheckinSignal } from '../domain/checkin.js';
import { isDemoPaid } from '../domain/demo-payment.js';
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

/**
 * `home_changed` for the people a card puts on (or takes off) their home's open items: the ones it names in
 * `for_person_ids`, before and after a replace. A vote or mandate card tells everyone: the open item now has its card.
 * So does an options card that carries a vote (1.3): it is that vote's card, and "see more" moves the item to the newer one.
 */
async function cardMovedHome(ctx: Ctx, db: import('pg').PoolClient, tripId: string, cards: Array<RawCard | null | undefined>): Promise<void> {
  if (cards.some((c) => c?.kind === 'vote' || c?.kind === 'mandate' || (c?.kind === 'options' && typeof c.decision_id === 'string'))) return publishHomeAll(ctx, tripId, db);
  const named = cards.flatMap((c) => (Array.isArray(c?.for_person_ids) ? c.for_person_ids : []));
  if (named.length) await publishHome(ctx, tripId, named);
}

export const postMessage = (ctx: Ctx) => async (p: any, raw: Record<string, unknown>) =>
  once(ctx.pool, p.trip_id, p.request_id, async (db, after) => {
    const trip = await tripOf(db, p.trip_id);
    if (!p.text && !p.card) throw invalid('text or card is required');
    const mentions: string[] = [...new Set<string>(p.mentions ?? [])];
    await assertPeopleInTrip(db, trip.trip_id, mentions, 'mentions');
    await assertMessagesInTrip(db, trip.trip_id, [p.reply_to], 'reply_to');
    // Official since 1.2: a message only these people see in the app (1 to 30 ids, checked with the params), each in the trip now.
    // 1.2 does not ask the ids to be unique, so a repeat is stored once.
    const visibleTo: string[] | null = p.visible_to_person_ids ? [...new Set<string>(p.visible_to_person_ids)] : null;
    if (visibleTo) await assertPeopleInTrip(db, trip.trip_id, visibleTo, 'visible_to_person_ids');

    // The card goes in as one JSON value, exactly as it arrived (raw.card), never rebuilt from the checked params.
    const card = (raw.card ?? null) as RawCard | null;
    if (card) {
      for (const [key, table, column] of RECORD_CARD_IDS) {
        const id = card[key];
        if (typeof id !== 'string') continue;
        const found = await db.query(`select 1 from ${table} where trip_id = $1 and ${column} = $2`, [trip.trip_id, id]);
        if (found.rowCount === 0) throw invalid(`card.${key}: ${id} is not in trip ${trip.trip_id}`);
      }
      // 1.3 (rev 5 A): an options card that carries a vote shows Vote buttons, so the vote must be one people can vote in.
      if (card.kind === 'options' && typeof card.decision_id === 'string') {
        // The vote's row is held to the end of this post, so it cannot close between this check and the card going in.
        const d = await db.query('select status from decisions where trip_id = $1 and decision_id = $2 for share', [trip.trip_id, card.decision_id]);
        if (d.rows[0].status !== 'open') throw invalid(`card.decision_id: vote ${card.decision_id} is ${d.rows[0].status}, not open`);
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
      `insert into messages (message_id, trip_id, seq, updated_seq, author_kind, text, reply_to, mentions_go, mentions, card, card_id, quick_replies, visible_to_person_ids)
       values ($1, $2, $3, $3, 'go', $4, $5, false, $6, $7, $8, $9, $10) returning *`,
      [newId('m'), trip.trip_id, seq, p.text ?? null, p.reply_to ?? null, JSON.stringify(mentions), card ? JSON.stringify(card) : null, card?.card_id ?? null,
       Array.isArray(raw.quick_replies) && raw.quick_replies.length ? JSON.stringify(raw.quick_replies) : null, visibleTo ? JSON.stringify(visibleTo) : null],
    )).rows[0]!;
    await emit(db, trip.trip_id, seq, 'message.created', { message: messageForGo(row, []) });

    // Live notices go out with the transaction, at the commit and in commit order.
    await ctx.live.publish(trip.trip_id, { kind: 'message', message_id: row.message_id, updated_seq: seq });
    await ctx.live.publish(trip.trip_id, { kind: 'typing', who: { kind: 'go' }, on: false });
    if (card) await cardMovedHome(ctx, db, trip.trip_id, [card]);
    // A notice card linking go://…/checkin/<booking> is Go saying "check-in is open" (§4.12): its own database work, after the commit.
    if (card) after(async () => void (await noteCheckinSignal(ctx, trip.trip_id, card)));
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
    const found = await db.query('select message_id, card from messages where trip_id = $1 and card_id = $2 and author_kind = $3 for update', [p.trip_id, card.card_id, 'go']);
    if (!found.rows[0]) throw notFound(`card ${card.card_id} is not on one of Go's messages in trip ${p.trip_id}`);
    // A pay card the Server took as paid (the demo's payment) stays paid: Go may add to it, never expire, fail or decline it.
    if ((card as { state?: string }).state !== 'paid' && await isDemoPaid(db, p.trip_id, card.card_id)) throw conflict(`card ${card.card_id} is paid: it can only be replaced with state "paid"`);
    const seq = await nextSeq(db, p.trip_id);
    await db.query('update messages set card = $2, updated_seq = $3 where message_id = $1', [found.rows[0].message_id, JSON.stringify(card), seq]);
    // What was kept about the old card's options (rev 5 E) is not about this card: Details asks Go afresh.
    await db.query('delete from option_details where trip_id = $1 and card_id = $2', [p.trip_id, card.card_id]);
    const message_id = found.rows[0].message_id as string;
    await ctx.live.publish(p.trip_id, { kind: 'card', message_id });
    // And the message as it now stands, at its new seq: an earlier notice for this message that finds it already moved
    // sends nothing (src/live/ws.ts), so this one carries whatever that earlier change was (a reaction, say).
    await ctx.live.publish(p.trip_id, { kind: 'message', message_id, updated_seq: seq });
    await cardMovedHome(ctx, db, p.trip_id, [found.rows[0].card as RawCard, card]); // named before or after the replace
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
