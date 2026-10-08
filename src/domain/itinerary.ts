// §4.10 GET /trips/:trip/itinerary: the stored days (Go writes them with update_trip, people with PATCH /trips/:trip),
// read two ways. `everyone` is the itinerary minus the private items that are not mine (GO-CHANGES 1.8: a `private`
// item is returned only to the people in its `person_ids`). `me` is "Just me": my items, the ones shared with me or
// with the group, and the ones that name nobody; and where an item points at a booking that covers me, its title is
// reworded for me from the booking ("BLR → GOX · 6E 5313, Seat 14A, lands Mopa 9:55 pm").
import type { Ctx } from '../context.js';
import { notFound } from './errors.js';
import type { BookingRow, JourneyLike, Passenger } from './mappers.js';
import type { Day } from './types.js';

export type ItineraryScope = 'everyone' | 'me';

/** An item as stored: the contract's ItineraryItem plus the 1.1 fields, and anything else Go wrote (kept as it is). */
type StoredItem = Record<string, unknown> & { title: string; booking_id?: string | null; person_ids?: string[] | null; audience?: 'group' | 'shared' | 'private' | null };
type StoredDay = Record<string, unknown> & { items?: StoredItem[] };

const names = (item: StoredItem): string[] | undefined => (Array.isArray(item.person_ids) ? item.person_ids : undefined);

/** Everyone's view keeps an item unless it is private and does not name me. */
export const visibleToEveryone = (item: StoredItem, me: string): boolean => item.audience !== 'private' || (names(item)?.includes(me) ?? false);

/** "Just me" keeps what names me, what is shared with me or the group, and what names nobody. */
export const visibleToMe = (item: StoredItem, me: string): boolean => {
  const people = names(item);
  if (people?.includes(me)) return true;
  if (item.audience === 'shared' || item.audience === 'group') return true;
  return people === undefined;
};

/** The wall-clock time written in an ISO time ("2026-11-06T21:55:00+05:30" → "9:55 pm"): the local time at the stop, as Go wrote it. */
export function wallClock(isoTime: string): string | undefined {
  const m = /T(\d{2}):(\d{2})/.exec(isoTime);
  if (!m) return undefined;
  const hours = Number(m[1]);
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${h12}:${m[2]} ${hours < 12 ? 'am' : 'pm'}`;
}

/**
 * The item's title for one covered person, from the booking's journey: origin code → destination code · carrier code and
 * number, then ", Seat 14A" when the booking knows their seat, then ", lands <destination> <local time>". A booking
 * without a journey keeps the stored title.
 */
export function titleForPerson(storedTitle: string, booking: Pick<BookingRow, 'journey' | 'passengers'>, me: string): string {
  const j = booking.journey as JourneyLike | null;
  if (!j) return storedTitle;
  const stop = (s: JourneyLike['origin']) => s.code ?? s.name;
  const flight = [j.carrier_code, j.number].filter(Boolean).join(' ').trim() || j.carrier_name;
  let title = `${stop(j.origin)} → ${stop(j.destination)}${flight ? ` · ${flight}` : ''}`;
  const seat = (booking.passengers as Passenger[] | null)?.find((p) => p.person_id === me)?.seat;
  if (seat) title += `, Seat ${seat}`;
  const lands = j.arrive_at ? wallClock(j.arrive_at) : undefined;
  if (lands) title += `, lands ${j.destination.name} ${lands}`;
  return title;
}

/** The days for one person in one scope. Pure: the route reads the rows and hands them here. */
export function daysFor(days: StoredDay[], bookings: BookingRow[], me: string, scope: ItineraryScope): Day[] {
  const byId = new Map(bookings.map((b) => [b.booking_id, b]));
  const keep = scope === 'me' ? visibleToMe : visibleToEveryone;
  return days.map((day) => ({
    ...day,
    items: (day.items ?? []).filter((item) => keep(item, me)).map((item) => {
      if (scope !== 'me' || !item.booking_id) return item;
      const booking = byId.get(item.booking_id);
      if (!booking || !booking.for_person_ids.includes(me)) return item;
      return { ...item, title: titleForPerson(item.title, booking, me) };
    }),
  })) as unknown as Day[];
}

/** One repeatable-read transaction: the itinerary, the bookings it may point at, and the change number they match. */
export async function readItinerary(ctx: Ctx, tripId: string, personId: string, scope: ItineraryScope): Promise<{ days: Day[]; seq: number }> {
  const db = await ctx.pool.connect();
  try {
    await db.query('begin transaction isolation level repeatable read read only');
    const trip = (await db.query('select itinerary, seq from trips where trip_id = $1', [tripId])).rows[0];
    if (!trip) throw notFound(`trip ${tripId} does not exist`);
    const bookings = scope === 'me' ? (await db.query<BookingRow>('select * from bookings where trip_id = $1', [tripId])).rows : [];
    await db.query('commit');
    return { days: daysFor(trip.itinerary as StoredDay[], bookings, personId, scope), seq: trip.seq as number };
  } catch (err) {
    await db.query('rollback').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}
