// What the section files share: the dependencies the shell hands them, the small JSON-schema pieces for Fastify's own
// checks of a query string or the dev sign-in body (every app body is strict: src/api/bodies.ts), and the two ways a
// trip route runs for a signed-in person.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Features } from '../../config.js';
import type { Ctx } from '../../context.js';
import { requireMember } from '../../domain/actions.js';
import type { GoClient } from '../../domain/ask-go.js';
import { invalid } from '../../domain/errors.js';
import type { LiveHub, LiveHubOptions } from '../../live/ws.js';
import type { Authenticator } from '../auth.js';
import { IDEMPOTENCY_KEY_HEADER } from '../idempotency.js';

export interface V1Deps {
  go: GoClient & { connected?: boolean };
  authenticator: Authenticator;
  /** Signs dev tokens (POST /app/v1/dev/sign-in, AUTH_MODE=dev only). */
  sessionSecret: string;
  /** The exact origins of the web app that may call this server from a browser. */
  origins: string[];
  features: Features;
  /** The live socket hub's settings (a shorter heartbeat in tests). */
  live?: LiveHubOptions;
  /** Hands the hub to whoever built the app (tests look at its socket count). */
  onLiveHub?: (hub: LiveHub) => void;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in person, set by the shell's sign-in hook on every route that is not `public` (and on an `optionalAuth` route when a valid token came). */
    personId: string;
  }
  interface FastifyContextConfig {
    /** No sign-in: config, health, the invite preview and dev sign-in. */
    public?: boolean;
    /** A public route that uses a valid bearer token when one is sent (the invite preview's personal `state`); anything else is anonymous. */
    optionalAuth?: boolean;
  }
}

/** Marks a route as needing no sign-in. */
export const PUBLIC = { config: { public: true } } as const;
/** Marks a route as public, with the person known when a valid token is sent. */
export const OPTIONAL_AUTH = { config: { public: true, optionalAuth: true } } as const;

export const str = { type: 'string', minLength: 1, maxLength: 4000 } as const;
export const id = { type: 'string', minLength: 1, maxLength: 64 } as const;

/** The route params every trip route has. The HTTP edge is loosely typed; the domain functions are not. */
export type TripRequest = FastifyRequest & { params: { trip: string; [k: string]: string }; body: any; query: any };

/** Runs `fn` for a person who is in the trip (403 otherwise, also for a trip that does not exist). `cacheControl` for private reads (§1.6). */
export const inTrip = (ctx: Ctx, fn: (req: TripRequest, trip: string, me: string) => unknown, status = 200, cacheControl?: string) => ({
  handler: async (req: FastifyRequest, reply: FastifyReply) => {
    const r = req as TripRequest;
    if (cacheControl) reply.header('cache-control', cacheControl);
    await requireMember(ctx.pool, r.params.trip, r.personId);
    const out = await fn(r, r.params.trip, r.personId);
    if (status !== 200) reply.code(status);
    return out;
  },
});

/**
 * Runs `fn` with the trip and the person. The domain function checks membership again inside its transaction; the check
 * here comes first so a stranger gets 403 before any body rule, feature flag or rate limit tells them about the route.
 */
export const withTrip = (ctx: Ctx, fn: (trip: string, me: string, req: TripRequest) => unknown, status = 200) => ({
  handler: async (req: FastifyRequest, reply: FastifyReply) => {
    const r = req as TripRequest;
    await requireMember(ctx.pool, r.params.trip, r.personId);
    const out = await fn(r.params.trip, r.personId, r);
    if (status !== 200) reply.code(status);
    return out;
  },
});

/**
 * The create routes take a press key: the app's own `client_id` in the body (the domain's repeat key) or the
 * `Idempotency-Key` header (the contract's one mechanism). Neither is 422 naming `client_id`.
 */
export function requirePressKey(req: FastifyRequest, field = 'client_id'): void {
  const bodyKey = (req.body as Record<string, unknown> | undefined)?.[field];
  if (typeof bodyKey === 'string' && bodyKey) return;
  if (req.headers[IDEMPOTENCY_KEY_HEADER]) return;
  throw invalid(`${field} is required (or send an Idempotency-Key header)`, field);
}

/** 422 when an edit names no field at all. */
export function atLeastOneField(input: object): void {
  if (Object.keys(input).length === 0) throw invalid('send at least one field');
}
