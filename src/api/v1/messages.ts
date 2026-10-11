// §4.6: the room. Reading messages in the two modes, posting, editing and deleting your own, your one reaction, and
// catch-up. Typing is on the live socket (§3), not here.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { deleteMessage, editMessage, postPersonMessage, setReaction } from '../../domain/actions.js';
import { catchUp } from '../../domain/ask-go.js';
import { pageMessages } from '../../domain/room.js';
import { RateLimiter } from '../rate-limit.js';
import { checkEditMessage, checkPostMessage, checkPutReaction } from '../bodies.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import { inTrip, memberFirst, withTrip, type V1Deps } from './shared.js';

/** App contract Appendix A: 20 reactions a minute per person per trip. */
export const REACTIONS_PER_MINUTE = 20;

const message = {
  message_id: 'm_01JA7R', seq: 42, updated_seq: 42, author: { kind: 'person', person_id: 'p_priya' }, text: 'in, but only after 6pm fri',
  attachments: [{ kind: 'photo', url: 'https://…/storage/v1/object/sign/go-files/…?token=…', width: 1280, height: 960, caption: 'Seats', upload_id: 'up_01JA' }],
  mentions_go: false, mentions: [], reactions: [], withheld: false, deleted: false, sent_at: '2026-10-08T07:05:00Z',
};
const refused = (status: number, code: string, msg: string, field: string | null = null) => ({ name: code, status, body: { error: { code, message: msg, field, retry_after_seconds: null, request_id: 'req_01JA7Q3V8Z' } } });

export const routes: RouteMeta[] = [
  {
    method: 'GET', path: '/app/v1/trips/:trip/messages', section: SECTIONS.messages, title: 'Read messages',
    summary: 'History mode: no cursor (the newest page) or ?before_seq=<n>, newest limit (default 50, max 100) by seq ascending, has_more = older exist. Changes mode: ?after_seq=<n>&limit= (default and max 200), updated_seq > n ascending (edits, deletes, reactions, replaced cards). Both cursors: 422. seq = the trip change number the page matches. Only the messages you can see: one of Go\'s with visible_to_person_ids not naming you is never returned (a gap in seq); author.former / reactions[].former mark people no longer in the trip.',
    example: { query: { limit: '50' }, responses: [{ name: 'page', status: 200, body: { messages: [message], has_more: true, seq: 57 } }, refused(422, 'invalid', 'send before_seq (history) or after_seq (changes), not both', 'after_seq')] },
  },
  {
    method: 'POST', path: '/app/v1/trips/:trip/messages', section: SECTIONS.messages, title: 'Post a message',
    summary: 'client_message_id (required, your id for the "sending" bubble: a repeat gets the same Message), text and/or attachments [{ upload_id, caption? } | Attachment], reply_to, about_message_id ("Ask Go about this"), mentions. Attachment links are signed, valid 1 hour. 30 a minute per person per trip (429).',
    example: { body: { client_message_id: 'cm_3f9a', text: 'in, but only after 6pm fri', attachments: [{ upload_id: 'up_01JA', caption: 'Seats' }], reply_to: 'm_0122', mentions: ['p_priya'] }, responses: [{ name: 'stored', status: 201, body: message }, refused(422, 'invalid', 'attachments[0].upload_id: up_x is not one of your uploads', 'attachments[0].upload_id')] },
  },
  {
    method: 'PATCH', path: '/app/v1/trips/:trip/messages/:id', section: SECTIONS.messages, title: 'Edit a message',
    summary: 'Edit your own message { text } (1-4000, strict). Answers the Message (edited_at set). 403 not yours, 409 deleted.',
    example: { body: { text: 'in, after 7pm fri' }, responses: [{ name: 'edited', status: 200, body: { ...message, text: 'in, after 7pm fri', updated_seq: 43, edited_at: '2026-10-08T07:06:00Z' } }] },
  },
  {
    method: 'DELETE', path: '/app/v1/trips/:trip/messages/:id', section: SECTIONS.messages, title: 'Delete a message',
    summary: 'Delete your own message. Answers the Message (deleted: true, no text, no attachments).',
    example: { responses: [{ name: 'deleted', status: 200, body: { ...message, text: undefined, attachments: [], deleted: true, updated_seq: 44 } }] },
  },
  {
    method: 'PUT', path: '/app/v1/trips/:trip/messages/:id/reaction', section: SECTIONS.messages, title: 'React',
    summary: `{ emoji | null }: your one reaction on a message. A new emoji replaces the old one (Go hears reaction.removed, then reaction.added); null takes it back. Answers the Message. ${REACTIONS_PER_MINUTE} a minute per person per trip (429).`,
    example: { body: { emoji: '🔥' }, responses: [{ name: 'reacted', status: 200, body: { ...message, updated_seq: 45, reactions: [{ emoji: '🔥', person_id: 'p_rahul' }] } }, { name: 'rate_limited', status: 429, body: { error: { code: 'rate_limited', message: `at most ${REACTIONS_PER_MINUTE} reactions a minute: slow down`, field: null, retry_after_seconds: 42, request_id: 'req_01JA7Q3V8Z' } } }] },
  },
  {
    method: 'GET', path: '/app/v1/trips/:trip/catch-up', section: SECTIONS.messages, title: 'Catch-up',
    summary: 'What you missed, from Go, when away 3 hours or with 15+ unread since your last read (?force=1 to ask anyway). 200 CatchUp, or 204 when not away long enough or Go did not answer in time.',
    example: { responses: [{ name: 'catch-up', status: 200, body: { summary: 'While you were away, Villa Sol won the vote.', items: [{ kind: 'decided', text: 'Villa Sol won, 4 to 1' }] } }, { name: 'nothing to catch up on', status: 204 }] },
  },
];

const seqParam = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;

export function register(app: FastifyInstance, ctx: Ctx, deps: V1Deps): void {
  app.get('/app/v1/trips/:trip/messages', {
    // The limit's own range depends on the mode, so the domain checks it; here only that it is a whole number.
    schema: { querystring: { type: 'object', properties: { before_seq: seqParam, after_seq: seqParam, limit: { type: 'integer', minimum: 1, maximum: 10000 } } } },
    ...inTrip(ctx, (req, trip, me) => pageMessages(ctx, trip, me, req.query)),
  });
  app.post('/app/v1/trips/:trip/messages', withTrip(ctx, (trip, me, r) => postPersonMessage(ctx, trip, me, checkPostMessage(r.body)), 201));
  app.patch('/app/v1/trips/:trip/messages/:id', withTrip(ctx, (trip, me, r) => editMessage(ctx, trip, me, r.params.id!, checkEditMessage(r.body).text)));
  app.delete('/app/v1/trips/:trip/messages/:id', withTrip(ctx, (trip, me, r) => deleteMessage(ctx, trip, me, r.params.id!)));
  const reactions = new RateLimiter(() => ctx.limits?.reactionsPerMinute ?? REACTIONS_PER_MINUTE, 60_000, { what: 'reactions' });
  app.put('/app/v1/trips/:trip/messages/:id/reaction', withTrip(ctx, (trip, me, r) => {
    const { emoji } = checkPutReaction(r.body);
    reactions.take(`${me}:${trip}`);
    return setReaction(ctx, trip, me, r.params.id!, emoji);
  }));
  app.get('/app/v1/trips/:trip/catch-up', {
    schema: { querystring: { type: 'object', properties: { force: { type: 'string', enum: ['1', '0', 'true', 'false'] } } } },
    preValidation: memberFirst(ctx), // catchUp checks again, for its read marker
    handler: async (req: any, reply) => {
      const answer = await catchUp(ctx, deps.go, req.params.trip, req.personId, req.query.force === '1' || req.query.force === 'true');
      return answer === null ? reply.code(204).send() : answer;
    },
  });
}
