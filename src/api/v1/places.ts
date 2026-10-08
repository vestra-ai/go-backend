// §4.14 Places: the "Travelling from" city search and the top list, from the bundled dataset (no third-party call).
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { PAGE, searchCities, topCities } from '../../domain/places.js';
import { RateLimiter } from '../rate-limit.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import type { V1Deps } from './shared.js';

/** The contract's bound: a person may ask five times a second (a 400 ms debounce is the app's). */
export const SEARCHES_PER_SECOND = 5;

const ITEMS = [{ id: 'in-indore-mp', name: 'Indore', region: 'Madhya Pradesh, India', lat: 22.7196, lng: 75.8577, population: 1964086 }, { id: 'in-imphal-mn', name: 'Imphal', region: 'Manipur, India', lat: 24.817, lng: 93.9368, population: 264986 }];

export const routes: RouteMeta[] = [
  { method: 'GET', path: '/app/v1/places/cities', section: SECTIONS.config, title: 'Search cities', summary: 'Populated places whose name starts with ?q= (accents and case ignored), biggest first, one per name and state, at most 8 (?limit=). Under two characters: the top list. ?country=IN only for now. Five a second per person.',
    example: { query: { q: 'in', country: 'IN', limit: '8' }, responses: [{ name: 'Matches', status: 200, body: { items: ITEMS } }] } },
  { method: 'GET', path: '/app/v1/places/cities/top', section: SECTIONS.config, title: 'Top cities', summary: 'The eight biggest cities of the country (?country=IN), for the dropdown before anything is typed. Cached seven days.',
    example: { query: { country: 'IN' }, responses: [{ name: 'Top 8', status: 200, body: { items: [{ id: 'in-mumbai-mh', name: 'Mumbai', region: 'Maharashtra, India', lat: 19.076, lng: 72.8777, population: 12442373 }] } }] } },
];

const query = { type: 'object', properties: { q: { type: 'string', maxLength: 80 }, country: { type: 'string', minLength: 2, maxLength: 2, default: 'IN' }, limit: { type: 'integer', minimum: 1, maximum: PAGE, default: PAGE } } } as const;

export function register(app: FastifyInstance, ctx: Ctx, _deps: V1Deps): void {
  const searches = new RateLimiter(SEARCHES_PER_SECOND, 1_000);
  app.get('/app/v1/places/cities', { schema: { querystring: query } }, async (req: any, reply) => {
    searches.take(req.personId);
    reply.header('cache-control', 'private, max-age=86400');
    return { items: await searchCities(ctx.pool, req.query.q ?? '', req.query.country, req.query.limit) };
  });
  app.get('/app/v1/places/cities/top', { schema: { querystring: query } }, async (req: any, reply) => {
    searches.take(req.personId);
    reply.header('cache-control', 'private, max-age=604800');
    return { items: await topCities(ctx.pool, req.query.country, req.query.limit) };
  });
}
