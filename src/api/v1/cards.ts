// §4.7: a press on a button of one of Go's cards. The Server forwards it to Go as a card_tap and hands back Go's answer.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { cardTap, TAP_UNANSWERED } from '../../domain/ask-go.js';
import { checkCardAction } from '../bodies.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import { inTrip, type V1Deps } from './shared.js';

export const routes: RouteMeta[] = [
  {
    method: 'POST', path: '/app/v1/trips/:trip/cards/:card_id/actions', section: SECTIONS.cards, title: 'Press a card button',
    summary: '{ action_id, option_id?, press_id, payload? }: a tap on a Go card (options, working, call, pay, notice, checklist). press_id becomes Go\'s tap_id (a double tap is one tap); payload { trip: oneway | round } goes through to Go. Answers Go\'s CardActionResult: done | open { url, expires_at } | refused { toast }. When Go does not answer: 200 refused "Go didn\'t answer. Try again." Record cards (vote, mandate, expense) are the Server\'s own: 422.',
    example: {
      body: { action_id: 'pick', option_id: 'opt_flight_1', press_id: '9a1c3c2e-7b1e-4f0d-9d3c-1a2b3c4d5e6f', payload: { trip: 'round' } },
      responses: [
        { name: 'done', status: 200, body: { result: 'done', toast: 'Noted. Go will reply in the room.' } },
        { name: 'open a page', status: 200, body: { result: 'open', url: 'https://brain.go.example/vault/approve?link=lk_4Rt8Zp2Lq', expires_at: '2026-10-05T09:06:30Z' } },
        { name: 'Go did not answer', status: 200, body: TAP_UNANSWERED },
      ],
    },
  },
];

export function register(app: FastifyInstance, ctx: Ctx, deps: V1Deps): void {
  app.post('/app/v1/trips/:trip/cards/:card_id/actions', inTrip(ctx, (req, trip, me) => {
    const input = checkCardAction(req.body);
    return cardTap(ctx, deps.go, trip, me, { card_id: req.params.card_id!, ...input });
  }));
}
