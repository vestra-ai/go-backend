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

/** Until real delivery exists: writes the push to the log. */
export class LogPush implements Push {
  constructor(private readonly log: (msg: string) => void = console.log) {}

  async send(personIds: string[], n: Notification): Promise<void> {
    if (personIds.length === 0) return;
    this.log(`push to ${personIds.join(',')}: ${n.body.slice(0, 80)}`);
  }
}
