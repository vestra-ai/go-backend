// §4.9 the `settle_up` card's two buttons. Pay by UPI: a `upi://pay` link to the payee, built here because the UPI id is
// kept on the server (it hides nothing: the link carries the id; it is a convenience). Nudge: a reminder to someone who
// owes the caller. Both work from the trip's net transfers (the fewest payments that square everyone up), never a share
// of one expense. Go hears nothing of either: the contract has no event for them.
import type { Ctx } from '../context.js';
import type { NudgeBody, PayLinkBody } from '../api/bodies.js';
import { Forbidden, formatMoney, requireMember } from './actions.js';
import { conflict, invalid, rateLimited } from './errors.js';
import { readOnly, tripMoney } from './money-view.js';

export const NUDGE_WINDOW_HOURS = 24;
export const PAY_LINK_MINUTES = 10;

const allowedAt = (lastSentAt: Date | string) => new Date(new Date(lastSentAt).getTime() + NUDGE_WINDOW_HOURS * 3_600_000);

/** How many digits of the minor unit make one unit of the currency (two for rupees, none for yen, three for dinars). */
const fractionDigits = (currency: string) => new Intl.NumberFormat('en-IN', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;

/** `upi://pay?pa=<id>&pn=<name>&am=<units.fraction>&cu=<currency>&tn=<note>`, every value percent-encoded; the note is cut to the 50 characters UPI allows. */
export function upiPayUri(p: { pa: string; pn: string; amount_minor: number; currency: string; tn: string }): string {
  const digits = fractionDigits(p.currency);
  const am = (p.amount_minor / 10 ** digits).toFixed(digits);
  const q = Object.entries({ pa: p.pa, pn: p.pn, am, cu: p.currency, tn: Array.from(p.tn).slice(0, 50).join('') }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return `upi://pay?${q.join('&')}`;
}

/**
 * A pay link to someone the caller owes right now (422 otherwise). 409 when the payee is not in the trip or has no UPI id
 * saved (the app then offers Record a payment instead). The link is good for ten minutes as far as the app is concerned;
 * the server keeps nothing.
 */
export async function payLinkFor(ctx: Ctx, tripId: string, callerId: string, input: PayLinkBody): Promise<{ upi_uri: string; expires_at: string }> {
  return readOnly(ctx, async (db) => {
    await requireMember(db, tripId, callerId);
    const m = await tripMoney(db, tripId);
    const payee = m.people.find((p) => p.person_id === input.to_person_id);
    if (!payee) throw conflict(`${input.to_person_id} is not in this trip`);
    if (!payee.upi_id) throw conflict(`${payee.name} has no UPI id saved: record the payment instead`);
    if (!m.money.transfers.some((t) => t.from_person_id === callerId && t.to_person_id === input.to_person_id)) throw invalid(`to_person_id: you do not owe ${payee.name} anything right now`, 'to_person_id');
    return {
      upi_uri: upiPayUri({ pa: payee.upi_id, pn: payee.name, amount_minor: input.amount_minor, currency: m.trip.currency, tn: `${m.trip.title} · settle up` }),
      expires_at: new Date(Date.now() + PAY_LINK_MINUTES * 60_000).toISOString(),
    };
  });
}

/**
 * The caller reminds someone who owes them money: allowed only while a current net transfer runs from that person to the
 * caller and both are in the trip (else 409). One reminder per pair per trip every 24 hours, claimed by one statement so two
 * taps send one (429 with Retry-After and retry_after_seconds otherwise; a retry after a lost answer also gets 429). The
 * reminded person gets one "owes money" notification. Delivery is best-effort: if it fails, or they have notifications
 * off, the caller is not told and the 24 hours are still used up. Nothing is stored for the reminded person, and no
 * change number is taken.
 */
export async function nudgePerson(ctx: Ctx, tripId: string, callerId: string, input: NudgeBody) {
  const owes = await readOnly(ctx, async (db) => {
    const me = await db.query('select p.name from people p join trip_people tp on tp.person_id = p.person_id where tp.trip_id = $1 and tp.person_id = $2 and tp.left_at is null', [tripId, callerId]);
    if (!me.rows[0]) throw new Forbidden(`${callerId} is not in trip ${tripId}`);
    const m = await tripMoney(db, tripId);
    const there = m.people.some((p) => p.person_id === input.from_person_id);
    const transfer = m.money.transfers.find((t) => t.from_person_id === input.from_person_id && t.to_person_id === callerId);
    if (!there || !transfer) throw conflict(`${input.from_person_id} does not owe you money in this trip`);
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
