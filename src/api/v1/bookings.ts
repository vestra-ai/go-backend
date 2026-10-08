// §4.10: bookings people add themselves, their edits, and the group vote to cancel one.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { addPersonBooking, proposeCancelBooking, updatePersonBooking } from '../../domain/votes-bookings.js';
import { checkAddBooking, checkCancelVote, checkUpdateBooking } from '../bodies.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import { atLeastOneField, inTrip, requirePressKey, type V1Deps } from './shared.js';

export const routes: RouteMeta[] = [
  { method: 'POST', path: '/app/v1/trips/:trip/bookings', section: SECTIONS.bookings, title: 'Add a booking', summary: 'A member adds a booking they made (kind, title, vendor, ref, amount_minor, payer, for_person_ids, journey?, place?...). Strict body; client_id or an Idempotency-Key makes a retry safe.' },
  { method: 'PATCH', path: '/app/v1/trips/:trip/bookings/:id', section: SECTIONS.bookings, title: 'Edit a booking', summary: 'ref, refundable_until, starts_at, ends_at (null clears the times). At least one field.' },
  { method: 'POST', path: '/app/v1/trips/:trip/bookings/:id/cancel-vote', section: SECTIONS.bookings, title: 'Propose cancelling', summary: 'Opens a 24-hour yes/no vote "Cancel this booking?"; passes with more than half of the trip. 409 when cancelled, paid through the vault, or already up for a vote.' },
];

export function register(app: FastifyInstance, ctx: Ctx, _deps: V1Deps): void {
  app.post('/app/v1/trips/:trip/bookings', inTrip(ctx, (req, trip, me) => (requirePressKey(req), addPersonBooking(ctx, trip, me, checkAddBooking(req.body))), 201));
  app.patch('/app/v1/trips/:trip/bookings/:id', inTrip(ctx, (req, trip, me) => {
    const input = checkUpdateBooking(req.body);
    atLeastOneField(input);
    return updatePersonBooking(ctx, trip, me, req.params.id!, input);
  }));
  app.post('/app/v1/trips/:trip/bookings/:id/cancel-vote', inTrip(ctx, (req, trip, me) => (requirePressKey(req), proposeCancelBooking(ctx, trip, me, req.params.id!, checkCancelVote(req.body))), 201));
}
