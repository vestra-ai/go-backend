// §4.13: the You screen, what Go knows about the person. Every route asks Go for the signed-in person only.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { deleteFact, forgetPerson, getPerson, updateCarryOver } from '../../domain/ask-go.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import { body, bool, id, type V1Deps } from './shared.js';

export const routes: RouteMeta[] = [
  { method: 'GET', path: '/app/v1/me/go', section: SECTIONS.you, title: 'What Go knows', summary: 'The facts Go holds about you, where each came from, and the carry-over switch.' },
  { method: 'PATCH', path: '/app/v1/me/go', section: SECTIONS.you, title: 'Carry-over', summary: '{ carry_over: true|false }: remember me in future trips (off by default).' },
  { method: 'DELETE', path: '/app/v1/me/go/facts/:fact_id', section: SECTIONS.you, title: 'Delete a fact', summary: 'Delete one thing Go knows about you. 404 when Go has no such fact.' },
  { method: 'DELETE', path: '/app/v1/me/go', section: SECTIONS.you, title: 'Forget me', summary: 'Go forgets you in one trip (?trip_id=) or everywhere; the server clears your join answers there too. Never claims success when Go did not answer.' },
];

export function register(app: FastifyInstance, ctx: Ctx, deps: V1Deps): void {
  app.get('/app/v1/me/go', async (req) => getPerson(deps.go, req.personId));
  app.patch('/app/v1/me/go', body({ carry_over: bool }, ['carry_over']), async (req: any) => updateCarryOver(deps.go, req.personId, req.body.carry_over));
  app.delete('/app/v1/me/go/facts/:fact_id', async (req: any) => deleteFact(deps.go, req.personId, req.params.fact_id));
  app.delete('/app/v1/me/go', { schema: { querystring: { type: 'object', properties: { trip_id: id } } } }, async (req: any) => forgetPerson(ctx, deps.go, req.personId, req.query.trip_id));
}
