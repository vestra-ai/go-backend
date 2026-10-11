// The demo's payment (docs/GO-TEAM-DEMO-PAYMENT.md). No real payment is taken: when the payer taps Approve on one of
// Go's waiting pay cards, the Server takes the payment as done. The tap never reaches Go and no vault page opens. In one
// transaction the card becomes paid, the booking and its expense are written, the room gets its lines, and Go hears
// booking.changed, record.changed, expense.changed and then payment.completed, which names them all.
import { nowOf, type Ctx } from '../context.js';
import { newId } from '../db/ids.js';
import { once } from '../db/once.js';
import type { Db } from '../db/pool.js';
import { change, emit, nextSeq } from '../db/write-change.js';
import { attachDemoTickets } from '../demo/attach.js';
import { publishHome } from './actions.js';
import { storeBookingExtras } from './bookings.js';
import { demoBookingFor, type DemoOption } from './demo-booking.js';
import { conflict } from './errors.js';
import { insertExpense, moneyChanged } from './expenses.js';
import { postExpenseAdded } from './ledger-lines.js';
import { bookingOf, compact, recordLineOf, type BookingRow, type RecordLineRow } from './mappers.js';
import { activePeople, loadDecisions } from './snapshot.js';
import type { ApprovalRow, PickRow } from './spend.js';
import { bookedText, postSystemMessage } from './system-messages.js';

export interface PayCardLike {
  card_id: string; kind: string; state?: string; approval_id?: string; payer_person_id?: string; merchant?: string; purpose?: string;
  for_person_ids?: string[] | null; actions?: Array<{ action_id: string }> | null;
}

/** The button that pays, on every pay card Go posts (Go's answer Q1: key on the action, never the label). */
export const DEMO_PAY_ACTION = 'approve';
/** What the app is answered: the card it holds is replaced by the paid one over the live connection. */
export const DEMO_PAID = { result: 'done' } as const;
/** What the payer sees when the payment could not be taken: the card moved on, or it is booked already. */
export const DEMO_NOT_WAITING = { result: 'refused', toast: 'This payment is no longer waiting.' } as const;

/** The `once` key of a card's demo payment: its row in go_requests is also the mark that the card was paid this way. */
export const demoPayKey = (cardId: string) => `demo:pay:${cardId}`;

/** True when this card's payment was taken as done by the Server. Such a card stays paid: Go may not expire or fail it. */
export async function isDemoPaid(db: Db, tripId: string, cardId: string): Promise<boolean> {
  return ((await db.query('select 1 from go_requests where trip_id = $1 and request_id = $2', [tripId, demoPayKey(cardId)])).rowCount ?? 0) > 0;
}

/** The booking's kind as an expense category. */
const CATEGORY: Record<string, string> = { stay: 'stay', flight: 'getting_around', train: 'getting_around', bus: 'getting_around', cab: 'getting_around', activity: 'activities', table: 'food' };

type OptionsCardLike = { option_kind?: string; options?: Array<DemoOption & { option_id: string }> | null };

/** The option a payment was for, with its card's kind: the person's pick, or the winning option of the group's vote. */
async function paidOption(db: Db, tripId: string, approval: ApprovalRow): Promise<{ option?: DemoOption; option_kind?: string }> {
  const onCard = async (cardId: string, optionId: string) => {
    const card = (await db.query('select card from messages where trip_id = $1 and card_id = $2', [tripId, cardId])).rows[0]?.card as OptionsCardLike | undefined;
    return { option: card?.options?.find((o) => o.option_id === optionId), option_kind: card?.option_kind };
  };
  if (approval.pick_id) {
    const pick = (await db.query<PickRow>('select * from option_picks where pick_id = $1', [approval.pick_id])).rows[0];
    return pick ? onCard(pick.card_id, pick.option_id) : {};
  }
  const decision = approval.decision_id ? (await loadDecisions(db, tripId, approval.decision_id))[0] : undefined;
  const won = decision?.mandate ? (decision.options[decision.mandate.choice_index] as (DemoOption & { option_ref?: string | null }) | undefined) : undefined;
  if (!won) return {};
  // The vote's option names the card option it came from (1.3): that one carries the journey and the place.
  const from = won.option_ref
    ? (await db.query(
        `select card from messages where trip_id = $1 and author_kind = 'go' and card->>'kind' = 'options' and not deleted
           and card->'options' @> jsonb_build_array(jsonb_build_object('option_id', $2::text)) order by seq desc limit 1`,
        [tripId, won.option_ref],
      )).rows[0]?.card as OptionsCardLike | undefined
    : undefined;
  return { option: { ...won, ...from?.options?.find((o) => o.option_id === won.option_ref) }, option_kind: from?.option_kind ?? 'stay' };
}

/**
 * The payer tapped Approve on a waiting pay card. Done once per card: a second tap (a double tap, a retry, a tap that
 * raced the first) is answered as the first was and writes nothing. A conflict when the card is no longer waiting, its
 * approval is not one of this trip's, is used or was cancelled, or what it pays for is already booked: the tap then
 * answers a refusal toast (cardTap). The approval's ten minutes are not checked: Go expires the card itself, and an
 * expired card is not waiting.
 */
export async function demoPay(ctx: Ctx, tripId: string, personId: string, cardId: string): Promise<typeof DEMO_PAID> {
  return once(ctx.pool, tripId, demoPayKey(cardId), async (db, after) => {
    const m = (await db.query(`select message_id, card from messages where trip_id = $1 and card_id = $2 and author_kind = 'go' and not deleted for update`, [tripId, cardId])).rows[0];
    const card = m?.card as PayCardLike | undefined;
    if (!m || card?.kind !== 'pay' || card.state !== 'waiting' || card.payer_person_id !== personId) throw conflict('this payment is no longer waiting');
    const approval = (await db.query<ApprovalRow>('select * from spend_approvals where approval_id = $1 and trip_id = $2 for update', [card.approval_id, tripId])).rows[0];
    if (!approval || approval.payer_person_id !== personId) throw conflict('this payment has no approval of yours');
    if (approval.used_at || approval.cancelled_at) throw conflict('this payment is already done or was called off');
    // Not twice: when this approval ran out unpaid, Go may have been granted another for the same vote or pick, and that
    // one may be paid already while this card still waits. The same rule as the spend check's `already_booked`.
    const booked = approval.decision_id
      ? await db.query(`select 1 from bookings where trip_id = $1 and decision_id = $2 and status = 'confirmed' limit 1`, [tripId, approval.decision_id])
      : await db.query(
          `select 1 from bookings b join spend_approvals a on a.approval_id = b.approval_id join option_picks k on k.pick_id = a.pick_id
            join option_picks mine on mine.pick_id = $2 and mine.person_id = k.person_id and mine.card_id = k.card_id and mine.option_id = k.option_id
            where b.trip_id = $1 and b.status = 'confirmed' limit 1`,
          [tripId, approval.pick_id],
        );
    if (booked.rowCount) throw conflict('this is already booked');
    const amount = Number(approval.amount_minor);

    const everyone = (await activePeople(db, tripId)).map((p) => p.person_id);
    const forPeople = approval.for_person_id ? [approval.for_person_id] : everyone;
    const { option, option_kind } = await paidOption(db, tripId, approval);
    // The names on the ticket (the covered people and the payer) and the trip's dates for a stay.
    const people = (await db.query('select person_id, name, email from people where person_id = any($1)', [[...new Set([...forPeople, personId])]])).rows
      .map((p) => compact({ person_id: p.person_id as string, name: p.name as string, email: (p.email as string | null) ?? undefined }));
    const trip = (await db.query(`select title, destination, to_char(dates_start, 'YYYY-MM-DD') as start, to_char(dates_end, 'YYYY-MM-DD') as "end" from trips where trip_id = $1`, [tripId])).rows[0];
    const f = await demoBookingFor({
      trip_id: tripId, approval_id: approval.approval_id, merchant: approval.merchant, purpose: card.purpose ?? approval.merchant,
      amount_minor: amount, currency: approval.currency, payer_person_id: personId, for_person_ids: forPeople, option_kind, option, people,
      trip: trip && compact({ title: trip.title as string, destination: trip.destination ?? undefined, dates: trip.start && trip.end ? { start: trip.start as string, end: trip.end as string } : undefined }),
    }, nowOf(ctx));

    // Row locks before the change number, as on Go's add_booking: the vote's decided line becomes the booked line.
    const decided = approval.decision_id
      ? (await db.query<RecordLineRow>(`select * from record_lines where trip_id = $1 and decision_id = $2 and kind = 'decided' and status = 'active' for update`, [tripId, approval.decision_id])).rows[0]
      : undefined;

    // The card first: paid, with no buttons, everything else as Go sent it. A change number with no event, like a replace_card.
    const paid = { ...card, state: 'paid', actions: null };
    const cardSeq = await nextSeq(db, tripId);
    await db.query('update messages set card = $2, updated_seq = $3 where message_id = $1', [m.message_id, JSON.stringify(paid), cardSeq]);
    await ctx.live.publish(tripId, { kind: 'card', message_id: m.message_id });
    await ctx.live.publish(tripId, { kind: 'message', message_id: m.message_id, updated_seq: cardSeq });

    const json = (v: unknown) => (v == null ? null : JSON.stringify(v));
    const booking = (await db.query<BookingRow>(
      `insert into bookings (booking_id, trip_id, kind, title, vendor, ref, amount_minor, currency, payer_person_id, for_person_ids,
                             refundable_until, starts_at, ends_at, journey, place, image_url, decision_id, approval_id, details, return_journey, passengers)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) returning *`,
      [newId('b'), tripId, f.kind, f.title, f.vendor, f.ref, amount, approval.currency, personId, JSON.stringify(forPeople),
       f.refundable_until ?? null, f.starts_at ?? null, f.ends_at ?? null, json(f.journey), json(f.place), f.image_url ?? null,
       approval.decision_id, approval.approval_id, json(f.details), json(f.return_journey), json(f.passengers)],
    )).rows[0]!;
    await db.query('update spend_approvals set used_at = now(), booking_id = $2 where approval_id = $1', [approval.approval_id, booking.booking_id]);
    const by = { kind: 'system' as const };
    await change(db, tripId, 'booking.changed', { booking: bookingOf(booking), change: 'added', by });

    const line = decided
      ? (await db.query<RecordLineRow>(
          `update record_lines set kind = 'booked', text = $2, booking_id = $3, source = 'booking', updated_at = now() where line_id = $1 returning *`,
          [decided.line_id, f.title.slice(0, 200), booking.booking_id],
        )).rows[0]!
      : (await db.query<RecordLineRow>(
          `insert into record_lines (line_id, trip_id, kind, text, booking_id, decision_id, source) values ($1, $2, 'booked', $3, $4, $5, 'booking') returning *`,
          [newId('r'), tripId, f.title.slice(0, 200), booking.booking_id, approval.decision_id],
        )).rows[0]!;
    const lineSeq = await change(db, tripId, 'record.changed', { line: recordLineOf(line), change: decided ? 'updated' : 'added', by });
    await ctx.live.publish(tripId, { kind: 'trip', seq: lineSeq, kinds: ['booking', 'record'] });

    // The expense: a person's own payment is theirs alone, a group payment is split equally across the trip.
    const expense = await insertExpense(db, tripId, {
      paid_by_person_id: personId, amount_minor: amount, currency: approval.currency, note: f.title.slice(0, 120),
      category: CATEGORY[f.kind] ?? 'other', split_person_ids: forPeople, booking_id: booking.booking_id,
    });
    const expenseSeq = await change(db, tripId, 'expense.changed', { expense, change: 'added', by });
    await moneyChanged(ctx, tripId, expenseSeq);

    const pick = approval.pick_id ? (await db.query<PickRow>('select * from option_picks where pick_id = $1', [approval.pick_id])).rows[0] : undefined;
    await change(db, tripId, 'payment.completed', {
      approval_id: approval.approval_id, card_id: cardId, payer_person_id: personId, amount_minor: amount, currency: approval.currency,
      merchant: approval.merchant, purpose: card.purpose ?? approval.merchant,
      ...(approval.decision_id ? { decision_id: approval.decision_id } : {}),
      ...(pick ? { personal: { person_id: pick.person_id, card_id: pick.card_id, option_id: pick.option_id } } : {}),
      booking_id: booking.booking_id, expense_id: expense.expense_id, method: 'demo', paid_at: new Date().toISOString(),
      by: { kind: 'person', person_id: personId },
    });

    // The room's lines last, as after Go's add_booking and add_expense: "<title> booked", then the money line.
    await postSystemMessage(ctx, db, tripId, bookedText(f.title));
    await postExpenseAdded({ ctx, db, tripId }, expense, { kind: 'person', person_id: personId });
    await publishHome(ctx, tripId, [...new Set([personId, ...(card.for_person_ids ?? [])])]); // the card leaves their open items
    // The ticket files are copied from their links once the payment is saved, in the background, as for Go's add_booking:
    // a file that cannot be fetched is skipped and the booking stands without it.
    const documents = (f.documents ?? []).slice(0, 10).map((d) => ({ ...d, document_id: newId('doc'), size_bytes: 0 }));
    if (documents.length) after(() => storeBookingExtras(ctx, tripId, booking.booking_id, { documents }));
    // The ticket PDFs the module described are rendered here, in the background too (src/demo/attach.ts).
    const tickets = f.tickets ?? [];
    if (tickets.length) after(() => attachDemoTickets(ctx, tripId, booking.booking_id, tickets));
    return DEMO_PAID;
  });
}
