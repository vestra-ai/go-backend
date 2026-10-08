import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { resolveFeatures, type Features } from '../config.js';
import type { Ctx } from '../context.js';
import type { GoClient } from '../domain/ask-go.js';
import type { LiveHub, LiveHubOptions } from '../live/ws.js';
import { DevAuth, type Authenticator } from './auth.js';
import { corsHeaders } from './cors.js';
import { handleError, newRequestId, sendError } from './errors.js';
import { registerIdempotency } from './idempotency.js';
import { sections } from './v1/index.js';
import type { V1Deps } from './v1/shared.js';

export interface AppDeps {
  ctx: Ctx;
  go: GoClient & { connected?: boolean };
  /** Signs dev tokens (POST /app/v1/dev/sign-in) and checks them when no other authenticator is given. */
  sessionSecret: string;
  /** How sign-in is checked: Supabase access tokens in production, our dev tokens otherwise (the default). */
  auth?: Authenticator;
  /** The exact origins of the web app that may call this server from a browser. None by default. */
  origins?: string[];
  /** The server's VAPID public key, given to browsers so they can subscribe. Without it `GET /app/v1/config` says web_push is off. */
  pushPublicKey?: string;
  /** Feature flags the environment set; the rest take their defaults. */
  features?: Partial<Features>;
  /** The live socket hub's settings (tests shorten the heartbeat), and a way to get hold of the hub. */
  live?: LiveHubOptions;
  onLiveHub?: (hub: LiveHub) => void;
}

/**
 * The app's API, under /app/v1 (app contract rev 3). This is the shell: the request id, CORS, the body parser, the one
 * error shape, sign-in and the Idempotency-Key store; the routes live one file per contract section in src/api/v1.
 * The app talks only to this, never to Go.
 */
export function buildApp({ ctx, go, sessionSecret, auth: authenticator = new DevAuth(sessionSecret), origins = [], pushPublicKey, features = {}, live, onLiveHub }: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: false,
    genReqId: () => newRequestId(),
    // Fastify answers a malformed address (bad percent-encoding) itself, before any hook runs: give that answer the
    // same headers and error shape as every other response.
    frameworkErrors: (err, req, reply) => {
      for (const [name, value] of Object.entries(corsHeaders(origins, req.headers.origin))) reply.header(name, value);
      reply.header('x-request-id', req.id);
      return sendError(reply as FastifyReply, { status: err.statusCode ?? 400, code: 'bad_request', message: err.message }, req.id);
    },
  });

  // The request id on every response, the cross-origin headers, and the preflight answered here, before any sign-in.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    const preflight = req.method === 'OPTIONS' && !!req.headers['access-control-request-method'];
    for (const [name, value] of Object.entries(corsHeaders(origins, req.headers.origin, preflight))) reply.header(name, value);
    if (preflight) return reply.code(204).send();
  });

  // An empty body is fine even with content-type: application/json (many HTTP clients always set it): it is read as
  // no body, and each route's schema still decides what is required. Unreadable JSON is a 400. The text is kept for
  // the Idempotency-Key body hash.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = String(body);
    req.rawBody = text;
    if (text.trim() === '') return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  app.setErrorHandler(handleError);
  app.setNotFoundHandler((req, reply) => {
    reply.header('x-request-id', req.id);
    return sendError(reply, { status: 404, code: 'not_found', message: `no route ${req.method} ${req.url.split('?')[0]}` }, req.id);
  });
  // A POST with no body is the same as an empty one, so a route's required fields are still checked by its schema.
  app.addHook('preValidation', async (req) => {
    if (req.body === undefined && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) req.body = {};
  });

  // Every route that is not marked public: "Authorization: Bearer <token>". On any 401 the app refreshes its Supabase
  // session once and retries. Sign-in comes before the body check, so a stranger learns nothing about a route's rules.
  app.addHook('preValidation', async (req, reply) => {
    if (req.is404 || req.routeOptions.config.public) return; // an unknown path answers 404, whoever asks
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    const result = token ? await authenticator.personFor(token) : { error: 'missing' as const };
    if ('error' in result) {
      const message = { missing: 'sign in first', expired: 'the sign-in has expired: refresh it and try again', invalid: 'the sign-in token is not valid' }[result.error];
      return sendError(reply, { status: 401, code: 'unauthorized', message }, req.id);
    }
    req.personId = result.personId;
  });
  registerIdempotency(app, ctx.pool);

  const deps: V1Deps = { go, authenticator, sessionSecret, origins, pushPublicKey, features: resolveFeatures(features, !!pushPublicKey), live, onLiveHub };
  for (const section of sections) section.register(app, ctx, deps);
  // The in-process storage fake serves its own upload and download endpoints; Supabase Storage needs none.
  ctx.storage.attach?.(app);
  return app;
}
