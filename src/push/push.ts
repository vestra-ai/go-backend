/** The app contract's §8 push types. Set on the pushes built since phase 3; the older ones (owe, nudge, mention, card, vote_closing) get theirs in phase 4.7. */
export type PushType = 'mention' | 'card' | 'vote_closing' | 'owe' | 'settlement' | 'nudge' | 'joined' | 'expense' | 'checkin';

export interface Notification {
  /** What the push is about (§8): the app routes a tap by it. */
  type?: PushType;
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
  /** Waits (for a bounded time) for notifications still being delivered: called once when the server shuts down. */
  drain?(): Promise<void>;
}

/** Until real delivery exists: writes the push to the log. */
export class LogPush implements Push {
  constructor(private readonly log: (msg: string) => void = console.log) {}

  async send(personIds: string[], n: Notification): Promise<void> {
    if (personIds.length === 0) return;
    this.log(`push to ${personIds.join(',')}: ${n.body.slice(0, 80)}`);
  }
}
