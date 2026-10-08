import type { Ctx } from '../context.js';
import { MAX_FRAME_BYTES } from '../contract/index.js';
import { freshenAttachments } from '../domain/attachments.js';
import { messageForGo } from '../domain/mappers.js';
import type { MessageRow, ReactionRow } from '../domain/mappers.js';
import { readSnapshot } from '../domain/snapshot.js';
import type { Message } from '../domain/types.js';
import { tripOf } from './guards.js';

/** Room for the frame's own envelope: the page stays well under the 1 MB limit. */
const PAGE_BYTES_BUDGET = MAX_FRAME_BYTES - 64 * 1024;

export const readTrip = (ctx: Ctx) => async (p: { trip_id: string }) => readSnapshot(ctx.pool, p.trip_id, ctx.publicBaseUrl);

export const readMessages = (ctx: Ctx) => async (p: { trip_id: string; after_seq: number; limit?: number }) => {
  await tripOf(ctx.pool, p.trip_id);
  const limit = p.limit ?? 200;
  // One extra row tells us whether there are more.
  const { rows } = await ctx.pool.query<MessageRow>(
    'select * from messages where trip_id = $1 and updated_seq > $2 order by updated_seq limit $3',
    [p.trip_id, p.after_seq, limit + 1],
  );
  let hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const reactions = page.length
    ? (await ctx.pool.query<ReactionRow>('select message_id, person_id, emoji from reactions where message_id = any($1) order by created_at', [page.map((m) => m.message_id)])).rows
    : [];
  // Attachment links are signed again for Go too: the one written at post time may have run out by now.
  const fresh = await freshenAttachments(ctx, ctx.pool, page.map((row) => messageForGo(row, reactions.filter((r) => r.message_id === row.message_id))));
  const messages: Message[] = [];
  let bytes = 0;
  for (const message of fresh) {
    const size = Buffer.byteLength(JSON.stringify(message));
    // Fewer messages with has_more when 200 would not fit in a frame. Always send at least one.
    if (messages.length > 0 && bytes + size > PAGE_BYTES_BUDGET) {
      hasMore = true;
      break;
    }
    bytes += size;
    messages.push(message);
  }
  return { messages, has_more: hasMore };
};
