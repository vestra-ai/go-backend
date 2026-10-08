import type pg from 'pg';

/** What the app's live connection carries for a trip (guides/app.md, "The live connection"). */
export type LiveEvent =
  /** A message was posted or changed (a reaction, a replaced card). The app reads it by id. */
  | { kind: 'message'; message_id: string; updated_seq: number }
  /** Something in the trip that is not a message changed. The app reads again when `seq` is higher than it holds. */
  | { kind: 'trip'; seq: number }
  /** "Go is typing...". `until` is when it runs out by itself, 10 seconds after Go's notification. */
  | { kind: 'typing'; who: { kind: 'go' } | { kind: 'person'; person_id: string }; on: boolean; until?: string }
  /**
   * One person's home screen moved (app contract §3.1 `home_changed`): they created, joined or left a trip, or marked an
   * invite. Published under the trip it is about, for that person only; the app re-reads GET /home. Never replayed.
   */
  | { kind: 'home_changed'; person_id: string };

export interface Live {
  publish(tripId: string, event: LiveEvent): Promise<void>;
  /** Calls `fn` for every live event from every instance. Returns a function that stops it. */
  subscribe(fn: (tripId: string, event: LiveEvent) => void): () => void;
}

const CHANNEL = 'go_live';

/**
 * Live updates over Postgres LISTEN/NOTIFY, so Go's message, typing and reactions reach phones
 * connected to any instance. Payloads are small pointers: the app reads the row by id.
 */
export class PgLive implements Live {
  private listener: pg.PoolClient | null = null;
  private closed = false;
  private retry: NodeJS.Timeout | undefined;
  private readonly subscribers = new Set<(tripId: string, event: LiveEvent) => void>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly log: (msg: string) => void = (m) => console.error(`[live] ${m}`),
  ) {}

  async publish(tripId: string, event: LiveEvent): Promise<void> {
    await this.pool.query('select pg_notify($1, $2)', [CHANNEL, JSON.stringify({ trip_id: tripId, ...event })]);
  }

  subscribe(fn: (tripId: string, event: LiveEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /**
   * Listens on one connection of its own. If that connection drops (a database restart, a network blip), it
   * listens again on a new one, after 1, 2, 5, 10, then every 30 seconds, so live updates do not stop silently.
   */
  async listen(): Promise<void> {
    if (this.closed) return;
    const client = await this.pool.connect();
    this.listener = client;
    client.on('notification', (n) => {
      if (n.channel !== CHANNEL || !n.payload) return;
      const { trip_id, ...event } = JSON.parse(n.payload);
      for (const fn of this.subscribers) fn(trip_id, event as LiveEvent);
    });
    let lost = false;
    const onLost = (why: string) => {
      if (lost || this.closed) return;
      lost = true;
      this.log(`listen connection lost (${why}); listening again`);
      client.removeAllListeners('notification');
      client.release(true);
      if (this.listener === client) this.listener = null;
      this.again(0);
    };
    client.on('error', (err) => onLost(err.message));
    client.on('end', () => onLost('ended'));
    await client.query(`listen ${CHANNEL}`);
  }

  private again(attempt: number): void {
    const wait = [1, 2, 5, 10, 30][Math.min(attempt, 4)]! * 1000;
    this.retry = setTimeout(() => {
      this.listen().catch((err) => {
        this.log(`listen failed: ${(err as Error).message}`);
        this.again(attempt + 1);
      });
    }, wait);
  }

  /** Stops listening. The connection is destroyed, not returned to the pool, so it cannot keep a stale LISTEN. */
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.retry);
    this.listener?.removeAllListeners('notification');
    this.listener?.removeAllListeners('error');
    this.listener?.removeAllListeners('end');
    this.listener?.release(true);
    this.listener = null;
  }
}
