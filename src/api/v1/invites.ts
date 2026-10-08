// §4.3: the invite link. The preview needs no sign-in (and is rate-limited per address, so codes cannot be guessed);
// accepting joins the trip with the join answers; "Not now" and "Decline" are marks on the link for one person.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { acceptInvite, invitePreview, markInvite } from '../../domain/invites.js';
import { checkAcceptInvite } from '../bodies.js';
import { RateLimiter } from '../rate-limit.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import { OPTIONAL_AUTH, type V1Deps } from './shared.js';

/** The contract's bound on the public preview: 30 a minute per IP address. */
export const PREVIEW_PER_MINUTE = 30;

const PREVIEW = {
  code: 'k3Jd8Qw2Lp9a', state: 'pending', trip: { trip_id: 't_goa', title: 'Goa 🌴', dates: { start: '2026-11-06', end: '2026-11-09' } },
  inviter: { person_id: 'p_rahul', name: 'Rahul' }, people_preview: [{ person_id: 'p_rahul', name: 'Rahul' }, { person_id: 'p_priya', name: 'Priya' }], joined_count: 3,
};

export const routes: RouteMeta[] = [
  { method: 'GET', path: '/app/v1/invites/:code', section: SECTIONS.invites, title: 'Invite preview', summary: 'The trip behind an invite link, who invited and who is in. No sign-in needed; signed in, state is personal (already_member, declined). A rotated link answers revoked, a trip that is over expired; 404 for a bad link. 30 a minute per address.', auth: 'none',
    example: { responses: [{ name: 'Pending', status: 200, body: PREVIEW }, { name: 'Rotated away', status: 200, body: { ...PREVIEW, state: 'revoked' } }] } },
  { method: 'POST', path: '/app/v1/invites/:code/accept', section: SECTIONS.invites, title: 'Accept an invite', summary: 'Joins the trip with the join answers ({ join_answers?: { from_city, earliest_leave, know, vibe, spend_band } }) and says where to land: chat when the room already has messages, else trip_home. Already a member: the landing only. Safe to repeat.',
    example: { body: { join_answers: { from_city: 'Delhi', vibe: 'beach', spend_band: '15to25' } }, responses: [{ name: 'Joined', status: 200, body: { trip_id: 't_goa', seq: 9, landing: 'chat' } }] } },
  { method: 'POST', path: '/app/v1/invites/:code/later', section: SECTIONS.invites, title: 'Not now', summary: 'Keeps the invite on my home screen for later. Safe to repeat.', example: { responses: [{ name: 'Kept', status: 204 }] } },
  { method: 'POST', path: '/app/v1/invites/:code/decline', section: SECTIONS.invites, title: 'Decline', summary: 'Takes the invite off my home screen; the inviter is not told. I can still accept from the link later.', example: { responses: [{ name: 'Declined', status: 204 }] } },
];

export function register(app: FastifyInstance, ctx: Ctx, _deps: V1Deps): void {
  const previews = new RateLimiter(PREVIEW_PER_MINUTE, 60_000);
  app.get('/app/v1/invites/:code', OPTIONAL_AUTH, async (req: any, reply) => {
    previews.take(req.ip);
    reply.header('cache-control', 'private, no-store');
    return invitePreview(ctx, req.params.code, req.personId ?? undefined);
  });
  app.post('/app/v1/invites/:code/accept', async (req: any) => acceptInvite(ctx, req.params.code, req.personId, checkAcceptInvite(req.body).join_answers));
  app.post('/app/v1/invites/:code/later', async (req: any, reply) => (await markInvite(ctx, req.params.code, req.personId, 'later'), reply.code(204).send()));
  app.post('/app/v1/invites/:code/decline', async (req: any, reply) => (await markInvite(ctx, req.params.code, req.personId, 'declined'), reply.code(204).send()));
}
