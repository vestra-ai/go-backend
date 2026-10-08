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
  /** `/trips/<trip>/chat?msg=<message>` for a message, `/trips/<trip>/expenses` for money, `/trips/<trip>/checkin/<booking>` for check-in, `/trips/<trip>` otherwise. */
  deep_link: string;
  /** `<trip>:<message>` or `<trip>:<type>:<id>`: the same thing twice collapses into one notification. */
  tag: string;
}

/** The push types whose tap lands on the Expenses tab. */
const MONEY: ReadonlySet<PushType> = new Set(['owe', 'settlement', 'nudge', 'expense']);

/** `id` is the booking for a `checkin` push: its tap opens that flight's check-in. */
export const deepLinkFor = (type: PushType, tripId: string, messageId?: string, id?: string): string =>
  messageId ? `/trips/${tripId}/chat?msg=${messageId}` : MONEY.has(type) ? `/trips/${tripId}/expenses` : type === 'checkin' && id ? `/trips/${tripId}/checkin/${id}` : `/trips/${tripId}`;

export const tagFor = (type: PushType, tripId: string, messageId?: string, id?: string): string =>
  messageId ? `${tripId}:${messageId}` : `${tripId}:${type}${id ? `:${id}` : ''}`;

export interface PushInput {
  type: PushType;
  trip_id: string;
  /** The trip's title. */
  title: string;
  body: string;
  message_id?: string;
  /** The thing the push is about when it is not a message (a vote, a payee, an expense, a settlement, a nudger, a joiner, a booking): part of the tag. */
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
    deep_link: deepLinkFor(input.type, input.trip_id, input.message_id, input.id),
    tag: tagFor(input.type, input.trip_id, input.message_id, input.id),
  };
}

/**
 * Pushes go out only when someone needs to look now (app contract §8): Go names them, a new card needs them, a vote is
 * about to close for them, they owe money, an expense needs their approval, someone paid them or nudged them, a friend
 * joined their trip, check-in opened. Never for every message. Every caller goes through `sendPush` (src/push/send.ts),
 * which drops people whose notifications are off and fills in the trip's title: a sender only receives finished payloads.
 */
export interface Push {
  send(personIds: string[], payload: PushPayload): Promise<void>;
  /** Waits (for a bounded time) for notifications still being delivered: called once when the server shuts down. */
  drain?(): Promise<void>;
}

/** Until real delivery exists: writes the push to the log. */
export class LogPush implements Push {
  constructor(private readonly log: (msg: string) => void = console.log) {}

  async send(personIds: string[], p: PushPayload): Promise<void> {
    if (personIds.length === 0) return;
    this.log(`push (${p.type}) to ${personIds.join(',')}: ${p.body.slice(0, 80)}`);
  }
}
