// §4.10: the bookings tab and the ticket viewer. Reading bookings (with the covered-people rule for passengers and
// documents), opening a ticket file, bookings people add themselves, their edits, and the group vote to cancel one.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { documentLink, getBooking, listBookings } from '../../domain/bookings.js';
import { addPersonBooking, proposeCancelBooking, updatePersonBooking } from '../../domain/votes-bookings.js';
import { checkAddBooking, checkCancelVote, checkUpdateBooking } from '../bodies.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import { atLeastOneField, inTrip, memberFirst, type TripRequest, type V1Deps } from './shared.js';

const JOURNEY = { mode: 'flight', origin: { name: 'Bengaluru', code: 'BLR' }, destination: { name: 'Mopa', code: 'GOX' }, depart_at: '2026-11-06T19:40:00+05:30', arrive_at: '2026-11-06T21:55:00+05:30', carrier_name: 'IndiGo', carrier_code: '6E', number: '5313' };
const BOOKING = {
  booking_id: 'b_01JA', kind: 'flight', status: 'confirmed', title: 'BLR → GOX · 6E 5313', vendor: 'ixigo', ref: 'K7QX2M', amount_minor: 1184000, currency: 'INR',
  payer_person_id: 'p_rahul', for_person_ids: ['p_rahul', 'p_arjun'], starts_at: '2026-11-06T14:10:00Z', ends_at: '2026-11-06T16:25:00Z', journey: JOURNEY,
  details: [{ label: 'PNR', value: 'K7QX2M' }, { label: 'Baggage', value: '15 kg' }], created_at: '2026-10-08T10:00:00Z',
  passengers: [{ person_id: 'p_rahul', seat: '14A', pnr: 'K7QX2M' }, { person_id: 'p_arjun', seat: '14B', pnr: 'K7QX2M' }],
  documents: [{ document_id: 'doc_01JA', name: '6E5313-K7QX2M.pdf', mime: 'application/pdf', size_bytes: 184233, pages: 2, visibility: 'covered', url: 'https://<ref>.supabase.co/storage/v1/object/sign/go-files/bookings/t_goa/b_01JA/doc_01JA.pdf?token=…' }],
};
const { passengers: _p, documents: _d, ...BOOKING_FOR_OTHERS } = BOOKING;
const refused = (status: number, code: string, msg: string, field: string | null = null) => ({ name: code, status, body: { error: { code, message: msg, field, retry_after_seconds: null, request_id: 'req_01JA7Q3V8Z' } } });

export const routes: RouteMeta[] = [
  {
    method: 'GET', path: '/app/v1/trips/:trip/bookings', section: SECTIONS.bookings, title: 'Bookings',
    summary: 'The Bookings tab: every booking of the trip, confirmed and cancelled, newest first, with the trip change number. passengers[] and documents[] are in a booking only for the people it covers (for_person_ids); everyone else gets the booking without those two keys. Each document carries url, a signed link valid 1 hour, minted on every read. details and return_journey are for everyone.',
    example: { responses: [{ name: 'as a covered person', status: 200, body: { items: [BOOKING], seq: 61 } }, { name: 'as anyone else', status: 200, body: { items: [BOOKING_FOR_OTHERS], seq: 61 } }] },
  },
  {
    method: 'GET', path: '/app/v1/trips/:trip/bookings/:id', section: SECTIONS.bookings, title: 'One booking',
    summary: 'One Booking (the ticket card redraws from this), with the same covered-people rule. 404 when it is not in this trip.',
    example: { responses: [{ name: 'Booking', status: 200, body: BOOKING }, refused(404, 'not_found', 'booking b_nope does not exist in trip t_goa')] },
  },
  {
    method: 'GET', path: '/app/v1/trips/:trip/bookings/:id/documents/:document_id', section: SECTIONS.bookings, title: 'Open a ticket file',
    summary: 'The ticket PDF for the viewer, Save and Share: 302 to a signed link valid 10 minutes (Cache-Control: private, no-store). Only for the people the booking covers, or anyone in the trip when the document is marked group-visible (403 otherwise); 404 for a document that is not on this booking.',
    example: { responses: [{ name: 'Redirect', status: 302 }, refused(403, 'forbidden', 'this ticket is for the people the booking covers'), refused(404, 'not_found', 'document doc_x is not on booking b_01JA')] },
  },
  {
    method: 'POST', path: '/app/v1/trips/:trip/bookings', section: SECTIONS.bookings, title: 'Add a booking',
    summary: 'A member records a booking made outside Go: kind, title, vendor, ref, amount_minor, payer_person_id, for_person_ids, and optionally refundable_until, starts_at, ends_at, journey, return_journey, details [{ label, value }], passengers [{ person_id (one of for_person_ids), seat?, pnr? }], place, image_url, decision_id (a closed vote it fulfils). Stored confirmed in the trip\'s currency, no expense; answers 201 Booking as you see it (the covered-people rule applies; documents [] for now) plus seq. Go hears booking.changed added by you, then the booked record line. Strict body; send an Idempotency-Key so a retry is safe.',
    example: { body: { kind: 'flight', title: 'BLR → GOX · 6E 5313', vendor: 'ixigo', ref: 'K7QX2M', amount_minor: 1184000, payer_person_id: 'p_rahul', for_person_ids: ['p_rahul', 'p_arjun'], journey: JOURNEY, details: [{ label: 'Baggage', value: '15 kg' }], passengers: [{ person_id: 'p_rahul', seat: '14A', pnr: 'K7QX2M' }] }, responses: [{ name: 'Added', status: 201, body: { ...BOOKING, added_by_person_id: 'p_rahul', passengers: [{ person_id: 'p_rahul', seat: '14A', pnr: 'K7QX2M' }], documents: [], seq: 62 } }, refused(422, 'invalid', 'passengers[0].person_id must be one of for_person_ids', 'passengers[0].person_id')] },
  },
  {
    method: 'PATCH', path: '/app/v1/trips/:trip/bookings/:id', section: SECTIONS.bookings, title: 'Edit a booking',
    summary: 'ref, refundable_until, starts_at, ends_at (null clears a time). At least one field; only what differs is written (seq null when nothing changed). 409 on a cancelled booking.',
    example: { body: { ref: 'K7QX2N', starts_at: null }, responses: [{ name: 'Updated', status: 200, body: { seq: 63 } }, { name: 'Nothing changed', status: 200, body: { seq: null } }] },
  },
  {
    method: 'POST', path: '/app/v1/trips/:trip/bookings/:id/cancel-vote', section: SECTIONS.bookings, title: 'Propose cancelling',
    summary: 'Opens a 24-hour, non-anonymous yes/no vote "Cancel this booking?" that passes with more than half of the trip; the vote carries cancels_booking_id in app reads. Empty body (send an Idempotency-Key). 409 when the booking is cancelled, was paid through the vault, or is already up for a vote.',
    example: { body: {}, responses: [{ name: 'Opened', status: 201, body: { decision_id: 'd_01JB', seq: 64 } }, refused(409, 'conflict', 'a vote to cancel booking b_01JA is already open: d_01JB')] },
  },
];

export function register(app: FastifyInstance, ctx: Ctx, _deps: V1Deps): void {
  app.get('/app/v1/trips/:trip/bookings', inTrip(ctx, (_req, trip, me) => listBookings(ctx, trip, me)));
  app.get('/app/v1/trips/:trip/bookings/:id', inTrip(ctx, (req, trip, me) => getBooking(ctx, trip, me, req.params.id!)));
  // A redirect, not a JSON answer: the link is made here rather than through inTrip.
  app.get('/app/v1/trips/:trip/bookings/:id/documents/:document_id', { preValidation: memberFirst(ctx) }, async (req, reply) => {
    const r = req as TripRequest;
    const url = await documentLink(ctx, r.params.trip, r.personId, r.params.id!, r.params.document_id!);
    reply.header('cache-control', 'private, no-store');
    return reply.redirect(url, 302);
  });
  app.post('/app/v1/trips/:trip/bookings', inTrip(ctx, (req, trip, me) => addPersonBooking(ctx, trip, me, checkAddBooking(req.body)), 201));
  app.patch('/app/v1/trips/:trip/bookings/:id', inTrip(ctx, (req, trip, me) => {
    const input = checkUpdateBooking(req.body);
    atLeastOneField(input);
    return updatePersonBooking(ctx, trip, me, req.params.id!, input);
  }));
  app.post('/app/v1/trips/:trip/bookings/:id/cancel-vote', inTrip(ctx, (req, trip, me) => proposeCancelBooking(ctx, trip, me, req.params.id!, checkCancelVote(req.body)), 201));
}
