// Settling up: whom the caller owes (with that person's UPI id, so the app can offer "Pay by UPI"), who owes the caller, and
// a reminder ("nudge") to someone who does. Both lists are the caller's entries from the trip's net transfers (the fewest
// payments that square everyone up), never a share of one expense. Go hears nothing: the contract has no event for reminders.
import type pg from 'pg';
import type { Ctx } from '../context.js';
import type { NudgeBody } from '../api/bodies.js';
import { Forbidden, formatMoney, requireMember } from './actions.js';
import { conflict, rateLimited } from './errors.js';
import { buildSnapshot } from './snapshot.js';

export const NUDGE_WINDOW_HOURS = 24;

/** Runs `work` in one read-only transaction at repeatable read, so the change number matches the data it read. */
async function readOnly<T>(ctx: Ctx, work: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await ctx.pool.connect();
  try {
    await db.query('begin transaction isolation level repeatable read read only');
    const out = await work(db);
    await db.query('commit');
    return out;
  } catch (err) {
    await db.query('rollback').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

const allowedAt = (lastSentAt: Date | string) => new Date(new Date(lastSentAt).getTime() + NUDGE_WINDOW_HOURS * 3_600_000);

/**
 * The caller's settle-up. `upi_id` is a payee's id, shown only to someone who owes that payee, and `null` when the payee has none
 * saved or has left the trip. `nudge_allowed_at` is when the caller may remind that person again, or `null` when they may now.
 * Membership, the transfers and the UPI lookup are one read at one change number.
 */
export async function getSettleUp(ctx: Ctx, tripId: string, personId: string) {
  return readOnly(ctx, async (db) => {
    await requireMember(db, tripId, personId);
    const snap = await buildSnapshot(db, tripId, ctx.publicBaseUrl);
    const mine = snap.money.transfers.filter((t) => t.from_person_id === personId);
    const owed = snap.money.transfers.filter((t) => t.to_person_id === personId);
    const upis = mine.length
      ? (await db.query(
          `select p.person_id, p.upi_id from people p join trip_people tp on tp.person_id = p.person_id
            where tp.trip_id = $1 and tp.left_at is null and p.person_id = any($2)`,
          [tripId, mine.map((t) => t.to_person_id)],
        )).rows
      : [];
    const upiOf = new Map(upis.map((r) => [r.person_id as string, (r.upi_id as string | null) ?? null]));
    const sent = owed.length
      ? (await db.query('select to_person_id, last_sent_at from nudges where trip_id = $1 and from_person_id = $2', [tripId, personId])).rows
      : [];
    const lastSent = new Map(sent.map((r) => [r.to_person_id as string, r.last_sent_at as Date]));
    const now = Date.now();
    return {
      seq: snap.seq,
      you_pay: mine.map((t) => ({ to_person_id: t.to_person_id, amount_minor: t.amount_minor, currency: t.currency, upi_id: upiOf.get(t.to_person_id) ?? null })),
      owed_to_you: owed.map((t) => {
        const at = lastSent.has(t.from_person_id) ? allowedAt(lastSent.get(t.from_person_id)!) : null;
        return { from_person_id: t.from_person_id, amount_minor: t.amount_minor, currency: t.currency, nudge_allowed_at: at && at.getTime() > now ? at.toISOString() : null };
      }),
    };
  });
}

/**
 * The caller reminds someone who owes them money: allowed only while a current net transfer runs from that person to the
 * caller and both are in the trip (else 409). One reminder per pair per trip every 24 hours, claimed by one statement so two
 * taps send one (429 with Retry-After otherwise; a retry after a lost answer also gets 429). The reminded person gets one
 * "owes money" notification. Delivery is best-effort: if it fails, or they have notifications off, the caller is not told and
 * the 24 hours are still used up. Nothing is stored for the reminded person, and no change number is taken.
 */
export async function nudgePerson(ctx: Ctx, tripId: string, callerId: string, input: NudgeBody) {
  const owes = await readOnly(ctx, async (db) => {
    const me = await db.query('select p.name from people p join trip_people tp on tp.person_id = p.person_id where tp.trip_id = $1 and tp.person_id = $2 and tp.left_at is null', [tripId, callerId]);
    if (!me.rows[0]) throw new Forbidden(`${callerId} is not in trip ${tripId}`);
    const there = await db.query('select 1 from trip_people where trip_id = $1 and person_id = $2 and left_at is null', [tripId, input.from_person_id]);
    const snap = await buildSnapshot(db, tripId, ctx.publicBaseUrl);
    const transfer = snap.money.transfers.find((t) => t.from_person_id === input.from_person_id && t.to_person_id === callerId);
    if (!there.rowCount || !transfer) throw conflict(`${input.from_person_id} does not owe you money in this trip`);
    return { name: me.rows[0].name as string, amount: transfer.amount_minor, currency: transfer.currency };
  });
  const text = `${owes.name} reminded you: you owe ${formatMoney(owes.amount, owes.currency)}`.slice(0, 300); // built before the claim, so a formatting failure cannot use up the window
  const claim = await ctx.pool.query(
    `insert into nudges (trip_id, from_person_id, to_person_id, last_sent_at) values ($1, $2, $3, now())
     on conflict (trip_id, from_person_id, to_person_id) do update set last_sent_at = now()
       where nudges.last_sent_at <= now() - make_interval(hours => $4)
     returning last_sent_at`,
    [tripId, callerId, input.from_person_id, NUDGE_WINDOW_HOURS],
  );
  if (!claim.rows[0]) {
    const last = (await ctx.pool.query('select last_sent_at from nudges where trip_id = $1 and from_person_id = $2 and to_person_id = $3', [tripId, callerId, input.from_person_id])).rows[0];
    const wait = last ? Math.max(1, Math.ceil((allowedAt(last.last_sent_at).getTime() - Date.now()) / 1000)) : NUDGE_WINDOW_HOURS * 3600;
    throw rateLimited(`${input.from_person_id} was reminded recently: try again later`, wait);
  }
  try {
    await ctx.push.send([input.from_person_id], { body: text, data: { trip_id: tripId } });
  } catch (err) {
    console.error('nudge delivery failed:', err instanceof Error ? err.name : 'error'); // best-effort: the caller is not told; nothing about the target or its address is logged
  }
  return { reminded: true, nudge_allowed_at: allowedAt(claim.rows[0].last_sent_at).toISOString() };
}
