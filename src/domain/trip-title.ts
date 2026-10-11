// The trip's automatic name (rev 5 I): a trip still called "New trip" is shown as "<destination> <year>", such as
// "Hampi 2026", once it has a destination. Worked out on every app read (TripView, the home cards, the invite
// preview); nothing is stored and no event is sent, and Go's read_trip, the snapshot and the events keep the stored title.
import type { Place } from './types.js';

/** The title a trip gets when it is made with neither a title nor a destination hint (POST /trips). */
export const DEFAULT_TRIP_TITLE = 'New trip';

/** The year it is now in India (Asia/Kolkata), where the trips are planned. */
const yearInIndia = (now: Date) => Number(new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric' }).format(now));

/**
 * The title the app shows. The stored title, unless it is still exactly "New trip" and the trip has a destination with a
 * name: then "<destination.name> <year>", the year of the start date when dates are set, else the current year (IST).
 */
export function tripTitle(t: { title: string; destination?: Place | null; dates_start?: string | null }, now: Date = new Date()): string {
  const name = t.destination?.name?.trim();
  if (t.title !== DEFAULT_TRIP_TITLE || !name) return t.title;
  const year = t.dates_start ? Number(String(t.dates_start).slice(0, 4)) : yearInIndia(now);
  return `${name} ${year}`;
}
