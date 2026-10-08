// §4.9: money. Expenses people add by hand, settle-up (who pays whom) and the reminder.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { addPersonExpense, removePersonExpense, requireMember } from '../../domain/actions.js';
import { getSettleUp, nudgePerson } from '../../domain/settle-up.js';
import { checkNudge } from '../bodies.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import { body, id, inTrip, minor, withTrip, type V1Deps } from './shared.js';

export const routes: RouteMeta[] = [
  { method: 'POST', path: '/app/v1/trips/:trip/expenses', section: SECTIONS.money, title: 'Add an expense', summary: 'paid_by_person_id, amount_minor, note, category, split_person_ids (shared equally), booking_id?. People who owe overall are pushed.' },
  { method: 'DELETE', path: '/app/v1/trips/:trip/expenses/:id', section: SECTIONS.money, title: 'Remove an expense', summary: 'Removes an expense. 404 when not in this trip or already removed.' },
  { method: 'GET', path: '/app/v1/trips/:trip/settle-up', section: SECTIONS.money, title: 'Settle up', summary: 'Your entries from the fewest-payments list: you_pay (with the payee\'s UPI id) and owed_to_you (with nudge_allowed_at). no-store.' },
  { method: 'POST', path: '/app/v1/trips/:trip/transfers/nudge', section: SECTIONS.money, title: 'Nudge', summary: '{ from_person_id }: remind someone who owes you. One per person per trip every 24 hours (429 with Retry-After).' },
];

export function register(app: FastifyInstance, ctx: Ctx, _deps: V1Deps): void {
  app.post('/app/v1/trips/:trip/expenses', {
    ...body({
      paid_by_person_id: id,
      amount_minor: minor,
      note: { type: 'string', minLength: 1, maxLength: 120 },
      category: { type: 'string', minLength: 1 },
      split_person_ids: { type: 'array', minItems: 1, maxItems: 30, items: id },
      booking_id: id,
    }, ['paid_by_person_id', 'amount_minor', 'note', 'category', 'split_person_ids']),
    ...withTrip((t, me, r) => addPersonExpense(ctx, t, me, r.body)),
  });
  app.delete('/app/v1/trips/:trip/expenses/:id', withTrip((t, me, r) => removePersonExpense(ctx, t, me, r.params.id!)));
  app.get('/app/v1/trips/:trip/settle-up', async (req: any, reply) => {
    await requireMember(ctx.pool, req.params.trip, req.personId);
    reply.header('cache-control', 'no-store'); // it carries payees' UPI ids
    return getSettleUp(ctx, req.params.trip, req.personId);
  });
  app.post('/app/v1/trips/:trip/transfers/nudge', inTrip(ctx, (req, trip, me) => nudgePerson(ctx, trip, me, checkNudge(req.body))));
}
