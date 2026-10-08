// §4.11: the trip home's "needs you" strip.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { needsYou } from '../../domain/actions.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import { inTrip, type V1Deps } from './shared.js';

export const routes: RouteMeta[] = [
  { method: 'GET', path: '/app/v1/trips/:trip/needs-you', section: SECTIONS.needsYou, title: 'Needs you', summary: 'What this person has to do in the trip: open votes, a mandate to answer, a Go card naming them, an open record line.' },
];

export function register(app: FastifyInstance, ctx: Ctx, _deps: V1Deps): void {
  app.get('/app/v1/trips/:trip/needs-you', inTrip(ctx, (_r, trip, me) => needsYou(ctx, trip, me)));
}
