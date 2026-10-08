// §4.10 Itinerary: GET /trips/:trip/itinerary in its two scopes. People edit the itinerary with PATCH /trips/:trip (§4.4),
// which accepts the 1.1 item fields person_ids and audience and Day.image_url; Go writes it with update_trip.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { readItinerary } from '../../domain/itinerary.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import { inTrip, type V1Deps } from './shared.js';

const DAY = {
  date: '2026-11-06', title: 'Arrive', image_url: 'https://images.example/goa-day1.jpg',
  items: [
    { item_id: 'it_1', time: '19:40', title: 'Fly to Goa', category: 'getting_around', booking_id: 'b_01JA', status: 'booked', person_ids: ['p_rahul', 'p_arjun'], audience: 'shared' },
    { item_id: 'it_2', time: '22:30', title: 'Check in at Villa Sol', category: 'stay', status: 'booked', audience: 'group' },
    { item_id: 'it_3', time: '23:00', title: 'Call home', category: 'other', status: 'planned', person_ids: ['p_priya'], audience: 'private' },
  ],
};

export const routes: RouteMeta[] = [
  {
    method: 'GET', path: '/app/v1/trips/:trip/itinerary', section: SECTIONS.bookings, title: 'Itinerary',
    summary: '?scope=everyone (default) is the stored itinerary minus private items that do not name you. ?scope=me is "Just me": items that name you, are shared with you or the group, or name nobody; an item tied to a booking that covers you is reworded from the booking ("BLR → GOX · 6E 5313, Seat 14A, lands Mopa 9:55 pm"). Items keep person_ids and audience. days: [] is the "No plan yet" state.',
    example: {
      query: { scope: 'me' },
      responses: [
        { name: 'everyone (as Rahul)', status: 200, body: { days: [{ ...DAY, items: DAY.items.slice(0, 2) }], seq: 61 } },
        { name: 'me (as Rahul)', status: 200, body: { days: [{ ...DAY, items: [{ ...DAY.items[0], title: 'BLR → GOX · 6E 5313, Seat 14A, lands Mopa 9:55 pm' }, DAY.items[1]] }], seq: 61 } },
      ],
    },
  },
];

export function register(app: FastifyInstance, ctx: Ctx, _deps: V1Deps): void {
  app.get('/app/v1/trips/:trip/itinerary', {
    schema: { querystring: { type: 'object', properties: { scope: { type: 'string', enum: ['everyone', 'me'] } } } },
    ...inTrip(ctx, (req, trip, me) => readItinerary(ctx, trip, me, req.query.scope ?? 'everyone')),
  });
}
