import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import type { Ctx } from '../../src/context.js';
import { GoSocket } from '../../src/go/go-socket.js';
import type { Live, LiveEvent } from '../../src/live/live.js';
import type { LiveHub, LiveHubOptions } from '../../src/live/ws.js';
import { MemoryStorage } from '../../src/storage/memory-storage.js';
import type { Notification, Push } from '../../src/push/push.js';
import { goRequestHandlers } from '../../src/requests/index.js';
import { OutboxSender } from '../../src/outbox/sender.js';
import { buildApp } from '../../src/api/app.js';
import { DevAuth, SupabaseAuth, signSession, type Authenticator } from '../../src/api/auth.js';
import type { Features } from '../../src/config.js';
import { freshDb } from './db.js';
import { FakeSupabaseAuth, type FakeUser } from './fake-supabase-auth.js';
import { MockGo } from './mock-go.js';
import { seedTrip, uuidFor } from './seed.js';

/** The app's API lives under /app/v1: `v1('/trips/t_goa')`. */
export const v1 = (path: string) => `/app/v1${path}`;

export class RecordingLive implements Live {
  events: Array<{ tripId: string; event: LiveEvent }> = [];
  private subscribers = new Set<(tripId: string, event: LiveEvent) => void>();
  async publish(tripId: string, event: LiveEvent) {
    this.events.push({ tripId, event });
    for (const fn of this.subscribers) fn(tripId, event);
  }
  subscribe(fn: (tripId: string, event: LiveEvent) => void) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
}

export class RecordingPush implements Push {
  sent: Array<{ to: string[]; n: Notification }> = [];
  async send(to: string[], n: Notification) {
    this.sent.push({ to, n });
  }
}

const spend = JSON.parse(readFileSync(new URL('../../contract/test-vectors/spend-approval.json', import.meta.url), 'utf8'));
export const SPEND_PUBLIC_KEY: string = spend.public_key_pem;

export interface HarnessOptions {
  seed?: boolean;
  origins?: string[];
  makePush?: (pool: pg.Pool) => Push;
  pushPublicKey?: string;
  features?: Partial<Features>;
  /**
   * How people sign in. `supabase` (the default) runs a fake Supabase Auth and checks its tokens exactly as production
   * checks the real ones; `dev` uses the server's own dev tokens (for the tests about dev sign-in).
   */
  auth?: 'supabase' | 'dev';
  /** Your own authenticator (the Supabase sign-in tests build one with a legacy secret). */
  makeAuth?: (pool: pg.Pool) => Authenticator;
  /** The live socket hub's settings (a short heartbeat for the pong-timeout test). */
  live?: LiveHubOptions;
}

/** A person's name from a test id: `p_rahul` → `Rahul`. */
const nameFor = (personId: string) => personId.replace(/^p_/, '').replace(/^./, (c) => c.toUpperCase());

/** The server wired to a real Postgres and a mock Go over a real, signed WebSocket; people sign in through a fake Supabase Auth. */
export async function startHarness(opts: HarnessOptions = {}) {
  const { pool, close } = await freshDb();
  const live = new RecordingLive();
  const push = new RecordingPush();
  const storage = new MemoryStorage('https://go.example'); // its signed URLs point at the server under test (app.inject takes the path)
  const ctx: Ctx = { pool, live, push: opts.makePush ? opts.makePush(pool) : push, storage, publicBaseUrl: 'https://go.example', spendPrivateKey: spend.private_key_pem };
  const go = new MockGo();
  const base = await go.listen();
  const socket = new GoSocket({
    url: `${base}/v1/socket?instance=test-1`,
    secret: go.secret,
    handlers: goRequestHandlers(ctx),
    log: () => {},
  });
  socket.start();
  await go.untilConnected();
  if (opts.seed !== false) await seedTrip(pool);
  const sessionSecret = 'test-session-secret';
  const mode = opts.auth ?? 'supabase';
  const fakeAuth = mode === 'supabase' && !opts.makeAuth ? new FakeSupabaseAuth() : null;
  if (fakeAuth) await fakeAuth.start();
  const auth: Authenticator = opts.makeAuth ? opts.makeAuth(pool) : fakeAuth ? new SupabaseAuth({ supabaseUrl: fakeAuth.url, pool }) : new DevAuth(sessionSecret);
  let hub!: LiveHub;
  const app = buildApp({ ctx, go: socket, sessionSecret, auth, origins: opts.origins, pushPublicKey: opts.pushPublicKey, features: opts.features, live: opts.live, onLiveHub: (h) => (hub = h) });
  await app.ready();
  const sender = new OutboxSender({ pool, send: (e) => socket.request('send_event', e, { timeoutMs: 2500 }), ready: () => socket.connected });
  /** Sends every pending event to Go now, in order. */
  const flush = async () => {
    for (let i = 0; i < 50; i++) {
      await sender.tick();
      await sender.idle();
      const { rows } = await pool.query("select count(*)::int as n from outbox where status = 'pending'");
      if (rows[0].n === 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const tokens = new Map<string, Promise<string>>();
  /**
   * A sign-in token for a person id: a Supabase-style token for the user the seed links to that id (a person who does not
   * exist yet is created on first use, named after the id), or a dev token in `dev` mode.
   */
  const token = (personId: string): Promise<string> => {
    let t = tokens.get(personId);
    if (!t) {
      t = fakeAuth ? fakeAuth.mint({ id: uuidFor(personId), name: nameFor(personId), email: `${personId}@mail.test` }) : Promise.resolve(signSession(personId, sessionSecret));
      tokens.set(personId, t);
    }
    return t;
  };
  /** Signs a new person in the way the app does (a fresh Supabase user, created on the first request), or through dev sign-in. */
  const signIn = async (name: string, user: Omit<FakeUser, 'name'> & { upi_id?: string; phone?: string } = {}): Promise<{ id: string; token: string; name: string }> => {
    if (!fakeAuth) {
      const r = await app.inject({ method: 'POST', url: v1('/dev/sign-in'), payload: { name, ...user } });
      if (r.statusCode !== 201) throw new Error(`dev sign-in failed: ${r.body}`);
      const { person_id, token: t } = JSON.parse(r.body);
      return { id: person_id, token: t, name };
    }
    const { upi_id, phone: _phone, ...profile } = user;
    const t = await fakeAuth.mint({ name, ...profile });
    const me = await app.inject({ method: 'GET', url: v1('/me'), headers: { authorization: `Bearer ${t}` } });
    if (me.statusCode !== 200) throw new Error(`sign-in failed: ${me.body}`);
    const id: string = JSON.parse(me.body).person_id;
    if (upi_id) await app.inject({ method: 'PATCH', url: v1('/me'), payload: { upi_id }, headers: { authorization: `Bearer ${t}` } });
    return { id, token: t, name };
  };
  /** The server listening on a real port (for WebSocket tests): its base URL. Idempotent. */
  const listen = async (): Promise<string> => {
    if (!app.server.listening) await app.listen({ port: 0, host: '127.0.0.1' });
    return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  };
  return {
    pool, ctx, go, socket, live, push, storage, hub, sender, flush, app, sessionSecret, fakeAuth, token, signIn, listen,
    async stop() {
      sender.stop();
      socket.stop();
      await app.close();
      await go.close();
      await fakeAuth?.close();
      await close();
    },
  };
}
export type Harness = Awaited<ReturnType<typeof startHarness>>;

export const rows = async <T = any>(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows;
