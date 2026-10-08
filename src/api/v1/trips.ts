// §4.4: trips, the person's own answers in a trip, reading, leaving; and (§3, until the WebSocket lands) the live stream.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Ctx } from '../../context.js';
import { createTrip, leaveTrip, markSeen, requireMember, setGoPaused } from '../../domain/actions.js';
import { getMyTripAnswers, setMyBudget, updateMyTripAnswers, updateTripDetails } from '../../domain/person-edits.js';
import { readSnapshotForApp } from '../../domain/snapshot.js';
import type { MessageRow, ReactionRow } from '../../domain/mappers.js';
import { messageForApp } from '../../domain/mappers.js';
import type { LiveEvent } from '../../live/live.js';
import { checkPatchTrip, checkPatchTripMe, checkPutBudget } from '../bodies.js';
import { corsHeaders } from '../cors.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import { atLeastOneField, body, bool, inTrip, type V1Deps } from './shared.js';

export const routes: RouteMeta[] = [
  { method: 'POST', path: '/app/v1/trips', section: SECTIONS.trips, title: 'Create a trip', summary: 'Creates a trip with you as organizer; Go is told and greets the room. Answers trip_id and the invite link.' },
  { method: 'GET', path: '/app/v1/trips/:trip', section: SECTIONS.trips, title: 'Read a trip', summary: 'The whole trip for the Trip screens (a contract TripSnapshot plus cancels_booking_id on cancellation votes).' },
  { method: 'PATCH', path: '/app/v1/trips/:trip', section: SECTIONS.trips, title: 'Edit the trip', summary: 'Any member changes title, dates, status or the whole itinerary. Strict body, at least one field.' },
  { method: 'GET', path: '/app/v1/trips/:trip/me', section: SECTIONS.trips, title: 'My answers', summary: 'Your join answers, your own budget answer, your role and whether Go is paused for you.' },
  { method: 'PUT', path: '/app/v1/trips/:trip/me/join-answers', section: SECTIONS.trips, title: 'Edit my answers', summary: 'from_city, earliest_leave (null clears), know ([] clears). Go hears only what differs, in this trip.' },
  { method: 'PUT', path: '/app/v1/trips/:trip/me/budget', section: SECTIONS.trips, title: 'Set my budget', summary: 'Your private budget answer { min_minor, max_minor? }. Go learns only that the band moved.' },
  { method: 'PATCH', path: '/app/v1/trips/:trip/me', section: SECTIONS.trips, title: 'Pause Go', summary: '{ go_paused: true|false }: while paused your messages reach Go with no words.' },
  { method: 'POST', path: '/app/v1/trips/:trip/leave', section: SECTIONS.trips, title: 'Leave the trip', summary: 'Leaves the trip; a vote waiting only for you closes.' },
  { method: 'POST', path: '/app/v1/trips/:trip/read', section: SECTIONS.trips, title: 'Mark as read', summary: 'Call when the room is opened or left ({ up_to_seq? }). Feeds catch-up.' },
  { method: 'GET', path: '/app/v1/trips/:trip/live', section: SECTIONS.live, title: 'Live stream (SSE)', summary: 'Server-sent events for one trip: hello, message, trip, typing. Replaced by the WebSocket in phase 2.' },
];

export function register(app: FastifyInstance, ctx: Ctx, deps: V1Deps): void {
  app.post('/app/v1/trips', { schema: { body: { type: 'object', required: ['title'], properties: { title: { type: 'string', minLength: 1, maxLength: 80 } } } } },
    async (req, reply) => reply.code(201).send(await createTrip(ctx, req.personId, req.body as any)));

  app.get('/app/v1/trips/:trip', inTrip(ctx, (_req, trip) => readSnapshotForApp(ctx.pool, trip, ctx.publicBaseUrl)));
  app.patch('/app/v1/trips/:trip', inTrip(ctx, (req, trip, me) => {
    const input = checkPatchTrip(req.body);
    atLeastOneField(input);
    return updateTripDetails(ctx, trip, me, input);
  }));

  app.get('/app/v1/trips/:trip/me', inTrip(ctx, (_req, trip, me) => getMyTripAnswers(ctx, trip, me)));
  app.put('/app/v1/trips/:trip/me/join-answers', inTrip(ctx, (req, trip, me) => {
    const input = checkPatchTripMe(req.body);
    atLeastOneField(input);
    return updateMyTripAnswers(ctx, trip, me, input);
  }));
  app.put('/app/v1/trips/:trip/me/budget', inTrip(ctx, (req, trip, me) => setMyBudget(ctx, trip, me, checkPutBudget(req.body))));
  app.patch('/app/v1/trips/:trip/me', { ...body({ go_paused: bool }, ['go_paused']), ...inTrip(ctx, (req, trip, me) => setGoPaused(ctx, trip, me, req.body.go_paused)) });

  app.post('/app/v1/trips/:trip/leave', inTrip(ctx, (_r, trip, me) => leaveTrip(ctx, trip, me)));
  app.post('/app/v1/trips/:trip/read', {
    ...body({ up_to_seq: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } }),
    ...inTrip(ctx, async (req, trip, me) => (await markSeen(ctx, trip, me, req.body.up_to_seq), { ok: true })),
  });

  // ---- the live connection (server-sent events): messages, reactions, typing, "the trip changed"
  app.get('/app/v1/trips/:trip/live', async (req: any, reply: FastifyReply) => {
    const tripId: string = req.params.trip;
    await requireMember(ctx.pool, tripId, req.personId);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-request-id': req.id, ...corsHeaders(deps.origins, req.headers.origin) });
    const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    send('hello', { trip_id: tripId });
    const unsubscribe = ctx.live.subscribe(async (id: string, e: LiveEvent) => {
      if (id !== tripId) return;
      try {
        if (e.kind === 'message') {
          const m = (await ctx.pool.query<MessageRow>('select * from messages where message_id = $1', [e.message_id])).rows[0];
          if (!m) return;
          const r = (await ctx.pool.query<ReactionRow>('select message_id, person_id, emoji from reactions where message_id = $1 order by created_at', [m.message_id])).rows;
          send('message', messageForApp(m, r));
        } else if (e.kind === 'trip') send('trip', { seq: e.seq });
        else send('typing', { who: e.who, on: e.on, until: e.until });
      } catch (err) {
        console.error('live send failed', err);
      }
    });
    const beat = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.raw.on('close', () => (clearInterval(beat), unsubscribe()));
  });
}
