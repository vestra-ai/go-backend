// What every v1 route says about itself, next to its handler. docs/API.md (the contract document) describes the same
// routes; its Appendix C is kept in step with this list by hand.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import type { V1Deps } from './shared.js';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** An example request and its example answers, for the document. */
export interface RouteExample {
  body?: unknown;
  query?: Record<string, string>;
  responses?: Array<{ name: string; status: number; body?: unknown }>;
}

export interface RouteMeta {
  method: Method;
  /** The full path, with Fastify's `:param` names: `/app/v1/trips/:trip/messages`. */
  path: string;
  /** The app contract's section the route belongs to (one section of docs/API.md each). */
  section: string;
  title: string;
  summary: string;
  /** `none`: no sign-in (the default is a bearer token). */
  auth?: 'none' | 'bearer';
  /** Local only (AUTH_MODE=dev): kept out of API.md. */
  dev?: boolean;
  example?: RouteExample;
}

/** One file under src/api/v1 per contract section: its routes' metadata and the function that registers them. */
export interface Section {
  name: string;
  routes: RouteMeta[];
  register(app: FastifyInstance, ctx: Ctx, deps: V1Deps): void;
}

/** The app contract's section titles, in its order. */
export const SECTIONS = {
  live: '§3 The live connection',
  me: '§4.1 Sign-in, session, Me',
  home: '§4.2 Home',
  invites: '§4.3 Invites',
  trips: '§4.4 Trips',
  uploads: '§4.5 Uploads',
  messages: '§4.6 The room',
  cards: "§4.7 Go's cards",
  decisions: '§4.8 Votes, mandate, record',
  money: '§4.9 Money',
  bookings: '§4.10 Bookings, documents, itinerary',
  needsYou: '§4.11 Trip home',
  checkin: '§4.12 Web check-in',
  you: '§4.13 You screen',
  config: '§4.14 Places, config, health',
  dev: 'Dev (AUTH_MODE=dev only)',
} as const;
