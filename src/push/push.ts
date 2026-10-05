import type pg from 'pg';

export interface Notification {
  /** Go's text, a card's fallback_text, or the question of a vote about to close. */
  body: string;
  /** So a tap opens the room at that message. */
  data: { trip_id: string; message_id?: string };
}

/**
 * Pushes go out only when someone needs to look now (guides/app.md, "Pushes"): Go names them, a new
 * card needs them, a vote is about to close for them, or they owe money. Never for every message.
 */
export interface Push {
  send(personIds: string[], notification: Notification): Promise<void>;
}

/** Until a provider (FCM or APNs) is chosen: writes the push to the log. */
export class LogPush implements Push {
  constructor(
    private readonly pool: pg.Pool,
    private readonly log: (msg: string) => void = console.log,
  ) {}

  async send(personIds: string[], n: Notification): Promise<void> {
    if (personIds.length === 0) return;
    const { rows } = await this.pool.query('select token, platform, person_id from push_devices where person_id = any($1)', [personIds]);
    this.log(`push to ${personIds.join(',')} (${rows.length} devices): ${n.body.slice(0, 80)}`);
  }
}
