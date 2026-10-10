// The App team's internal routes, under /internal/v1, for testing and support: look a person up by email, delete or
// forget any person exactly as they could themselves (DELETE /app/v1/me, DELETE /app/v1/me/go), and reset a test trip.
// They are not part of the app's API (docs/API.md, "Internal routes"). Each one answers 404, the same as an unknown path,
// unless INTERNAL_API_KEY is set and the request's `x-internal-key` matches it. No CORS headers, ever (src/api/app.ts):
// they are called with a key from a terminal or a script, never from a browser page. Rate-limited, and each call is
// logged as one line with the route, the person or trip id and the status: never a name, an email or the key.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import { deleteAccount } from '../domain/account.js';
import { forgetPerson, type GoClient } from '../domain/ask-go.js';
import { notFound } from '../domain/errors.js';
import { resetTrip } from '../domain/trip-reset.js';
import { sendError, toHttpError } from './errors.js';
import { RateLimiter } from './rate-limit.js';
import { id } from './v1/shared.js';

export const INTERNAL_PREFIX = '/internal/v1';
export const INTERNAL_KEY_HEADER = 'x-internal-key';
/** Calls a minute, per caller address. */
export const INTERNAL_CALLS_PER_MINUTE = 30;

/** True for a path under /internal/v1 (the shell keeps CORS off them). */
export const isInternal = (url: string) => url === INTERNAL_PREFIX || url.startsWith(`${INTERNAL_PREFIX}/`) || url.startsWith(`${INTERNAL_PREFIX}?`);

/** The two keys compared in constant time. Both are hashed first, so a key of another length takes as long to refuse. */
function keyMatches(expected: string, sent: unknown): boolean {
  if (typeof sent !== 'string' || !sent) return false;
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(expected), digest(sent));
}

/** The same answer as a path that does not exist (the shell's not-found handler). */
const hidden = (req: FastifyRequest, reply: FastifyReply) =>
  sendError(reply, { status: 404, code: 'not_found', message: `no route ${req.method} ${req.url.split('?')[0]}` }, req.id);

type Handler = (req: FastifyRequest & { params: any; query: any; body: any }, reply: FastifyReply) => Promise<unknown>;

export function registerInternal(app: FastifyInstance, ctx: Ctx, go: GoClient, key: string | undefined): void {
  const calls = new RateLimiter(INTERNAL_CALLS_PER_MINUTE, 60_000, { what: 'internal calls' });
  const log = (route: string, subject: string, status: number) => console.log(`[internal] ${route} ${subject} → ${status}`);

  /**
   * One internal route: the key, checked as the request arrives, before its body or query is read (404 when it is unset,
   * missing or wrong, so a stranger learns nothing about the route's rules); then the rate limit, the work and the log
   * line. `subject` names the person or trip for the log.
   */
  const route = (name: string, subject: (req: any) => string, fn: Handler) => ({
    onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
      if (key && keyMatches(key, req.headers[INTERNAL_KEY_HEADER])) return;
      log(name, subject(req), 404);
      return hidden(req, reply);
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        calls.take(req.ip);
        const out = await fn(req as any, reply);
        log(name, subject(req), reply.statusCode);
        return out;
      } catch (err) {
        log(name, subject(req), toHttpError(err)?.status ?? 500);
        throw err;
      }
    },
  });
  // No bearer token: the key is the only sign-in these routes have.
  const config = { public: true } as const;
  const personParam = { params: { type: 'object', properties: { person_id: id } } };

  app.get(`${INTERNAL_PREFIX}/people`, {
    config,
    schema: { querystring: { type: 'object', required: ['email'], properties: { email: { type: 'string', minLength: 3, maxLength: 320 } } } },
    ...route('GET /people', () => 'by email', async (req, reply) => {
      reply.header('cache-control', 'no-store');
      // Emails are stored as the sign-in gave them; matched without case. A deleted account has no email left, so it is never found here.
      const p = (await ctx.pool.query(
        'select person_id, name, created_at, deleted_at from people where lower(email) = lower($1) order by created_at, person_id limit 1',
        [req.query.email.trim()],
      )).rows[0];
      if (!p) throw notFound('no person with that email');
      return { person_id: p.person_id, name: p.name, created_at: new Date(p.created_at).toISOString(), deleted: p.deleted_at !== null };
    }),
  });

  // The same deletion as DELETE /app/v1/me (src/domain/account.ts), for anyone: 202, 404 for an unknown or already deleted person.
  app.delete(`${INTERNAL_PREFIX}/people/:person_id`, {
    config,
    schema: personParam,
    ...route('DELETE /people/:person_id', (req) => `person=${req.params.person_id}`, async (req, reply) => {
      await deleteAccount(ctx, go, req.params.person_id);
      return reply.code(202).send();
    }),
  });

  // The same as DELETE /app/v1/me/go: Go forgets the person in one trip or everywhere, and their join answers there go too.
  app.post(`${INTERNAL_PREFIX}/people/:person_id/forget`, {
    config,
    schema: { ...personParam, body: { type: 'object', additionalProperties: false, properties: { trip_id: id } } },
    ...route('POST /people/:person_id/forget', (req) => `person=${req.params.person_id}${req.body?.trip_id ? ` trip=${req.body.trip_id}` : ''}`, async (req) => {
      const exists = await ctx.pool.query('select 1 from people where person_id = $1', [req.params.person_id]);
      if (!exists.rowCount) throw notFound(`person ${req.params.person_id} does not exist`);
      return forgetPerson(ctx, go, req.params.person_id, req.body?.trip_id);
    }),
  });

  // Destructive, for test trips: the trip and everything in it are deleted (src/domain/trip-reset.ts).
  app.post(`${INTERNAL_PREFIX}/trips/:trip_id/reset`, {
    config,
    schema: { params: { type: 'object', properties: { trip_id: id } } },
    ...route('POST /trips/:trip_id/reset', (req) => `trip=${req.params.trip_id}`, async (req) => resetTrip(ctx, req.params.trip_id)),
  });
}
