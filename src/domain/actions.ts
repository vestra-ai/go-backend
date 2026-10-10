// What people do in the app. Each action is one transaction that takes the trip's next change number,
// writes the change and its event for Go, and then (after the commit) updates phones.
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Ctx } from '../context.js';
import { check } from '../contract/index.js';
import { newId } from '../db/ids.js';
import { once } from '../db/once.js';
import { withTx, type AfterCommit } from '../db/pool.js';
import type { ChangeKind } from '../live/live.js';
import { change, emit, nextSeq } from '../db/write-change.js';
import type { Db } from '../db/pool.js';
import type { PatchTripMeBody } from '../api/bodies.js';
import type { Features } from '../config.js';
import { resolveAttachments } from './attachments.js';
import { checkinItems, checkinOn } from './checkin.js';
import { conflict, invalid, notFound, rateLimited } from './errors.js';
import { knowWithVibe } from './join-answers.js';
import { assertDate } from './limits.js';
import { compact, decisionOf, expenseOf, messageForGo, personForGo, recordLineOf, tallyOf } from './mappers.js';
import type { DecisionRow, ExpenseRow, MessageRow, RecordLineRow, VoteRow } from './mappers.js';
import { loadSettlements } from './ledger.js';
import { moneyOf } from './money.js';
import { loadMessageForApp } from './room.js';
import { activePeople, buildSnapshot } from './snapshot.js';
import { joinedText, leftText, personName, postSystemMessage, tripCreatedText } from './system-messages.js';
import type { Decision, Mandate, Message, Person, RecordLine } from './types.js';
import { closeDecision, lockBooking, lockDecision, votesOf } from './voting.js';

export class Forbidden extends Error {}

/** The person must be in the trip now. */
export async function requireMember(db: pg.Pool | pg.PoolClient, tripId: string, personId: string) {
  const { rows } = await db.query('select * from trip_people where trip_id = $1 and person_id = $2 and left_at is null', [tripId, personId]);
  if (!rows[0]) throw new Forbidden(`${personId} is not in trip ${tripId}`);
  return rows[0] as { role: 'organizer' | 'member'; go_paused: boolean; joined_at: Date; last_seen_at: Date | null };
}

// ---------------------------------------------------------------- people and trips

export interface NewPerson {
  name: string;
  photo_url?: string;
  phone?: string;
  email?: string;
  upi_id?: string;
  /** How they signed in: `dev` for dev tokens (Supabase sign-ins are created in src/api/auth.ts). */
  auth_provider?: string;
}

/**
 * A shared lock on the person's row, taken first. A profile edit holds the row while it tells every trip the person is in,
 * so a join or a new trip that starts meanwhile waits for it and then reads the new name, never the old one.
 * (Lock order: person row first, always.)
 */
export async function lockPersonForRead(db: pg.PoolClient, personId: string): Promise<void> {
  await db.query('select 1 from people where person_id = $1 for share', [personId]);
}

export async function createPerson(ctx: Ctx, input: NewPerson): Promise<{ person_id: string }> {
  const person_id = newId('p');
  await ctx.pool.query('insert into people (person_id, name, photo_url, phone, email, upi_id, auth_provider) values ($1, $2, $3, $4, $5, $6, $7)', [
    person_id, input.name, input.photo_url ?? null, input.phone ?? null, input.email ?? null, input.upi_id ?? null, input.auth_provider ?? null,
  ]);
  return { person_id };
}

export interface NewTrip {
  title?: string;
  /** What the app sends when an idea is tapped: the title when there is no title. */
  destination_hint?: string;
  /** The organizer's own "travelling from", saved as their join answer. */
  from_city?: string;
  destination?: { name: string; [k: string]: unknown };
  dates?: { start: string; end: string };
  vibe?: string[];
  stay?: string;
  plan_minor?: number;
  currency?: string;
}

/** A fresh invite code: random, URL-safe, at least 10 characters (the contract's rule, so codes cannot be guessed). */
export const newInviteCode = () => randomBytes(9).toString('base64url');

/**
 * Creates the trip with the organizer in it, its first invite link, and sends `trip.created` (change number 1) with the whole
 * trip. Everything is optional: the title falls back to the destination hint, then "New trip".
 */
export async function createTrip(ctx: Ctx, organizerId: string, input: NewTrip) {
  if (input.dates) {
    assertDate(input.dates.start, 'dates.start');
    assertDate(input.dates.end, 'dates.end');
    if (input.dates.start > input.dates.end) throw invalid('dates.start must be on or before dates.end');
  }
  const title = input.title ?? input.destination_hint ?? 'New trip';
  return withTx(ctx.pool, async (db, after) => {
    await lockPersonForRead(db, organizerId);
    const trip_id = newId('t');
    const invite_code = newInviteCode();
    await db.query(
      `insert into trips (trip_id, title, organizer_person_id, invite_code, destination, dates_start, dates_end, vibe, stay, plan_minor, currency)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [trip_id, title, organizerId, invite_code, input.destination ? JSON.stringify(input.destination) : null, input.dates?.start ?? null,
       input.dates?.end ?? null, JSON.stringify(input.vibe ?? []), input.stay ?? null, input.plan_minor ?? null, input.currency ?? 'INR'],
    );
    await db.query('insert into invites (code, trip_id, created_by) values ($1, $2, $3)', [invite_code, trip_id, organizerId]);
    await db.query(`insert into trip_people (trip_id, person_id, role, from_city) values ($1, $2, 'organizer', $3)`, [trip_id, organizerId, input.from_city ?? null]);
    const seq = await nextSeq(db, trip_id); // 1
    const trip = await buildSnapshot(db, trip_id, ctx.publicBaseUrl);
    await emit(db, trip_id, seq, 'trip.created', { trip });
    // The room's first line, after the event (so trip.created keeps change 1).
    await postSystemMessage(ctx, db, after, trip_id, tripCreatedText(trip.people[0]!.name));
    after(() => ctx.live.publish(trip_id, { kind: 'trip', seq, kinds: ['trip', 'people'] }));
    after(() => ctx.live.publish(trip_id, { kind: 'home', person_id: organizerId }));
    return { trip_id, invite_url: trip.invite_url, seq };
  });
}

/** The join answers (contract JoinAnswers): the three group-visible ones and the vibe (one `know` entry). */
export type JoinAnswers = PatchTripMeBody;

/** The trip behind an invite code that still works: unknown → 404, rotated away → 409, trip over → 409. */
async function tripForInvite(db: Db, code: string): Promise<string> {
  const row = (await db.query('select i.trip_id, i.revoked_at, t.status from invites i join trips t using (trip_id) where i.code = $1', [code])).rows[0];
  if (!row) throw notFound('no trip for this invite link');
  if (row.revoked_at !== null) throw conflict('this invite link was replaced by a new one: ask for the new link');
  if (row.status === 'over') throw conflict('this trip is over');
  return row.trip_id as string;
}

/**
 * Someone joins with the invite link and answers the join questions. Go gets `person.joined` with those answers.
 * Already in the trip: nothing changes (`already: true`). The joiner's home screen is told to re-read.
 */
export async function joinTrip(ctx: Ctx, code: string, personId: string, answers: JoinAnswers) {
  return withTx(ctx.pool, async (db, after) => {
    await lockPersonForRead(db, personId);
    const tripId = await tripForInvite(db, code);
    const existing = (await db.query('select left_at from trip_people where trip_id = $1 and person_id = $2', [tripId, personId])).rows[0];
    if (existing && existing.left_at === null) {
      const { seq } = (await db.query('select seq from trips where trip_id = $1', [tripId])).rows[0];
      return { trip_id: tripId, seq: seq as number, already: true };
    }
    const know = JSON.stringify(knowWithVibe(answers.know ?? [], answers.vibe));
    const values = [tripId, personId, answers.from_city ?? null, answers.earliest_leave ?? null, know];
    if (existing) {
      await db.query(
        `update trip_people set left_at = null, joined_at = now(), from_city = $3, earliest_leave = $4, know = $5
          where trip_id = $1 and person_id = $2`,
        values,
      );
    } else {
      await db.query(
        `insert into trip_people (trip_id, person_id, role, from_city, earliest_leave, know)
         values ($1, $2, 'member', $3, $4, $5)`,
        values,
      );
    }
    // Someone who joins can vote in the votes that are still open.
    await db.query(
      `update decisions set of_count = of_count + 1
        where trip_id = $1 and status = 'open' and not exists (select 1 from votes v where v.decision_id = decisions.decision_id and v.person_id = $2)`,
      [tripId, personId],
    );
    const people = await activePeople(db, tripId);
    const person = people.find((p) => p.person_id === personId)!;
    const seq = await change(db, tripId, 'person.joined', { person: personForGo(person) });
    await postSystemMessage(ctx, db, after, tripId, joinedText(person.name)); // after the events, so they keep adjacent numbers
    after(() => ctx.live.publish(tripId, { kind: 'trip', seq, kinds: ['people'] }));
    publishHome(ctx, after, tripId, people.map((p) => p.person_id)); // the joiner's home gains the trip; everyone's card shows one more face
    return { trip_id: tripId, seq, already: false };
  });
}

export async function leaveTrip(ctx: Ctx, tripId: string, personId: string) {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    await db.query('update trip_people set left_at = now() where trip_id = $1 and person_id = $2', [tripId, personId]);
    // Someone who left can no longer vote, so an open vote no longer waits for them.
    await db.query(
      `update decisions set of_count = greatest(1, of_count - 1)
        where trip_id = $1 and status = 'open' and not exists (select 1 from votes v where v.decision_id = decisions.decision_id and v.person_id = $2)`,
      [tripId, personId],
    );
    // A vote that completes below may be about cancelling a booking: hold those bookings (in a fixed order) before this path
    // takes a change number, as the closing code expects.
    await db.query(
      `select booking_id from bookings
        where trip_id = $1 and booking_id in (select cancels_booking_id from decisions where trip_id = $1 and status = 'open' and cancels_booking_id is not null)
        order by booking_id for update`,
      [tripId],
    );
    const seq = await change(db, tripId, 'person.left', { person_id: personId });
    await postSystemMessage(ctx, db, after, tripId, leftText(await personName(db, personId)));
    const lastSeq = seq;
    const kinds: ChangeKind[] = ['people'];
    after(() => ctx.live.publish(tripId, { kind: 'trip', seq: lastSeq, kinds }));
    publishHome(ctx, after, tripId, [personId, ...(await activePeople(db, tripId)).map((p) => p.person_id)]);
    // A vote that was only waiting for the person who left has now been voted on by everyone.
    const ready = await db.query(
      `select d.decision_id from decisions d where d.trip_id = $1 and d.status = 'open'
          and d.of_count <= (select count(*) from votes v where v.decision_id = d.decision_id)`,
      [tripId],
    );
    for (const r of ready.rows) await closeDecision(ctx, db, after, tripId, r.decision_id, 'everyone_voted');
    return { seq };
  });
}

/** "Pause Go in this trip": the person's later messages still reach Go, as `withheld`, with no words. Answers the person's own Person (whole) plus the change number. */
export async function setGoPaused(ctx: Ctx, tripId: string, personId: string, paused: boolean): Promise<Person & { seq: number }> {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    await db.query('update trip_people set go_paused = $3 where trip_id = $1 and person_id = $2', [tripId, personId, paused]);
    const person = personForGo((await activePeople(db, tripId)).find((p) => p.person_id === personId)!);
    const seq = await change(db, tripId, 'person.updated', { person, changed: ['go_paused'] });
    after(() => ctx.live.publish(tripId, { kind: 'trip', seq, kinds: ['people'] }));
    return { ...person, seq };
  });
}

/** `home_changed` for each of these people, after the commit (app contract §3.1: the home screen's data moved). */
export function publishHome(ctx: Ctx, after: AfterCommit, tripId: string, personIds: string[]): void {
  for (const person_id of new Set(personIds)) after(() => ctx.live.publish(tripId, { kind: 'home', person_id }));
}

// ---------------------------------------------------------------- messages

/** True when the text @mentions Go or starts by addressing it, or the message replies to Go or asks Go about a message. */
export function mentionsGo(text: string | undefined, repliesToGo: boolean, aboutMessage: boolean): boolean {
  return repliesToGo || aboutMessage || /(^|\s)@go\b/i.test(text ?? '') || /^\s*(hey |ok |okay )?go[,:!]/i.test(text ?? '');
}

export interface NewMessage {
  /** The app's own id for this message, unique per (trip, person): a retry does not post twice and gets the same Message back. */
  client_message_id: string;
  text?: string;
  /** `{ upload_id, caption? }` for a file the app uploaded, or a contract Attachment (a shared location, a link). */
  attachments?: unknown[];
  reply_to?: string;
  about_message_id?: string;
  mentions?: string[];
}

/** App contract §4.6: 30 messages per minute per person per trip. */
export const MESSAGES_PER_MINUTE = 30;

/**
 * A person posts in the room. Stored once per (trip, person, client_message_id): a repeat gets the first answer, the
 * stored Message. Go gets `message.created` in the same transaction; the room sees it live after the commit.
 */
export async function postPersonMessage(ctx: Ctx, tripId: string, personId: string, input: NewMessage): Promise<Message> {
  const stored = await once(ctx.pool, tripId, `app:msg:${personId}:${input.client_message_id}`, async (db, after) => {
    const member = await requireMember(db, tripId, personId);
    if (!input.text && !(input.attachments?.length)) throw invalid('text or an attachment is required', 'text');
    const recent = (await db.query(
      `select count(*)::int as n from messages where trip_id = $1 and author_person_id = $2 and sent_at > now() - interval '1 minute'`,
      [tripId, personId],
    )).rows[0].n as number;
    const perMinute = ctx.limits?.messagesPerMinute ?? MESSAGES_PER_MINUTE;
    if (recent >= perMinute) throw rateLimited(`at most ${perMinute} messages a minute: wait a little`, 10);
    const attachments = await resolveAttachments(ctx, db, personId, input.attachments ?? []);
    const mentions = [...new Set(input.mentions ?? [])];
    if (mentions.length) {
      const found = await db.query('select person_id from trip_people where trip_id = $1 and left_at is null and person_id = any($2)', [tripId, mentions]);
      const have = new Set(found.rows.map((r) => r.person_id as string));
      const i = mentions.findIndex((id) => !have.has(id));
      if (i >= 0) throw invalid(`mentions[${i}]: ${mentions[i]} is not in the trip`, `mentions[${i}]`);
    }
    let repliesToGo = false;
    for (const [field, ref] of [['reply_to', input.reply_to], ['about_message_id', input.about_message_id]] as const) {
      if (!ref) continue;
      const m = (await db.query('select author_kind from messages where trip_id = $1 and message_id = $2', [tripId, ref])).rows[0];
      if (!m) throw invalid(`${field}: message ${ref} is not in this trip`, field);
      if (field === 'reply_to' && m.author_kind === 'go') repliesToGo = true;
    }
    const seq = await nextSeq(db, tripId);
    const row = (await db.query<MessageRow>(
      `insert into messages (message_id, trip_id, seq, updated_seq, author_kind, author_person_id, text, attachments, reply_to, about_message_id, mentions_go, mentions, withheld)
       values ($1,$2,$3,$3,'person',$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [newId('m'), tripId, seq, personId, input.text ?? null, JSON.stringify(attachments), input.reply_to ?? null, input.about_message_id ?? null,
       mentionsGo(input.text, repliesToGo, !!input.about_message_id), JSON.stringify(mentions), member.go_paused],
    )).rows[0]!;
    // Go gets the message as it may see it: a person who paused Go has `withheld: true` and no words.
    await emit(db, tripId, seq, 'message.created', { message: messageForGo(row, []) });
    after(() => ctx.live.publish(tripId, { kind: 'message', message_id: row.message_id, updated_seq: seq }));
    return { message_id: row.message_id };
  });
  return loadMessageForApp(ctx, ctx.pool, tripId, stored.message_id);
}

async function ownMessage(db: pg.PoolClient, tripId: string, personId: string, messageId: string): Promise<MessageRow> {
  const row = (await db.query<MessageRow>('select * from messages where trip_id = $1 and message_id = $2 for update', [tripId, messageId])).rows[0];
  if (!row) throw notFound(`message ${messageId} does not exist`);
  if (row.author_person_id !== personId) throw new Forbidden('only the author can change a message');
  if (row.deleted) throw conflict('the message is deleted');
  return row;
}

export async function editMessage(ctx: Ctx, tripId: string, personId: string, messageId: string, text: string): Promise<Message> {
  return withTx(ctx.pool, async (db, after) => {
    const member = await requireMember(db, tripId, personId);
    await ownMessage(db, tripId, personId, messageId);
    const seq = await nextSeq(db, tripId);
    // Words written while Go is paused must not reach Go, even in an edit of an older message.
    const row = (await db.query<MessageRow>('update messages set text = $2, edited_at = now(), updated_seq = $3, withheld = withheld or $4 where message_id = $1 returning *', [messageId, text, seq, member.go_paused])).rows[0]!;
    const reactions = (await db.query('select message_id, person_id, emoji from reactions where message_id = $1 order by created_at', [messageId])).rows;
    await emit(db, tripId, seq, 'message.edited', { message: messageForGo(row, reactions) });
    after(() => ctx.live.publish(tripId, { kind: 'message', message_id: messageId, updated_seq: seq }));
    return loadMessageForApp(ctx, db, tripId, messageId);
  });
}

export async function deleteMessage(ctx: Ctx, tripId: string, personId: string, messageId: string): Promise<Message> {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    await ownMessage(db, tripId, personId, messageId);
    const seq = await nextSeq(db, tripId);
    await db.query(`update messages set deleted = true, text = null, attachments = '[]', updated_seq = $2 where message_id = $1`, [messageId, seq]);
    await emit(db, tripId, seq, 'message.deleted', { message_id: messageId });
    after(() => ctx.live.publish(tripId, { kind: 'message', message_id: messageId, updated_seq: seq }));
    return loadMessageForApp(ctx, db, tripId, messageId);
  });
}

/**
 * One reaction per person per message (app contract §4.6): `emoji` sets or replaces it, `null` takes it back. A change
 * of emoji is two changes for Go (`reaction.removed`, then `reaction.added`), each with its own number; the message's
 * `updated_seq` is the last. The same emoji again, or `null` with none, changes nothing.
 */
export async function setReaction(ctx: Ctx, tripId: string, personId: string, messageId: string, emoji: string | null): Promise<Message> {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    const m = (await db.query('select deleted from messages where trip_id = $1 and message_id = $2 for update', [tripId, messageId])).rows[0];
    if (!m) throw notFound(`message ${messageId} does not exist`);
    if (m.deleted) throw conflict('the message is deleted');
    const current = (await db.query('select emoji from reactions where message_id = $1 and person_id = $2', [messageId, personId])).rows[0]?.emoji as string | undefined;
    if (current === (emoji ?? undefined)) return loadMessageForApp(ctx, db, tripId, messageId);
    let seq: number | undefined;
    if (current !== undefined) {
      await db.query('delete from reactions where message_id = $1 and person_id = $2', [messageId, personId]);
      seq = await change(db, tripId, 'reaction.removed', { message_id: messageId, reaction: { emoji: current, person_id: personId } });
    }
    if (emoji !== null) {
      await db.query('insert into reactions (trip_id, message_id, person_id, emoji) values ($1,$2,$3,$4)', [tripId, messageId, personId, emoji]);
      seq = await change(db, tripId, 'reaction.added', { message_id: messageId, reaction: { emoji, person_id: personId } });
    }
    await db.query('update messages set updated_seq = $1 where message_id = $2', [seq, messageId]);
    const last = seq!;
    after(() => ctx.live.publish(tripId, { kind: 'message', message_id: messageId, updated_seq: last }));
    return loadMessageForApp(ctx, db, tripId, messageId);
  });
}

// ---------------------------------------------------------------- votes, mandates and the record

/**
 * A Decision as the app reads it: the contract's object plus this person's own vote (app contract §4.8) and, on a vote about
 * cancelling a booking, `cancels_booking_id` (as the TripView's decisions and the needs-you target carry it; Go never sees it).
 */
export type DecisionForPerson = Decision & { my_vote: { option_index: number } | { flexible: true } | null; cancels_booking_id?: string };

const myVoteOf = (votes: VoteRow[], personId: string): DecisionForPerson['my_vote'] => {
  const mine = votes.find((v) => v.person_id === personId);
  return !mine ? null : mine.flexible ? { flexible: true } : { option_index: mine.option_index! };
};

export const decisionForPerson = (row: DecisionRow, votes: VoteRow[], personId: string): DecisionForPerson => ({
  ...decisionOf(row, votes),
  ...(row.cancels_booking_id ? { cancels_booking_id: row.cancels_booking_id } : {}),
  my_vote: myVoteOf(votes, personId),
});

export async function getDecision(ctx: Ctx, tripId: string, personId: string, decisionId: string): Promise<DecisionForPerson> {
  const row = (await ctx.pool.query<DecisionRow>('select * from decisions where decision_id = $1 and trip_id = $2', [decisionId, tripId])).rows[0];
  if (!row) throw notFound(`decision ${decisionId} does not exist in trip ${tripId}`);
  return decisionForPerson(row, await votesOf(ctx.pool, decisionId), personId);
}

/** `decision.voted` for Go: an anonymous vote's event has totals only (no person, no option). Flexible and retracted are said either way. */
const votedEvent = (d: DecisionRow, votes: VoteRow[], personId: string, mine: { option_index?: number; flexible?: true; retracted?: true }) => ({
  decision_id: d.decision_id,
  ...(d.anonymous ? {} : { person_id: personId }),
  ...(d.anonymous && mine.option_index !== undefined ? {} : mine),
  voted: votes.length,
  of: d.of_count,
  tally: tallyOf(d.options.length, votes),
});

/**
 * A person's vote, for an option or "I'm flexible" (GO-CHANGES 1.5): they may change it until the vote closes. Closes
 * the vote when everyone has voted. A flexible vote counts toward `voted` and leaves the tally alone.
 */
export async function castVote(ctx: Ctx, tripId: string, personId: string, decisionId: string, choice: { option_index: number } | { flexible: true }): Promise<DecisionForPerson> {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    const d = await lockDecision(db, tripId, decisionId);
    if (d.status !== 'open') throw conflict(`decision ${decisionId} is ${d.status}`);
    // A vote about cancelling a booking may close below: hold the booking before this path takes a change number.
    if (d.cancels_booking_id) await lockBooking(db, tripId, d.cancels_booking_id);
    const flexible = 'flexible' in choice;
    const optionIndex = flexible ? null : choice.option_index;
    if (!flexible && (!Number.isInteger(optionIndex) || optionIndex! < 0 || optionIndex! >= d.options.length)) throw invalid('option_index is not one of the options', 'option_index');
    await db.query(
      `insert into votes (decision_id, person_id, option_index, flexible) values ($1,$2,$3,$4)
       on conflict (decision_id, person_id) do update set option_index = excluded.option_index, flexible = excluded.flexible, voted_at = now()`,
      [decisionId, personId, optionIndex, flexible],
    );
    const votes = await votesOf(db, decisionId);
    const seq = await change(db, tripId, 'decision.voted', votedEvent(d, votes, personId, flexible ? { flexible: true } : { option_index: optionIndex! }));
    after(() => ctx.live.publish(tripId, { kind: 'trip', seq, kinds: ['decision'] }));
    const closed = votes.length >= d.of_count ? await closeDecision(ctx, db, after, tripId, decisionId, 'everyone_voted') : null;
    return closed ? { ...closed.decision, my_vote: myVoteOf(votes, personId) } : decisionForPerson(d, votes, personId);
  });
}

/** Takes a vote back (GO-CHANGES 1.9): `decision.voted` with `retracted: true` and the new totals. Behind `features.vote_retract`. */
export async function retractVote(ctx: Ctx, tripId: string, personId: string, decisionId: string): Promise<DecisionForPerson> {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    const d = await lockDecision(db, tripId, decisionId);
    if (d.status !== 'open') throw conflict(`decision ${decisionId} is ${d.status}`);
    const gone = await db.query('delete from votes where decision_id = $1 and person_id = $2', [decisionId, personId]);
    if (!gone.rowCount) throw conflict('you have not voted');
    const votes = await votesOf(db, decisionId);
    const seq = await change(db, tripId, 'decision.voted', votedEvent(d, votes, personId, { retracted: true }));
    after(() => ctx.live.publish(tripId, { kind: 'trip', seq, kinds: ['decision'] }));
    return decisionForPerson(d, votes, personId);
  });
}

/** App contract §4.8: closing or calling off a vote is for the organizer or the person who opened it. */
async function requireOrganizerOrOpener(db: pg.PoolClient, tripId: string, personId: string, d: DecisionRow): Promise<void> {
  const trip = (await db.query('select organizer_person_id from trips where trip_id = $1', [tripId])).rows[0];
  if (trip?.organizer_person_id !== personId && d.opened_by_person_id !== personId) throw new Forbidden('only the organizer or the person who opened the vote can do that');
}

/** The organizer or the opener closes a vote early. */
export async function closeVoteByPerson(ctx: Ctx, tripId: string, personId: string, decisionId: string): Promise<DecisionForPerson> {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    await requireOrganizerOrOpener(db, tripId, personId, await lockDecision(db, tripId, decisionId));
    const { decision } = await closeDecision(ctx, db, after, tripId, decisionId, 'closed_by_person');
    return { ...decision, my_vote: myVoteOf(await votesOf(db, decisionId), personId) };
  });
}

export async function cancelDecision(ctx: Ctx, tripId: string, personId: string, decisionId: string): Promise<DecisionForPerson> {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    const d = await lockDecision(db, tripId, decisionId);
    await requireOrganizerOrOpener(db, tripId, personId, d);
    if (d.status !== 'open') throw conflict(`decision ${decisionId} is ${d.status}`);
    const row = (await db.query<DecisionRow>(`update decisions set status = 'cancelled' where decision_id = $1 returning *`, [decisionId])).rows[0]!;
    const seq = await change(db, tripId, 'decision.cancelled', { decision_id: decisionId, by: { kind: 'person', person_id: personId } });
    after(() => ctx.live.publish(tripId, { kind: 'trip', seq, kinds: ['decision'] }));
    return decisionForPerson(row, await votesOf(db, decisionId), personId);
  });
}

/** The mandate card's buttons belong to the server: only the payer can tap them, and they are part of the spend check. */
export async function answerMandate(ctx: Ctx, tripId: string, personId: string, decisionId: string, answer: 'confirm' | 'decline'): Promise<Mandate> {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    const d = await lockDecision(db, tripId, decisionId);
    const m = d.mandate as (typeof d.mandate & { confirmed_at?: string; declined_at?: string }) | null;
    if (!m) throw conflict(`decision ${decisionId} has no mandate`);
    if (m.payer_person_id !== personId) throw new Forbidden('only the payer can answer the mandate');
    const next = answer === 'confirm' ? { ...m, confirmed_at: new Date().toISOString() } : { ...m, declined_at: new Date().toISOString() };
    await db.query('update decisions set mandate = $2 where decision_id = $1', [decisionId, JSON.stringify(next)]);
    const seq = await change(db, tripId, answer === 'confirm' ? 'mandate.confirmed' : 'mandate.declined', { decision_id: decisionId, person_id: personId });
    after(() => ctx.live.publish(tripId, { kind: 'trip', seq, kinds: ['mandate'] }));
    return next as Mandate;
  });
}

/** The trip record (app contract §4.8): active and done lines, oldest first; undone lines too when asked. `seq` is read with them. */
export async function getRecord(ctx: Ctx, tripId: string, includeUndone: boolean): Promise<{ lines: RecordLine[]; seq: number }> {
  const db = await ctx.pool.connect();
  try {
    await db.query('begin transaction isolation level repeatable read read only');
    const seq = (await db.query('select seq from trips where trip_id = $1', [tripId])).rows[0]?.seq as number | undefined;
    if (seq === undefined) throw notFound(`trip ${tripId} does not exist`);
    const { rows } = await db.query<RecordLineRow>(
      `select * from record_lines where trip_id = $1 ${includeUndone ? '' : "and status <> 'undone'"} order by created_at, line_id`,
      [tripId],
    );
    await db.query('commit');
    return { lines: rows.map(recordLineOf), seq };
  } catch (err) {
    await db.query('rollback').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

async function lockLine(db: pg.PoolClient, tripId: string, lineId: string): Promise<RecordLineRow> {
  const cur = (await db.query<RecordLineRow>('select * from record_lines where trip_id = $1 and line_id = $2 for update', [tripId, lineId])).rows[0];
  if (!cur) throw notFound(`line ${lineId} does not exist`);
  return cur;
}

/** Anyone in the trip can undo a line. Go never undoes one and never writes it back on its own. Already undone: the line, unchanged. */
export async function undoRecordLine(ctx: Ctx, tripId: string, personId: string, lineId: string): Promise<RecordLine> {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    const cur = await lockLine(db, tripId, lineId);
    if (cur.status === 'undone') return recordLineOf(cur);
    const line = (await db.query<RecordLineRow>(`update record_lines set status = 'undone', updated_at = now() where line_id = $1 returning *`, [lineId])).rows[0]!;
    const seq = await change(db, tripId, 'record.changed', { line: recordLineOf(line), change: 'undone', by: { kind: 'person', person_id: personId } });
    after(() => ctx.live.publish(tripId, { kind: 'trip', seq, kinds: ['record'] }));
    return recordLineOf(line);
  });
}

/** Takes an undo back: the line is active again (`record.changed` updated). 409 when it was not undone. */
export async function redoRecordLine(ctx: Ctx, tripId: string, personId: string, lineId: string): Promise<RecordLine> {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    const cur = await lockLine(db, tripId, lineId);
    if (cur.status !== 'undone') throw conflict(`line ${lineId} is ${cur.status}, not undone`);
    const line = (await db.query<RecordLineRow>(`update record_lines set status = 'active', updated_at = now() where line_id = $1 returning *`, [lineId])).rows[0]!;
    const seq = await change(db, tripId, 'record.changed', { line: recordLineOf(line), change: 'updated', by: { kind: 'person', person_id: personId } });
    after(() => ctx.live.publish(tripId, { kind: 'trip', seq, kinds: ['record'] }));
    return recordLineOf(line);
  });
}

// ---------------------------------------------------------------- expenses (the actions themselves live in expenses.ts since phase 3)

/**
 * An amount for people to read, in the trip's currency: ₹1,133.34, or ₹680 when there is no fraction. Amounts are whole numbers in the
 * currency's minor unit, so how many digits make a unit depends on the currency (two for rupees, none for yen, three for dinars).
 */
export function formatMoney(amountMinor: number, currency: string): string {
  const digits = new Intl.NumberFormat('en-IN', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const unit = 10 ** digits;
  const whole = amountMinor % unit === 0;
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, minimumFractionDigits: whole ? 0 : digits, maximumFractionDigits: whole ? 0 : digits }).format(amountMinor / unit);
}

// ---------------------------------------------------------------- seen, needs you

/**
 * The person opened or left the room (POST …/read). `upToSeq`, when the app sends it, is the last change number they have read
 * (it never moves back); `messageId` names a message instead, and its change number is used (422 when it is not in the trip).
 */
export async function markSeen(ctx: Ctx, tripId: string, personId: string, upToSeq?: number, messageId?: string): Promise<void> {
  let upTo = upToSeq ?? null;
  if (messageId !== undefined) {
    const m = (await ctx.pool.query('select seq from messages where trip_id = $1 and message_id = $2', [tripId, messageId])).rows[0];
    if (!m) throw invalid(`message ${messageId} is not in this trip`, 'message_id');
    upTo = Math.max(upTo ?? 0, m.seq as number);
  }
  await ctx.pool.query(
    'update trip_people set last_seen_at = now(), last_read_seq = greatest(last_read_seq, coalesce($3::bigint, last_read_seq)) where trip_id = $1 and person_id = $2',
    [tripId, personId, upTo],
  );
}

/** The app contract's NeedsYouItem (§2, §4.11), plus our `cancels_booking_id` on a vote about cancelling a booking. */
export interface NeedsYouItem {
  /** Stable per underlying thing: `vote:<decision>:<me>`, `mandate:<decision>`, `card:<card>`, `record_line:<line>`, `settle:<payee>`, `checkin:<booking>`. */
  item_id: string;
  kind: 'vote' | 'mandate' | 'card' | 'record_line' | 'settle_up' | 'checkin';
  title: string;
  subtitle?: string;
  cta_label?: string;
  since: string;
  target: {
    message_id?: string; card_id?: string; decision_id?: string; line_id?: string; expense_id?: string; booking_id?: string;
    transfer?: { to_person_id: string; amount_minor: number; currency: string };
    cancels_booking_id?: string;
  };
}

/** "closes in 1 hour", "closes in 25 minutes", "closes in 2 days": the vote's subtitle. */
export function closesIn(closesAt: Date, now = Date.now()): string {
  const minutes = Math.max(1, Math.round((closesAt.getTime() - now) / 60_000));
  if (minutes < 60) return `closes in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `closes in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.round(hours / 24);
  return `closes in ${days} days`;
}

/** The "needs you" strip (GET …/needs-you): the items and the change number they match, from one consistent read. */
export async function needsYou(ctx: Ctx, tripId: string, personId: string): Promise<{ items: NeedsYouItem[]; seq: number }> {
  const db = await ctx.pool.connect();
  try {
    await db.query('begin transaction isolation level repeatable read read only');
    const seq = (await db.query('select seq from trips where trip_id = $1', [tripId])).rows[0]?.seq as number | undefined;
    if (seq === undefined) throw notFound(`trip ${tripId} does not exist`);
    const items = await needsYouIn(db, tripId, personId, ctx.features);
    await db.query('commit');
    return { items, seq };
  } catch (err) {
    await db.query('rollback').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

/**
 * What this person has to do in this trip, worked out from our own rows (app contract §4.11, the sources table plus the
 * money line), on a given connection so a trip read and the home screen count it inside their own transactions.
 * `vote`: each open vote they have not voted in. `mandate`: the payer, while the mandate is unanswered. `card`: Go's cards
 * naming them in `for_person_ids` (until replace_card drops them). `record_line`: an open, active line naming them.
 * `settle_up`: each net transfer where they owe. `checkin`: each flight covering them whose cached check-in state is open (src/domain/checkin.ts),
 * only when `features.checkin` is on; the strip never asks Go.
 */
export async function needsYouIn(db: Db, tripId: string, personId: string, features?: Partial<Features>): Promise<NeedsYouItem[]> {
  const votes = await db.query(
    `select d.decision_id, d.question, d.cancels_booking_id, d.closes_at, d.opened_at, d.of_count,
            (select count(*)::int from votes v where v.decision_id = d.decision_id) as voted,
            (select m.message_id from messages m where m.trip_id = d.trip_id and m.card->>'kind' = 'vote' and m.card->>'decision_id' = d.decision_id order by m.seq limit 1) as message_id
       from decisions d
      where d.trip_id = $1 and d.status = 'open'
        and not exists (select 1 from votes v where v.decision_id = d.decision_id and v.person_id = $2)
      order by d.opened_at, d.decision_id`,
    [tripId, personId],
  );
  const mandates = await db.query(
    `select d.decision_id, d.question, d.options, d.mandate, d.closed_at,
            (select m.message_id from messages m where m.trip_id = d.trip_id and m.card->>'kind' = 'mandate' and m.card->>'decision_id' = d.decision_id order by m.seq desc limit 1) as message_id,
            (select m.card->>'card_id' from messages m where m.trip_id = d.trip_id and m.card->>'kind' = 'mandate' and m.card->>'decision_id' = d.decision_id order by m.seq desc limit 1) as card_id
       from decisions d
      where d.trip_id = $1 and d.status = 'closed' and d.mandate->>'payer_person_id' = $2
        and d.mandate->>'confirmed_at' is null and d.mandate->>'declined_at' is null
      order by d.closed_at, d.decision_id`,
    [tripId, personId],
  );
  const cards = await db.query(
    `select message_id, card->>'card_id' as card_id, card->>'fallback_text' as text, card->>'title' as title, card->'actions'->0->>'label' as cta, sent_at from messages
      where trip_id = $1 and author_kind = 'go' and card->'for_person_ids' ? $2 order by seq`,
    [tripId, personId],
  );
  const lines = await db.query(
    `select line_id, text, due_at, created_at from record_lines where trip_id = $1 and kind = 'open' and status = 'active' and person_ids ? $2 order by created_at, line_id`,
    [tripId, personId],
  );
  const trip = (await db.query('select currency, plan_minor from trips where trip_id = $1', [tripId])).rows[0];
  const people = await activePeople(db, tripId);
  const expenses = (await db.query<ExpenseRow>('select * from expenses where trip_id = $1 and removed_at is null order by created_at, expense_id', [tripId])).rows;
  // The same maths as money.transfers: settlements already recorded shrink what is owed.
  const money = trip ? moneyOf(expenses, people.map((p) => p.person_id), trip.currency, trip.plan_minor, await loadSettlements(db, tripId)) : { transfers: [] as { from_person_id: string; to_person_id: string; amount_minor: number; currency: string }[] };
  const nameOf = new Map(people.map((p) => [p.person_id, p.name]));
  const lastExpenseAt = expenses.length ? new Date(expenses[expenses.length - 1]!.created_at).toISOString() : new Date(0).toISOString();
  const checkins = checkinOn(features) ? await checkinItems(db, tripId, personId) : [];
  const at = (d: Date | string) => new Date(d).toISOString();

  return [
    ...votes.rows.map((r): NeedsYouItem => ({
      item_id: `vote:${r.decision_id}:${personId}`,
      kind: 'vote',
      title: r.question,
      subtitle: r.closes_at ? closesIn(new Date(r.closes_at)) : `${r.voted} of ${r.of_count} voted`,
      cta_label: 'Vote',
      since: at(r.opened_at),
      target: compact({ decision_id: r.decision_id, message_id: r.message_id ?? undefined, cancels_booking_id: r.cancels_booking_id ?? undefined }),
    })),
    // What the payer is asked to confirm, such as "Yes, book it? Villa Sol, up to ₹55,000", and the vote it came from.
    ...mandates.rows.map((r): NeedsYouItem => ({
      item_id: `mandate:${r.decision_id}`,
      kind: 'mandate',
      title: `Yes, book it? ${r.options[r.mandate.choice_index]?.label ?? r.question}, up to ${formatMoney(r.mandate.cap_minor, r.mandate.currency)}`,
      subtitle: r.question,
      cta_label: 'Yes, book it',
      since: at(r.mandate.set_at ?? r.closed_at),
      target: compact({ decision_id: r.decision_id, card_id: r.card_id ?? undefined, message_id: r.message_id ?? undefined }),
    })),
    ...cards.rows.map((r): NeedsYouItem => ({
      item_id: `card:${r.card_id}`,
      kind: 'card',
      title: r.text,
      ...(r.title && r.title !== r.text ? { subtitle: r.title } : {}),
      ...(r.cta ? { cta_label: r.cta } : {}),
      since: at(r.sent_at),
      target: { card_id: r.card_id, message_id: r.message_id },
    })),
    ...lines.rows.map((r): NeedsYouItem => ({
      item_id: `record_line:${r.line_id}`,
      kind: 'record_line',
      title: r.text,
      ...(r.due_at ? { subtitle: `due ${new Date(r.due_at).toISOString().slice(0, 10)}` } : {}),
      since: at(r.created_at),
      target: { line_id: r.line_id },
    })),
    ...money.transfers.filter((t) => t.from_person_id === personId).map((t): NeedsYouItem => ({
      item_id: `settle:${t.to_person_id}`,
      kind: 'settle_up',
      title: `Settle up with ${nameOf.get(t.to_person_id) ?? 'a former member'}`,
      subtitle: `${formatMoney(t.amount_minor, t.currency)} left of your share`,
      cta_label: 'Record',
      since: lastExpenseAt,
      target: { transfer: { to_person_id: t.to_person_id, amount_minor: t.amount_minor, currency: t.currency } },
    })),
    ...checkins,
  ];
}

