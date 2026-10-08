// §4.10 Itinerary: GET /trips/:trip/itinerary and the booking reads (phase 4). Nothing is registered yet; the section exists so the
// collection and API.md keep the contract's order.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import type { RouteMeta } from './meta.js';
import type { V1Deps } from './shared.js';

export const routes: RouteMeta[] = [];

export function register(_app: FastifyInstance, _ctx: Ctx, _deps: V1Deps): void {}
