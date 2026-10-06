import { readFileSync } from 'node:fs';
import type pg from 'pg';
import type { Ctx } from '../../src/context.js';
import { GoSocket } from '../../src/go/go-socket.js';
import type { Live, LiveEvent } from '../../src/live/live.js';
import type { Notification, Push } from '../../src/push/push.js';
import { goRequestHandlers } from '../../src/requests/index.js';
import { OutboxSender } from '../../src/outbox/sender.js';
import { buildApp } from '../../src/api/app.js';
import { freshDb } from './db.js';
import { MockGo } from './mock-go.js';
import { seedTrip } from './seed.js';

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

/** The server wired to a real Postgres and a mock Go over a real, signed WebSocket. */
export async function startHarness(opts: { seed?: boolean; origins?: string[] } = {}) {
  const { pool, close } = await freshDb();
  const live = new RecordingLive();
  const push = new RecordingPush();
  const ctx: Ctx = { pool, live, push, publicBaseUrl: 'https://go.example', spendPrivateKey: spend.private_key_pem };
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
  const app = buildApp({ ctx, go: socket, sessionSecret, origins: opts.origins });
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
  return {
    pool, ctx, go, socket, live, push, sender, flush, app, sessionSecret,
    async stop() {
      sender.stop();
      socket.stop();
      await app.close();
      await go.close();
      await close();
    },
  };
}
export type Harness = Awaited<ReturnType<typeof startHarness>>;

export const rows = async <T = any>(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows;
