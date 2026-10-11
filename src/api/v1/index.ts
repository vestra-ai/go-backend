// Every section of the app's API, in the contract's order. The shell (src/api/app.ts) registers each one.
// tests/rev4-whole.test.ts counts the routes (71); docs/API.md Appendix C is kept in step by hand.
import type { Section } from './meta.js';
import * as bookings from './bookings.js';
import * as cards from './cards.js';
import * as checkin from './checkin.js';
import * as config from './config.js';
import * as decisions from './decisions.js';
import * as home from './home.js';
import * as invites from './invites.js';
import * as itinerary from './itinerary.js';
import * as live from './live.js';
import * as me from './me.js';
import * as messages from './messages.js';
import * as money from './money.js';
import * as needsYou from './needs-you.js';
import * as places from './places.js';
import * as trips from './trips.js';
import * as uploads from './uploads.js';
import * as you from './you.js';

export const sections: Section[] = [
  { name: 'live', ...live },
  { name: 'me', ...me },
  { name: 'home', ...home },
  { name: 'invites', ...invites },
  { name: 'trips', ...trips },
  { name: 'uploads', ...uploads },
  { name: 'messages', ...messages },
  { name: 'cards', ...cards },
  { name: 'decisions', ...decisions },
  { name: 'money', ...money },
  { name: 'bookings', ...bookings },
  { name: 'itinerary', ...itinerary },
  { name: 'needs-you', ...needsYou },
  { name: 'checkin', ...checkin },
  { name: 'you', ...you },
  { name: 'places', ...places },
  { name: 'config', ...config },
];

export { SECTIONS, type RouteMeta, type Section } from './meta.js';
