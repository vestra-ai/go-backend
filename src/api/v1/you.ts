// §4.13: the You screen, what Go knows about the person. Every route asks Go for the signed-in person only.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { deleteFact, forgetPerson, getPerson, updateCarryOver } from '../../domain/ask-go.js';
import { checkCarryOver } from '../bodies.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import { id, type V1Deps } from './shared.js';

const FACT = { fact_id: 'f_01JA', topic: 'food', text: 'Vegetarian', trip_id: 't_goa', message_id: 'm_0122', said_at: '2026-10-08T07:05:00Z' };
const GO_AWAY = { name: 'Go did not answer', status: 504, body: { error: { code: 'go_unavailable', message: 'Go did not answer in time. Try again.', field: null, retry_after_seconds: null, request_id: 'a1b2c3d4e5f6' } } };

export const routes: RouteMeta[] = [
  { method: 'GET', path: '/app/v1/me/go', section: SECTIONS.you, title: 'What Go knows', summary: 'The facts Go holds about you, where each came from (trip and message), and the carry-over switch. Asked of Go every time (never cached); 502/504 go_unavailable when Go does not answer.',
    example: { responses: [{ name: 'Page', status: 200, body: { person_id: 'p_aarav', carry_over: false, facts: [FACT] } }, GO_AWAY] } },
  { method: 'PATCH', path: '/app/v1/me/go', section: SECTIONS.you, title: 'Carry-over', summary: '{ carry_over: true|false } (strict): remember me in future trips (off by default). Answers Go\'s own acknowledgement.',
    example: { body: { carry_over: true }, responses: [{ name: 'Saved', status: 200, body: { ok: true } }] } },
  { method: 'DELETE', path: '/app/v1/me/go/facts/:fact_id', section: SECTIONS.you, title: 'Delete a fact', summary: 'Delete one thing Go knows about you. 404 when Go has no such fact.',
    example: { responses: [{ name: 'Deleted', status: 200, body: { ok: true } }, { name: 'No such fact', status: 404, body: { error: { code: 'not_found', message: 'no fact f_nope for this person', field: null, retry_after_seconds: null, request_id: 'a1b2c3d4e5f6' } } }] } },
  { method: 'DELETE', path: '/app/v1/me/go', section: SECTIONS.you, title: 'Forget me', summary: 'Go forgets you in one trip (?trip_id=) or everywhere; the server clears your join answers there too. Answers Go\'s count; never claims success when Go did not answer (502).',
    example: { query: { trip_id: 't_goa' }, responses: [{ name: 'Forgotten', status: 200, body: { deleted_facts: 3, remaining_facts: 0 } }, GO_AWAY] } },
];

export function register(app: FastifyInstance, ctx: Ctx, deps: V1Deps): void {
  app.get('/app/v1/me/go', async (req) => getPerson(deps.go, req.personId));
  app.patch('/app/v1/me/go', async (req) => updateCarryOver(deps.go, req.personId, checkCarryOver(req.body).carry_over));
  app.delete('/app/v1/me/go/facts/:fact_id', async (req: any) => deleteFact(deps.go, req.personId, req.params.fact_id));
  app.delete('/app/v1/me/go', { schema: { querystring: { type: 'object', properties: { trip_id: id } } } }, async (req: any) => forgetPerson(ctx, deps.go, req.personId, req.query.trip_id));
}
