// The one way the domain sends a push: it honours `Me.notifications_enabled` (the single switch, app contract §8), looks
// up the trip's title for the payload and hands the finished payload to the sender. A person with the switch off, or a
// deleted account, gets nothing from here; the Web Push sender checks the switch again at delivery for callers that
// still use the legacy shape.
import type { Ctx } from '../context.js';
import { pushPayload, type PushType } from './push.js';

export interface SendPushInput {
  type: PushType;
  body: string;
  message_id?: string;
  /** The thing the push is about when there is no message (a vote, a payee, a joiner): part of the tag. */
  id?: string;
}

/** People among `personIds` who may be pushed: notifications on, account not deleted. */
export async function pushablePeople(ctx: Ctx, personIds: string[]): Promise<string[]> {
  const wanted = [...new Set(personIds)];
  if (wanted.length === 0) return [];
  const { rows } = await ctx.pool.query('select person_id from people where person_id = any($1) and notifications_enabled and deleted_at is null', [wanted]);
  const allowed = new Set(rows.map((r) => r.person_id as string));
  return wanted.filter((id) => allowed.has(id));
}

export async function sendPush(ctx: Ctx, tripId: string, personIds: string[], input: SendPushInput): Promise<void> {
  const to = await pushablePeople(ctx, personIds);
  if (to.length === 0) return;
  const title = ((await ctx.pool.query('select title from trips where trip_id = $1', [tripId])).rows[0]?.title as string | undefined) ?? 'Go';
  await ctx.push.send(to, pushPayload({ type: input.type, trip_id: tripId, title, body: input.body, message_id: input.message_id, id: input.id }));
}
