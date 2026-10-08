// What people do in the app. Each action is one transaction that takes the trip's next change number,
// writes the change and its event for Go, and then (after the commit) updates phones and sends pushes.
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Ctx } from '../context.js';
import { check } from '../contract/index.js';
import { newId } from '../db/ids.js';
import { onceIfKeyed } from '../db/once.js';
import { withTx } from '../db/pool.js';
import { change, emit, nextSeq } from '../db/write-change.js';
import { conflict, invalid, notFound } from './errors.js';
import { assertDate } from './limits.js';
import { expenseOf, messageForGo, personForGo, recordLineOf } from './mappers.js';
import type { ExpenseRow, MessageRow, RecordLineRow } from './mappers.js';
import { activePeople, buildSnapshot } from './snapshot.js';
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
  title: string;
  destination?: { name: string; [k: string]: unknown };
  dates?: { start: string; end: string };
  vibe?: string[];
  stay?: string;
  plan_minor?: number;
  currency?: string;
}

/** Creates the trip with the organizer in it, and sends `trip.created` (change number 1) with the whole trip. */
export async function createTrip(ctx: Ctx, organizerId: string, input: NewTrip) {
  if (input.dates) {
    assertDate(input.dates.start, 'dates.start');
    assertDate(input.dates.end, 'dates.end');
    if (input.dates.start > input.dates.end) throw invalid('dates.start must be on or before dates.end');
  }
  return withTx(ctx.pool, async (db, after) => {
    await lockPersonForRead(db, organizerId);
    const trip_id = newId('t');
    const invite_code = randomBytes(6).toString('base64url');
    await db.query(
      `insert into trips (trip_id, title, organizer_person_id, invite_code, destination, dates_start, dates_end, vibe, stay, plan_minor, currency)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [trip_id, input.title, organizerId, invite_code, input.destination ? JSON.stringify(input.destination) : null, input.dates?.start ?? null,
       input.dates?.end ?? null, JSON.stringify(input.vibe ?? []), input.stay ?? null, input.plan_minor ?? null, input.currency ?? 'INR'],
    );
    await db.query(`insert into trip_people (trip_id, person_id, role) values ($1, $2, 'organizer')`, [trip_id, organizerId]);
    const seq = await nextSeq(db, trip_id); // 1
    const trip = await buildSnapshot(db, trip_id, ctx.publicBaseUrl);
    await emit(db, trip_id, seq, 'trip.created', { trip });
    after(() => ctx.live.publish(trip_id, { kind: 'trip', seq }));
    return { trip_id, invite_url: trip.invite_url };
  });
}

export interface JoinAnswers {
  from_city?: string;
  earliest_leave?: string;
  know?: string[];
  budget?: { min_minor: number; max_minor?: number };
}

export async function tripByInvite(ctx: Ctx, code: string) {
  const { rows } = await ctx.pool.query(
    `select t.trip_id, t.title, t.destination, t.dates_start, t.dates_end,
            (select count(*)::int from trip_people tp where tp.trip_id = t.trip_id and tp.left_at is null) as people
       from trips t where invite_code = $1`,
    [code],
  );
  return rows[0] ?? null;
}

/**
 * Someone joins with the invite link and answers the join questions. Go gets `person.joined` with
 * those answers, never their budget answer: that only moves the lowest band, announced as a
 * `trip.updated` that names nobody (so the band cannot be traced to a person).
 */
export async function joinTrip(ctx: Ctx, code: string, personId: string, answers: JoinAnswers) {
  return withTx(ctx.pool, async (db, after) => {
    await lockPersonForRead(db, personId);
    const t = (await db.query('select trip_id from trips where invite_code = $1', [code])).rows[0];
    if (!t) throw notFound('no trip for this invite link');
    const tripId: string = t.trip_id;
    const existing = (await db.query('select left_at from trip_people where trip_id = $1 and person_id = $2', [tripId, personId])).rows[0];
    if (existing && existing.left_at === null) return { trip_id: tripId, already: true };
    if (existing) {
      await db.query(
        `update trip_people set left_at = null, joined_at = now(), from_city = $3, earliest_leave = $4, know = $5, budget_min_minor = $6, budget_max_minor = $7
          where trip_id = $1 and person_id = $2`,
        [tripId, personId, answers.from_city ?? null, answers.earliest_leave ?? null, JSON.stringify(answers.know ?? []), answers.budget?.min_minor ?? null, answers.budget?.max_minor ?? null],
      );
    } else {
      await db.query(
        `insert into trip_people (trip_id, person_id, role, from_city, earliest_leave, know, budget_min_minor, budget_max_minor)
         values ($1, $2, 'member', $3, $4, $5, $6, $7)`,
        [tripId, personId, answers.from_city ?? null, answers.earliest_leave ?? null, JSON.stringify(answers.know ?? []), answers.budget?.min_minor ?? null, answers.budget?.max_minor ?? null],
      );
    }
    // Someone who joins can vote in the votes that are still open.
    await db.query(
      `update decisions set of_count = of_count + 1
        where trip_id = $1 and status = 'open' and not exists (select 1 from votes v where v.decision_id = decisions.decision_id and v.person_id = $2)`,
      [tripId, personId],
    );
    const person = (await activePeople(db, tripId)).find((p) => p.person_id === personId)!;
    let seq = await change(db, tripId, 'person.joined', { person: personForGo(person) });
    if (answers.budget) seq = await change(db, tripId, 'trip.updated', { by: { kind: 'system' }, changed: ['budget'] });
    after(() => ctx.live.publish(tripId, { kind: 'trip', seq }));
    return { trip_id: tripId, already: false };
  });
}

export async function leaveTrip(ctx: Ctx, tripId: string, personId: string) {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    const left = (await db.query('update trip_people set left_at = now() where trip_id = $1 and person_id = $2 returning budget_min_minor', [tripId, personId])).rows[0];
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
    let seq = await change(db, tripId, 'person.left', { person_id: personId });
    // Their budget answer no longer counts, so the band (and how many answered) moved: say so, naming nobody.
    if (left.budget_min_minor !== null) seq = await change(db, tripId, 'trip.updated', { by: { kind: 'system' }, changed: ['budget'] });
    const lastSeq = seq;
    after(() => ctx.live.publish(tripId, { kind: 'trip', seq: lastSeq }));
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

/** "Pause Go in this trip": the person's later messages still reach Go, as `withheld`, with no words. */
export async function setGoPaused(ctx: Ctx, tripId: string, personId: string, paused: boolean) {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    await db.query('update trip_people set go_paused = $3 where trip_id = $1 and person_id = $2', [tripId, personId, paused]);
    const person = (await activePeople(db, tripId)).find((p) => p.person_id === personId)!;
    const seq = await change(db, tripId, 'person.updated', { person: personForGo(person), changed: ['go_paused'] });
    after(() => ctx.live.publish(tripId, { kind: 'trip', seq }));
    return { seq };
  });
}

// ---------------------------------------------------------------- messages

/** True when the text @mentions Go or starts by addressing it, or the message replies to Go or asks Go about a message. */
export function mentionsGo(text: string | undefined, repliesToGo: boolean, aboutMessage: boolean): boolean {
  return repliesToGo || aboutMessage || /(^|\s)@go\b/i.test(text ?? '') || /^\s*(hey |ok |okay )?go[,:!]/i.test(text ?? '');
}

export interface NewMessage {
  client_id?: string; // the app's own id for this press, so a retry does not post twice (or the Idempotency-Key header)
  text?: string;
  attachments?: unknown[];
  reply_to?: string;
  about_message_id?: string;
  mentions?: string[];
}

export async function postPersonMessage(ctx: Ctx, tripId: string, personId: string, input: NewMessage) {
  return onceIfKeyed(ctx.pool, tripId, input.client_id && `app:msg:${personId}:${input.client_id}`, async (db, after) => {
    const member = await requireMember(db, tripId, personId);
    if (!input.text && !(input.attachments?.length)) throw invalid('text or an attachment is required');
    for (const [i, a] of (input.attachments ?? []).entries()) {
      const ok = check('Attachment', a);
      if (!ok.ok) throw invalid(`attachments.${i}: ${ok.message}`);
    }
    const mentions = [...new Set(input.mentions ?? [])];
    if (mentions.length) {
      const found = await db.query('select person_id from trip_people where trip_id = $1 and left_at is null and person_id = any($2)', [tripId, mentions]);
      if (found.rowCount !== mentions.length) throw invalid('mentions: someone is not in the trip');
    }
    let repliesToGo = false;
    for (const ref of [input.reply_to, input.about_message_id]) {
      if (!ref) continue;
      const m = (await db.query('select author_kind from messages where trip_id = $1 and message_id = $2', [tripId, ref])).rows[0];
      if (!m) throw invalid(`message ${ref} is not in this trip`);
      if (ref === input.reply_to && m.author_kind === 'go') repliesToGo = true;
    }
    const seq = await nextSeq(db, tripId);
    const row = (await db.query<MessageRow>(
      `insert into messages (message_id, trip_id, seq, updated_seq, author_kind, author_person_id, text, attachments, reply_to, about_message_id, mentions_go, mentions, withheld)
       values ($1,$2,$3,$3,'person',$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [newId('m'), tripId, seq, personId, input.text ?? null, JSON.stringify(input.attachments ?? []), input.reply_to ?? null, input.about_message_id ?? null,
       mentionsGo(input.text, repliesToGo, !!input.about_message_id), JSON.stringify(mentions), member.go_paused],
    )).rows[0]!;
    // Go gets the message as it may see it: a person who paused Go has `withheld: true` and no words.
    await emit(db, tripId, seq, 'message.created', { message: messageForGo(row, []) });
    after(() => ctx.live.publish(tripId, { kind: 'message', message_id: row.message_id, updated_seq: seq }));
    return { message_id: row.message_id, seq };
  });
}

async function ownMessage(db: pg.PoolClient, tripId: string, personId: string, messageId: string): Promise<MessageRow> {
  const row = (await db.query<MessageRow>('select * from messages where trip_id = $1 and message_id = $2 for update', [tripId, messageId])).rows[0];
  if (!row) throw notFound(`message ${messageId} does not exist`);
  if (row.author_person_id !== personId) throw new Forbidden('only the author can change a message');
  if (row.deleted) throw conflict('the message is deleted');
  return row;
}

export async function editMessage(ctx: Ctx, tripId: string, personId: string, messageId: string, text: string) {
  return withTx(ctx.pool, async (db, after) => {
    const member = await requireMember(db, tripId, personId);
    await ownMessage(db, tripId, personId, messageId);
    const seq = await nextSeq(db, tripId);
    // Words written while Go is paused must not reach Go, even in an edit of an older message.
    const row = (await db.query<MessageRow>('update messages set text = $2, edited_at = now(), updated_seq = $3, withheld = withheld or $4 where message_id = $1 returning *', [messageId, text, seq, member.go_paused])).rows[0]!;
    const reactions = (await db.query('select message_id, person_id, emoji from reactions where message_id = $1 order by created_at', [messageId])).rows;
    await emit(db, tripId, seq, 'message.edited', { message: messageForGo(row, reactions) });
    after(() => ctx.live.publish(tripId, { kind: 'message', message_id: messageId, updated_seq: seq }));
    return { seq };
  });
}

export async function deleteMessage(ctx: Ctx, tripId: string, personId: string, messageId: string) {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    await ownMessage(db, tripId, personId, messageId);
    const seq = await nextSeq(db, tripId);
    await db.query(`update messages set deleted = true, text = null, attachments = '[]', updated_seq = $2 where message_id = $1`, [messageId, seq]);
    await emit(db, tripId, seq, 'message.deleted', { message_id: messageId });
    after(() => ctx.live.publish(tripId, { kind: 'message', message_id: messageId, updated_seq: seq }));
    return { seq };
  });
}

export async function reactTo(ctx: Ctx, tripId: string, personId: string, messageId: string, emoji: string, on: boolean) {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    const m = (await db.query('select deleted from messages where trip_id = $1 and message_id = $2', [tripId, messageId])).rows[0];
    if (!m) throw notFound(`message ${messageId} does not exist`);
    if (m.deleted) throw conflict('the message is deleted');
    if (on) {
      const added = await db.query('insert into reactions (trip_id, message_id, person_id, emoji) values ($1,$2,$3,$4) on conflict do nothing', [tripId, messageId, personId, emoji]);
      if (!added.rowCount) return { seq: null }; // already reacted: nothing changed
    } else {
      const gone = await db.query('delete from reactions where message_id = $1 and person_id = $2 and emoji = $3', [messageId, personId, emoji]);
      if (!gone.rowCount) return { seq: null };
    }
    const seq = await nextSeq(db, tripId);
    await db.query('update messages set updated_seq = $1 where message_id = $2', [seq, messageId]);
    await emit(db, tripId, seq, on ? 'reaction.added' : 'reaction.removed', { message_id: messageId, reaction: { emoji, person_id: personId } });
    after(() => ctx.live.publish(tripId, { kind: 'message', message_id: messageId, updated_seq: seq }));
    return { seq };
  });
}

// ---------------------------------------------------------------- votes, mandates and the record

/** A person's vote (they may change it until the vote closes). Closes the vote when everyone has voted. */
export async function castVote(ctx: Ctx, tripId: string, personId: string, decisionId: string, optionIndex: number) {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    const d = await lockDecision(db, tripId, decisionId);
    if (d.status !== 'open') throw conflict(`decision ${decisionId} is ${d.status}`);
    // A vote about cancelling a booking may close below: hold the booking before this path takes a change number.
    if (d.cancels_booking_id) await lockBooking(db, tripId, d.cancels_booking_id);
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= d.options.length) throw invalid('option_index is not one of the options');
    await db.query(
      `insert into votes (decision_id, person_id, option_index) values ($1,$2,$3)
       on conflict (decision_id, person_id) do update set option_index = excluded.option_index, voted_at = now()`,
      [decisionId, personId, optionIndex],
    );
    const votes = await votesOf(db, decisionId);
    const tally = d.options.map((_, i) => votes.filter((v) => v.option_index === i).length);
    // An anonymous vote's event has totals only: no person, no option.
    const seq = await change(db, tripId, 'decision.voted', {
      decision_id: decisionId,
      ...(d.anonymous ? {} : { person_id: personId, option_index: optionIndex }),
      voted: votes.length,
      of: d.of_count,
      tally,
    });
    after(() => ctx.live.publish(tripId, { kind: 'trip', seq }));
    if (votes.length >= d.of_count) await closeDecision(ctx, db, after, tripId, decisionId, 'everyone_voted');
    return { seq };
  });
}

/** Anyone in the trip may close a vote early. */
export async function closeVoteByPerson(ctx: Ctx, tripId: string, personId: string, decisionId: string) {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    return closeDecision(ctx, db, after, tripId, decisionId, 'closed_by_person');
  });
}

export async function cancelDecision(ctx: Ctx, tripId: string, personId: string, decisionId: string) {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    const d = await lockDecision(db, tripId, decisionId);
    if (d.status !== 'open') throw conflict(`decision ${decisionId} is ${d.status}`);
    await db.query(`update decisions set status = 'cancelled' where decision_id = $1`, [decisionId]);
    const seq = await change(db, tripId, 'decision.cancelled', { decision_id: decisionId, by: { kind: 'person', person_id: personId } });
    after(() => ctx.live.publish(tripId, { kind: 'trip', seq }));
    return { seq };
  });
}

/** The mandate card's buttons belong to the server: only the payer can tap them, and they are part of the spend check. */
export async function answerMandate(ctx: Ctx, tripId: string, personId: string, decisionId: string, answer: 'confirm' | 'decline') {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    const d = await lockDecision(db, tripId, decisionId);
    const m = d.mandate as (typeof d.mandate & { confirmed_at?: string; declined_at?: string }) | null;
    if (!m) throw conflict(`decision ${decisionId} has no mandate`);
    if (m.payer_person_id !== personId) throw new Forbidden('only the payer can answer the mandate');
    const next = answer === 'confirm' ? { ...m, confirmed_at: new Date().toISOString() } : { ...m, declined_at: new Date().toISOString() };
    await db.query('update decisions set mandate = $2 where decision_id = $1', [decisionId, JSON.stringify(next)]);
    const seq = await change(db, tripId, answer === 'confirm' ? 'mandate.confirmed' : 'mandate.declined', { decision_id: decisionId, person_id: personId });
    after(() => ctx.live.publish(tripId, { kind: 'trip', seq }));
    return { seq };
  });
}

/** Anyone in the trip can undo a line. Go never undoes one and never writes it back on its own. */
export async function undoRecordLine(ctx: Ctx, tripId: string, personId: string, lineId: string) {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    const cur = (await db.query<RecordLineRow>('select * from record_lines where trip_id = $1 and line_id = $2 for update', [tripId, lineId])).rows[0];
    if (!cur) throw notFound(`line ${lineId} does not exist`);
    if (cur.status === 'undone') return { seq: null };
    const line = (await db.query<RecordLineRow>(`update record_lines set status = 'undone', updated_at = now() where line_id = $1 returning *`, [lineId])).rows[0]!;
    const seq = await change(db, tripId, 'record.changed', { line: recordLineOf(line), change: 'undone', by: { kind: 'person', person_id: personId } });
    after(() => ctx.live.publish(tripId, { kind: 'trip', seq }));
    return { seq };
  });
}

// ---------------------------------------------------------------- expenses

export interface NewExpense {
  paid_by_person_id: string;
  amount_minor: number;
  note: string;
  category: string;
  split_person_ids: string[];
  booking_id?: string;
}

export async function addPersonExpense(ctx: Ctx, tripId: string, personId: string, input: NewExpense) {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    const trip = (await db.query('select currency from trips where trip_id = $1', [tripId])).rows[0];
    if (input.amount_minor <= 0) throw invalid('amount_minor must be more than zero');
    if (!check('Category', input.category).ok) throw invalid('category must be stay, food, getting_around, activities or other');
    const ids = [...new Set([input.paid_by_person_id, ...input.split_person_ids])];
    const found = await db.query('select person_id from trip_people where trip_id = $1 and left_at is null and person_id = any($2)', [tripId, ids]);
    if (found.rowCount !== ids.length) throw invalid('paid_by_person_id/split_person_ids: someone is not in the trip');
    if (input.booking_id) {
      const b = await db.query('select 1 from bookings where trip_id = $1 and booking_id = $2', [tripId, input.booking_id]);
      if (!b.rowCount) throw invalid(`booking_id: ${input.booking_id} is not a booking in this trip`);
    }
    const expense = (await db.query<ExpenseRow>(
      `insert into expenses (expense_id, trip_id, paid_by_person_id, amount_minor, currency, note, category, split_person_ids, booking_id, added_by_person_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [newId('e'), tripId, input.paid_by_person_id, input.amount_minor, trip.currency, input.note, input.category, JSON.stringify(input.split_person_ids), input.booking_id ?? null, personId],
    )).rows[0]!;
    const seq = await change(db, tripId, 'expense.changed', { expense: expenseOf(expense), change: 'added', by: { kind: 'person', person_id: personId } });
    after(() => ctx.live.publish(tripId, { kind: 'trip', seq }));
    after(() => pushOwed(ctx, tripId, expense));
    return { expense_id: expense.expense_id, seq };
  });
}

export async function removePersonExpense(ctx: Ctx, tripId: string, personId: string, expenseId: string) {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    const row = (await db.query<ExpenseRow>('update expenses set removed_at = now() where trip_id = $1 and expense_id = $2 and removed_at is null returning *', [tripId, expenseId])).rows[0];
    if (!row) throw notFound(`expense ${expenseId} does not exist`);
    const seq = await change(db, tripId, 'expense.changed', { expense: expenseOf(row), change: 'removed', by: { kind: 'person', person_id: personId } });
    after(() => ctx.live.publish(tripId, { kind: 'trip', seq }));
    return { seq };
  });
}

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

/**
 * After an expense is added, pushes the people in its split who now owe money, from the trip's
 * `money.transfers` (guides: "Pushes"): who and how much, such as "You owe Kabir ₹680 for the airport cab".
 * Someone whose balance is settled or in credit after the whole trip's expenses gets no push.
 */
export async function pushOwed(ctx: Ctx, tripId: string, expense: ExpenseRow): Promise<void> {
  const snap = await buildSnapshot(ctx.pool, tripId, ctx.publicBaseUrl);
  const names = new Map(snap.people.map((p) => [p.person_id, p.name]));
  const inSplit = new Set(expense.split_person_ids.filter((id) => id !== expense.paid_by_person_id));
  for (const t of snap.money.transfers) {
    if (!inSplit.has(t.from_person_id)) continue;
    await ctx.push.send([t.from_person_id], {
      body: `You owe ${names.get(t.to_person_id) ?? 'someone'} ${formatMoney(t.amount_minor, t.currency)} for ${expense.note}`,
      data: { trip_id: tripId },
    });
  }
}

// ---------------------------------------------------------------- seen, needs you

/** The person opened or left the room. `upToSeq`, when the app sends it, is the last change number they have read (it never moves back). */
export async function markSeen(ctx: Ctx, tripId: string, personId: string, upToSeq?: number): Promise<void> {
  await ctx.pool.query(
    'update trip_people set last_seen_at = now(), last_read_seq = greatest(last_read_seq, coalesce($3::bigint, last_read_seq)) where trip_id = $1 and person_id = $2',
    [tripId, personId, upToSeq ?? null],
  );
}

/** The "needs you" strip: what this person has to do in this trip, worked out from our own rows. */
export async function needsYou(ctx: Ctx, tripId: string, personId: string) {
  const votes = await ctx.pool.query(
    `select d.decision_id, d.question, d.cancels_booking_id from decisions d
      where d.trip_id = $1 and d.status = 'open'
        and not exists (select 1 from votes v where v.decision_id = d.decision_id and v.person_id = $2)`,
    [tripId, personId],
  );
  const mandates = await ctx.pool.query(
    `select decision_id, question, options, mandate from decisions
      where trip_id = $1 and status = 'closed' and mandate->>'payer_person_id' = $2
        and mandate->>'confirmed_at' is null and mandate->>'declined_at' is null`,
    [tripId, personId],
  );
  const cards = await ctx.pool.query(
    `select message_id, card->>'card_id' as card_id, card->>'fallback_text' as text from messages
      where trip_id = $1 and author_kind = 'go' and card->'for_person_ids' ? $2`,
    [tripId, personId],
  );
  const lines = await ctx.pool.query(
    `select line_id, text from record_lines where trip_id = $1 and kind = 'open' and status = 'active' and person_ids ? $2`,
    [tripId, personId],
  );
  return [
    ...votes.rows.map((r) => ({ kind: 'vote', decision_id: r.decision_id, text: r.question, ...(r.cancels_booking_id ? { cancels_booking_id: r.cancels_booking_id } : {}) })),
    // What the payer is asked to confirm, such as "Yes, book it? Villa Sol, up to ₹55,000", and the vote it came from.
    ...mandates.rows.map((r) => ({
      kind: 'mandate',
      decision_id: r.decision_id,
      text: `Yes, book it? ${r.options[r.mandate.choice_index]?.label ?? r.question}, up to ${formatMoney(r.mandate.cap_minor, r.mandate.currency)}`,
      question: r.question,
    })),
    ...cards.rows.map((r) => ({ kind: 'card', card_id: r.card_id, message_id: r.message_id, text: r.text })),
    ...lines.rows.map((r) => ({ kind: 'record', line_id: r.line_id, text: r.text })),
  ];
}

