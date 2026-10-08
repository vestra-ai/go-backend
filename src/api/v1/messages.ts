// §4.6: the room. Reading and posting messages, editing and deleting your own, reactions, typing, and catch-up.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { deleteMessage, editMessage, postPersonMessage, reactTo } from '../../domain/actions.js';
import { catchUp } from '../../domain/ask-go.js';
import type { MessageRow, ReactionRow } from '../../domain/mappers.js';
import { messageForApp } from '../../domain/mappers.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import { body, bool, id, inTrip, requirePressKey, str, withTrip, type V1Deps } from './shared.js';

export const routes: RouteMeta[] = [
  { method: 'GET', path: '/app/v1/trips/:trip/messages', section: SECTIONS.messages, title: 'Read messages', summary: 'Messages posted or changed after a change number (?after_seq=&limit=), oldest change first, with has_more.' },
  { method: 'POST', path: '/app/v1/trips/:trip/messages', section: SECTIONS.messages, title: 'Post a message', summary: 'text and/or attachments; reply_to, about_message_id ("Ask Go about this"), mentions. client_id or an Idempotency-Key makes a retry safe.' },
  { method: 'PATCH', path: '/app/v1/trips/:trip/messages/:id', section: SECTIONS.messages, title: 'Edit a message', summary: 'Edit your own message { text }. 403 not yours, 409 deleted.' },
  { method: 'DELETE', path: '/app/v1/trips/:trip/messages/:id', section: SECTIONS.messages, title: 'Delete a message', summary: 'Delete your own message.' },
  { method: 'POST', path: '/app/v1/trips/:trip/messages/:id/reactions', section: SECTIONS.messages, title: 'Add a reaction', summary: '{ emoji }: your reaction on a message (seq null when you already had it).' },
  { method: 'DELETE', path: '/app/v1/trips/:trip/messages/:id/reactions/:emoji', section: SECTIONS.messages, title: 'Remove a reaction', summary: 'Takes your reaction back; :emoji URL-encoded.' },
  { method: 'POST', path: '/app/v1/trips/:trip/typing', section: SECTIONS.messages, title: 'Typing', summary: '{ on }: shows "<you> is typing" to the room for 5 s. Never sent to Go.' },
  { method: 'GET', path: '/app/v1/trips/:trip/catch-up', section: SECTIONS.messages, title: 'Catch-up', summary: 'What the person missed, when away 3 hours or 15+ unread (?force=1 to ask anyway). { needed: false } otherwise.' },
];

export function register(app: FastifyInstance, ctx: Ctx, deps: V1Deps): void {
  app.get('/app/v1/trips/:trip/messages', {
    schema: { querystring: { type: 'object', properties: { after_seq: { type: 'integer', minimum: 0, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 } } } },
    ...inTrip(ctx, async (req, trip) => {
      const { after_seq: after, limit } = req.query as { after_seq: number; limit: number };
      const { rows } = await ctx.pool.query<MessageRow>('select * from messages where trip_id = $1 and updated_seq > $2 order by updated_seq limit $3', [trip, after, limit + 1]);
      const page = rows.slice(0, limit);
      const reactions = page.length ? (await ctx.pool.query<ReactionRow>('select message_id, person_id, emoji from reactions where message_id = any($1) order by created_at', [page.map((m) => m.message_id)])).rows : [];
      return { messages: page.map((m) => messageForApp(m, reactions.filter((r) => r.message_id === m.message_id))), has_more: rows.length > limit };
    }),
  });
  app.post('/app/v1/trips/:trip/messages', {
    ...body({
      client_id: id,
      text: str,
      attachments: { type: 'array', maxItems: 10, items: { type: 'object' } },
      reply_to: id,
      about_message_id: id,
      mentions: { type: 'array', maxItems: 30, items: id },
    }),
    ...inTrip(ctx, (req, trip, me) => (requirePressKey(req), postPersonMessage(ctx, trip, me, req.body))),
  });
  app.patch('/app/v1/trips/:trip/messages/:id', { ...body({ text: str }, ['text']), ...withTrip((trip, me, r) => editMessage(ctx, trip, me, r.params.id!, r.body.text)) });
  app.delete('/app/v1/trips/:trip/messages/:id', withTrip((trip, me, r) => deleteMessage(ctx, trip, me, r.params.id!)));
  app.post('/app/v1/trips/:trip/messages/:id/reactions', {
    ...body({ emoji: { type: 'string', minLength: 1, maxLength: 16 } }, ['emoji']),
    ...withTrip((trip, me, r) => reactTo(ctx, trip, me, r.params.id!, r.body.emoji, true)),
  });
  app.delete('/app/v1/trips/:trip/messages/:id/reactions/:emoji', {
    schema: { params: { type: 'object', properties: { emoji: { type: 'string', minLength: 1, maxLength: 16 } } } },
    ...withTrip((trip, me, r) => reactTo(ctx, trip, me, r.params.id!, decodeURIComponent(r.params.emoji!), false)),
  });
  /** People's typing is between the app and the Server only: Go does not need it. */
  app.post('/app/v1/trips/:trip/typing', {
    ...body({ on: bool }, ['on']),
    ...inTrip(ctx, async (req, trip, me) => {
      const on: boolean = req.body.on;
      await ctx.live.publish(trip, { kind: 'typing', who: { kind: 'person', person_id: me }, on, ...(on ? { until: new Date(Date.now() + 5_000).toISOString() } : {}) });
      return { ok: true };
    }),
  });
  app.get('/app/v1/trips/:trip/catch-up', {
    schema: { querystring: { type: 'object', properties: { force: { type: 'string', enum: ['1', '0', 'true', 'false'] } } } },
    ...inTrip(ctx, (req, trip, me) => catchUp(ctx, deps.go, trip, me, req.query.force === '1' || req.query.force === 'true')),
  });
}
