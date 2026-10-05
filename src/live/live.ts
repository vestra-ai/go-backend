import type pg from 'pg';

/** What the app's live connection carries for a trip (guides/app.md, "The live connection"). */
export type LiveEvent =
  /** A message was posted or changed (a reaction, a replaced card). The app reads it by id. */
  | { kind: 'message'; message_id: string; updated_seq: number }
  /** Something in the trip that is not a message changed. The app reads again when `seq` is higher than it holds. */
  | { kind: 'trip'; seq: number }
  /** "Go is typing...". `until` is when it runs out by itself, 10 seconds after Go's notification. */
  | { kind: 'typing'; who: { kind: 'go' } | { kind: 'person'; person_id: string }; on: boolean; until?: string };

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
  private readonly subscribers = new Set<(tripId: string, event: LiveEvent) => void>();

  constructor(private readonly pool: pg.Pool) {}

  async publish(tripId: string, event: LiveEvent): Promise<void> {
    await this.pool.query('select pg_notify($1, $2)', [CHANNEL, JSON.stringify({ trip_id: tripId, ...event })]);
  }

  subscribe(fn: (tripId: string, event: LiveEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  async listen(): Promise<void> {
    const client = await this.pool.connect();
    this.listener = client;
    client.on('notification', (n) => {
      if (n.channel !== CHANNEL || !n.payload) return;
      const { trip_id, ...event } = JSON.parse(n.payload);
      for (const fn of this.subscribers) fn(trip_id, event as LiveEvent);
    });
    await client.query(`listen ${CHANNEL}`);
  }

  /** Stops listening. The connection is destroyed, not returned to the pool, so it cannot keep a stale LISTEN. */
  async close(): Promise<void> {
    this.listener?.removeAllListeners('notification');
    this.listener?.release(true);
    this.listener = null;
  }
}
