import { randomBytes } from 'node:crypto';
import { MAX_APPROVAL_TTL_SECONDS, signSpendApproval } from '../contract/index.js';
import type { components } from '../contract/schema.js';
import type { Decision } from './types.js';

type S = components['schemas'];
export type SpendDenialReason = S['SpendDenialReason'];
export type SpendRequest = S['RequestSpendApproval'];

export interface Denial {
  reason: SpendDenialReason;
  detail: string;
}

/**
 * The spend check (guides/money.md): the first rule that fails, or null when the payment may go
 * ahead. It reads only our own rows, never anything Go says. The rules run in this order.
 */
export function spendCheck(
  decision: Decision | undefined, // looked up by trip_id and decision_id, so another trip's vote is not found
  req: SpendRequest,
  hasOutstanding: boolean, // another unused, uncancelled, unexpired approval exists for this vote
  now: Date = new Date(),
  alreadyPaid = false, // the vote already has a confirmed booking: paying again would charge twice
): Denial | null {
  if (!decision) return { reason: 'decision_not_found', detail: 'no such vote in this trip' };
  if (decision.status !== 'closed') return { reason: 'decision_not_closed', detail: `the vote is ${decision.status}` };
  const m = decision.mandate;
  if (decision.kind !== 'choice' || !m) return { reason: 'no_mandate', detail: 'the vote has no mandate' };
  if (m.declined_at && (!m.confirmed_at || new Date(m.declined_at) > new Date(m.confirmed_at))) {
    return { reason: 'payer_declined', detail: 'the payer tapped Not now' };
  }
  if (!m.confirmed_at) return { reason: 'payer_has_not_confirmed', detail: 'the payer has not tapped Yes, book it' };
  if (req.currency !== m.currency) return { reason: 'currency_mismatch', detail: `${req.currency} is not the mandate's ${m.currency}` };
  if (req.amount_minor > m.cap_minor) return { reason: 'over_cap', detail: `${req.amount_minor} ${req.currency} is above the cap of ${m.cap_minor} ${m.currency}` };
  if (m.refundable_only && !(req.refundable_until && new Date(req.refundable_until) > now)) {
    return { reason: 'not_refundable', detail: 'the mandate is refundable only and refundable_until is missing or past' };
  }
  // Checked before a waiting approval: when both hold, "already booked" is what Go needs to hear.
  if (alreadyPaid) return { reason: 'already_booked', detail: 'this vote is already booked: a second payment would charge twice (cancel the booking first)' };
  if (hasOutstanding) return { reason: 'approval_outstanding', detail: 'an earlier spend approval for this vote is still waiting' };
  return null;
}

/** How far over the picked option's price a personal payment may be: fares move between the pick and the payment. */
export const PICK_PRICE_SLACK = 1.05;
/** How long a pick stands for a personal approval. */
export const PICK_MINUTES = 30;
export type PersonalPick = S['PersonalPick'];

/** A person's pick of an option on one of Go's options cards (option_picks), the price as the card showed it. */
export interface PickRow {
  pick_id: string;
  trip_id: string;
  person_id: string;
  card_id: string;
  message_id: string;
  option_id: string;
  price_minor: number | null;
  currency: string | null;
  picked_at: Date;
}

/**
 * The spend check for 1.3's personal form: a person's own payment (their ticket; a seat or a bag at check-in), with no
 * vote behind it. The first rule that fails, or null. The rules run in this order (Go's guide, "A person's own pick").
 * `pick` is that person's most recent tap on that option of that card in the last PICK_MINUTES (personalPickSql);
 * `theirs` says the card is their own: Go's card naming them in for_person_ids, or on a message only they and the people
 * named with them can see.
 */
export function personalCheck(
  inTrip: boolean, // personal.person_id is in the trip now
  pick: PickRow | undefined,
  theirs: boolean,
  req: { amount_minor: number; currency: string },
  hasOutstanding: boolean, // an unused, uncancelled, unexpired approval exists for the same person, card and option
  alreadyBooked: boolean, // a confirmed booking was made with an approval for the same person, card and option
): Denial | null {
  if (!inTrip) return { reason: 'not_in_trip', detail: 'the person is not in this trip' };
  if (!pick || !theirs) return { reason: 'no_pick', detail: `that person has not picked that option on their own card in the last ${PICK_MINUTES} minutes` };
  // The price is the one the card showed when they tapped. A pick with no price, or in another currency, fits no amount.
  if (pick.price_minor == null || pick.currency !== req.currency || req.amount_minor > Math.floor(Number(pick.price_minor) * PICK_PRICE_SLACK)) {
    return { reason: 'no_pick', detail: "the amount is more than the picked option's price plus 5%, or the option showed no price in this currency" };
  }
  if (hasOutstanding) return { reason: 'approval_outstanding', detail: 'an earlier approval for this pick is still waiting' };
  if (alreadyBooked) return { reason: 'already_booked', detail: 'this pick is already booked: a second payment would charge twice (cancel the booking first)' };
  return null;
}

/** That person's most recent tap on that option of that card, while it still stands: $1 trip, $2 person, $3 card, $4 option. */
export const personalPickSql = `select * from option_picks
  where trip_id = $1 and person_id = $2 and card_id = $3 and option_id = $4 and picked_at > now() - interval '${PICK_MINUTES} minutes'
  order by picked_at desc limit 1`;

export interface ApprovalRow {
  approval_id: string;
  trip_id: string;
  request_id: string;
  decision_id: string | null; // null for a personal approval
  for_person_id: string | null; // a personal approval's person, who is its payer; null for a group approval
  pick_id: string | null; // the pick a personal approval was granted against (its card and option)
  payer_person_id: string;
  amount_minor: number;
  currency: string;
  merchant: string;
  approval: string;
  expires_at: Date;
  used_at: Date | null;
  cancelled_at: Date | null;
  booking_id: string | null;
}

/**
 * Signs a spend approval for a request that passed the check. Store `row`, then send `answer`. A group approval names
 * its vote and is paid by the mandate's payer; a personal one names the person's pick, and that person is always its
 * payer. The payer is never anything from the request: the pick is the Server's own row.
 */
export function issueApproval(
  tripId: string,
  form: { decision: Decision } | { pick: PickRow },
  req: SpendRequest,
  privateKeyPem: string,
  nowMs: number = Date.now(),
) {
  const decisionId = 'decision' in form ? form.decision.decision_id : null;
  const personal: PersonalPick | null = 'pick' in form ? { person_id: form.pick.person_id, card_id: form.pick.card_id, option_id: form.pick.option_id } : null;
  const payer = 'decision' in form ? form.decision.mandate!.payer_person_id : form.pick.person_id;
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + MAX_APPROVAL_TTL_SECONDS;
  const approvalId = `ap_${randomBytes(8).toString('hex')}`;
  const token = signSpendApproval(
    {
      iss: 'server',
      aud: 'go-vault',
      jti: approvalId,
      trip_id: tripId,
      decision_id: decisionId,
      personal,
      payer_person_id: payer,
      amount_minor: req.amount_minor,
      currency: req.currency,
      merchant: req.merchant,
      purpose: req.purpose,
      refundable_until: req.refundable_until,
      iat,
      exp,
    } as S['SpendApprovalClaims'],
    privateKeyPem,
  );
  const expiresAt = new Date(exp * 1000);
  return {
    row: {
      approval_id: approvalId,
      trip_id: tripId,
      request_id: req.request_id,
      decision_id: decisionId,
      for_person_id: personal?.person_id ?? null,
      pick_id: 'pick' in form ? form.pick.pick_id : null,
      payer_person_id: payer,
      amount_minor: req.amount_minor,
      currency: req.currency,
      merchant: req.merchant,
      approval: token,
      expires_at: expiresAt,
    },
    answer: { status: 'approved' as const, approval_id: approvalId, approval: token, expires_at: expiresAt.toISOString() },
  };
}

/** Why this booking may not use this approval, or null when it may. The expiry is not checked: the vault did that. */
export function approvalProblem(
  tripId: string,
  booking: { approval_id?: string; decision_id?: string; payer_person_id: string; for_person_ids: string[]; amount_minor: number; currency: string },
  row: ApprovalRow | undefined,
): string | null {
  if (!row || row.trip_id !== tripId) return `approval ${booking.approval_id} is not one of this trip's`;
  // A personal approval has no vote on either side; a group approval's booking names the same vote.
  if ((booking.decision_id ?? null) !== row.decision_id) return row.decision_id ? 'the approval is for another vote' : 'a personal approval is for a booking with no vote';
  // A personal approval is one person's, paid by them: the booking is for that person alone, and they pay.
  if (row.for_person_id && (booking.for_person_ids.length !== 1 || booking.for_person_ids[0] !== row.for_person_id)) return `the personal approval is for ${row.for_person_id} alone`;
  if (row.for_person_id && booking.payer_person_id !== row.for_person_id) return `the personal approval is paid by ${row.for_person_id}`;
  if (row.used_at) return 'the approval is already used';
  if (row.cancelled_at) return 'the approval was cancelled';
  if (booking.currency !== row.currency || booking.amount_minor > row.amount_minor) return 'the booking costs more than the approval allows';
  return null;
}
