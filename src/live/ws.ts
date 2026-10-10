// The app's live connection (app contract §3): one WebSocket per signed-in app instance at GET /app/v1/live?ticket=,
// carrying every trip the person has open plus the home screen. The ticket (POST /app/v1/live/ticket) stands in for
// the Authorization header a browser cannot set on a socket. Each server instance runs one hub: it listens to the
// shared LISTEN/NOTIFY stream (src/live/live.ts) and routes each event to the sockets subscribed to its trip, or to
// the person's sockets for `home_changed`. Instances hold no other state: a socket may land on any of them.
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { Ctx } from '../context.js';
import { requireMember } from '../domain/actions.js';
import type { MessageRow } from '../domain/mappers.js';
import { messagesForApp } from '../domain/room.js';
import type { Message } from '../domain/types.js';
import type { ChangeKind, LiveEvent } from './live.js';

export const LIVE_PATH = '/app/v1/live';
export const HEARTBEAT_SECONDS = 25;
export const MISSED_PONGS_TO_CLOSE = 2;
/** Our replay rule (app contract §3): up to this many changed messages, then one trip_changed; more means resync. */
export const REPLAY_MAX_MESSAGES = 200;
/** A frame never goes over 1 MB (app contract §3.4); a replay that would is a resync instead. */
export const REPLAY_MAX_BYTES = 900 * 1024;
export const MAX_TRIPS_PER_SOCKET = 50;
export const TYPING_MIN_INTERVAL_MS = 2000;
export const TYPING_RUNS_OUT_MS = 6000;
/** Close codes: 4401 the ticket is bad; 4000 another socket from the same device took over. */
export const CLOSE_BAD_TICKET = 4401;
export const CLOSE_REPLACED = 4000;
export const CLOSE_NO_PONG = 4002;

/** Server → app frames (app contract §3.1). */
export type ServerFrame =
  | { type: 'hello'; person_id: string; server_time: string; heartbeat_seconds: number }
  | { type: 'message'; trip_id: string; message: Message }
  | { type: 'card'; trip_id: string; message_id: string; card: unknown }
  | { type: 'typing'; trip_id: string; who: { kind: 'go' } | { kind: 'person'; person_id: string }; on: boolean; until?: string }
  | { type: 'trip_changed'; trip_id: string; seq: number; kinds?: ChangeKind[] }
  | { type: 'home_changed' }
  | { type: 'resync'; trip_id: string }
  | { type: 'ping' }
  | { type: 'error'; trip_id?: string; code: string };

interface Client {
  ws: WebSocket;
  personId: string;
  deviceId: string;
  trips: Set<string>;
  missedPongs: number;
  /** When this socket last sent typing per trip (the 1 per 2 s rule). */
  typingAt: Map<string, number>;
}

export interface LiveHubOptions {
  /** Shorter in tests. */
  heartbeatMs?: number;
  log?: (msg: string, err?: unknown) => void;
}

export class LiveHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly clients = new Set<Client>();
  private readonly byTrip = new Map<string, Set<Client>>();
  private readonly byPerson = new Map<string, Set<Client>>();
  private heartbeat: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly log: (msg: string, err?: unknown) => void;

  constructor(private readonly ctx: Ctx, private readonly opts: LiveHubOptions = {}) {
    this.log = opts.log ?? ((m, e) => console.error(`[live] ${m}`, e ?? ''));
  }

  /** Takes the upgrades for LIVE_PATH on this HTTP server and starts routing events. Anything else on `upgrade` is closed. */
  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => void this.onUpgrade(req, socket, head));
    this.unsubscribe = this.ctx.live.subscribe((tripId, event) => void this.route(tripId, event).catch((err) => this.log(`routing ${event.kind} failed`, err)));
    this.heartbeat = setInterval(() => this.beat(), this.opts.heartbeatMs ?? HEARTBEAT_SECONDS * 1000);
    this.heartbeat.unref?.();
  }

  close(): void {
    clearInterval(this.heartbeat);
    this.unsubscribe?.();
    for (const c of this.clients) c.ws.terminate();
    this.clients.clear();
    this.byTrip.clear();
    this.byPerson.clear();
  }

  /** How many sockets are open (tests). */
  get size(): number {
    return this.clients.size;
  }

  // ---------------------------------------------------------------- connect

  private async onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== LIVE_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return void socket.destroy();
    }
    // The handshake completes first: a close code needs an open socket (a refused upgrade has none).
    const ticket = url.searchParams.get('ticket') ?? '';
    const holder = await this.useTicket(ticket).catch((err) => (this.log('ticket lookup failed', err), null));
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      if (!holder) return ws.close(CLOSE_BAD_TICKET, 'ticket unknown, used or expired');
      this.accept(ws, holder.person_id, holder.device_id);
    });
  }

  /** Marks the ticket used, once: the row is claimed in one statement so two connects with it cannot both pass. */
  private async useTicket(ticket: string): Promise<{ person_id: string; device_id: string } | null> {
    if (!ticket) return null;
    const { rows } = await this.ctx.pool.query(
      `update live_tickets set used_at = now() where ticket = $1 and used_at is null and expires_at > now() returning person_id, device_id`,
      [ticket],
    );
    if (!rows[0]) return null;
    return { person_id: rows[0].person_id, device_id: rows[0].device_id ?? `anon_${Math.random().toString(36).slice(2)}` };
  }

  private accept(ws: WebSocket, personId: string, deviceId: string): void {
    // One socket per (person, device): the newer one wins.
    for (const other of this.byPerson.get(personId) ?? []) if (other.deviceId === deviceId) other.ws.close(CLOSE_REPLACED, 'another connection from this device');
    const client: Client = { ws, personId, deviceId, trips: new Set(), missedPongs: 0, typingAt: new Map() };
    this.clients.add(client);
    index(this.byPerson, personId).add(client);
    ws.on('message', (data) => void this.onFrame(client, data.toString()).catch((err) => this.log(`frame from ${personId} failed`, err)));
    ws.on('close', () => this.drop(client));
    ws.on('error', (err) => this.log(`socket ${personId}: ${err.message}`));
    this.send(client, { type: 'hello', person_id: personId, server_time: new Date().toISOString(), heartbeat_seconds: (this.opts.heartbeatMs ?? HEARTBEAT_SECONDS * 1000) / 1000 });
  }

  private drop(client: Client): void {
    this.clients.delete(client);
    this.byPerson.get(client.personId)?.delete(client);
    if (this.byPerson.get(client.personId)?.size === 0) this.byPerson.delete(client.personId);
    for (const trip of client.trips) {
      this.byTrip.get(trip)?.delete(client);
      if (this.byTrip.get(trip)?.size === 0) this.byTrip.delete(trip);
    }
  }

  private send(client: Client, frame: ServerFrame): void {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(frame));
  }

  // ---------------------------------------------------------------- app → server

  private async onFrame(client: Client, raw: string): Promise<void> {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw);
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return;
    } catch {
      return; // not JSON: ignored, like an unknown type
    }
    switch (frame.type) {
      case 'pong':
        client.missedPongs = 0;
        return;
      case 'subscribe': {
        const trips = Array.isArray(frame.trips) ? frame.trips : [];
        for (const t of trips) {
          if (!t || typeof t !== 'object') continue;
          const { trip_id, since_seq } = t as { trip_id?: unknown; since_seq?: unknown };
          if (typeof trip_id !== 'string') continue;
          await this.subscribe(client, trip_id, typeof since_seq === 'number' && since_seq >= 0 ? Math.floor(since_seq) : 0);
        }
        return;
      }
      case 'unsubscribe': {
        for (const trip of Array.isArray(frame.trip_ids) ? frame.trip_ids : []) {
          if (typeof trip !== 'string') continue;
          client.trips.delete(trip);
          this.byTrip.get(trip)?.delete(client);
        }
        return;
      }
      case 'typing': {
        const tripId = frame.trip_id;
        if (typeof tripId !== 'string' || typeof frame.on !== 'boolean' || !client.trips.has(tripId)) return; // only for a trip this socket follows
        const last = client.typingAt.get(tripId) ?? 0;
        const now = Date.now();
        if (frame.on && now - last < TYPING_MIN_INTERVAL_MS) return; // at most one per 2 s per trip; "stopped" always goes through
        client.typingAt.set(tripId, now);
        // Through the shared stream, so a subscriber on another instance sees it too. Never to Go.
        await this.ctx.live.publish(tripId, { kind: 'typing', who: { kind: 'person', person_id: client.personId }, on: frame.on, ...(frame.on ? { until: new Date(now + TYPING_RUNS_OUT_MS).toISOString() } : {}) });
        return;
      }
      default:
        return; // unknown types are ignored (app contract §3.1)
    }
  }

  /**
   * Subscribes the socket to a trip and replays what it missed since `sinceSeq` (app contract §3):
   * the messages changed after it as `message` frames, oldest change first, then one `trip_changed` with the trip's current
   * seq when that moved; more than REPLAY_MAX_MESSAGES changed messages (or more than a frame's worth) is a `resync`.
   * The subscription is in place before the replay is read, so a change that lands meanwhile is seen (twice at worst).
   */
  private async subscribe(client: Client, tripId: string, sinceSeq: number): Promise<void> {
    try {
      await requireMember(this.ctx.pool, tripId, client.personId);
    } catch {
      return this.send(client, { type: 'error', trip_id: tripId, code: 'forbidden' });
    }
    if (!client.trips.has(tripId) && client.trips.size >= MAX_TRIPS_PER_SOCKET) return this.send(client, { type: 'error', trip_id: tripId, code: 'too_many_trips' });
    client.trips.add(tripId);
    index(this.byTrip, tripId).add(client);
    const db = await this.ctx.pool.connect();
    try {
      await db.query('begin transaction isolation level repeatable read read only');
      const seq = (await db.query('select seq from trips where trip_id = $1', [tripId])).rows[0]?.seq as number | undefined;
      const { rows } = await db.query<MessageRow>('select * from messages where trip_id = $1 and updated_seq > $2 order by updated_seq limit $3', [tripId, sinceSeq, REPLAY_MAX_MESSAGES + 1]);
      const messages = rows.length > REPLAY_MAX_MESSAGES ? null : await messagesForApp(this.ctx, db, rows);
      await db.query('commit');
      if (seq === undefined) return;
      if (messages === null) return this.send(client, { type: 'resync', trip_id: tripId });
      let bytes = 0;
      const frames = messages.map((message) => JSON.stringify({ type: 'message', trip_id: tripId, message } satisfies ServerFrame));
      for (const f of frames) bytes += f.length;
      if (bytes > REPLAY_MAX_BYTES) return this.send(client, { type: 'resync', trip_id: tripId });
      for (const f of frames) if (client.ws.readyState === WebSocket.OPEN) client.ws.send(f);
      if (seq > sinceSeq) this.send(client, { type: 'trip_changed', trip_id: tripId, seq });
    } catch (err) {
      await db.query('rollback').catch(() => {});
      throw err;
    } finally {
      db.release();
    }
  }

  // ---------------------------------------------------------------- server → app

  private async route(tripId: string, event: LiveEvent): Promise<void> {
    if (event.kind === 'home') {
      for (const c of this.byPerson.get(event.person_id) ?? []) this.send(c, { type: 'home_changed' });
      return;
    }
    const subscribers = this.byTrip.get(tripId);
    if (!subscribers?.size) return;
    switch (event.kind) {
      case 'message': {
        const row = (await this.ctx.pool.query<MessageRow>('select * from messages where message_id = $1', [event.message_id])).rows[0];
        if (!row) return;
        const [message] = await messagesForApp(this.ctx, this.ctx.pool, [row]);
        for (const c of subscribers) this.send(c, { type: 'message', trip_id: tripId, message: message! });
        return;
      }
      case 'card': {
        const row = (await this.ctx.pool.query<Pick<MessageRow, 'card'>>('select card from messages where message_id = $1', [event.message_id])).rows[0];
        if (!row?.card) return;
        for (const c of subscribers) this.send(c, { type: 'card', trip_id: tripId, message_id: event.message_id, card: row.card });
        return;
      }
      case 'trip':
        for (const c of subscribers) this.send(c, { type: 'trip_changed', trip_id: tripId, seq: event.seq, ...(event.kinds ? { kinds: event.kinds } : {}) });
        return;
      case 'typing':
        for (const c of subscribers) {
          if (event.who.kind === 'person' && event.who.person_id === c.personId) continue; // not back to the one typing
          this.send(c, { type: 'typing', trip_id: tripId, who: event.who, on: event.on, ...(event.until ? { until: event.until } : {}) });
        }
        return;
    }
  }

  /** Every heartbeat: a `ping` to each socket; one that missed two pongs is closed. */
  private beat(): void {
    for (const c of this.clients) {
      if (c.missedPongs >= MISSED_PONGS_TO_CLOSE) {
        c.ws.close(CLOSE_NO_PONG, 'no pong');
        continue;
      }
      c.missedPongs++;
      this.send(c, { type: 'ping' });
    }
  }
}

function index<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  return set;
}

/** Tickets that ran out and were never used are swept (they are only good for 30 seconds). */
export async function sweepLiveTickets(ctx: Ctx): Promise<number> {
  const { rowCount } = await ctx.pool.query(`delete from live_tickets where expires_at < now() - interval '1 hour'`);
  return rowCount ?? 0;
}
