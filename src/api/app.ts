import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import {
  Forbidden, addPersonExpense, answerMandate, cancelDecision, castVote, closeVoteByPerson, createPerson, createTrip, deleteMessage, editMessage,
  joinTrip, leaveTrip, markSeen, needsYou, postPersonMessage, reactTo, removePersonExpense, requireMember, setGoPaused, tripByInvite, undoRecordLine,
} from '../domain/actions.js';
import { GoUnavailable, cardTap, catchUp, deleteFact, forgetPerson, getPerson, updateCarryOver, vaultLink } from '../domain/ask-go.js';
import type { GoClient } from '../domain/ask-go.js';
import { messageForApp } from '../domain/mappers.js';
import { getMyProfile, getMyTripAnswers, setMyBudget, updateMyProfile, updateMyTripAnswers, updateTripDetails } from '../domain/person-edits.js';
import { addPersonBooking, openPersonVote, proposeCancelBooking, updatePersonBooking } from '../domain/votes-bookings.js';
import { invalid } from '../domain/errors.js';
import type { MessageRow, ReactionRow } from '../domain/mappers.js';
import { buildSnapshot } from '../domain/snapshot.js';
import { SocketCallError } from '../go/go-socket.js';
import type { LiveEvent } from '../live/live.js';
import { signSession, verifySession } from './auth.js';
import { checkAddBooking, checkCancelVote, checkOpenVote, checkPatchMe, checkPatchTrip, checkPatchTripMe, checkPutBudget, checkUpdateBooking } from './bodies.js';
import { corsHeaders } from './cors.js';

export interface AppDeps {
  ctx: Ctx;
  go: GoClient & { connected?: boolean };
  sessionSecret: string;
  /** The exact origins of the web app that may call this server from a browser. None by default. */
  origins?: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    personId: string;
  }
}

const str = { type: 'string', minLength: 1, maxLength: 4000 } as const;
const id = { type: 'string', minLength: 1, maxLength: 64 } as const;
const bool = { type: 'boolean' } as const;
const minor = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const;
/** A JSON body with these fields. The limits are the contract's, so what the app sends always fits Go's events. */
const body = (properties: Record<string, object>, required: string[] = []) => ({ schema: { body: { type: 'object', required, properties } } });

/** The app's API. The app talks only to this, never to Go. The paths are ours to design. */
export function buildApp({ ctx, go, sessionSecret, origins = [] }: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: false,
    // Fastify answers a malformed address (bad percent-encoding) itself, before any hook runs: give that answer the
    // same headers and error shape as every other response.
    frameworkErrors: (err, req, reply) => {
      for (const [name, value] of Object.entries(corsHeaders(origins, req.headers.origin))) reply.header(name, value);
      return (reply as FastifyReply).code(err.statusCode ?? 400).send({ error: { code: 'invalid', message: err.message } });
    },
  });

  // Cross-origin headers on every response, and the preflight answered here, before any sign-in.
  app.addHook('onRequest', async (req, reply) => {
    const preflight = req.method === 'OPTIONS' && !!req.headers['access-control-request-method'];
    for (const [name, value] of Object.entries(corsHeaders(origins, req.headers.origin, preflight))) reply.header(name, value);
    if (preflight) return reply.code(204).send();
  });

  // An empty body is fine even with content-type: application/json (many HTTP clients always set it): it is read as
  // no body, and each route's schema still decides what is required. Unreadable JSON is a 400.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = String(body);
    if (text.trim() === '') return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof Forbidden) return reply.code(403).send({ error: { code: 'forbidden', message: err.message } });
    if (err instanceof GoUnavailable) {
      if (err.retryAfterSeconds) reply.header('retry-after', String(err.retryAfterSeconds));
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof SocketCallError && [404, 409, 422, 429, 503].includes(err.code)) {
      if (err.retryAfterSeconds) reply.header('retry-after', String(err.retryAfterSeconds));
      return reply.code(err.code).send({ error: { code: err.dataCode, message: err.message } });
    }
    if ((err as { validation?: unknown }).validation) return reply.code(400).send({ error: { code: 'invalid', message: err.message } });
    // Fastify's own refusals before a handler runs: unreadable JSON, a body too large, a wrong content type.
    if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: { code: 'invalid', message: err.message } });
    }
    console.error(err);
    return reply.code(500).send({ error: { code: 'internal', message: 'something went wrong' } });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: { code: 'not_found', message: `no route ${req.method} ${req.url.split('?')[0]}` } }));
  // A POST with no body is the same as an empty one, so a route's required fields are still checked by its schema.
  app.addHook('preValidation', async (req) => {
    if (req.body === undefined && ['POST', 'PUT', 'PATCH'].includes(req.method)) req.body = {};
  });

  const needAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const personId = token ? verifySession(token, sessionSecret) : null;
    if (!personId) return reply.code(401).send({ error: { code: 'unauthorized', message: 'sign in first' } });
    req.personId = personId;
  };
  const auth = { preHandler: needAuth };
  /** Runs `fn` for a person who is in the trip. The HTTP edge is loosely typed; the domain functions are not. */
  const inTrip = (fn: (req: any, trip: string, me: string) => unknown, status = 200) => ({
    preHandler: needAuth,
    handler: async (req: any, reply: FastifyReply) => {
      await requireMember(ctx.pool, req.params.id, req.personId);
      const out = await fn(req, req.params.id, req.personId);
      if (status !== 200) reply.code(status);
      return out;
    },
  });

  app.get('/health', async () => ({ ok: true, go: go.connected ?? null }));

  // ---- people, trips, joining
  app.post('/app/people', { schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, photo_url: str, phone: str, email: str, upi_id: str } } } },
    async (req, reply) => {
      const { person_id } = await createPerson(ctx, req.body as any);
      return reply.code(201).send({ person_id, token: signSession(person_id, sessionSecret) });
    });

  app.post('/app/trips', { ...auth, schema: { body: { type: 'object', required: ['title'], properties: { title: { type: 'string', minLength: 1, maxLength: 80 } } } } },
    async (req, reply) => reply.code(201).send(await createTrip(ctx, req.personId, req.body as any)));

  app.get('/app/join/:code', async (req: any, reply) => {
    const trip = await tripByInvite(ctx, req.params.code);
    return trip ?? reply.code(404).send({ error: { code: 'not_found', message: 'no trip for this invite link' } });
  });
  app.post('/app/join/:code', {
    ...auth,
    ...body({
      from_city: { type: 'string', maxLength: 60 },
      earliest_leave: { type: 'string', maxLength: 60 },
      know: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 80 } },
      budget: { type: 'object', required: ['min_minor'], properties: { min_minor: { type: 'integer', minimum: 0 }, max_minor: { type: 'integer', minimum: 0 } } },
    }),
  }, async (req: any) => joinTrip(ctx, req.params.code, req.personId, req.body));

  app.get('/app/trips/:id', inTrip((_req, trip) => buildSnapshot(ctx.pool, trip, ctx.publicBaseUrl)));
  app.get('/app/trips/:id/me', inTrip((_req, trip, me) => getMyTripAnswers(ctx, trip, me)));
  app.patch('/app/trips/:id/me', inTrip((req, trip, me) => {
    const body = checkPatchTripMe(req.body);
    if (Object.keys(body).length === 0) throw invalid('send at least one field');
    return updateMyTripAnswers(ctx, trip, me, body);
  }));
  app.put('/app/trips/:id/me/budget', inTrip((req, trip, me) => setMyBudget(ctx, trip, me, checkPutBudget(req.body))));
  app.patch('/app/trips/:id', inTrip((req, trip, me) => {
    const body = checkPatchTrip(req.body);
    if (Object.keys(body).length === 0) throw invalid('send at least one field');
    return updateTripDetails(ctx, trip, me, body);
  }));
  app.post('/app/trips/:id/leave', inTrip((_r, trip, me) => leaveTrip(ctx, trip, me)));
  app.post('/app/trips/:id/go-paused', { ...body({ paused: bool }, ['paused']), ...inTrip((req, trip, me) => setGoPaused(ctx, trip, me, req.body.paused)) });
  app.post('/app/trips/:id/seen', inTrip(async (_r, trip, me) => (await markSeen(ctx, trip, me), { ok: true })));
  app.get('/app/trips/:id/needs-you', inTrip((_r, trip, me) => needsYou(ctx, trip, me)));

  // ---- messages
  app.get('/app/trips/:id/messages', {
    schema: { querystring: { type: 'object', properties: { after_seq: { type: 'integer', minimum: 0, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 } } } },
    ...inTrip(async (req, trip) => {
      const { after_seq: after, limit } = req.query as { after_seq: number; limit: number };
      const { rows } = await ctx.pool.query<MessageRow>('select * from messages where trip_id = $1 and updated_seq > $2 order by updated_seq limit $3', [trip, after, limit + 1]);
      const page = rows.slice(0, limit);
      const reactions = page.length ? (await ctx.pool.query<ReactionRow>('select message_id, person_id, emoji from reactions where message_id = any($1) order by created_at', [page.map((m) => m.message_id)])).rows : [];
      return { messages: page.map((m) => messageForApp(m, reactions.filter((r) => r.message_id === m.message_id))), has_more: rows.length > limit };
    }),
  });
  app.post('/app/trips/:id/messages', {
    ...body({
      client_id: id,
      text: str,
      attachments: { type: 'array', maxItems: 10, items: { type: 'object' } },
      reply_to: id,
      about_message_id: id,
      mentions: { type: 'array', maxItems: 30, items: id },
    }, ['client_id']),
    ...inTrip((req, trip, me) => postPersonMessage(ctx, trip, me, req.body)),
  });
  app.patch('/app/trips/:id/messages/:mid', {
    ...body({ text: str }, ['text']),
    preHandler: needAuth,
    handler: async (req: any) => editMessage(ctx, req.params.id, req.personId, req.params.mid, req.body.text),
  });
  app.delete('/app/trips/:id/messages/:mid', {
    preHandler: needAuth,
    handler: async (req: any) => deleteMessage(ctx, req.params.id, req.personId, req.params.mid),
  });
  app.post('/app/trips/:id/messages/:mid/reactions', {
    ...body({ emoji: { type: 'string', minLength: 1, maxLength: 16 } }, ['emoji']),
    preHandler: needAuth,
    handler: async (req: any) => reactTo(ctx, req.params.id, req.personId, req.params.mid, req.body.emoji, true),
  });
  app.delete('/app/trips/:id/messages/:mid/reactions/:emoji', {
    schema: { params: { type: 'object', properties: { emoji: { type: 'string', minLength: 1, maxLength: 16 } } } },
    preHandler: needAuth,
    handler: async (req: any) => reactTo(ctx, req.params.id, req.personId, req.params.mid, decodeURIComponent(req.params.emoji), false),
  });
  /** People's typing is between the app and the Server only: Go does not need it. */
  app.post('/app/trips/:id/typing', {
    ...body({ on: bool }, ['on']),
    ...inTrip(async (req, trip, me) => {
      const on: boolean = req.body.on;
      await ctx.live.publish(trip, { kind: 'typing', who: { kind: 'person', person_id: me }, on, ...(on ? { until: new Date(Date.now() + 5_000).toISOString() } : {}) });
      return { ok: true };
    }),
  });

  // ---- votes, mandate, record, expenses (all the Server's own buttons: they never reach Go)
  const withTrip = (fn: (trip: string, me: string, req: any) => unknown) => ({
    preHandler: needAuth,
    handler: async (req: any) => fn(req.params.id, req.personId, req),
  });
  app.post('/app/trips/:id/decisions', inTrip((req, trip, me) => openPersonVote(ctx, trip, me, checkOpenVote(req.body)), 201));
  app.post('/app/trips/:id/bookings', inTrip((req, trip, me) => addPersonBooking(ctx, trip, me, checkAddBooking(req.body)), 201));
  app.patch('/app/trips/:id/bookings/:bid', inTrip((req, trip, me) => {
    const body = checkUpdateBooking(req.body);
    if (Object.keys(body).length === 0) throw invalid('send at least one field');
    return updatePersonBooking(ctx, trip, me, req.params.bid, body);
  }));
  app.post('/app/trips/:id/bookings/:bid/cancel-vote', inTrip((req, trip, me) => proposeCancelBooking(ctx, trip, me, req.params.bid, checkCancelVote(req.body)), 201));
  app.post('/app/trips/:id/decisions/:did/vote', {
    ...body({ option_index: { type: 'integer', minimum: 0 } }, ['option_index']),
    ...withTrip((t, me, r) => castVote(ctx, t, me, r.params.did!, r.body.option_index)),
  });
  app.post('/app/trips/:id/decisions/:did/close', withTrip((t, me, r) => closeVoteByPerson(ctx, t, me, r.params.did!)));
  app.post('/app/trips/:id/decisions/:did/cancel', withTrip((t, me, r) => cancelDecision(ctx, t, me, r.params.did!)));
  app.post('/app/trips/:id/decisions/:did/mandate/confirm', withTrip((t, me, r) => answerMandate(ctx, t, me, r.params.did!, 'confirm')));
  app.post('/app/trips/:id/decisions/:did/mandate/decline', withTrip((t, me, r) => answerMandate(ctx, t, me, r.params.did!, 'decline')));
  app.post('/app/trips/:id/record/:lid/undo', withTrip((t, me, r) => undoRecordLine(ctx, t, me, r.params.lid!)));
  app.post('/app/trips/:id/expenses', {
    ...body({
      paid_by_person_id: id,
      amount_minor: minor,
      note: { type: 'string', minLength: 1, maxLength: 120 },
      category: { type: 'string', minLength: 1 },
      split_person_ids: { type: 'array', minItems: 1, maxItems: 30, items: id },
      booking_id: id,
    }, ['paid_by_person_id', 'amount_minor', 'note', 'category', 'split_person_ids']),
    ...withTrip((t, me, r) => addPersonExpense(ctx, t, me, r.body)),
  });
  app.delete('/app/trips/:id/expenses/:eid', withTrip((t, me, r) => removePersonExpense(ctx, t, me, r.params.eid!)));

  // ---- asking Go: card taps and catch-up
  app.post('/app/trips/:id/card-taps', {
    ...body({ card_id: id, action_id: { type: 'string', pattern: '^[a-z][a-z_]{0,31}$' }, option_id: id, tap_id: id }, ['card_id', 'action_id']),
    ...inTrip((req, trip, me) => cardTap(ctx, go, trip, me, req.body)),
  });
  app.post('/app/trips/:id/catch-up', { ...body({ force: bool }), ...inTrip((req, trip, me) => catchUp(ctx, go, trip, me, !!req.body.force)) });

  // ---- the You screen
  app.get('/app/me', auth, async (req, reply) => (reply.header('cache-control', 'no-store'), getMyProfile(ctx, req.personId))); // it holds the UPI id
  app.patch('/app/me', auth, async (req, reply) => {
    const body = checkPatchMe(req.body);
    if (Object.keys(body).length === 0) throw invalid('send at least one field');
    reply.header('cache-control', 'no-store');
    return updateMyProfile(ctx, req.personId, body);
  });
  app.get('/app/me/go-knows', auth, async (req) => getPerson(go, req.personId));
  app.put('/app/me/carry-over', { ...auth, ...body({ carry_over: bool }, ['carry_over']) }, async (req: any) => updateCarryOver(go, req.personId, req.body.carry_over));
  app.delete('/app/me/facts/:fact', auth, async (req: any) => deleteFact(go, req.personId, req.params.fact));
  app.post('/app/me/forget', { ...auth, ...body({ trip_id: id }) }, async (req: any) => forgetPerson(ctx, go, req.personId, req.body.trip_id));
  app.post('/app/me/vault-link', { ...auth, ...body({ start: { type: 'string', enum: ['home', 'add_card', 'add_login'] } }) }, async (req: any) => vaultLink(go, req.personId, req.body.start));

  // ---- the live connection (server-sent events): messages, reactions, typing, "the trip changed"
  app.get('/app/trips/:id/live', {
    preHandler: needAuth,
    handler: async (req: any, reply) => {
      const tripId = req.params.id;
      await requireMember(ctx.pool, tripId, req.personId);
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...corsHeaders(origins, req.headers.origin) });
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
    },
  });

  return app;
}
