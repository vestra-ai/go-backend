// §4.4: trips, the person's own answers in a trip, reading, leaving. The live connection is in live.ts (§3).
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { createTrip, leaveTrip, markSeen, requireMember, setGoPaused } from '../../domain/actions.js';
import { inviteOf, rotateInvite } from '../../domain/invites.js';
import { getMyTripAnswers, updateMyTripAnswers, updateTripDetails } from '../../domain/person-edits.js';
import { parseInclude, readTripView } from '../../domain/trip-view.js';
import { checkCreateTrip, checkPatchTrip, checkPatchTripMe, checkPauseGo, checkReadTrip } from '../bodies.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import { atLeastOneField, inTrip, type V1Deps } from './shared.js';

const PERSON = { person_id: 'p_aarav', name: 'Aarav Shah', role: 'organizer', joined_at: '2026-10-08T10:00:00.000Z', from_city: 'Bengaluru', know: ['Vibe: beach'], has_upi: true, go_paused: false };
// `seq` is 2 after a create: trip.created is change 1, the "Trip created · Aarav joined" pill is change 2.
const TRIP_VIEW = {
  trip_id: 't_goa', seq: 2, title: 'Goa 🌴', status: 'planning', created_at: '2026-10-08T10:00:00.000Z', organizer_person_id: 'p_aarav', invite_url: 'https://go.example/invite/k3Jd8Qw2Lp9a',
  vibe: [], budget: { answered: 0, of: 1 }, people: [PERSON], decisions: [], bookings: [], expenses: [], money: { currency: 'INR', spent_minor: 0, by_category: [], transfers: [] }, itinerary: [], record: [],
  stage: 'new', me: { person: PERSON, last_read_seq: 0, unread_count: 0 }, chat: { unread_count: 0, participants_preview: [] }, needs_you_count: 0, can: { invite: true, manage_trip: true },
};

export const routes: RouteMeta[] = [
  { method: 'POST', path: '/app/v1/trips', section: SECTIONS.trips, title: 'Create a trip', summary: 'Everything optional: title (else destination_hint, else "New trip"), destination_hint (also the destination { name } when none is sent), dates, from_city (saved as your own answer), plus destination, vibe, stay, plan_minor, currency. You are the organizer; Go is told (trip.created, change 1). Answers the TripView.',
    example: { body: { title: 'Goa 🌴', destination_hint: 'Goa', dates: { start: '2026-11-06', end: '2026-11-09' }, from_city: 'Bengaluru' }, responses: [{ name: 'Created', status: 201, body: TRIP_VIEW }] } },
  { method: 'GET', path: '/app/v1/trips/:trip', section: SECTIONS.trips, title: 'Read a trip', summary: 'The TripView: the snapshot plus stage, me (your Person, read marker, unread count), chat (unread, last message, who talks), needs_you_count and can. ?include=people,decisions,bookings,expenses,money,itinerary,record trims the rest. ETag is the seq: If-None-Match ⇒ 304. Every member\'s from_city and earliest_leave are shown to every member.',
    example: { query: { include: 'people,decisions' }, responses: [{ name: 'TripView', status: 200, body: TRIP_VIEW }, { name: 'Nothing moved', status: 304 }] } },
  { method: 'PATCH', path: '/app/v1/trips/:trip', section: SECTIONS.trips, title: 'Edit the trip', summary: 'Any member changes title, dates, status, the whole itinerary, or budget_per_person_minor (the group\'s one budget per person, a whole number ≥ 1; null clears it, the only field that can be cleared). Strict body, at least one field. Answers { seq } (null when nothing differed); Go hears trip.updated naming what changed (budget for the budget).',
    example: { body: { title: 'Goa 🌴 (long weekend)', dates: { start: '2026-11-06', end: '2026-11-09' }, budget_per_person_minor: 2000000 }, responses: [{ name: 'Updated', status: 200, body: { seq: 10 } }, { name: 'Nothing changed', status: 200, body: { seq: null } }] } },
  { method: 'GET', path: '/app/v1/trips/:trip/invite', section: SECTIONS.trips, title: 'Invite link', summary: 'The link and code for the Share sheet.', example: { responses: [{ name: 'Link', status: 200, body: { invite_url: 'https://go.example/invite/k3Jd8Qw2Lp9a', code: 'k3Jd8Qw2Lp9a' } }] } },
  { method: 'POST', path: '/app/v1/trips/:trip/invite/rotate', section: SECTIONS.trips, title: 'Rotate the invite link', summary: 'Organizer only (403 otherwise). The old link answers revoked from now on; the new one is returned.', example: { responses: [{ name: 'New link', status: 200, body: { invite_url: 'https://go.example/invite/Zp2Qw9Lk3Jd8', code: 'Zp2Qw9Lk3Jd8' } }] } },
  { method: 'GET', path: '/app/v1/trips/:trip/me', section: SECTIONS.trips, title: 'My answers', summary: 'Your join answers, your role and whether Go is paused for you.',
    example: { responses: [{ name: 'Mine', status: 200, body: { from_city: 'Bengaluru', earliest_leave: 'Fri after 6 pm', know: ['Vibe: beach'], role: 'organizer', go_paused: false } }] } },
  { method: 'PUT', path: '/app/v1/trips/:trip/me/join-answers', section: SECTIONS.trips, title: 'Edit my answers', summary: 'JoinAnswers: from_city, earliest_leave (null clears), know ([] clears), vibe (beach|hills|city|any ⇒ one "Vibe: …" know entry). Answers your Person (seq null when nothing changed). Go hears only what differs.',
    example: { body: { from_city: 'Delhi', vibe: 'beach' }, responses: [{ name: 'Person', status: 200, body: { ...PERSON, from_city: 'Delhi', seq: 7 } }] } },
  { method: 'PATCH', path: '/app/v1/trips/:trip/me', section: SECTIONS.trips, title: 'Pause Go', summary: '{ go_paused: true|false } (strict): while paused your messages reach Go with no words (the room still sees them in full). Answers your own Person (whole) plus seq.',
    example: { body: { go_paused: true }, responses: [{ name: 'Person', status: 200, body: { ...PERSON, go_paused: true, seq: 11 } }] } },
  { method: 'POST', path: '/app/v1/trips/:trip/leave', section: SECTIONS.trips, title: 'Leave the trip', summary: 'Leaves the trip; a vote waiting only for you closes. 204; from then on every route of this trip answers 403.',
    example: { body: {}, responses: [{ name: 'Left', status: 204 }] } },
  { method: 'POST', path: '/app/v1/trips/:trip/read', section: SECTIONS.trips, title: 'Mark as read', summary: '{ up_to_seq } or { message_id }: the room is read up to there (never moves back). Drives unread counts and catch-up. 204.',
    example: { body: { up_to_seq: 42 }, responses: [{ name: 'Read', status: 204 }] } },
];

/** `If-None-Match` names the ETag we would send (`"<seq>"`, possibly among others, possibly weak): nothing moved. */
function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(',').map((s) => s.trim().replace(/^W\//, '')).some((s) => s === etag || s === '*');
}

export function register(app: FastifyInstance, ctx: Ctx, deps: V1Deps): void {
  app.post('/app/v1/trips', async (req, reply) => {
    const { trip_id } = await createTrip(ctx, req.personId, checkCreateTrip(req.body));
    return reply.code(201).send(await readTripView(ctx, trip_id, req.personId));
  });

  app.get('/app/v1/trips/:trip', { schema: { querystring: { type: 'object', properties: { include: { type: 'string', maxLength: 200 } } } } }, async (req: any, reply) => {
    const trip: string = req.params.trip;
    await requireMember(ctx.pool, trip, req.personId);
    const view = await readTripView(ctx, trip, req.personId, parseInclude(req.query.include));
    const etag = `"${view.seq}"`;
    reply.header('etag', etag);
    reply.header('cache-control', 'private, no-cache');
    if (matchesEtag(req.headers['if-none-match'], etag)) return reply.code(304).send();
    return view;
  });
  app.patch('/app/v1/trips/:trip', inTrip(ctx, (req, trip, me) => {
    const input = checkPatchTrip(req.body);
    atLeastOneField(input);
    return updateTripDetails(ctx, trip, me, input);
  }));

  app.get('/app/v1/trips/:trip/invite', inTrip(ctx, (_req, trip) => inviteOf(ctx, trip)));
  app.post('/app/v1/trips/:trip/invite/rotate', inTrip(ctx, (_req, trip, me) => rotateInvite(ctx, trip, me)));

  app.get('/app/v1/trips/:trip/me', inTrip(ctx, (_req, trip, me) => getMyTripAnswers(ctx, trip, me)));
  app.put('/app/v1/trips/:trip/me/join-answers', inTrip(ctx, (req, trip, me) => {
    const input = checkPatchTripMe(req.body);
    atLeastOneField(input);
    return updateMyTripAnswers(ctx, trip, me, input);
  }));
  app.patch('/app/v1/trips/:trip/me', inTrip(ctx, (req, trip, me) => setGoPaused(ctx, trip, me, checkPauseGo(req.body).go_paused)));

  app.post('/app/v1/trips/:trip/leave', inTrip(ctx, async (_r, trip, me) => {
    await leaveTrip(ctx, trip, me);
  }, 204));
  app.post('/app/v1/trips/:trip/read', inTrip(ctx, async (req, trip, me) => {
    const input = checkReadTrip(req.body);
    await markSeen(ctx, trip, me, input.up_to_seq, input.message_id);
  }, 204));
}
