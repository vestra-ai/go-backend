// A booking settles part of the trip (11 Oct 2026): when someone books a flight to Goa or a stay in Anjuna before the
// group set the trip's place, stay or dates, the trip takes them from its confirmed bookings. Only empty fields are
// filled, never a value a person or Go set:
// - destination: a place, never the hotel: where the outbound flight (train, bus) lands, else the town or state of the
//   stay's address;
// - stay: the stay's name;
// - dates: the stay's check-in to check-out; else, only when the trip has both an outbound and a return journey, the
//   outbound departure date to the return arrival date (a one-way flight sets no dates).
// It runs in the transaction that wrote the booking, after the booking's own events, and sends `trip.updated` by the
// system naming what it filled. The automatic name ("Goa 2026") then follows on the next read.
import type pg from 'pg';
import type { Ctx } from '../context.js';
import { withTx } from '../db/pool.js';
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

/** India's states and union territories, to read a town or state out of an address. */
const STATES = new Set(['andhra pradesh', 'arunachal pradesh', 'assam', 'bihar', 'chhattisgarh', 'goa', 'gujarat', 'haryana', 'himachal pradesh',
  'jharkhand', 'karnataka', 'kerala', 'madhya pradesh', 'maharashtra', 'manipur', 'meghalaya', 'mizoram', 'nagaland', 'odisha', 'punjab',
  'rajasthan', 'sikkim', 'tamil nadu', 'telangana', 'tripura', 'uttar pradesh', 'uttarakhand', 'west bengal', 'andaman and nicobar islands',
  'chandigarh', 'dadra and nagar haveli and daman and diu', 'delhi', 'jammu and kashmir', 'ladakh', 'lakshadweep', 'puducherry']);
/** States that are themselves the trip's place: people go "to Goa", not to the village their villa is in. */
const STATE_IS_PLACE = new Set(['goa', 'sikkim', 'ladakh', 'lakshadweep', 'andaman and nicobar islands', 'puducherry', 'delhi', 'chandigarh']);

/**
 * The trip's place from a stay's address: "Anjuna Beach Road, Anjuna, Goa 403509" → "Goa"; "Old Manali, Manali, Himachal
 * Pradesh 175131" → "Manali"; "Rawalpora, Srinagar" and "Srinagar" → "Srinagar" (Go's real addresses, 11 Oct). The postcode and the country are dropped;
 * before a state comes its town (or the state itself when people travel to the state). Undefined when there is no address.
 */
export function placeFromAddress(address: string | undefined, hotel?: string): string | undefined {
  const parts = (address ?? '').split(',').map((p) => p.replace(/\b\d{5,6}\b/g, '').trim()).filter((p) => p && !/^india$/i.test(p));
  if (!parts.length) return undefined;
  const last = parts[parts.length - 1]!;
  const state = STATES.has(last.toLowerCase());
  if (state && (STATE_IS_PLACE.has(last.toLowerCase()) || parts.length === 1)) return last;
  if (state) return parts[parts.length - 2];
  // Go often sends the town alone ("Srinagar", "Candolim"): that is the place, unless it is just the hotel's own name.
  return parts.length === 1 && hotel && last.toLowerCase() === hotel.trim().toLowerCase() ? undefined : last;
}

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
    // A place, never the hotel: the city the outbound journey lands in, else the town or state of the stay's address.
    const city = (outbound ? cityOf(outbound.destination) : undefined) ?? (stay ? placeFromAddress(text(stay.place?.address), text(stay.place?.name) ?? stay.title) : undefined);
    if (city) fills.destination = { name: city.slice(0, 120) };
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

/**
 * A one-time repair, run after start (12 Oct 2026). The first version of this file gave the trip a stay's whole place as
 * its destination, so a trip read "Villa Sol, Anjuna" as its place. This finds each trip whose destination the system
 * filled (a `trip.updated` by the system naming `destination` in its outbox) and still is exactly a booked stay's place,
 * works the place out again with today's rule (the landing city, else the address's town or state, else empty), saves
 * it and tells Go and the room. Idempotent: a repaired trip no longer matches, so a later start does nothing.
 */
export async function repairStayDestinations(ctx: Ctx): Promise<number> {
  const { rows } = await ctx.pool.query<{ trip_id: string }>(
    `select t.trip_id from trips t
      where t.destination ? 'name'
        and exists (select 1 from bookings b where b.trip_id = t.trip_id and b.kind = 'stay' and b.status = 'confirmed' and b.place->>'name' = t.destination->>'name')
        and exists (select 1 from outbox o where o.trip_id = t.trip_id and o.body->>'type' = 'trip.updated'
                    and o.body->'data'->'by'->>'kind' = 'system' and o.body->'data'->'changed' ? 'destination')`,
  );
  let repaired = 0;
  for (const { trip_id } of rows) {
    const done = await withTx(ctx.pool, async (db) => {
      const trip = (await db.query('select destination from trips where trip_id = $1 for no key update', [trip_id])).rows[0];
      const bookings = (await db.query<BookingRowLike>(
        `select kind, title, place, starts_at, ends_at, journey, return_journey from bookings where trip_id = $1 and status = 'confirmed' order by created_at`, [trip_id],
      )).rows;
      if (!trip?.destination?.name || !bookings.some((b) => b.kind === 'stay' && b.place?.name === trip.destination.name)) return false; // changed meanwhile
      const place = fillsFromBookings({ destination: null, stay: 'set', dates_start: 'set' }, bookings).destination ?? null;
      await db.query('update trips set destination = $2 where trip_id = $1', [trip_id, place ? JSON.stringify(place) : null]);
      const seq = await change(db, trip_id, 'trip.updated', { by: { kind: 'system' }, changed: ['destination'] });
      await ctx.live.publish(trip_id, { kind: 'trip', seq, kinds: ['trip'] });
      await publishHomeAll(ctx, trip_id, db);
      return true;
    });
    if (done) repaired++;
  }
  return repaired;
}

