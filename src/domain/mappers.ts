// Rows from our database as the contract's objects, the way Go may see them.
import { isContractUri } from '../contract/index.js';
import type { Ledger } from './ledger-lines.js';
import type { Actor, Booking, Decision, Expense, Mandate, Message, Person, Reaction, RecordLine } from './types.js';

export const iso = (d: Date | string | null | undefined): string | undefined =>
  d === null || d === undefined ? undefined : new Date(d).toISOString();

/** Leaves out null members: null and missing mean the same, and the contract objects stay small. */
export function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as T;
}

export interface MessageRow {
  message_id: string; trip_id: string; seq: number; updated_seq: number; author_kind: 'person' | 'go' | 'system'; author_person_id: string | null;
  text: string | null; attachments: unknown[]; reply_to: string | null; about_message_id: string | null;
  mentions_go: boolean; mentions: string[]; card: unknown | null; withheld: boolean; deleted: boolean;
  edited_at: Date | null; sent_at: Date;
  /** Go's chips under its message (GO-CHANGES 1.3), as sent; null when none. */
  quick_replies: unknown[] | null;
  /** A money line's app-only member (rev 4 §5.3): which movement and which row. Never sent to Go. */
  ledger?: Ledger | null;
  /** Who may see the message in the app (official since 1.2, migration 013); null is everyone. Go sees every message, with this list. */
  visible_to_person_ids?: string[] | null;
}
export interface ReactionRow { message_id: string; person_id: string | null; emoji: string }

export const reactionOf = (r: ReactionRow): Reaction => compact({ emoji: r.emoji, person_id: r.person_id ?? undefined });

/** True when this person may see the message in the app: it has no list, or the list names them. */
export const visibleTo = (row: Pick<MessageRow, 'visible_to_person_ids'>, personId: string): boolean =>
  !row.visible_to_person_ids || row.visible_to_person_ids.includes(personId);

/**
 * The same test in SQL, for a query on `messages` (or on `alias.`): `param` is the placeholder holding the reader's
 * person id. Every app read of the room uses it, so a person outside the list never learns the message exists.
 */
export const visibleSql = (param: string, alias = ''): string => `(${alias}visible_to_person_ids is null or ${alias}visible_to_person_ids ? ${param})`;

export const actorOf = (row: Pick<MessageRow, 'author_kind' | 'author_person_id'>): Actor =>
  // openapi-typescript names the discriminator values after the schemas, so the literal needs a cast.
  (row.author_kind === 'person' ? { kind: 'person', person_id: row.author_person_id! } : { kind: row.author_kind }) as unknown as Actor;

/**
 * A message as Go may see it. A deleted message has no text. A message from someone who paused
 * Go keeps its change number but has no words, attachments, mentions or "ask Go about this".
 */
export function messageForGo(row: MessageRow, reactions: ReactionRow[]): Message {
  const hidden = row.deleted || row.withheld;
  return compact({
    message_id: row.message_id,
    seq: row.seq,
    updated_seq: row.updated_seq,
    author: actorOf(row),
    text: hidden ? undefined : row.text ?? undefined,
    attachments: hidden ? [] : (row.attachments as Message['attachments']),
    reply_to: row.withheld ? undefined : row.reply_to ?? undefined,
    about_message_id: row.withheld ? undefined : row.about_message_id ?? undefined,
    mentions_go: row.withheld ? false : row.mentions_go,
    mentions: row.withheld ? [] : row.mentions,
    reactions: reactions.map(reactionOf),
    card: (row.card as Message['card']) ?? undefined,
    quick_replies: row.quick_replies ?? undefined, // 1.1
    visible_to_person_ids: row.visible_to_person_ids ?? undefined, // official since 1.2: Go sees every message, and whom it is for
    withheld: row.withheld,
    deleted: row.deleted,
    edited_at: iso(row.edited_at),
    sent_at: iso(row.sent_at)!,
  }) as Message;
}

export interface PersonRow {
  person_id: string; name: string; photo_url: string | null; upi_id: string | null; role: 'organizer' | 'member';
  joined_at: Date; from_city: string | null; earliest_leave: string | null; know: string[]; go_paused: boolean;
}

/**
 * A person as Go may see them: no phone, email or UPI id. A stored photo link that fails the contract's
 * own URL test (older sign-ups were not checked) is left out: sent as it is, it would make every event about that person invalid.
 */
export const personForGo = (r: PersonRow): Person =>
  compact({
    person_id: r.person_id,
    name: r.name,
    photo_url: isContractUri(r.photo_url) ? r.photo_url : undefined,
    role: r.role,
    joined_at: iso(r.joined_at)!,
    from_city: r.from_city ?? undefined,
    earliest_leave: r.earliest_leave ?? undefined,
    know: r.know,
    has_upi: !!r.upi_id,
    go_paused: r.go_paused,
  }) as Person;

export interface DecisionRow {
  decision_id: string; question: string; kind: 'choice' | 'yesno'; anonymous: boolean; status: 'open' | 'closed' | 'cancelled';
  opened_by_person_id: string | null; options: unknown[]; of_count: number; closes_at: Date | null; closed_at: Date | null;
  result_index: number | null; mandate: Mandate | null; opened_at: Date;
  /** Only the Server uses this link; it is never in an event or a snapshot. */
  cancels_booking_id: string | null;
}
/** A vote: for one option, or "I'm flexible" (GO-CHANGES 1.5), which counts toward `voted` and names no option. */
export interface VoteRow { person_id: string; option_index: number | null; flexible: boolean }

/** The option a vote names, by index. A flexible vote names none. */
export const tallyOf = (optionCount: number, votes: VoteRow[]): number[] => Array.from({ length: optionCount }, (_, i) => votes.filter((v) => v.option_index === i).length);

/** An anonymous vote shows totals only: no `votes` list, to anyone, Go included. Flexible voters are in `voted` and `flexible_count`, never in `votes`. */
export function decisionOf(r: DecisionRow, votes: VoteRow[]): Decision {
  const tally = tallyOf((r.options as unknown[]).length, votes);
  const flexible = votes.filter((v) => v.flexible).length;
  return compact({
    decision_id: r.decision_id,
    question: r.question,
    kind: r.kind,
    anonymous: r.anonymous,
    status: r.status,
    opened_by_person_id: r.opened_by_person_id ?? undefined,
    options: r.options as Decision['options'],
    closes_at: iso(r.closes_at),
    voted: votes.length,
    of: r.of_count,
    tally,
    flexible_count: flexible || undefined,
    votes: r.anonymous ? undefined : votes.filter((v) => !v.flexible).map((v) => ({ person_id: v.person_id, option_index: v.option_index! })),
    result_index: r.result_index ?? undefined,
    mandate: r.mandate ?? undefined,
    opened_at: iso(r.opened_at)!,
    closed_at: iso(r.closed_at),
  }) as Decision;
}

/** A leg of a journey as the contract has it (Journey): what the itinerary wording is built from. */
export interface JourneyLike {
  mode: string; origin: { name: string; code?: string }; destination: { name: string; code?: string };
  depart_at: string; arrive_at: string; carrier_name?: string; carrier_code?: string; number?: string;
}
/** One covered person's seat and PNR (GO-CHANGES 1.7). */
export interface Passenger { person_id: string; seat?: string; pnr?: string }

export interface BookingRow {
  booking_id: string; kind: string; status: 'confirmed' | 'cancelled'; title: string; vendor: string; ref: string;
  amount_minor: number; currency: string; payer_person_id: string; for_person_ids: string[]; refundable_until: Date | null;
  starts_at: Date | null; ends_at: Date | null; journey: JourneyLike | null; place: unknown | null; image_url: string | null;
  decision_id: string | null; approval_id: string | null; added_by_person_id: string | null; created_at: Date;
  /** GO-CHANGES 1.7 (migration 008): detail rows, the return leg, and who sits where. `passengers` is per-person data (app contract §1.7). */
  details: unknown[] | null; return_journey: JourneyLike | null; passengers: Passenger[] | null;
}

/** A booking as Go may see it: everything stored. Documents are not here (they live in booking_documents and are served by link; see src/domain/bookings.ts). */
export const bookingOf = (r: BookingRow): Booking =>
  compact({
    booking_id: r.booking_id, kind: r.kind, status: r.status, title: r.title, vendor: r.vendor, ref: r.ref,
    amount_minor: r.amount_minor, currency: r.currency, payer_person_id: r.payer_person_id, for_person_ids: r.for_person_ids,
    refundable_until: iso(r.refundable_until), starts_at: iso(r.starts_at), ends_at: iso(r.ends_at),
    journey: r.journey ?? undefined, place: r.place ?? undefined, image_url: r.image_url ?? undefined,
    decision_id: r.decision_id ?? undefined, approval_id: r.approval_id ?? undefined,
    added_by_person_id: r.added_by_person_id ?? undefined, created_at: iso(r.created_at)!,
    details: r.details ?? undefined, return_journey: r.return_journey ?? undefined, passengers: r.passengers ?? undefined,
  }) as unknown as Booking;

export interface ExpenseRow {
  expense_id: string; paid_by_person_id: string; amount_minor: number; currency: string; note: string; category: string;
  split_person_ids: string[]; booking_id: string | null; added_by_person_id: string | null; created_at: Date;
}

export const expenseOf = (r: ExpenseRow): Expense =>
  compact({
    expense_id: r.expense_id, paid_by_person_id: r.paid_by_person_id, amount_minor: r.amount_minor, currency: r.currency,
    note: r.note, category: r.category, split_person_ids: r.split_person_ids, booking_id: r.booking_id ?? undefined,
    added_by_person_id: r.added_by_person_id ?? undefined, created_at: iso(r.created_at)!,
  }) as unknown as Expense;

export interface RecordLineRow {
  line_id: string; kind: string; text: string; status: string; proof: unknown[]; person_ids: string[]; due_at: Date | null;
  decision_id: string | null; booking_id: string | null; source: string; created_at: Date; updated_at: Date;
}

export const recordLineOf = (r: RecordLineRow): RecordLine =>
  compact({
    line_id: r.line_id, kind: r.kind, text: r.text, status: r.status, proof: r.proof, person_ids: r.person_ids,
    due_at: iso(r.due_at), decision_id: r.decision_id ?? undefined, booking_id: r.booking_id ?? undefined,
    source: r.source, created_at: iso(r.created_at)!, updated_at: iso(r.updated_at)!,
  }) as unknown as RecordLine;

/**
 * A message as the app shows it to the room: the text is always there, even when its author paused Go. `former` holds the
 * people who are no longer in the trip (they left, or deleted their account): their messages and reactions say
 * `former: true`, because the app cannot find them among the trip's people and draws "Former member". App only.
 */
export function messageForApp(row: MessageRow, reactions: ReactionRow[], former: ReadonlySet<string> = new Set()): Message {
  const author = actorOf(row);
  return compact({
    message_id: row.message_id,
    seq: row.seq,
    updated_seq: row.updated_seq,
    author: row.author_person_id && former.has(row.author_person_id) ? { ...author, former: true } : author,
    text: row.deleted ? undefined : row.text ?? undefined,
    attachments: row.deleted ? [] : (row.attachments as Message['attachments']),
    reply_to: row.reply_to ?? undefined,
    about_message_id: row.about_message_id ?? undefined,
    mentions_go: row.mentions_go,
    mentions: row.mentions,
    reactions: reactions.map((r) => (r.person_id && former.has(r.person_id) ? { ...reactionOf(r), former: true } : reactionOf(r))),
    card: (row.card as Message['card']) ?? undefined,
    quick_replies: row.quick_replies ?? undefined, // 1.1
    visible_to_person_ids: row.visible_to_person_ids ?? undefined, // the app shows "Only you can see this"
    ledger: row.deleted ? undefined : row.ledger ?? undefined, // app only: `messageForGo` has no such member
    withheld: false, // `withheld` is only for Go
    deleted: row.deleted,
    edited_at: iso(row.edited_at),
    sent_at: iso(row.sent_at)!,
  }) as Message;
}
