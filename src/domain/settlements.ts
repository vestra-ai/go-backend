// §4.9 "Record a payment": money one person sent another outside Go (UPI, cash, a bank transfer). It counts in the
// transfers at once, provisionally, so the debt shrinks while the payee is asked "Got it?"; a dispute puts it back. Each
// step takes a change number so the app re-reads, but Go hears only of a confirmed payment (`settlement.recorded`,
// docs/GO-CHANGES.md 2.1): it never sees a pending or disputed one.
import type { Ctx } from '../context.js';
import { newId } from '../db/ids.js';
import { withTx } from '../db/pool.js';
import { emit, nextSeq } from '../db/write-change.js';
import { Forbidden, requireMember } from './actions.js';
import { conflict, invalid, notFound } from './errors.js';
import { moneyChanged } from './expenses.js';
import { settlementOf, type Settlement, type SettlementRow } from './ledger.js';
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
    const seq = await nextSeq(db, tripId); // a change number, no event: Go is told when the payee confirms
    const row = (await db.query<SettlementRow>(
      `insert into settlements (settlement_id, trip_id, from_person_id, to_person_id, amount_minor, currency, method, note, seq)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [newId('st'), tripId, personId, input.to_person_id, input.amount_minor, input.currency, input.method, input.note ?? null, seq],
    )).rows[0]!;
    const { money } = await tripMoney(db, tripId);
    after(() => moneyChanged(ctx, tripId, seq));
    return { settlement: settlementOf(row), transfers: money.transfers, seq };
  });
}

/**
 * The payee answers (403 for anyone else, 409 once answered). A confirmation is the one moment Go hears of the payment;
 * a dispute takes a change number and puts the amount back, and Go hears nothing.
 */
export async function answerSettlement(ctx: Ctx, tripId: string, personId: string, settlementId: string, answer: 'confirmed' | 'disputed'): Promise<Settlement> {
  return withTx(ctx.pool, async (db, after) => {
    await requireMember(db, tripId, personId);
    const row = (await db.query<SettlementRow>('select * from settlements where trip_id = $1 and settlement_id = $2 for update', [tripId, settlementId])).rows[0];
    if (!row) throw notFound(`settlement ${settlementId} does not exist`);
    if (row.to_person_id !== personId) throw new Forbidden('only the payee can answer a settlement');
    if (row.status !== 'pending_confirmation') throw conflict(`settlement ${settlementId} is already ${row.status}`);
    const seq = await nextSeq(db, tripId);
    const updated = (await db.query<SettlementRow>('update settlements set status = $2, responded_at = now(), seq = $3 where settlement_id = $1 returning *', [settlementId, answer, seq])).rows[0]!;
    if (answer === 'confirmed') {
      await emit(db, tripId, seq, 'settlement.recorded', compact({
        settlement_id: updated.settlement_id, from_person_id: updated.from_person_id, to_person_id: updated.to_person_id, amount_minor: updated.amount_minor,
        currency: updated.currency, method: updated.method, note: updated.note ?? undefined, status: 'confirmed', recorded_at: iso(updated.created_at)!, confirmed_at: iso(updated.responded_at)!,
      }));
    }
    after(() => moneyChanged(ctx, tripId, seq));
    return settlementOf(updated);
  });
}
