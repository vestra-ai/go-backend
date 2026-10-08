// §3: the live connection. POST /live/ticket gives a single-use 30-second ticket; GET /live?ticket= upgrades to the
// WebSocket (src/live/ws.ts). The hub is attached to the HTTP server once the app is ready.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { LiveHub } from '../../live/ws.js';
import { checkLiveTicket } from '../bodies.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import type { V1Deps } from './shared.js';

export const TICKET_SECONDS = 30;

export const routes: RouteMeta[] = [
  {
    method: 'POST', path: '/app/v1/live/ticket', section: SECTIONS.live, title: 'Live ticket',
    summary: 'A single-use ticket, valid 30 s, for GET /app/v1/live?ticket= (a browser cannot set Authorization on a WebSocket). { device_id? }: a second socket from the same device replaces the first.',
    example: { body: { device_id: 'dev_8f2c' }, responses: [{ name: 'ticket', status: 201, body: { ticket: 'tk_3f9a…', expires_at: '2026-10-08T07:12:30Z' } }] },
  },
  {
    method: 'GET', path: '/app/v1/live', section: SECTIONS.live, title: 'Live socket (WebSocket)',
    summary: 'wss://…/app/v1/live?ticket=<ticket>. Frames: hello, message, card, typing, trip_changed { seq, kinds? }, home_changed, resync, ping / pong; app sends subscribe { trips: [{ trip_id, since_seq }] }, unsubscribe, typing, pong. A bad ticket closes with 4401. Not for Postman: use wscat.',
    example: { query: { ticket: 'tk_3f9a…' } },
  },
];

export function register(app: FastifyInstance, ctx: Ctx, deps: V1Deps): void {
  app.post('/app/v1/live/ticket', async (req, reply) => {
    const { device_id } = checkLiveTicket(req.body);
    const ticket = `tk_${randomBytes(18).toString('base64url')}`;
    const expires_at = new Date(Date.now() + TICKET_SECONDS * 1000).toISOString();
    await ctx.pool.query('insert into live_tickets (ticket, person_id, device_id, expires_at) values ($1, $2, $3, $4)', [ticket, req.personId, device_id ?? null, expires_at]);
    return reply.code(201).send({ ticket, expires_at });
  });
  // The WebSocket takes the HTTP upgrade before Fastify's routing; a plain GET here is told what the path is for.
  app.get('/app/v1/live', { config: { public: true } }, async (req, reply) => reply.code(426).header('upgrade', 'websocket').send({ error: { code: 'upgrade_required', message: 'this is a WebSocket: connect with ?ticket= from POST /app/v1/live/ticket', field: null, retry_after_seconds: null, request_id: req.id } }));

  const hub = new LiveHub(ctx, deps.live);
  app.addHook('onReady', async () => hub.attach(app.server));
  app.addHook('onClose', async () => hub.close());
  deps.onLiveHub?.(hub);
}
