// §4.12 Web check-in, behind features.checkin: the state of one person's check-in on a flight (asked of Go and kept), their
// answers, and the submit. Go performs the check-in on the airline site; the server's copy is what the sheets, the
// strip and the home card read (src/domain/checkin.ts). With the flag off every route is 404, so the app's flag and the
// server agree.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../../context.js';
import { requireMember } from '../../domain/actions.js';
import { checkinOff, completeCheckin, getCheckin, patchCheckin } from '../../domain/checkin.js';
import { checkPatchCheckin } from '../bodies.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import { atLeastOneField, type TripRequest, type V1Deps } from './shared.js';

const FLIGHT = { number: '6E 5313', carrier_name: 'IndiGo', logo_url: 'https://brain.go.example/logos/6E.png', date: '2026-11-06', origin: { name: 'Bengaluru T1', code: 'BLR', time: '20:40' }, destination: { name: 'Goa · Mopa', code: 'GOX', time: '21:55' } };
const SEAT_MAP = {
  front_label: 'FRONT OF PLANE', columns: ['A', 'B', 'C', 'D', 'E', 'F'], aisle_after: 'C', rows: [12, 13, 14, 15, 16, 17, 18],
  seats: [{ id: '14A', row: 14, col: 'A', state: 'free', price_minor: 0 }, { id: '14B', row: 14, col: 'B', state: 'companion', price_minor: 0 }, { id: '14C', row: 14, col: 'C', state: 'taken', price_minor: 0 }, { id: '12A', row: 12, col: 'A', state: 'paid', price_minor: 45000 }],
};
/** The contract's CheckinState example (app contract §4.12), as the server answers it while check-in is open. */
const OPEN = {
  status: 'open', opens_at: '2026-11-04T08:40:00+05:30', closes_at: '2026-11-06T19:40:00+05:30', flight: FLIGHT,
  passenger: { name: 'Aarav Shah', mobile_masked: '+91 98••• ••210', bags: '7 kg cabin · 15 kg check-in' },
  digi_yatra: true, declaration: true, seat: '14A', companion: { person_id: 'p_arjun', seat: '14B', next_to_seats: ['14A', '14C'] }, seat_map: SEAT_MAP, boarding_pass: null,
};
const PASS = { passenger: 'AARAV SHAH', boarding: '20:00', departs: '20:40', gate: null, zone: '2', seq: '087', barcode: { format: 'qr', payload: 'M1SHAH/AARAV…' } };
const DONE = { ...OPEN, status: 'done', boarding_pass: PASS };
const refused = (status: number, code: string, msg: string, field: string | null = null) => ({ name: code, status, body: { error: { code, message: msg, field, retry_after_seconds: null, request_id: 'req_01JA7Q3V8Z' } } });

export const routes: RouteMeta[] = [
  {
    method: 'GET', path: '/app/v1/trips/:trip/bookings/:booking_id/checkin', section: SECTIONS.checkin, title: 'Check-in state',
    summary: 'CheckinState for your seat on a flight booking (status not_open | open | done, plus Go\'s working/failed/closed while it works): opens_at, closes_at, flight, passenger, digi_yatra, declaration, seat, companion (the friend on the same booking and their seat, filled by the server from the booking\'s passengers unless Go named one), seat_map (free | paid | taken | companion seats with price_minor) and boarding_pass (null until done). The server asks Go get_checkin (2 s) and keeps the answer; Go\'s `working` keeps what is cached; Go away → the cached state, or 502 go_unavailable when there is none. The first time a flight\'s check-in is open, everyone it covers gets the `checkin` push (deep link /trips/:trip/checkin/:booking_id) and the strip\'s `checkin` item. Go may also open it by posting a notice card linking go://trips/:trip/checkin/:booking_id. Only for a flight that covers you (403); 404 when the flag is off or the booking is not in the trip.',
    example: { responses: [{ name: 'Open', status: 200, body: OPEN }, { name: 'Not open yet', status: 200, body: { ...OPEN, status: 'not_open', digi_yatra: false, declaration: false, seat: undefined, seat_map: undefined } }, { name: 'Checked in', status: 200, body: DONE }, refused(404, 'not_found', 'web check-in is not available'), refused(403, 'forbidden', 'this flight does not cover you'), refused(502, 'go_unavailable', 'Go could not read the check-in just now. Try again.')] },
  },
  {
    method: 'PATCH', path: '/app/v1/trips/:trip/bookings/:booking_id/checkin', section: SECTIONS.checkin, title: 'Check-in answers',
    summary: 'The details and seat steps: { digi_yatra?, declaration?, seat?, mobile? } go into your cached state (fetched from Go first when there is none) and the updated CheckinState comes back; nothing reaches Go until complete. A seat must be on the seat_map and free, paid or companion (422 seat); taken is 409. A paid seat (price_minor > 0) is a payment: the answer is 200 { ...state, payment_required: true, seat_price: { amount_minor, currency } } and the seat is NOT set; the vault pays first (Go posts a pay card) and Go sets the seat once the payment lands. mobile is kept for the submit and shown back masked in passenger.mobile_masked. 409 when the check-in is not open (not yet open, done, or Go still working).',
    example: { body: { digi_yatra: true, declaration: true, seat: '14A', mobile: '+91 98765 43210' }, responses: [{ name: 'Updated', status: 200, body: OPEN }, { name: 'Paid seat', status: 200, body: { ...OPEN, seat: undefined, payment_required: true, seat_price: { amount_minor: 45000, currency: 'INR' } } }, refused(422, 'invalid', 'seat 99Z is not on the seat map', 'seat'), refused(409, 'conflict', 'seat 14C is taken'), refused(409, 'conflict', 'you are already checked in')] },
  },
  {
    method: 'POST', path: '/app/v1/trips/:trip/bookings/:booking_id/checkin/complete', section: SECTIONS.checkin, title: 'Complete the check-in',
    summary: 'Sends Go submit_checkin with your cached answers (digi_yatra, declaration, seat, mobile?), 2 s. Needs declaration: true and a seat (422). Go done → 200 CheckinState with status done and the boarding_pass; Go working → 202 with the state marked working (Go finishes on the airline site and updates by replace_card; read GET …/checkin again for the pass); Go failed → 409 conflict with Go\'s message, your answers kept so you can fix and retry; Go silent → 502 go_unavailable. Empty body (send an Idempotency-Key).',
    example: { body: {}, responses: [{ name: 'Checked in', status: 200, body: DONE }, { name: 'Go is working on it', status: 202, body: { ...OPEN, status: 'working' } }, refused(422, 'invalid', 'the declaration must be accepted first', 'declaration'), refused(409, 'conflict', 'the airline did not accept the check-in: check the details and try again'), refused(502, 'go_unavailable', 'Go could not complete the check-in just now. Try again.')] },
  },
];

export function register(app: FastifyInstance, ctx: Ctx, deps: V1Deps): void {
  // The flag first (404 for anyone, member or not), then the member check, then the domain.
  const checkin = (fn: (req: TripRequest, trip: string, me: string, reply: FastifyReply) => unknown) => ({
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      if (!deps.features.checkin) throw checkinOff();
      const r = req as TripRequest;
      await requireMember(ctx.pool, r.params.trip, r.personId);
      return fn(r, r.params.trip, r.personId, reply);
    },
  });
  app.get('/app/v1/trips/:trip/bookings/:booking_id/checkin', checkin((req, trip, me) => getCheckin(ctx, deps.go, trip, me, req.params.booking_id!)));
  app.patch('/app/v1/trips/:trip/bookings/:booking_id/checkin', checkin((req, trip, me) => {
    const input = checkPatchCheckin(req.body);
    atLeastOneField(input);
    return patchCheckin(ctx, deps.go, trip, me, req.params.booking_id!, input);
  }));
  app.post('/app/v1/trips/:trip/bookings/:booking_id/checkin/complete', checkin(async (req, trip, me, reply) => {
    const { working, state } = await completeCheckin(ctx, deps.go, trip, me, req.params.booking_id!);
    return reply.code(working ? 202 : 200).send(state);
  }));
}
