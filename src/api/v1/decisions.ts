// §4.8: votes, the mandate and the trip record. These buttons are the Server's own: they never reach Go.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { answerMandate, cancelDecision, castVote, closeVoteByPerson, undoRecordLine } from '../../domain/actions.js';
import { openPersonVote } from '../../domain/votes-bookings.js';
import { checkOpenVote } from '../bodies.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import { body, inTrip, requirePressKey, withTrip, type V1Deps } from './shared.js';

export const routes: RouteMeta[] = [
  { method: 'POST', path: '/app/v1/trips/:trip/decisions', section: SECTIONS.decisions, title: 'Open a vote', summary: 'A member opens a vote (question, kind, anonymous, 2-10 options, closes_at?). Strict body; client_id or an Idempotency-Key makes a retry safe.' },
  { method: 'PUT', path: '/app/v1/trips/:trip/decisions/:id/vote', section: SECTIONS.decisions, title: 'Vote', summary: '{ option_index }: cast or change your vote until it closes. The vote closes by itself when everyone has voted.' },
  { method: 'POST', path: '/app/v1/trips/:trip/decisions/:id/close', section: SECTIONS.decisions, title: 'Close a vote', summary: 'Closes the vote early with the current result.' },
  { method: 'POST', path: '/app/v1/trips/:trip/decisions/:id/cancel', section: SECTIONS.decisions, title: 'Call a vote off', summary: 'Cancels an open vote.' },
  { method: 'POST', path: '/app/v1/trips/:trip/decisions/:id/mandate/confirm', section: SECTIONS.decisions, title: 'Mandate: yes, book it', summary: 'The payer confirms the mandate; Go may then ask for a spend approval. Payer only.' },
  { method: 'POST', path: '/app/v1/trips/:trip/decisions/:id/mandate/decline', section: SECTIONS.decisions, title: 'Mandate: not now', summary: 'The payer declines the mandate. Payer only.' },
  { method: 'POST', path: '/app/v1/trips/:trip/record/:line_id/undo', section: SECTIONS.decisions, title: 'Undo a record line', summary: 'Undoes a trip-record line (seq null when already undone).' },
];

export function register(app: FastifyInstance, ctx: Ctx, _deps: V1Deps): void {
  app.post('/app/v1/trips/:trip/decisions', inTrip(ctx, (req, trip, me) => (requirePressKey(req), openPersonVote(ctx, trip, me, checkOpenVote(req.body))), 201));
  app.put('/app/v1/trips/:trip/decisions/:id/vote', {
    ...body({ option_index: { type: 'integer', minimum: 0 } }, ['option_index']),
    ...withTrip((t, me, r) => castVote(ctx, t, me, r.params.id!, r.body.option_index)),
  });
  app.post('/app/v1/trips/:trip/decisions/:id/close', withTrip((t, me, r) => closeVoteByPerson(ctx, t, me, r.params.id!)));
  app.post('/app/v1/trips/:trip/decisions/:id/cancel', withTrip((t, me, r) => cancelDecision(ctx, t, me, r.params.id!)));
  app.post('/app/v1/trips/:trip/decisions/:id/mandate/confirm', withTrip((t, me, r) => answerMandate(ctx, t, me, r.params.id!, 'confirm')));
  app.post('/app/v1/trips/:trip/decisions/:id/mandate/decline', withTrip((t, me, r) => answerMandate(ctx, t, me, r.params.id!, 'decline')));
  app.post('/app/v1/trips/:trip/record/:line_id/undo', withTrip((t, me, r) => undoRecordLine(ctx, t, me, r.params.line_id!)));
}
