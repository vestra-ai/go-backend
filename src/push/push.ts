// What a push carries (app contract §8, without `badge_count`: APP-CONTRACT-CHANGES §8). The service worker shows
// `title` and `body`, routes `deep_link` on a tap and dedupes with `tag`. Never a vault link, never a signed file link.

export type PushType = 'mention' | 'card' | 'vote_closing' | 'owe' | 'settlement' | 'nudge' | 'joined' | 'expense' | 'checkin';

/** The payload as the browser receives it. Identical for every platform the product may add later. */
export interface PushPayload {
  type: PushType;
  trip_id: string;
  /** So a tap opens the room at that message, when the push is about one. */
  message_id?: string;
  /** The trip's title. */
  title: string;
  body: string;
  /** `/trips/<trip>/chat?msg=<message>` for a message, `/trips/<trip>/expenses` for money, `/trips/<trip>` otherwise. */
  deep_link: string;
  /** `<trip>:<message>` or `<trip>:<type>:<id>`: the same thing twice collapses into one notification. */
  tag: string;
}

/**
 * The shape pushes had before phase 4: the text and where a tap goes. Still accepted by every sender, so a call site that
 * has not moved yet (and the money phase's `settlement` and `expense` pushes, written at the same time as this) keeps
 * working: the sender fills in the trip's title and the rest. `data.type` names the type when the caller knows it; without
 * it a push about a message is a `mention` and any other is a `nudge` (today's only legacy caller without a message).
 */
export interface LegacyNotification {
  body: string;
  data: { trip_id: string; message_id?: string; type?: PushType };
}

export type Notification = PushPayload | LegacyNotification;

export const isLegacyNotification = (n: Notification): n is LegacyNotification => 'data' in n;

/** The push types whose tap lands on the Expenses tab. */
const MONEY: ReadonlySet<PushType> = new Set(['owe', 'settlement', 'nudge', 'expense']);

export const deepLinkFor = (type: PushType, tripId: string, messageId?: string): string =>
  messageId ? `/trips/${tripId}/chat?msg=${messageId}` : MONEY.has(type) ? `/trips/${tripId}/expenses` : `/trips/${tripId}`;

export const tagFor = (type: PushType, tripId: string, messageId?: string, id?: string): string =>
  messageId ? `${tripId}:${messageId}` : `${tripId}:${type}${id ? `:${id}` : ''}`;

export interface PushInput {
  type: PushType;
  trip_id: string;
  /** The trip's title. */
  title: string;
  body: string;
  message_id?: string;
  /** The thing the push is about when it is not a message (a vote, a payee, a joiner): part of the tag. */
  id?: string;
}

/** The payload for a push: the text cut to 300 characters (by characters, so a pair is never cut in half), the link and the tag. */
export function pushPayload(input: PushInput): PushPayload {
  return {
    type: input.type,
    trip_id: input.trip_id,
    ...(input.message_id ? { message_id: input.message_id } : {}),
    title: input.title,
    body: Array.from(input.body).slice(0, 300).join(''),
    deep_link: deepLinkFor(input.type, input.trip_id, input.message_id),
    tag: tagFor(input.type, input.trip_id, input.message_id, input.id),
  };
}

/** A legacy notification as the new payload, once the trip's title is known. */
export function upgradeNotification(n: LegacyNotification, title: string): PushPayload {
  const type = n.data.type ?? (n.data.message_id ? 'mention' : 'nudge');
  return pushPayload({ type, trip_id: n.data.trip_id, title, body: n.body, message_id: n.data.message_id });
}

/**
 * Pushes go out only when someone needs to look now (app contract §8): Go names them, a new card needs them, a vote is
 * about to close for them, they owe money, someone paid them or nudged them, a friend joined their trip. Never for every
 * message. Callers go through `sendPush` (src/push/send.ts), which drops people whose notifications are off.
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
    const type = isLegacyNotification(n) ? n.data.type ?? 'legacy' : n.type;
    this.log(`push (${type}) to ${personIds.join(',')}: ${n.body.slice(0, 80)}`);
  }
}
