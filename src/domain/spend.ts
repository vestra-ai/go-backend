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

/** How far over the picked option's price a ticket may cost: fares move between the pick and the payment. */
export const TICKET_PRICE_SLACK = 1.05;
/** How long a pick stands for a ticket approval. */
export const PICK_MINUTES = 30;

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
 * The spend check for 1.2's ticket form: one traveller's own ticket, paid by them, with no vote behind it. The first
 * rule that fails, or null. The rules run in this order. `pick` is the traveller's most recent pick from the last
 * PICK_MINUTES in the request's currency at a price the amount fits (ticketPickSql), so a missing pick covers "no pick",
 * "too old", "another currency" and "over the price" alike.
 */
export function ticketCheck(
  inTrip: boolean, // for_person_id is in the trip now
  pick: PickRow | undefined,
  hasOutstanding: boolean, // an unused, uncancelled, unexpired ticket approval exists for the same person, card and option
  alreadyBooked: boolean, // a confirmed booking was made with a ticket approval for the same person, card and option
): Denial | null {
  if (!inTrip) return { reason: 'not_in_trip', detail: 'the traveller is not in this trip' };
  if (!pick) return { reason: 'payer_has_not_confirmed', detail: 'no option picked by this traveller in the last 30 minutes at this price' };
  if (hasOutstanding) return { reason: 'approval_outstanding', detail: 'an earlier ticket approval for this pick is still waiting' };
  if (alreadyBooked) return { reason: 'already_booked', detail: 'this pick is already booked: a second payment would charge twice (cancel the booking first)' };
  return null;
}

/**
 * The traveller's most recent pick that a ticket of this amount and currency fits: $1 trip, $2 person, $3 amount_minor,
 * $4 currency. A pick with no price fits any amount; one with a price fits up to ceil(price × 1.05).
 */
export const ticketPickSql = `select * from option_picks
  where trip_id = $1 and person_id = $2 and picked_at > now() - interval '${PICK_MINUTES} minutes' and currency = $4
    and (price_minor is null or $3 <= ceil(price_minor * ${TICKET_PRICE_SLACK}))
  order by picked_at desc limit 1`;

export interface ApprovalRow {
  approval_id: string;
  trip_id: string;
  request_id: string;
  decision_id: string | null; // null for a ticket
  for_person_id: string | null; // the ticket's traveller, who is its payer; null for a group approval
  pick_id: string | null; // the pick a ticket was granted against
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
 * its vote and is paid by the mandate's payer; a ticket names its traveller, who is always its payer. The payer is
 * never anything from the request.
 */
export function issueApproval(
  tripId: string,
  form: { decision: Decision } | { ticket: { for_person_id: string; pick_id: string } },
  req: SpendRequest,
  privateKeyPem: string,
  nowMs: number = Date.now(),
) {
  const decisionId = 'decision' in form ? form.decision.decision_id : null;
  const forPersonId = 'ticket' in form ? form.ticket.for_person_id : null;
  const payer = 'decision' in form ? form.decision.mandate!.payer_person_id : form.ticket.for_person_id;
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
      for_person_id: forPersonId,
      kind: forPersonId ? 'ticket' : null,
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
      for_person_id: forPersonId,
      pick_id: 'ticket' in form ? form.ticket.pick_id : null,
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
  // A ticket has no vote on either side; a group approval's booking names the same vote.
  if ((booking.decision_id ?? null) !== row.decision_id) return row.decision_id ? 'the approval is for another vote' : 'a ticket approval is for a booking with no vote';
  // A ticket is one traveller's, paid by them: the booking is for that person alone, and they pay.
  if (row.for_person_id && (booking.for_person_ids.length !== 1 || booking.for_person_ids[0] !== row.for_person_id)) return `the ticket approval is for ${row.for_person_id} alone`;
  if (row.for_person_id && booking.payer_person_id !== row.for_person_id) return `the ticket approval is paid by ${row.for_person_id}`;
  if (row.used_at) return 'the approval is already used';
  if (row.cancelled_at) return 'the approval was cancelled';
  if (booking.currency !== row.currency || booking.amount_minor > row.amount_minor) return 'the booking costs more than the approval allows';
  return null;
}
