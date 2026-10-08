// §4.11: the trip home's "Pending on you" and the room's "needs you" strip.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { needsYou } from '../../domain/actions.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import { inTrip, type V1Deps } from './shared.js';

const ITEMS = [
  { item_id: 'vote:d_when:p_aarav', kind: 'vote', title: 'Pick dates', subtitle: 'closes in 1 hour', cta_label: 'Vote', since: '2026-10-05T04:10:00Z', target: { decision_id: 'd_when', message_id: 'm_0150' } },
  { item_id: 'mandate:d_villa', kind: 'mandate', title: 'Yes, book it? Villa Sol, up to ₹55,000', subtitle: 'Where do we stay?', cta_label: 'Yes, book it', since: '2026-10-05T06:00:00Z', target: { decision_id: 'd_villa', card_id: 'c_villa_mandate', message_id: 'm_0170' } },
  { item_id: 'card:c_cab', kind: 'card', title: 'Airport cab to Villa Sol', subtitle: 'Fri 9:55 pm · with Arjun', cta_label: 'Book ₹1,600', since: '2026-10-05T07:00:00Z', target: { card_id: 'c_cab', message_id: 'm_0181' } },
  { item_id: 'record_line:r_scuba', kind: 'record_line', title: 'Scuba on Saturday?', since: '2026-10-05T07:30:00Z', target: { line_id: 'r_scuba' } },
  { item_id: 'settle:p_rahul', kind: 'settle_up', title: 'Settle up with Rahul', subtitle: '₹5,800 left of your share', cta_label: 'Record', since: '2026-10-05T08:00:00Z', target: { transfer: { to_person_id: 'p_rahul', amount_minor: 580000, currency: 'INR' } } },
  { item_id: 'expense:e_cab:p_aarav', kind: 'expense', title: 'Approve ₹1,700 · Airport cab', cta_label: 'Approve', since: '2026-10-05T08:30:00Z', target: { expense_id: 'e_cab' } },
];

export const routes: RouteMeta[] = [
  {
    method: 'GET', path: '/app/v1/trips/:trip/needs-you', section: SECTIONS.needsYou, title: 'Needs you',
    summary: 'What this person has to do in the trip, computed from the Server\'s own rows: { items: NeedsYouItem[], seq }. Kinds: vote (an open vote you have not voted in), mandate (you are the payer and have not answered), card (a Go card naming you, until replace_card drops you), record_line (an open line naming you), settle_up (each net transfer where you owe, from money.transfers), expense (an expense waiting for your approval), checkin (web check-in open for your flight: phase 5). item_id is stable per underlying thing; a vote about cancelling a booking also carries target.cancels_booking_id. TripView.needs_you_count and the home card are this list\'s length.',
    example: { responses: [{ name: 'items', status: 200, body: { items: ITEMS, seq: 120 } }] },
  },
];

export function register(app: FastifyInstance, ctx: Ctx, _deps: V1Deps): void {
  app.get('/app/v1/trips/:trip/needs-you', inTrip(ctx, (_r, trip, me) => needsYou(ctx, trip, me)));
}
