// Rows from our database as the contract's objects, the way Go may see them.
import { isContractUri } from '../contract/index.js';
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
}
export interface ReactionRow { message_id: string; person_id: string | null; emoji: string }

export const reactionOf = (r: ReactionRow): Reaction => compact({ emoji: r.emoji, person_id: r.person_id ?? undefined });

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
    reply_to: row.reply_to ?? undefined,
    about_message_id: row.withheld ? undefined : row.about_message_id ?? undefined,
    mentions_go: row.withheld ? false : row.mentions_go,
    mentions: row.withheld ? [] : row.mentions,
    reactions: reactions.map(reactionOf),
    card: (row.card as Message['card']) ?? undefined,
    quick_replies: row.quick_replies ?? undefined, // 1.1 overlay: not in the generated 1.0 types yet
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
 * A person as Go may see them: no phone, email or UPI id, no budget answer. A stored photo link that fails the contract's
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

export interface BookingRow {
  booking_id: string; kind: string; status: 'confirmed' | 'cancelled'; title: string; vendor: string; ref: string;
  amount_minor: number; currency: string; payer_person_id: string; for_person_ids: string[]; refundable_until: Date | null;
  starts_at: Date | null; ends_at: Date | null; journey: unknown | null; place: unknown | null; image_url: string | null;
  decision_id: string | null; approval_id: string | null; added_by_person_id: string | null; created_at: Date;
}

export const bookingOf = (r: BookingRow): Booking =>
  compact({
    booking_id: r.booking_id, kind: r.kind, status: r.status, title: r.title, vendor: r.vendor, ref: r.ref,
    amount_minor: r.amount_minor, currency: r.currency, payer_person_id: r.payer_person_id, for_person_ids: r.for_person_ids,
    refundable_until: iso(r.refundable_until), starts_at: iso(r.starts_at), ends_at: iso(r.ends_at),
    journey: r.journey ?? undefined, place: r.place ?? undefined, image_url: r.image_url ?? undefined,
    decision_id: r.decision_id ?? undefined, approval_id: r.approval_id ?? undefined,
    added_by_person_id: r.added_by_person_id ?? undefined, created_at: iso(r.created_at)!,
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

/** A message as the app shows it to the room: the text is always there, even when its author paused Go. */
export function messageForApp(row: MessageRow, reactions: ReactionRow[]): Message {
  return compact({
    message_id: row.message_id,
    seq: row.seq,
    updated_seq: row.updated_seq,
    author: actorOf(row),
    text: row.deleted ? undefined : row.text ?? undefined,
    attachments: row.deleted ? [] : (row.attachments as Message['attachments']),
    reply_to: row.reply_to ?? undefined,
    about_message_id: row.about_message_id ?? undefined,
    mentions_go: row.mentions_go,
    mentions: row.mentions,
    reactions: reactions.map(reactionOf),
    card: (row.card as Message['card']) ?? undefined,
    quick_replies: row.quick_replies ?? undefined, // 1.1 overlay: not in the generated 1.0 types yet
    withheld: false, // `withheld` is only for Go
    deleted: row.deleted,
    edited_at: iso(row.edited_at),
    sent_at: iso(row.sent_at)!,
  }) as Message;
}
