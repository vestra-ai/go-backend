import type { Ctx } from '../context.js';
import { newId } from '../db/ids.js';
import { once } from '../db/once.js';
import { change, emit, nextSeq } from '../db/write-change.js';
import { conflict, invalid, notFound } from '../domain/errors.js';
import { insertExpense, moneyChanged } from '../domain/expenses.js';
import { postExpenseAdded } from '../domain/ledger-lines.js';
import { bookingOf, recordLineOf } from '../domain/mappers.js';
import type { BookingRow, RecordLineRow } from '../domain/mappers.js';
import { approvalProblem, issueApproval, spendCheck } from '../domain/spend.js';
import type { ApprovalRow } from '../domain/spend.js';
import { loadDecisions } from '../domain/snapshot.js';
import { bookedText, postSystemMessage } from '../domain/system-messages.js';
import { assertCurrency, assertPeopleInTrip, requireSomething, tripOf } from './guards.js';

export const addBooking = (ctx: Ctx) => async (p: any, raw: Record<string, unknown>) =>
  once(ctx.pool, p.trip_id, p.request_id, async (db, after) => {
    const trip = await tripOf(db, p.trip_id);
    await assertPeopleInTrip(db, p.trip_id, [p.payer_person_id, ...p.for_person_ids], 'payer_person_id/for_person_ids');
    if (p.decision_id) {
      const d = await db.query('select 1 from decisions where trip_id = $1 and decision_id = $2', [p.trip_id, p.decision_id]);
      if (!d.rowCount) throw invalid(`decision_id: ${p.decision_id} is not a vote in trip ${p.trip_id}`);
    }
    assertCurrency(trip, p.currency);
    // With an approval id, the approval is checked and marked used in the same transaction as the booking.
    if (p.approval_id) {
      const approval = (await db.query<ApprovalRow>('select * from spend_approvals where approval_id = $1 for update', [p.approval_id])).rows[0];
      const problem = approvalProblem(p.trip_id, p, approval);
      if (problem) throw conflict(problem);
    }
    // Row locks before the change number (which locks the trip row): a person undoing this line at the same moment must not deadlock with us.
    // When the vote already has a decided line, that line becomes the booked line. A line a person undid stays
    // undone (an undo is never written back), so the booking gets a new line of its own instead.
    const decided = p.decision_id
      ? (await db.query<RecordLineRow>(`select * from record_lines where trip_id = $1 and decision_id = $2 and kind = 'decided' and status = 'active' for update`, [p.trip_id, p.decision_id])).rows[0]
      : undefined;
    const booking = (await db.query<BookingRow>(
      `insert into bookings (booking_id, trip_id, kind, title, vendor, ref, amount_minor, currency, payer_person_id, for_person_ids,
                             refundable_until, starts_at, ends_at, journey, place, image_url, decision_id, approval_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning *`,
      [newId('b'), p.trip_id, p.kind, p.title, p.vendor, p.ref, p.amount_minor, p.currency, p.payer_person_id, JSON.stringify(p.for_person_ids),
       p.refundable_until ?? null, p.starts_at ?? null, p.ends_at ?? null, raw.journey ? JSON.stringify(raw.journey) : null,
       raw.place ? JSON.stringify(raw.place) : null, p.image_url ?? null, p.decision_id ?? null, p.approval_id ?? null],
    )).rows[0]!;
    if (p.approval_id) {
      const used = await db.query('update spend_approvals set used_at = now(), booking_id = $2 where approval_id = $1 and used_at is null', [p.approval_id, booking.booking_id]);
      if (!used.rowCount) throw conflict(`approval ${p.approval_id} is already used`);
    }
    const seq = await change(db, p.trip_id, 'booking.changed', { booking: bookingOf(booking), change: 'added', by: { kind: 'go' } });

    const line = decided
      ? (await db.query<RecordLineRow>(
          `update record_lines set kind = 'booked', text = $2, booking_id = $3, source = 'booking', updated_at = now() where line_id = $1 returning *`,
          [decided.line_id, p.title.slice(0, 200), booking.booking_id],
        )).rows[0]!
      : (await db.query<RecordLineRow>(
          `insert into record_lines (line_id, trip_id, kind, text, booking_id, decision_id, source) values ($1, $2, 'booked', $3, $4, $5, 'booking') returning *`,
          [newId('r'), p.trip_id, p.title.slice(0, 200), booking.booking_id, p.decision_id ?? null],
        )).rows[0]!;
    const lineSeq = await nextSeq(db, p.trip_id);
    await emit(db, p.trip_id, lineSeq, 'record.changed', { line: recordLineOf(line), change: decided ? 'updated' : 'added', by: { kind: 'system' } });
    await postSystemMessage(ctx, db, after, p.trip_id, bookedText(p.title)); // the room's pill (decision D8), after the events, no event of its own
    after(() => ctx.live.publish(p.trip_id, { kind: 'trip', seq: lineSeq, kinds: ['booking', 'record'] }));
    return { booking_id: booking.booking_id, seq };
  });

export const updateBooking = (ctx: Ctx) => async (p: any) =>
  once(ctx.pool, p.trip_id, p.request_id, async (db, after) => {
    await tripOf(db, p.trip_id);
    const current = (await db.query<BookingRow>('select * from bookings where trip_id = $1 and booking_id = $2 for update', [p.trip_id, p.booking_id])).rows[0];
    if (!current) throw notFound(`booking ${p.booking_id} does not exist in trip ${p.trip_id}`);
    requireSomething(p, ['status', 'ref', 'refundable_until', 'starts_at', 'ends_at']);
    if (current.status === 'cancelled') throw conflict(`booking ${p.booking_id} is cancelled and cannot change`);
    const updated = (await db.query<BookingRow>(
      `update bookings set status = $2, ref = $3, refundable_until = $4, starts_at = $5, ends_at = $6 where booking_id = $1 returning *`,
      [p.booking_id, p.status ?? current.status, p.ref ?? current.ref, p.refundable_until ?? current.refundable_until, p.starts_at ?? current.starts_at, p.ends_at ?? current.ends_at],
    )).rows[0]!;
    const seq = await change(db, p.trip_id, 'booking.changed', {
      booking: bookingOf(updated),
      change: p.status === 'cancelled' ? 'cancelled' : 'updated',
      by: { kind: 'go' },
    });
    after(() => ctx.live.publish(p.trip_id, { kind: 'trip', seq, kinds: ['booking'] }));
    return { seq };
  });

/** Go adds an expense. It counts at once, like any expense; `approval_id` names the vault payment it belongs to. */
export const addExpense = (ctx: Ctx) => async (p: any) =>
  once(ctx.pool, p.trip_id, p.request_id, async (db, after) => {
    const trip = await tripOf(db, p.trip_id);
    await assertPeopleInTrip(db, p.trip_id, [p.paid_by_person_id, ...p.split_person_ids], 'paid_by_person_id/split_person_ids');
    if (p.booking_id) {
      const b = await db.query('select 1 from bookings where trip_id = $1 and booking_id = $2', [p.trip_id, p.booking_id]);
      if (!b.rowCount) throw invalid(`booking_id: ${p.booking_id} is not a booking in trip ${p.trip_id}`);
    }
    if (p.amount_minor <= 0) throw invalid('amount_minor must be more than zero');
    assertCurrency(trip, p.currency);
    const expense = await insertExpense(db, p.trip_id, { ...p, booking_id: p.booking_id ?? null });
    const seq = await change(db, p.trip_id, 'expense.changed', { expense, change: 'added', by: { kind: 'go' } });
    after(() => moneyChanged(ctx, p.trip_id, seq));
    await postExpenseAdded({ ctx, db, after, tripId: p.trip_id }, expense, { kind: 'go' }); // the room's line, for Go's expenses too
    return { expense_id: expense.expense_id, seq };
  });

/**
 * The spend check, then a signed one-use approval for the vault. A denial is a normal result, not an error.
 * Not a change to the trip: no change number, no event. A repeat of the same request_id gets the same
 * result, approved or denied, with the same token.
 */
export const requestSpendApproval = (ctx: Ctx) => async (p: any) =>
  once(ctx.pool, p.trip_id, p.request_id, async (db) => {
    await tripOf(db, p.trip_id);
    // Lock the vote's row so two requests for the same vote at the same moment cannot both pass the last rule.
    const locked = await db.query('select decision_id from decisions where decision_id = $1 and trip_id = $2 for update', [p.decision_id, p.trip_id]);
    const decision = locked.rowCount ? (await loadDecisions(db, p.trip_id, p.decision_id))[0] : undefined;
    const outstanding = await db.query(
      'select 1 from spend_approvals where decision_id = $1 and used_at is null and cancelled_at is null and expires_at > now()',
      [p.decision_id],
    );
    const denial = spendCheck(decision, p, (outstanding.rowCount ?? 0) > 0);
    if (denial) return { status: 'denied' as const, reason: denial.reason, detail: denial.detail.slice(0, 200) };
    const { row, answer } = issueApproval(p.trip_id, decision!, p, ctx.spendPrivateKey);
    await db.query(
      `insert into spend_approvals (approval_id, trip_id, request_id, decision_id, payer_person_id, amount_minor, currency, merchant, approval, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [row.approval_id, row.trip_id, row.request_id, row.decision_id, row.payer_person_id, row.amount_minor, row.currency, row.merchant, row.approval, row.expires_at],
    );
    return answer;
  });

/** Releases an approval Go will not use. Cancelling one that is used, cancelled or expired still answers ok. */
export const cancelSpendApproval = (ctx: Ctx) => async (p: { request_id: string; trip_id: string; approval_id: string }) =>
  once(ctx.pool, p.trip_id, p.request_id, async (db) => {
    await tripOf(db, p.trip_id);
    const found = await db.query('select 1 from spend_approvals where trip_id = $1 and approval_id = $2', [p.trip_id, p.approval_id]);
    if (!found.rowCount) throw notFound(`approval ${p.approval_id} does not exist in trip ${p.trip_id}`);
    // Used, already cancelled or expired: nothing to release, and nothing changes.
    await db.query('update spend_approvals set cancelled_at = now() where approval_id = $1 and used_at is null and cancelled_at is null and expires_at > now()', [p.approval_id]);
    return { ok: true as const };
  });
