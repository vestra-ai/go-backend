import type pg from 'pg';
import { SocketCallError } from '../go/go-socket.js';

// guides/events.md, "Sending events reliably"
export const RETRY_AFTER_SECONDS = [1, 5, 30, 120, 600]; // then every 10 minutes
export const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;
const RETRY_CODES = new Set([429, 500, 503]); // a timeout is retried too

export interface SenderDeps {
  pool: pg.Pool;
  /** Sends one event as a `send_event` request and resolves with Go's answer. */
  send: (event: Record<string, unknown>) => Promise<object>;
  /** The sender waits while the socket is down: events stay in the outbox and no retry is used up. */
  ready?: () => boolean;
  log?: (msg: string, err?: unknown) => void;
}

interface Row {
  event_id: string;
  body: Record<string, unknown>;
  attempts: number;
  created_at: Date;
  due: boolean;
}

/**
 * Sends every trip's events to Go one at a time, in change-number order, waiting for each answer.
 * Trips do not wait for each other. With several server instances, a Postgres advisory lock per trip
 * keeps it to one sender at a time for each trip, whichever instance's socket carries the event.
 */
export class OutboxSender {
  private readonly sending = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly deps: SenderDeps,
    private readonly opts: { pollMs?: number; maxTrips?: number; maxPerHold?: number } = {},
  ) {}

  start(): void {
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.tick();
      } catch (err) {
        this.deps.log?.('outbox tick failed', err);
      }
      if (this.running) this.timer = setTimeout(loop, this.opts.pollMs ?? 200);
    };
    void loop();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
  }

  /** Waits until nothing is on the way. For tests and for a clean shutdown. */
  async idle(): Promise<void> {
    while (this.sending.size > 0) await new Promise((r) => setTimeout(r, 10));
  }

  /** One pass: starts a sender for each trip whose oldest unsent event is due. Returns the trips started. */
  async tick(): Promise<string[]> {
    if (this.deps.ready && !this.deps.ready()) return [];
    const room = (this.opts.maxTrips ?? 16) - this.sending.size;
    if (room <= 0) return [];
    const { rows } = await this.deps.pool.query<{ trip_id: string }>(
      `select trip_id from (
         select distinct on (trip_id) trip_id, next_attempt_at
           from outbox where status = 'pending' order by trip_id, seq
       ) oldest
       where next_attempt_at <= now() and trip_id <> all($1::text[])
       limit $2`,
      [[...this.sending], room],
    );
    for (const { trip_id } of rows) {
      this.sending.add(trip_id);
      void this.drain(trip_id)
        .catch((err) => this.deps.log?.(`outbox ${trip_id} failed`, err))
        .finally(() => this.sending.delete(trip_id));
    }
    return rows.map((r) => r.trip_id);
  }

  /** Sends the trip's events in order for as long as the next one is due and Go keeps answering. */
  private async drain(tripId: string): Promise<void> {
    const db = await this.deps.pool.connect();
    let broken = false;
    try {
      const got = await db.query('select pg_try_advisory_lock(hashtextextended($1, 0)) as ok', [`outbox:${tripId}`]);
      if (!got.rows[0].ok) return; // another instance is sending this trip
      try {
        for (let sent = 0; sent < (this.opts.maxPerHold ?? 100); sent++) {
          if (this.deps.ready && !this.deps.ready()) return;
          const next = await db.query<Row>(
            `select event_id, body, attempts, created_at, next_attempt_at <= now() as due
               from outbox where trip_id = $1 and status = 'pending' order by seq limit 1`,
            [tripId],
          );
          const row = next.rows[0];
          if (!row || !row.due) return;
          if (!(await this.sendOne(db, row))) return; // keep order: wait for the retry
        }
      } finally {
        await db.query('select pg_advisory_unlock(hashtextextended($1, 0))', [`outbox:${tripId}`]).catch(() => {
          broken = true;
        });
      }
    } catch (err) {
      broken = true;
      throw err;
    } finally {
      db.release(broken || undefined);
    }
  }

  /** Returns true when the event is finished (sent or given up on) and the trip's next one may go. */
  private async sendOne(db: pg.PoolClient, row: Row): Promise<boolean> {
    let failure: unknown = null;
    try {
      // Waits for Go's answer. If the socket drops first, the socket client sends this same request again after it reconnects.
      await this.deps.send(row.body);
    } catch (err) {
      failure = err; // a SocketCallError, or a SocketTimeoutError when there was no answer in time
    }
    if (failure === null) {
      // `accepted` is a success, and so is `accepted` with `duplicate: true`.
      await db.query(`update outbox set status = 'sent', sent_at = now() where event_id = $1`, [row.event_id]);
      return true;
    }
    const refused = failure instanceof SocketCallError && !RETRY_CODES.has(failure.code);
    if (refused || Date.now() - new Date(row.created_at).getTime() > GIVE_UP_AFTER_MS) {
      // Not retried. The trip's next event goes next, and Go catches up from the gap.
      this.deps.log?.(`event not delivered ${row.event_id}`, failure);
      await db.query(`update outbox set status = 'failed' where event_id = $1`, [row.event_id]);
      return true;
    }
    // A 429 says how long to wait. Otherwise, and when it does not say, follow the schedule.
    const asked = failure instanceof SocketCallError && failure.code === 429 ? failure.retryAfterSeconds : undefined;
    const wait = asked ?? RETRY_AFTER_SECONDS[Math.min(row.attempts, RETRY_AFTER_SECONDS.length - 1)]!;
    await db.query('update outbox set attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => $2) where event_id = $1', [row.event_id, wait]);
    return false;
  }
}
