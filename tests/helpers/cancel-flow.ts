import type { appApi } from './app-api.js';
import type { Harness } from './harness.js';

export const EVERYONE = ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir'];

/** Building blocks for tests about cancelling a booking by vote. */
export function cancelFlow(h: Harness, t: ReturnType<typeof appApi>) {
  let n = 0;
  /** A booking added by a member of `trip`. Returns its id. */
  const addBooking = async (trip = 't_goa', over: Record<string, unknown> = {}) =>
    (await t.api(t.as('p_arjun'), 'POST', `/app/v1/trips/${trip}/bookings`, {
      client_id: `cf-${++n}`, kind: 'stay', title: `Stay ${n}`, vendor: 'ixigo', ref: 'R', amount_minor: 100, payer_person_id: 'p_rahul', for_person_ids: EVERYONE, ...over,
    })).body.booking_id as string;
  const propose = (bookingId: string, trip = 't_goa', who = 'p_priya', client_id = `pc-${++n}`) =>
    t.api(t.as(who), 'POST', `/app/v1/trips/${trip}/bookings/${bookingId}/cancel-vote`, { client_id });
  const castVote = (decisionId: string, who: string, option: number, trip = 't_goa') =>
    t.api(t.as(who), 'PUT', `/app/v1/trips/${trip}/decisions/${decisionId}/vote`, { option_index: option });
  const closeEarly = (decisionId: string, trip = 't_goa', who = 'p_rahul') => t.api(t.as(who), 'POST', `/app/v1/trips/${trip}/decisions/${decisionId}/close`);
  /** Votes written straight into the table: no event, no closing, so a test can set up a tally that the path under test then completes. */
  const preCast = async (decisionId: string, cast: Array<[string, number]>) => {
    for (const [who, option] of cast) await h.pool.query('insert into votes (decision_id, person_id, option_index) values ($1, $2, $3)', [decisionId, who, option]);
  };
  const bookingStatus = async (bookingId: string) => (await h.pool.query('select status from bookings where booking_id = $1', [bookingId])).rows[0].status as string;
  const cancelledEvents = (bookingId: string) => t.events('booking.changed').filter((e) => e.data.change === 'cancelled' && e.data.booking.booking_id === bookingId);
  return { addBooking, propose, castVote, closeEarly, preCast, bookingStatus, cancelledEvents, next: () => ++n };
}
