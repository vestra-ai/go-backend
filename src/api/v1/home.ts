// §4.2 Home: the whole home screen in one read, and the ideas carousel for the first run.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { homeFor, ideasFor } from '../../domain/home.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import type { V1Deps } from './shared.js';

const PERSON = { person_id: 'p_aarav', name: 'Aarav Shah', photo_url: 'https://lh3.googleusercontent.com/a/photo' };

export const routes: RouteMeta[] = [
  { method: 'GET', path: '/app/v1/home', section: SECTIONS.home, title: 'Home', summary: 'My trips (latest activity first, with stage and the attention line the server works out), trips that are over, owes (every transfer where I am the one who pays, across all my trips, the over ones too), and a seq hint. attention: task when web check-in is open for my flight ("Web check-in is open"), else a checklist row of mine still to do ("Indonesia e-VOA needed", with features.visa); otherwise needs_you with the count, all_set once planned, else collecting. needs_you: { items, total }, every open item of mine across my trips that are not over (at most 50 listed; total counts all), each the trip\'s NeedsYouItem plus trip_id and trip_title, in this order: votes closing soonest (untimed after), mandates, cards for me, settle_up, record lines by due date, the rest; each item\'s target is what its popup opens. A title still "New trip" with a destination reads "<destination> - <year>". Empty trips ⇒ the first-run screen. Re-read on a home_changed notice.',
    example: { responses: [{ name: 'Returning', status: 200, body: {
      me: PERSON,
      trips: [{ trip_id: 't_goa', title: 'Goa 🌴', status: 'planning', stage: 'deciding', destination: { name: 'Goa', photo_url: 'https://images.example/goa.jpg' }, dates: { start: '2026-11-06', end: '2026-11-09' }, photo_url: 'https://images.example/goa.jpg',
        people_preview: [PERSON, { person_id: 'p_priya', name: 'Priya' }], people_count: 4, attention: { kind: 'needs_you', count: 2 }, last_activity_at: '2026-10-08T10:12:00.000Z' }],
      past_trips: [{ trip_id: 't_coorg', title: 'Coorg', dates: { start: '2026-03-06', end: '2026-03-08' }, people_count: 5, all_settled: true }],
      owes: [{ trip_id: 't_goa', trip_title: 'Goa 🌴', to: { person_id: 'p_priya', name: 'Priya' }, amount_minor: 170000, currency: 'INR' }],
      needs_you: { items: [
        { item_id: 'vote:d_stay:p_aarav', kind: 'vote', title: 'Which villa?', subtitle: 'closes in 3 hours', cta_label: 'Vote', since: '2026-10-08T09:00:00.000Z', target: { decision_id: 'd_stay', message_id: 'm_01JB' }, trip_id: 't_goa', trip_title: 'Goa 🌴' },
        { item_id: 'settle:p_priya', kind: 'settle_up', title: 'Settle up with Priya', subtitle: '₹1,700 left of your share', cta_label: 'Record', since: '2026-10-08T10:12:00.000Z', target: { transfer: { to_person_id: 'p_priya', amount_minor: 170000, currency: 'INR' } }, trip_id: 't_goa', trip_title: 'Goa 🌴' },
      ], total: 2 },
      seq_hint: 48,
    } }, { name: 'First run', status: 200, body: { me: PERSON, trips: [], past_trips: [], owes: [], needs_you: { items: [], total: 0 }, seq_hint: 0 } }] } },
  { method: 'GET', path: '/app/v1/discover/ideas', section: SECTIONS.home, title: 'Ideas', summary: 'Curated destination ideas for the first-run carousel: ?from_city= (defaults to your profile city; a general set when the city has none) &limit= (8). Cached a day. Tap ⇒ POST /trips with destination_hint.',
    example: { query: { from_city: 'Bengaluru', limit: '8' }, responses: [{ name: 'From Bengaluru', status: 200, body: { items: [{ idea_id: 'idea_blr_coorg', name: 'Coorg', tag: 'Coffee hills', travel: { mode: 'car', duration_minutes: 330 }, destination_hint: 'Coorg' }], from_city: 'Bengaluru' } }] } },
];

export function register(app: FastifyInstance, ctx: Ctx, _deps: V1Deps): void {
  app.get('/app/v1/home', async (req, reply) => (reply.header('cache-control', 'private, no-store'), homeFor(ctx, req.personId)));
  app.get('/app/v1/discover/ideas', {
    schema: { querystring: { type: 'object', properties: { from_city: { type: 'string', maxLength: 60 }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 } } } },
  }, async (req: any, reply) => {
    reply.header('cache-control', 'private, max-age=86400');
    return ideasFor(ctx, req.personId, req.query.from_city, req.query.limit);
  });
}
