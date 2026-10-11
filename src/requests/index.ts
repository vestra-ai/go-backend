import type { Ctx } from '../context.js';
import { storeBookingExtras } from '../domain/bookings.js';
import { SocketCallError, type Handler } from '../go/go-socket.js';
import { addReaction, removeReaction } from './reactions.js';
import { readMessages, readTrip } from './reads.js';
import { addRecordLine, updateRecordLine } from './record.js';
import { postMessage, replaceCard, typing } from './messages.js';
import { addBooking, addExpense, cancelSpendApproval, requestSpendApproval, updateBooking } from './money.js';
import { updateTrip } from './trip.js';
import { addVoteOptions, closeVote, openVote, setMandate } from './votes.js';

/** Every request is answered within 2 seconds. When it cannot be, Go gets 503 and tries again with the same request_id. */
export const ANSWER_WITHIN_MS = 1800;

function withDeadline(name: string, handler: Handler, ms: number): Handler {
  return async (params, raw) => {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SocketCallError(503, `${name} took too long: try again`, 'unavailable')), ms);
    });
    // A write that finishes after the deadline still commits and stores its answer, so Go's retry gets that answer (same request_id).
    return Promise.race([handler(params, raw), late]).finally(() => clearTimeout(timer));
  };
}

/**
 * add_booking, then the 1.1 fields (GO-CHANGES 1.7): details, the return leg and the passengers go on the row, and the
 * documents Go named are copied into Storage in the background (src/domain/bookings.ts). Go's answer is the same either way.
 */
function addBookingWithExtras(ctx: Ctx): Handler {
  const base = addBooking(ctx);
  return async (p, raw) => {
    const answer = (await base(p, raw)) as { booking_id: string; seq: number };
    await storeBookingExtras(ctx, p.trip_id, answer.booking_id, { details: p.details, return_journey: p.return_journey, passengers: p.passengers, documents: p.documents });
    return answer;
  };
}

/** Go's 19 requests, each answered from the shared database. A method not in this table is answered -32601. */
export function goRequestHandlers(ctx: Ctx, answerWithinMs = ANSWER_WITHIN_MS): Record<string, Handler> {
  const handlers: Record<string, Handler> = {
    read_trip: readTrip(ctx),
    read_messages: readMessages(ctx),
    post_message: postMessage(ctx),
    replace_card: replaceCard(ctx),
    typing: typing(ctx),
    add_reaction: addReaction(ctx),
    remove_reaction: removeReaction(ctx),
    update_trip: updateTrip(ctx),
    open_vote: openVote(ctx),
    add_vote_options: addVoteOptions(ctx),
    close_vote: closeVote(ctx),
    set_mandate: setMandate(ctx),
    add_record_line: addRecordLine(ctx),
    update_record_line: updateRecordLine(ctx),
    add_booking: addBookingWithExtras(ctx),
    update_booking: updateBooking(ctx),
    add_expense: addExpense(ctx),
    request_spend_approval: requestSpendApproval(ctx),
    cancel_spend_approval: cancelSpendApproval(ctx),
  };
  // `typing` is a notification: nothing answers it, so it has no deadline.
  return Object.fromEntries(Object.entries(handlers).map(([name, h]) => [name, name === 'typing' ? h : withDeadline(name, h, answerWithinMs)]));
}
