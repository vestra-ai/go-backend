// §4.9 "Record a payment": money one person sent another outside Go (UPI, cash, a bank transfer). It counts in the
// transfers at once and for good: nobody confirms it and nobody disputes it. Go hears `settlement.recorded`
// (docs/GO-CHANGES.md 2.1) in the same transaction.
import type { Ctx } from '../context.js';
import { newId } from '../db/ids.js';
import { withTx } from '../db/pool.js';
import { emit, nextSeq } from '../db/write-change.js';
import { requireMember } from './actions.js';
import { invalid } from './errors.js';
import { moneyChanged } from './expenses.js';
import { settlementOf, type Settlement, type SettlementRow } from './ledger.js';
import { postPayback } from './ledger-lines.js';
import { compact, iso } from './mappers.js';
import { tripMoney, type Transfer } from './money-view.js';

export interface NewSettlement {
  to_person_id: string;
  amount_minor: number;
  currency: string;
  method: SettlementRow['method'];
  note?: string;
}

/**
 * The caller paid `to_person_id` outside Go. The payee must be someone else in the trip and the amount in the trip's
 * currency (422 otherwise). Answers the settlement, the transfers as they now stand, and the change number.
 */
export async function recordSettlement(ctx: Ctx, tripId: string, personId: string, input: NewSettlement): Promise<{ settlement: Settlement; transfers: Transfer[]; seq: number }> {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    const trip = (await db.query('select currency from trips where trip_id = $1', [tripId])).rows[0];
    if (input.to_person_id === personId) throw invalid('to_person_id: you cannot pay yourself', 'to_person_id');
    const payee = (await db.query('select 1 from trip_people where trip_id = $1 and person_id = $2 and left_at is null', [tripId, input.to_person_id])).rows[0];
    if (!payee) throw invalid(`to_person_id: ${input.to_person_id} is not in the trip`, 'to_person_id');
    if (input.currency !== trip.currency) throw invalid(`currency must be ${trip.currency}, the trip's currency`, 'currency');
    const seq = await nextSeq(db, tripId);
    const row = (await db.query<SettlementRow>(
      `insert into settlements (settlement_id, trip_id, from_person_id, to_person_id, amount_minor, currency, method, note, seq)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [newId('st'), tripId, personId, input.to_person_id, input.amount_minor, input.currency, input.method, input.note ?? null, seq],
    )).rows[0]!;
    // The event's shape still names a confirmation (the proposal's wording): recorded is the whole of it now, so both times are the same.
    const recordedAt = iso(row.created_at)!;
    await emit(db, tripId, seq, 'settlement.recorded', compact({
      settlement_id: row.settlement_id, from_person_id: row.from_person_id, to_person_id: row.to_person_id, amount_minor: row.amount_minor,
      currency: row.currency, method: row.method, note: row.note ?? undefined, status: 'confirmed', recorded_at: recordedAt, confirmed_at: recordedAt,
    }));
    after(() => moneyChanged(ctx, tripId, seq));
    await postPayback({ ctx, db, after, tripId }, settlementOf(row)); // the room's line: the next change number, no event
    const { money } = await tripMoney(db, tripId);
    return { settlement: settlementOf(row), transfers: money.transfers, seq };
  });
}
