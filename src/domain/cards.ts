// §4.11 Go's cards outside the room: the Trip home's "Go's calls" reads them by kind and state without scanning the
// whole chat, and "Share in group chat" on an ended call puts the recording in the room without the bytes passing
// through the phone (app contract §4.11; behind features.calls).
import type { Ctx } from '../context.js';
import { newId } from '../db/ids.js';
import { once } from '../db/once.js';
import { emit, nextSeq } from '../db/write-change.js';
import { AUDIO, MAX_UPLOAD_BYTES, UPLOAD_EXPIRES_HOURS, extensionFor } from '../api/v1/uploads.js';
import { requireMember } from './actions.js';
import { STORED_LINK_TTL_SECONDS } from './attachments.js';
import { conflict, notFound, unavailable } from './errors.js';
import { messageForGo, visibleSql, type MessageRow } from './mappers.js';
import { loadMessageForApp } from './room.js';
import type { Message } from './types.js';

export const CARDS_MAX = 100;

export interface CardsQuery {
  kind?: string;
  /** A comma list: `dialing,talking`. Only cards with a `state` (call, working, pay) can match. */
  state?: string;
}

export interface CardItem { message_id: string; card: unknown; posted_at: string }

/**
 * GET /trips/:trip/cards?kind=&state=: the latest version of each card in the room (a replace_card writes the card in
 * place, so the row is always the latest), newest first, at most 100. Go's cards and the Server's own (the vote card of
 * a person-opened poll) alike; a deleted message's card is gone. A card on a message that is not for this person
 * (`visible_to_person_ids`) is not there. Cards hidden by for_person_ids/only_for_person_ids are not filtered here: the
 * app draws them as it draws the room, and `for_person_ids` is returned as stored.
 */
export async function listCards(ctx: Ctx, tripId: string, personId: string, q: CardsQuery): Promise<{ items: CardItem[] }> {
  const states = q.state ? [...new Set(q.state.split(',').map((s) => s.trim()).filter(Boolean))] : null;
  const { rows } = await ctx.pool.query(
    `select message_id, card, sent_at from messages
      where trip_id = $1 and card is not null and deleted = false and author_kind in ('go', 'system')
        and ($2::text is null or card->>'kind' = $2)
        and ($3::text[] is null or card->>'state' = any($3)) and ${visibleSql('$5')}
      order by seq desc limit $4`,
    [tripId, q.kind ?? null, states, CARDS_MAX, personId],
  );
  return { items: rows.map((r) => ({ message_id: r.message_id, card: r.card, posted_at: new Date(r.sent_at).toISOString() })) };
}

/** The recording is kept under this path; its upload row carries the audio MIME and length, so the room re-signs the link like any voice note. */
const RECORDING_LIMITS = { maxBytes: MAX_UPLOAD_BYTES, allow: (mime: string) => AUDIO.has(mime) || mime.startsWith('audio/') };

interface CallCardLike { card_id: string; kind: string; business?: string; outcome?: string; state?: string; recording_url?: string; duration_s?: number }

/**
 * POST /trips/:trip/cards/:card_id/share (201 Message): for an ended `call` card with a recording. The server copies the
 * recording from Go's link into Storage (recordings/<trip>/<card_id>.<ext>, audio only, at most 25 MB), then posts a
 * message by the caller, "Call with <business> · <outcome>", with the recording as one file attachment: a change
 * number and `message.created` to Go like any person's message. One message per card: a second share, by anyone,
 * answers the first message. 409 when the card is not an ended call with a recording.
 */
export async function shareCallRecording(ctx: Ctx, tripId: string, personId: string, cardId: string): Promise<Message> {
  await requireMember(ctx.pool, tripId, personId);
  const key = `app:share:${cardId}`;
  const shared = (await ctx.pool.query('select answer from go_requests where trip_id = $1 and request_id = $2', [tripId, key])).rows[0];
  if (shared) return loadMessageForApp(ctx, ctx.pool, tripId, (shared.answer as { message_id: string }).message_id, personId);
  const m = (await ctx.pool.query(`select card from messages where trip_id = $1 and card_id = $2 and author_kind = 'go' and deleted = false and ${visibleSql('$3')}`, [tripId, cardId, personId])).rows[0];
  if (!m) throw notFound(`card ${cardId} is not one of Go's cards in this trip`);
  const card = m.card as CallCardLike;
  if (card.kind !== 'call' || card.state !== 'ended' || !card.recording_url) throw conflict(`card ${cardId} is not an ended call with a recording`);
  // The copy happens outside the transaction (it is network work); two shares at once copy the same bytes to the same path, harmlessly.
  const path = `recordings/${tripId}/${cardId}.${extensionFor(guessMime(card.recording_url))}`;
  let copied: { mime: string; size_bytes: number };
  try {
    copied = await ctx.storage.putFromUrl(card.recording_url, path, RECORDING_LIMITS);
  } catch (err) {
    console.error(`[cards] recording of ${cardId} could not be copied`, err instanceof Error ? err.message : err); // never the link (it is signed)
    throw unavailable('the recording could not be fetched just now: try again');
  }
  const business = card.business ?? 'the business';
  const text = `Call with ${business}${card.outcome ? ` · ${card.outcome}` : ''}`.slice(0, 4000);
  const name = `${business} call.${extensionFor(copied.mime)}`;
  const made = await once(ctx.pool, tripId, key, async (db) => {
    const member = await requireMember(db, tripId, personId);
    const upload_id = newId('up');
    // The recording becomes an upload of the sharer, already used: the room mints fresh one-hour links for it on every read.
    await db.query(
      `insert into uploads (upload_id, person_id, purpose, kind, mime, name, size_bytes, duration_s, path, used_at, expires_at)
       values ($1, $2, 'chat_attachment', 'audio', $3, $4, $5, $6, $7, now(), now() + make_interval(hours => $8))
       on conflict (path) do update set used_at = now()`,
      [upload_id, personId, copied.mime, name, copied.size_bytes, card.duration_s ?? null, path, UPLOAD_EXPIRES_HOURS],
    );
    const url = await ctx.storage.signDownload(path, STORED_LINK_TTL_SECONDS);
    const attachment = { kind: 'file', url, name, mime: copied.mime, size_bytes: copied.size_bytes, ...(card.duration_s !== undefined ? { duration_s: Math.round(card.duration_s) } : {}), upload_id };
    const seq = await nextSeq(db, tripId);
    const row = (await db.query<MessageRow>(
      `insert into messages (message_id, trip_id, seq, updated_seq, author_kind, author_person_id, text, attachments, mentions_go, mentions, withheld)
       values ($1,$2,$3,$3,'person',$4,$5,$6,false,'[]',$7) returning *`,
      [newId('m'), tripId, seq, personId, text, JSON.stringify([attachment]), member.go_paused],
    )).rows[0]!;
    await emit(db, tripId, seq, 'message.created', { message: messageForGo(row, []) });
    await ctx.live.publish(tripId, { kind: 'message', message_id: row.message_id, updated_seq: seq });
    return { message_id: row.message_id };
  });
  return loadMessageForApp(ctx, ctx.pool, tripId, made.message_id, personId);
}

/** The MIME a recording link suggests by its extension, for the stored path before the bytes are fetched; the real type comes from the fetch. */
function guessMime(url: string): string {
  const ext = /\.([a-z0-9]{2,4})(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  return ({ m4a: 'audio/mp4', mp4: 'audio/mp4', mp3: 'audio/mpeg', webm: 'audio/webm', ogg: 'audio/ogg', wav: 'audio/wav', aac: 'audio/aac' } as Record<string, string>)[ext ?? ''] ?? 'audio/mp4';
}
