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
  if (hasOutstanding) return { reason: 'approval_outstanding', detail: 'an earlier spend approval for this vote is still waiting' };
  return null;
}

export interface ApprovalRow {
  approval_id: string;
  trip_id: string;
  request_id: string;
  decision_id: string;
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

/** Signs a spend approval for a request that passed the check. Store `row`, then send `answer`. */
export function issueApproval(tripId: string, decision: Decision, req: SpendRequest, privateKeyPem: string, nowMs: number = Date.now()) {
  const payer = decision.mandate!.payer_person_id; // always the mandate's payer, never anything from the request
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + MAX_APPROVAL_TTL_SECONDS;
  const approvalId = `ap_${randomBytes(8).toString('hex')}`;
  const token = signSpendApproval(
    {
      iss: 'server',
      aud: 'go-vault',
      jti: approvalId,
      trip_id: tripId,
      decision_id: decision.decision_id,
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
      decision_id: decision.decision_id,
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
  booking: { approval_id?: string; decision_id?: string; amount_minor: number; currency: string },
  row: ApprovalRow | undefined,
): string | null {
  if (!row || row.trip_id !== tripId) return `approval ${booking.approval_id} is not one of this trip's`;
  if (booking.decision_id !== row.decision_id) return 'the approval is for another vote';
  if (row.used_at) return 'the approval is already used';
  if (row.cancelled_at) return 'the approval was cancelled';
  if (booking.currency !== row.currency || booking.amount_minor > row.amount_minor) return 'the booking costs more than the approval allows';
  return null;
}
