// §4.3: the invite link. The preview needs no sign-in; accepting joins the trip with the join answers.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { joinTrip, tripByInvite } from '../../domain/actions.js';
import { notFound } from '../../domain/errors.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import { PUBLIC, body, type V1Deps } from './shared.js';

export const routes: RouteMeta[] = [
  { method: 'GET', path: '/app/v1/invites/:code', section: SECTIONS.invites, title: 'Invite preview', summary: 'The trip behind an invite link, for the join screen. No sign-in. 404 for a bad link.', auth: 'none' },
  { method: 'POST', path: '/app/v1/invites/:code/accept', section: SECTIONS.invites, title: 'Accept an invite', summary: 'Joins the trip with the join answers (from_city, earliest_leave, know, budget). Safe to repeat.' },
];

export function register(app: FastifyInstance, ctx: Ctx, _deps: V1Deps): void {
  app.get('/app/v1/invites/:code', PUBLIC, async (req: any) => {
    const trip = await tripByInvite(ctx, req.params.code);
    if (!trip) throw notFound('no trip for this invite link');
    return trip;
  });
  app.post('/app/v1/invites/:code/accept', body({
    from_city: { type: 'string', maxLength: 60 },
    earliest_leave: { type: 'string', maxLength: 60 },
    know: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 80 } },
    budget: { type: 'object', required: ['min_minor'], properties: { min_minor: { type: 'integer', minimum: 0 }, max_minor: { type: 'integer', minimum: 0 } } },
  }), async (req: any) => joinTrip(ctx, req.params.code, req.personId, req.body));
}
