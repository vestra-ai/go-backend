// The demo booking's fields and its ticket files, built from the option that was paid for (docs/DEMO-BOOKING-MODULE.md).
// Real data wherever Go gave it: the route, times, carrier and flight number of a journey; the stay's name, place, room
// and refund date; the trip's dates; the covered people's names. Everything else is made up (src/demo/fake.ts) or a
// plain placeholder, and both the booking and the files say DEMO. Pure and synchronous: it runs inside the payment's
// transaction. Every string is cut to the contract's limit, and the files are built from the same values as the booking,
// so the PDF and the app always agree.
import type { DemoBookingFields, DemoBookingSource, DemoOption } from '../domain/demo-booking.js';
import type { JourneyLike, Passenger } from '../domain/mappers.js';
import { fakesFor } from './fake.js';
import type { DemoTicket, HotelBookingData, TicketData } from './tickets/index.js';
import * as when from './when.js';

const FLIGHT_BRAND = { name: 'ixigo', color: '#fc4c02' };
const STAY_BRAND = { name: 'ixigo', color: '#e8682d' };
/** The detail row that tells a person this is not a real ticket. */
const DEMO_ROW = { label: 'Booking', value: 'Demo, no real ticket' };
const TICKET_MODES = new Set(['flight', 'train', 'bus']);
const CLASS: Record<string, string> = { flight: 'Economy', train: 'AC 3 Tier', bus: 'AC Seater' };

const STAY_TERMS = [
  'This is a demo booking made by Go. No room was reserved with the hotel and no money was taken.',
  'Your reservation is guaranteed for arrival on the confirmed check-in date only.',
  'Please carry a valid ID proof (Aadhaar Card, Driving License or Passport) for all the guests. PAN Card will not be accepted as an ID proof.',
  'Your booking details shall be sent to the respective hotel.',
  'Your special requests will be passed on to the hotel, and those shall be subject to availability.',
  'Please contact the hotel for any requests related to early check-in or late check-out.',
  'This is a computer-generated document and does not require a signature/stamp.',
];

type Row = { label: string; value: string };
type PlaceLike = { name?: unknown; address?: unknown; lat?: unknown; lng?: unknown; timezone?: unknown };

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const row = (label: string, value: string): Row => ({ label: label.slice(0, 40), value: value.slice(0, 200) });
const asPlace = (v: unknown): PlaceLike => (v && typeof v === 'object' ? (v as PlaceLike) : {});
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** A leg a ticket can be printed for: both ends named and both times readable. */
export const printable = (j: JourneyLike | null | undefined): j is JourneyLike =>
  !!j && !!text(j.origin?.name) && !!text(j.destination?.name) && !Number.isNaN(Date.parse(j.depart_at)) && !Number.isNaN(Date.parse(j.arrive_at));

/** Full names of India's busiest airports, for the e-ticket (Go sends the code and the city only). */
const AIRPORTS: Record<string, string> = {
  DEL: 'Indira Gandhi International Airport', BOM: 'Chhatrapati Shivaji Maharaj International Airport',
  BLR: 'Kempegowda International Airport', MAA: 'Chennai International Airport', CCU: 'Netaji Subhas Chandra Bose International Airport',
  HYD: 'Rajiv Gandhi International Airport', GOI: 'Dabolim Airport', GOX: 'Manohar International Airport, Mopa',
  COK: 'Cochin International Airport', PNQ: 'Pune International Airport', AMD: 'Sardar Vallabhbhai Patel International Airport',
  JAI: 'Jaipur International Airport', LKO: 'Chaudhary Charan Singh International Airport', IXC: 'Chandigarh International Airport',
  SXR: 'Sheikh ul-Alam International Airport', IXL: 'Kushok Bakula Rimpochee Airport', TRV: 'Trivandrum International Airport',
  IXB: 'Bagdogra Airport', GAU: 'Lokpriya Gopinath Bordoloi International Airport', VNS: 'Lal Bahadur Shastri International Airport',
  ATQ: 'Sri Guru Ram Dass Jee International Airport', IXZ: 'Veer Savarkar International Airport', UDR: 'Maharana Pratap Airport',
  IXE: 'Mangaluru International Airport', CJB: 'Coimbatore International Airport', DED: 'Dehradun Airport', NAG: 'Dr. Babasaheb Ambedkar International Airport',
};
const airportName = (code: string, city: string, isFlight: boolean) => (isFlight ? AIRPORTS[code.toUpperCase()] : undefined) ?? city;

/** An airport's code, else the first three letters of its city. */
const codeOf = (end: { name: string; code?: string | null }) => (text(end.code) ?? end.name.trim().slice(0, 3)).toUpperCase();

/** The carrier's number for the title ("6E 2134") and for the ticket ("6E-2134"). */
function numbers(j: JourneyLike): { title?: string; ticket: string } {
  const code = text(j.carrier_code);
  const num = text(j.number);
  if (!num) return { title: code, ticket: code ?? '-' };
  if (!code) {
    const split = /^([A-Z0-9]{2})[\s-](\d{1,5})$/i.exec(num); // "6E 2134" as Go often sends it
    return { title: num, ticket: split ? `${split[1]}-${split[2]}` : num };
  }
  const bare = num.toUpperCase().startsWith(code.toUpperCase()) ? num.slice(code.length).replace(/^[\s-]+/, '') || num : num;
  return { title: `${code} ${bare}`, ticket: `${code}-${bare}` };
}

const stopsText = (n: unknown) => (typeof n === 'number' && n > 0 ? plural(n, 'stop') : 'Nonstop');

/** The people a booking covers, in order, with their names (a covered person without one is "Traveller 2"). */
function covered(s: DemoBookingSource): Array<{ person_id: string; name: string }> {
  const names = new Map((s.people ?? []).map((p) => [p.person_id, text(p.name)]));
  return s.for_person_ids.slice(0, 30).map((person_id, i) => ({ person_id, name: names.get(person_id) ?? `Traveller ${i + 1}` }));
}

/** A flight, train or bus, from the option's journey and its return leg: one ticket per leg (a flight, train or bus). */
export function journeyBooking(s: DemoBookingSource, o: DemoOption, kind: string): DemoBookingFields {
  const out = o.journey!;
  const legs = [out, ...(printable(o.return_journey) ? [o.return_journey] : [])];
  const f = fakesFor(s.approval_id);
  const ref = f.ref();
  const pnr = f.pnr();
  const bookingId = f.flightBookingId();
  const fare = f.fareType();
  const people = covered(s);
  const eTickets = f.eTickets(people.length);
  const seats = legs.map(() => f.seats(people.length));
  const terminals = legs.map(() => [f.terminal(), f.terminal()] as const);
  const mode = TICKET_MODES.has(out.mode) ? out.mode : 'flight';
  const isFlight = mode === 'flight';
  const cabin = CLASS[mode]!;

  const head = (j: JourneyLike) => [text(j.carrier_name), numbers(j).title].filter(Boolean).join(' ');
  const route = (j: JourneyLike) => `${codeOf(j.origin)} → ${codeOf(j.destination)}`;
  const departs = (j: JourneyLike) => {
    const w = when.wallOf(j.depart_at, when.INDIA);
    return `${when.flightDate(w)} ${when.clock(w)}`;
  };
  const named = head(out) || text(o.title) || text(o.label);
  const title = named ? (head(out) ? `${named} · ${route(out)}` : named) : route(out);

  const tickets: DemoTicket[] = TICKET_MODES.has(out.mode)
    ? legs.map((j, i): DemoTicket => {
        const dep = when.wallOf(j.depart_at, when.INDIA);
        const arr = when.wallOf(j.arrive_at, when.INDIA);
        const [from, to] = [codeOf(j.origin), codeOf(j.destination)];
        const data: TicketData = {
          bookingId,
          brand: FLIGHT_BRAND,
          journey: { ...when.leaf(dep), from: j.origin.name.toUpperCase(), to: j.destination.name.toUpperCase(), status: 'CONFIRMED · DEMO', stops: stopsText((j as { stops?: unknown }).stops), duration: when.duration(j.depart_at, j.arrive_at) },
          flight: { airline: text(j.carrier_name) ?? text(j.carrier_code) ?? mode[0]!.toUpperCase() + mode.slice(1), flightNo: numbers(j).ticket, cabin, ...(isFlight ? { fareType: fare } : {}) },
          departure: { code: from, time: when.clock(dep), date: when.flightDate(dep), city: j.origin.name, airport: airportName(from, j.origin.name, isFlight), ...(isFlight ? { terminal: terminals[i]![0] } : {}) },
          arrival: { code: to, time: when.clock(arr), date: when.flightDate(arr), city: j.destination.name, airport: airportName(to, j.destination.name, isFlight), ...(isFlight ? { terminal: terminals[i]![1] } : {}) },
          baggage: isFlight ? { checkIn: '15 kg per piece, 1 piece per adult', cabin: '7 kg per adult' } : { checkIn: 'As per operator rules', cabin: 'As per operator rules' },
          travellers: people.map((p, k) => ({ name: p.name, pnr, eTicketNo: eTickets[k], sector: `${from}-${to}`, seat: seats[i]![k], meal: '' })),
        };
        return { kind: 'flight', name: `E-ticket ${from}-${to}.pdf`.slice(0, 200), data };
      })
    : [];

  const back = legs[1];
  const details: Row[] = [
    row(isFlight ? 'Cabin' : 'Class', cabin),
    ...(isFlight ? [row('Fare', fare), row('Baggage', 'Check-in 15 kg · Cabin 7 kg'), row('Terminal', terminals[0]![0])] : []),
    row('Stops', stopsText((out as { stops?: unknown }).stops)),
    row('Duration', when.duration(out.depart_at, out.arrive_at)),
    ...(back ? [row('Return', `${head(back) ? `${head(back)} · ` : ''}${route(back)} · ${departs(back)}`)] : []),
    row('Booking ID', bookingId),
    DEMO_ROW,
  ];
  const passengers: Passenger[] = people.map((p, k) => ({ person_id: p.person_id, seat: seats.map((leg) => leg[k]).join(' / ').slice(0, 20), pnr }));
  return {
    kind, title: title.slice(0, 120), vendor: s.merchant.slice(0, 80), ref,
    refundable_until: o.refundable_until ?? null, starts_at: out.depart_at, ends_at: (back ?? out).arrive_at,
    journey: out, return_journey: o.return_journey ?? null, place: o.place ?? null, image_url: o.image_url ?? null,
    details, passengers, tickets,
  };
}

/** A stay, from the option (its name, place, first room type, refund date) and the trip's dates: one hotel voucher. */
export function stayBooking(s: DemoBookingSource, o: DemoOption, now: Date): DemoBookingFields {
  const place = asPlace(o.place);
  const destination = asPlace(s.trip?.destination);
  const name = (text(o.title) ?? text(o.label) ?? text(place.name) ?? s.purpose).slice(0, 120);
  const tz = when.zoneOr(text(place.timezone) ?? text(destination.timezone));
  const f = fakesFor(s.approval_id);
  const ref = f.ref();
  const bookingId = f.stayBookingId();
  const hotelNumber = f.hotelBookingNumber();

  // The trip's own dates, or none: never made up (12 Oct 2026: a 1-5 Nov stay was booked as "tomorrow for three nights",
  // and the trip and Go then followed those wrong dates). The nights come from Go's own purpose ("Munnar: 4 nights").
  const [inDay, outDay] = [when.dateParts(s.trip?.dates?.start), when.dateParts(s.trip?.dates?.end)];
  const dated = inDay && outDay && when.daysBetween(inDay, outDay) >= 1 ? { checkIn: inDay, checkOut: outDay } : undefined;
  const purposeNights = Number(/(\d{1,2})\s*nights?\b/i.exec(s.purpose)?.[1]);
  const nights = dated ? when.daysBetween(dated.checkIn, dated.checkOut) : purposeNights > 0 ? purposeNights : undefined;

  const guests = Math.max(1, s.for_person_ids.length);
  const room = Array.isArray(o.room_types) ? o.room_types[0] : undefined;
  const sleeps = typeof room?.sleeps === 'number' && room.sleeps > 0 ? room.sleeps : undefined;
  const rooms = `${sleeps ? Math.max(1, Math.ceil(guests / sleeps)) : 1} x ${text(room?.label) ?? 'Deluxe Room'}`;
  const inclusions = Array.isArray(o.highlights) ? o.highlights.map(text).filter(Boolean).slice(0, 3).join(', ') : '';
  const travellers = plural(guests, 'Adult');

  const payer = (s.people ?? []).find((p) => p.person_id === s.payer_person_id);
  // An email is shown only on a voucher nobody else sees (app contract §1.7: no other person's email).
  const solo = s.for_person_ids.length === 1 && s.for_person_ids[0] === s.payer_person_id;
  // Free cancellation never runs past check-in (when the dates are known): Go's date is capped at a day before it.
  const checkInAt = dated ? Date.parse(when.zonedIso(dated.checkIn, 14, 0, tz)) : Infinity;
  const refundMs = text(o.refundable_until) ? Date.parse(o.refundable_until!) : NaN;
  const refundableUntil = Number.isNaN(refundMs) ? undefined : refundMs <= checkInAt - 86_400_000 ? o.refundable_until! : new Date(checkInAt - 86_400_000).toISOString();
  const until = refundableUntil && Date.parse(refundableUntil) > now.getTime() ? when.longTime(when.wallOf(refundableUntil, tz)) : undefined;
  const rules = until
    ? [
        { title: `Free cancellation till ${until}`, description: `Cancel your reservation before ${until}, to get a full refund` },
        { title: `Non-refundable after ${until}`, description: `100% amount will be deducted on cancellation after ${until}` },
      ]
    : [{ title: 'Non-refundable', description: '100% amount will be deducted on cancellation' }];
  const lat = typeof place.lat === 'number' && Number.isFinite(place.lat) ? place.lat : undefined;
  const lng = typeof place.lng === 'number' && Number.isFinite(place.lng) ? place.lng : undefined;

  const data: HotelBookingData = {
    bookingId,
    hotelBookingNumber: hotelNumber,
    bookedOn: when.longDate(when.wallAt(now.getTime(), tz)),
    brand: STAY_BRAND,
    hotel: {
      name,
      address: text(place.address) ?? text(destination.name) ?? text(place.name) ?? name,
      ...(lat !== undefined && lng !== undefined ? { mapUrl: `https://maps.google.com/?q=${lat},${lng}` } : {}),
    },
    status: 'Booking Confirmed · Demo',
    checkIn: dated ? when.stayDay(dated.checkIn) : 'To be confirmed',
    checkOut: dated ? when.stayDay(dated.checkOut) : nights ? `${plural(nights, 'night')}, dates to be confirmed` : 'To be confirmed',
    primaryGuest: { name: (text(payer?.name) ?? 'Guest').toUpperCase(), ...(solo && text(payer?.email) ? { email: payer!.email! } : {}) },
    travellers,
    rooms: { summary: rooms, ...(inclusions ? { inclusions } : {}) },
    price: { currency: s.currency === 'INR' ? '₹' : `${s.currency} `, total: (s.amount_minor / 100).toFixed(2), paymentMode: 'Demo payment, no money was taken' },
    cancellation: { rules, footnote: "All date and time are in hotel's timezone" },
    terms: { title: 'ixigo Terms & Conditions', items: STAY_TERMS },
  };

  const details: Row[] = [
    ...(dated ? [row('Check-in', `${data.checkIn} · 14:00`), row('Check-out', `${data.checkOut} · 11:00`)] : [row('Dates', 'To be confirmed')]),
    ...(nights ? [row('Nights', String(nights))] : []),
    row('Room', rooms),
    row('Guests', travellers),
    row('Cancellation', until ? `Free cancellation until ${until}` : 'Non-refundable'),
    row('Booking ID', bookingId),
    row('Hotel booking no.', hotelNumber),
    DEMO_ROW,
  ];
  return {
    kind: 'stay', title: name, vendor: s.merchant.slice(0, 80), ref,
    refundable_until: until ? refundableUntil! : null,
    starts_at: dated ? when.zonedIso(dated.checkIn, 14, 0, tz) : null, ends_at: dated ? when.zonedIso(dated.checkOut, 11, 0, tz) : null,
    journey: null, return_journey: null, place: text(place.name) ? o.place : null, image_url: o.image_url ?? null,
    details, passengers: null,
    tickets: [{ kind: 'stay', name: `Hotel voucher ${name.slice(0, 180)}.pdf`, data }],
  };
}
