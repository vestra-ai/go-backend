// A booking settles part of the trip (11 Oct 2026): when someone books a flight to Goa or a stay in Anjuna before the
// group set the trip's place, stay or dates, the trip takes them from its confirmed bookings. Only empty fields are
// filled, never a value a person or Go set:
// - destination: the stay's place, else where the outbound flight (train, bus) lands;
// - stay: the stay's name;
// - dates: the stay's check-in to check-out; else, only when the trip has both an outbound and a return journey, the
//   outbound departure date to the return arrival date (a one-way flight sets no dates).
// It runs in the transaction that wrote the booking, after the booking's own events, and sends `trip.updated` by the
// system naming what it filled. The automatic name ("Goa 2026") then follows on the next read.
import type pg from 'pg';
import type { Ctx } from '../context.js';
import { change } from '../db/write-change.js';
import { INDIA, wallOf } from '../demo/when.js';
import { publishHomeAll } from './actions.js';

interface Stop { name?: string; code?: string }
interface JourneyLike { mode?: string; origin?: Stop; destination?: Stop; depart_at?: string; arrive_at?: string }
interface PlaceLike { name?: string; timezone?: string; [k: string]: unknown }

/** The city an airport serves, where Go's stop name is the airport's own town ("Mopa" for Goa's new airport). */
const AIRPORT_CITY: Record<string, string> = {
  GOX: 'Goa', GOI: 'Goa', BOM: 'Mumbai', DEL: 'New Delhi', BLR: 'Bengaluru', MAA: 'Chennai', CCU: 'Kolkata', HYD: 'Hyderabad',
  COK: 'Kochi', PNQ: 'Pune', AMD: 'Ahmedabad', JAI: 'Jaipur', LKO: 'Lucknow', IXC: 'Chandigarh', SXR: 'Srinagar', IXL: 'Leh',
  TRV: 'Thiruvananthapuram', IXB: 'Siliguri', GAU: 'Guwahati', VNS: 'Varanasi', ATQ: 'Amritsar', IXZ: 'Port Blair',
  UDR: 'Udaipur', IXE: 'Mangaluru', CJB: 'Coimbatore', DED: 'Dehradun', NAG: 'Nagpur',
};

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const cityOf = (s: Stop | undefined): string | undefined => (s?.code && AIRPORT_CITY[s.code.toUpperCase()]) || text(s?.name);
const sameStop = (a: Stop | undefined, b: Stop | undefined) =>
  !!a && !!b && ((!!a.code && !!b.code && a.code.toUpperCase() === b.code.toUpperCase()) || (!!cityOf(a) && cityOf(a) === cityOf(b)));
const dayOf = (iso: string | null | undefined, tz: string): string | undefined => {
  if (!iso || Number.isNaN(Date.parse(iso))) return undefined;
  const w = wallOf(iso, tz);
  return `${w.y}-${String(w.mo).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
};

interface BookingRowLike { kind: string; title: string; place: PlaceLike | null; starts_at: Date | string | null; ends_at: Date | string | null; journey: JourneyLike | null; return_journey: JourneyLike | null }
const iso = (v: Date | string | null) => (v instanceof Date ? v.toISOString() : v);

/** What the trip's confirmed bookings settle for each empty field. Pure: the caller reads the rows. */
export function fillsFromBookings(trip: { destination: unknown; stay: string | null; dates_start: string | null }, bookings: BookingRowLike[]) {
  const fills: { destination?: PlaceLike; stay?: string; dates?: { start: string; end: string } } = {};
  const stay = [...bookings].reverse().find((b) => b.kind === 'stay');
  // Every journey leg, outbound first by departure.
  const legs = bookings.flatMap((b) => [b.journey, b.return_journey]).filter((j): j is JourneyLike => !!j && !!j.depart_at && !Number.isNaN(Date.parse(j.depart_at)))
    .sort((a, b) => Date.parse(a.depart_at!) - Date.parse(b.depart_at!));
  const outbound = legs[0];

  if (!trip.destination) {
    const place = stay?.place && text(stay.place.name) ? stay.place : undefined;
    const city = outbound ? cityOf(outbound.destination) : undefined;
    if (place) fills.destination = place;
    else if (city) fills.destination = { name: city.slice(0, 120) };
  }
  if (!trip.stay && stay) fills.stay = (text(stay.place?.name) ?? stay.title).slice(0, 80);
  if (!trip.dates_start) {
    const tz = text(stay?.place?.timezone) ?? INDIA;
    const [inDay, outDay] = [dayOf(iso(stay?.starts_at ?? null), tz), dayOf(iso(stay?.ends_at ?? null), tz)];
    if (inDay && outDay && inDay <= outDay) fills.dates = { start: inDay, end: outDay };
    else if (outbound) {
      // A return: a later leg that leaves from where the outbound landed.
      const back = legs.slice(1).find((l) => sameStop(l.origin, outbound.destination));
      const [start, end] = [dayOf(outbound.depart_at, INDIA), dayOf(back?.arrive_at ?? back?.depart_at, INDIA)];
      if (back && start && end && start <= end) fills.dates = { start, end };
    }
  }
  return fills;
}

/**
 * After a booking is written (in its transaction): fills the trip's empty destination, stay and dates from its confirmed
 * bookings, sends `trip.updated` by the system, and tells the room and everyone's home. Answers what it filled.
 */
export async function fillTripFromBookings(ctx: Ctx, db: pg.PoolClient, tripId: string): Promise<string[]> {
  const trip = (await db.query('select destination, stay, dates_start::text as dates_start from trips where trip_id = $1 for no key update', [tripId])).rows[0];
  if (!trip || (trip.destination && trip.stay && trip.dates_start)) return [];
  const { rows } = await db.query<BookingRowLike>(
    `select kind, title, place, starts_at, ends_at, journey, return_journey from bookings where trip_id = $1 and status = 'confirmed' order by created_at`,
    [tripId],
  );
  const fills = fillsFromBookings(trip, rows);
  const sets: string[] = [];
  const values: unknown[] = [tripId];
  const set = (column: string, value: unknown) => (values.push(value), sets.push(`${column} = $${values.length}`));
  if (fills.destination) set('destination', JSON.stringify(fills.destination));
  if (fills.stay) set('stay', fills.stay);
  if (fills.dates) (set('dates_start', fills.dates.start), set('dates_end', fills.dates.end));
  if (!sets.length) return [];
  await db.query(`update trips set ${sets.join(', ')} where trip_id = $1`, values);
  const changed = [...(fills.destination ? ['destination'] : []), ...(fills.dates ? ['dates'] : []), ...(fills.stay ? ['stay'] : [])];
  const seq = await change(db, tripId, 'trip.updated', { by: { kind: 'system' }, changed });
  await ctx.live.publish(tripId, { kind: 'trip', seq, kinds: ['trip'] });
  if (fills.destination || fills.dates) await publishHomeAll(ctx, tripId, db); // the home card's place, dates and automatic name
  return changed;
}
