// What people do with votes and bookings that Go does on their behalf elsewhere. Each action is one transaction:
// the change, its event for Go and the trip's next change number commit together, and the person must be in the
// trip inside that same transaction. Creates run once per (person, client_id).
import type { Ctx } from '../context.js';
import { once } from '../db/once.js';
import { change } from '../db/write-change.js';
import type { OpenVoteBody } from '../api/bodies.js';
import { invalid } from './errors.js';
import { compact, decisionOf } from './mappers.js';
import { openDecision } from './voting.js';
import { requireMember } from './actions.js';

/**
 * A checked date-time as an instant. The contract's format admits timezone offsets Postgres refuses, leap seconds
 * JavaScript cannot read, and times that fall outside years 1 to 9999 once the offset is applied; each would otherwise
 * become a 500 or a time that is silently not checked.
 */
export function instant(value: string, field: string): Date {
  const at = new Date(value);
  // After the offset is applied the instant must still be a year Postgres reads back: ISO text for year 10000 or year 0 is refused by it.
  if (Number.isNaN(at.getTime()) || at.getUTCFullYear() < 1 || at.getUTCFullYear() > 9999) throw invalid(`${field} is not a time that can be stored`);
  return at;
}

/** A member opens a vote. Go hears `decision.opened` by that person; the server posts no card (Go does). */
export async function openPersonVote(ctx: Ctx, tripId: string, personId: string, input: OpenVoteBody) {
  return once(ctx.pool, tripId, `app:vote:${personId}:${input.client_id}`, async (db, after) => {
    await requireMember(db, tripId, personId);
    const closesAt = input.closes_at ? instant(input.closes_at, 'closes_at') : null;
    if (closesAt && closesAt.getTime() <= Date.now()) throw invalid('closes_at must be in the future');
    const currency = (await db.query('select currency from trips where trip_id = $1', [tripId])).rows[0]!.currency as string;
    const options = input.options.map((o) =>
      compact({ label: o.label, image_url: o.image_url, price_minor: o.price_minor, currency: o.price_minor === undefined ? undefined : currency, note: o.note }));
    const row = await openDecision(db, tripId, {
      question: input.question, kind: input.kind, anonymous: input.anonymous, options, closesAt: closesAt?.toISOString() ?? null, openedBy: personId,
    });
    const seq = await change(db, tripId, 'decision.opened', { decision: decisionOf(row, []), by: { kind: 'person', person_id: personId } });
    after(() => ctx.live.publish(tripId, { kind: 'trip', seq }));
    return { decision_id: row.decision_id, seq };
  });
}
