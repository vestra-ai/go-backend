// §4.7: a press on a button of one of Go's cards. The Server forwards it to Go as a card_tap and hands back Go's answer.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { cardTap } from '../../domain/ask-go.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import { body, id, inTrip, type V1Deps } from './shared.js';

export const routes: RouteMeta[] = [
  { method: 'POST', path: '/app/v1/trips/:trip/cards/:card_id/actions', section: SECTIONS.cards, title: 'Press a card button', summary: '{ action_id, option_id?, press_id? }: a tap on a Go card (options, working, call, pay, notice). Answers done | open { url } | refused. Not for record cards (422).' },
];

export function register(app: FastifyInstance, ctx: Ctx, deps: V1Deps): void {
  app.post('/app/v1/trips/:trip/cards/:card_id/actions', {
    // `press_id` is the app's own id for this press (the contract's name); `tap_id` is the older name, still accepted.
    ...body({ action_id: { type: 'string', pattern: '^[a-z][a-z_]{0,31}$' }, option_id: id, press_id: id, tap_id: id }, ['action_id']),
    ...inTrip(ctx, (req, trip, me) => cardTap(ctx, deps.go, trip, me, {
      card_id: req.params.card_id!,
      action_id: req.body.action_id,
      option_id: req.body.option_id,
      tap_id: req.body.press_id ?? req.body.tap_id,
    })),
  });
}
