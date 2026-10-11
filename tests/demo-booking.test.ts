// The demo booking module (docs/DEMO-BOOKING-MODULE.md): `demoBookingFor` called directly with what the Server knows about
// a payment. A flight with its return leg, a stay with and without the trip's dates, and a payment whose option was not
// found. Every answer must pass the contract's Booking check, the made-up parts must be the same for the same payment,
// passengers come only from the covered people, and the ticket files carry the same values as the booking.
import { describe, expect, it } from 'vitest';
import { check } from '../src/contract/index.js';
import { demoBookingFor, type DemoBookingFields, type DemoBookingSource } from '../src/domain/demo-booking.js';
import { fakesFor } from '../src/demo/fake.js';
import type { HotelBookingData, TicketData } from '../src/demo/tickets/index.js';

const NOW = new Date('2026-10-12T20:00:00Z'); // 01:30 on 13 Oct in India
const PNR = /^[A-HJ-NP-Z2-9]{6}$/;

/** The module doc's §9 check: the fields as a stored Booking. */
const asBooking = (s: DemoBookingSource, f: DemoBookingFields) => {
  const { tickets: _t, documents: _d, ...fields } = f;
  return check('Booking', { booking_id: 'b_x', status: 'confirmed', amount_minor: s.amount_minor, currency: s.currency, payer_person_id: s.payer_person_id, for_person_ids: s.for_person_ids, created_at: NOW.toISOString(), ...fields });
};
const sync = (s: DemoBookingSource, now = NOW) => {
  const f = demoBookingFor(s, now);
  expect(f).not.toBeInstanceOf(Promise); // it runs inside the payment's transaction: never async
  return f as DemoBookingFields;
};

const OUT = { mode: 'flight', origin: { name: 'New Delhi', code: 'DEL' }, destination: { name: 'Goa', code: 'GOI' }, depart_at: '2026-09-11T07:50:00+05:30', arrive_at: '2026-09-11T10:20:00+05:30', carrier_name: 'IndiGo', carrier_code: '6E', number: '2134', stops: 0 };
const BACK = { mode: 'flight', origin: { name: 'Goa', code: 'GOI' }, destination: { name: 'New Delhi', code: 'DEL' }, depart_at: '2026-09-15T02:30:00Z', arrive_at: '2026-09-15T05:10:00Z', carrier_name: 'IndiGo', number: '6E 2135', stops: 1 };
const flight = (over: Partial<DemoBookingSource> = {}): DemoBookingSource => ({
  trip_id: 't_goa', approval_id: 'ap_flight_1', merchant: 'ixigo', purpose: 'DEL → GOI', amount_minor: 1184000, currency: 'INR', payer_person_id: 'p_priya',
  for_person_ids: ['p_priya', 'p_arjun'], option_kind: 'flight', option: { title: 'IndiGo 6E 2134', journey: OUT, return_journey: BACK, image_url: 'https://example.com/6e.png' },
  people: [{ person_id: 'p_priya', name: 'Priya Sharma', email: 'priya@example.com' }, { person_id: 'p_arjun', name: 'Arjun Mehta' }],
  trip: { title: 'Goa 2026', destination: { name: 'Goa' }, dates: { start: '2026-09-11', end: '2026-09-15' } },
  ...over,
});

const VILLA = { title: 'Villa Sol', place: { name: 'Villa Sol', address: 'Anjuna Beach Road, Anjuna, Goa 403509', lat: 15.5804, lng: 73.7414, timezone: 'Asia/Kolkata' }, room_types: [{ room_type_id: 'rt1', label: 'Pool Villa', sleeps: 6 }], refundable_until: '2026-11-18T18:29:00Z', highlights: ['Private pool', 'Breakfast included'] };
const stay = (over: Partial<DemoBookingSource> = {}): DemoBookingSource => ({
  trip_id: 't_goa', approval_id: 'ap_stay_1', merchant: 'ixigo: Villa Sol', purpose: 'Villa Sol, 3 nights', amount_minor: 2845000, currency: 'INR', payer_person_id: 'p_rahul',
  for_person_ids: ['p_rahul', 'p_priya', 'p_arjun', 'p_meher'], option_kind: 'stay', option: VILLA,
  people: [{ person_id: 'p_rahul', name: 'Rahul Manglani', email: 'rahul@example.com' }, { person_id: 'p_priya', name: 'Priya Sharma' }, { person_id: 'p_arjun', name: 'Arjun Mehta' }, { person_id: 'p_meher', name: 'Meher Kaur' }],
  trip: { title: 'Goa 2026', destination: { name: 'Goa', timezone: 'Asia/Kolkata' }, dates: { start: '2026-11-20', end: '2026-11-23' } },
  ...over,
});

describe('demoBookingFor: a flight with a return leg', () => {
  const s = flight();
  const f = sync(s);
  const [out, back] = (f.tickets ?? []).map((t) => t.data as TicketData);

  it('describes the booking from the journey: title, times, carrier, the legs as Go sent them, and passes the contract', () => {
    expect(asBooking(s, f)).toMatchObject({ ok: true });
    expect(f).toMatchObject({ kind: 'flight', title: 'IndiGo 6E 2134 · DEL → GOI', vendor: 'ixigo', starts_at: OUT.depart_at, ends_at: BACK.arrive_at, journey: OUT, return_journey: BACK, image_url: 'https://example.com/6e.png' });
    expect(f.ref).toMatch(/^DEMO-[0-9A-F]{6}$/);
    const details = f.details as Array<{ label: string; value: string }>;
    expect(details).toEqual(expect.arrayContaining([{ label: 'Cabin', value: 'Economy' }, { label: 'Baggage', value: 'Check-in 15 kg · Cabin 7 kg' }, { label: 'Stops', value: 'Nonstop' }, { label: 'Duration', value: '2h 30m' }, { label: 'Booking', value: 'Demo, no real ticket' }]));
    expect(details.find((d) => d.label === 'Return')?.value).toBe("IndiGo 6E 2135 · GOI → DEL · Tue, 15 Sep '26 08:00");
    expect(details.length).toBeLessThanOrEqual(20);
    for (const secret of [f.passengers![0]!.pnr!, ...out!.travellers.map((t) => t.eTicketNo!)]) expect(JSON.stringify(details)).not.toContain(secret); // rows everyone sees
  });

  it('gives each covered person a seat on each leg and the shared PNR', () => {
    expect(f.passengers!.map((p) => p.person_id)).toEqual(['p_priya', 'p_arjun']);
    for (const p of f.passengers!) expect([p.seat, p.pnr]).toEqual([expect.stringMatching(/^([3-9]|[12]\d|3[01])[A-F] \/ \d+[A-F]$/), expect.stringMatching(PNR)]);
    expect(new Set(f.passengers!.map((p) => p.pnr)).size).toBe(1);
    expect(new Set(f.passengers!.map((p) => p.seat)).size).toBe(2);
  });

  it('makes one e-ticket per leg with the same values as the booking, times in the airport\'s own time, and says DEMO', () => {
    expect(f.tickets!.map((t) => [t.kind, t.name])).toEqual([['flight', 'E-ticket DEL-GOI.pdf'], ['flight', 'E-ticket GOI-DEL.pdf']]);
    expect(out).toMatchObject({
      bookingId: expect.stringMatching(/^IF\d{14}$/), brand: { name: 'ixigo' },
      journey: { month: 'SEP', day: '11', weekday: 'Fri', from: 'NEW DELHI', to: 'GOA', status: 'CONFIRMED · DEMO', stops: 'Nonstop', duration: '2h 30m' },
      flight: { airline: 'IndiGo', flightNo: '6E-2134', cabin: 'Economy', fareType: expect.any(String) },
      departure: { code: 'DEL', time: '07:50', date: "Fri, 11 Sep '26", city: 'New Delhi', airport: 'Indira Gandhi International Airport', terminal: expect.stringMatching(/^Terminal [123]$/) },
      arrival: { code: 'GOI', time: '10:20', date: "Fri, 11 Sep '26", city: 'Goa' },
      baggage: { checkIn: '15 kg per piece, 1 piece per adult', cabin: '7 kg per adult' },
    });
    expect(back).toMatchObject({ bookingId: out!.bookingId, journey: { stops: '1 stop', duration: '2h 40m' }, flight: { flightNo: '6E-2135' }, departure: { code: 'GOI', time: '08:00', date: "Tue, 15 Sep '26" }, arrival: { time: '10:40' } });
    expect(out!.travellers).toEqual([
      { name: 'Priya Sharma', pnr: f.passengers![0]!.pnr, eTicketNo: expect.stringMatching(/^\d{13}$/), sector: 'DEL-GOI', seat: f.passengers![0]!.seat!.split(' / ')[0], meal: '' },
      { name: 'Arjun Mehta', pnr: f.passengers![0]!.pnr, eTicketNo: expect.stringMatching(/^\d{13}$/), sector: 'DEL-GOI', seat: f.passengers![1]!.seat!.split(' / ')[0], meal: '' },
    ]);
    expect(back!.travellers.map((t) => t.seat)).toEqual(f.passengers!.map((p) => p.seat!.split(' / ')[1]));
    expect(back!.travellers.map((t) => t.eTicketNo)).toEqual(out!.travellers.map((t) => t.eTicketNo));
  });

  it('makes up the same ticket for the same payment, and a different one for another', () => {
    expect(sync(flight())).toEqual(f);
    const other = sync(flight({ approval_id: 'ap_flight_2' }));
    expect([other.ref, other.passengers![0]!.pnr]).not.toEqual([f.ref, f.passengers![0]!.pnr]);
  });

  it('puts only the covered people on the ticket, never the payer when the booking is for someone else', () => {
    const forArjun = sync(flight({ for_person_ids: ['p_arjun'], option: { journey: OUT } }));
    expect(forArjun.passengers!.map((p) => p.person_id)).toEqual(['p_arjun']);
    expect((forArjun.tickets![0]!.data as TicketData).travellers.map((t) => t.name)).toEqual(['Arjun Mehta']);
    expect([forArjun.tickets!.length, forArjun.return_journey]).toEqual([1, null]);
    const unnamed = sync(flight({ people: [] }));
    expect((unnamed.tickets![0]!.data as TicketData).travellers.map((t) => t.name)).toEqual(['Traveller 1', 'Traveller 2']);
  });

  it('prints a carrier code with a bare number, and a train or bus on the same ticket without a terminal; a cab has no ticket', () => {
    const coded = sync(flight({ option: { journey: { ...OUT, number: '6E2134' } } }));
    expect([coded.title, (coded.tickets![0]!.data as TicketData).flight.flightNo]).toEqual(['IndiGo 6E 2134 · DEL → GOI', '6E-2134']);
    const train = sync(flight({ option_kind: 'train', option: { journey: { mode: 'train', origin: { name: 'Mumbai CSMT', code: 'CSMT' }, destination: { name: 'Madgaon', code: 'MAO' }, depart_at: '2026-11-06T23:05:00+05:30', arrive_at: '2026-11-07T10:45:00+05:30', carrier_name: 'Konkan Kanya Express', number: '10111' } } }));
    expect(asBooking(flight(), train)).toMatchObject({ ok: true });
    const t = train.tickets![0]!.data as TicketData;
    expect([train.kind, train.title, t.flight.cabin, t.departure.terminal, t.journey.duration, t.arrival.date]).toEqual(['train', 'Konkan Kanya Express 10111 · CSMT → MAO', 'AC 3 Tier', undefined, '11h 40m', "Sat, 07 Nov '26"]);
    const cab = sync(flight({ option_kind: 'cab', option: { journey: { ...OUT, mode: 'cab' } } }));
    expect([cab.kind, cab.tickets, asBooking(flight(), cab).ok]).toEqual(['cab', [], true]);
  });
});

describe('demoBookingFor: a stay', () => {
  it("with the trip's dates: check-in 14:00 and check-out 11:00 in the place's time, the room, the guests, the refund rule, and one voucher", () => {
    const s = stay();
    const f = sync(s);
    expect(asBooking(s, f)).toMatchObject({ ok: true });
    expect(f).toMatchObject({ kind: 'stay', title: 'Villa Sol', vendor: 'ixigo: Villa Sol', starts_at: '2026-11-20T08:30:00.000Z', ends_at: '2026-11-23T05:30:00.000Z', place: VILLA.place, refundable_until: VILLA.refundable_until, passengers: null, journey: null });
    expect(f.details).toEqual([
      { label: 'Check-in', value: 'Fri, 20 Nov · 14:00' }, { label: 'Check-out', value: 'Mon, 23 Nov · 11:00' }, { label: 'Nights', value: '3' },
      { label: 'Room', value: '1 x Pool Villa' }, { label: 'Guests', value: '4 Adults' }, { label: 'Cancellation', value: 'Free cancellation until 18 Nov 2026 11:59 PM' },
      { label: 'Booking ID', value: expect.stringMatching(/^IH\d{16}$/) }, { label: 'Hotel booking no.', value: expect.stringMatching(/^\d{10}$/) }, { label: 'Booking', value: 'Demo, no real ticket' },
    ]);
    expect(f.tickets!.map((t) => [t.kind, t.name])).toEqual([['stay', 'Hotel voucher Villa Sol.pdf']]);
    const v = f.tickets![0]!.data as HotelBookingData;
    expect(v).toMatchObject({
      bookingId: (f.details as any[])[6].value, hotelBookingNumber: (f.details as any[])[7].value, bookedOn: '13 Oct 2026', brand: { name: 'ixigo' },
      hotel: { name: 'Villa Sol', address: 'Anjuna Beach Road, Anjuna, Goa 403509', mapUrl: 'https://maps.google.com/?q=15.5804,73.7414' },
      status: 'Booking Confirmed · Demo', checkIn: 'Fri, 20 Nov', checkOut: 'Mon, 23 Nov', travellers: '4 Adults',
      primaryGuest: { name: 'RAHUL MANGLANI' }, rooms: { summary: '1 x Pool Villa', inclusions: 'Private pool, Breakfast included' },
      price: { currency: '₹', total: '28450.00' },
      cancellation: { rules: [{ title: 'Free cancellation till 18 Nov 2026 11:59 PM' }, { title: 'Non-refundable after 18 Nov 2026 11:59 PM' }] },
    });
    expect(v.primaryGuest.email).toBeUndefined(); // the voucher is seen by the whole group: no one's email (§1.7)
    expect(v.terms!.items[0]).toMatch(/demo booking/);
    expect(sync(stay())).toEqual(f);
  });

  it('free cancellation never runs past check-in: a later date from Go is capped at a day before it, on the booking and the voucher', () => {
    const s = stay({ option: { ...VILLA, refundable_until: '2026-12-01T18:29:00Z' } }); // after the 20-23 Nov stay
    const f = sync(s);
    expect(f.refundable_until).toBe('2026-11-19T08:30:00.000Z'); // check-in 20 Nov 14:00 IST, less a day
    const v = f.tickets![0]!.data as HotelBookingData;
    expect(v.cancellation.rules[0]!.title).toMatch(/^Free cancellation till 19 Nov 2026/);
  });

  it('without trip dates: no dates made up (12 Oct 2026: a 1-5 Nov stay was booked as 13-16 Oct); the nights from Go\'s purpose; the payer\'s email on their own voucher; the default room', () => {
    const s = stay({ for_person_ids: ['p_rahul'], purpose: 'Munnar: 4 nights (₹15,557 a night)', trip: { title: 'Munnar 2026' }, option: { label: 'Casa Azul', refundable_until: null } });
    const f = sync(s);
    expect(asBooking(s, f)).toMatchObject({ ok: true });
    expect([f.title, f.starts_at, f.ends_at, f.place]).toEqual(['Casa Azul', null, null, null]);
    const v = f.tickets![0]!.data as HotelBookingData;
    expect(v).toMatchObject({ checkIn: 'To be confirmed', checkOut: '4 nights, dates to be confirmed', travellers: '1 Adult', rooms: { summary: '1 x Deluxe Room' }, hotel: { name: 'Casa Azul', address: 'Casa Azul' }, primaryGuest: { name: 'RAHUL MANGLANI', email: 'rahul@example.com' } });
    expect([v.hotel.mapUrl, v.cancellation.rules.map((r) => r.title)]).toEqual([undefined, ['Non-refundable']]);
    const rows = Object.fromEntries((f.details as any[]).map((d) => [d.label, d.value]));
    expect([rows.Dates, rows.Nights, rows['Check-in'], rows.Cancellation]).toEqual(['To be confirmed', '4', undefined, 'Non-refundable']);
  });

  it("in another time zone, a room that sleeps two for four guests, and the trip's destination as the address", () => {
    const s = stay({ option: { title: 'Hotel Ubud', place: { name: 'Hotel Ubud', timezone: 'Asia/Makassar' }, room_types: [{ label: 'Deluxe Twin', sleeps: 2 }] }, trip: { title: 'Bali', destination: { name: 'Bali, Indonesia' }, dates: { start: '2026-12-01', end: '2026-12-05' } } });
    const f = sync(s);
    expect(asBooking(s, f)).toMatchObject({ ok: true });
    expect([f.starts_at, f.ends_at]).toEqual(['2026-12-01T06:00:00.000Z', '2026-12-05T03:00:00.000Z']);
    expect((f.tickets![0]!.data as HotelBookingData)).toMatchObject({ rooms: { summary: '2 x Deluxe Twin' }, hotel: { address: 'Bali, Indonesia' } });
  });
});

describe('demoBookingFor: nothing to go on', () => {
  it('with no option at all: the thin booking, titled from the purpose, with no ticket file', () => {
    const s = flight({ option: undefined, option_kind: undefined, purpose: 'Flight to Goa' });
    const f = sync(s);
    expect(asBooking(s, f)).toMatchObject({ ok: true });
    expect(f).toMatchObject({ kind: 'other', title: 'Flight to Goa', vendor: 'ixigo', ref: expect.stringMatching(/^DEMO-[0-9A-F]{6}$/), details: [{ label: 'Paid', value: 'Demo payment' }], passengers: null });
    expect(f.tickets).toBeUndefined();
  });

  it('with an option of another kind, or a journey it cannot read: the thin booking, inside the limits', () => {
    const activity = sync(flight({ option_kind: 'activity', option: { title: 'Scuba at Grande Island'.repeat(10) } }));
    expect([activity.kind, activity.title.length, activity.tickets]).toEqual(['activity', 120, undefined]);
    const broken = sync(flight({ option: { title: 'IndiGo 6E 2134', journey: { ...OUT, depart_at: 'soon' } } }));
    expect([broken.kind, broken.title, broken.tickets]).toEqual(['flight', 'IndiGo 6E 2134', undefined]);
    const odd = sync(stay({ option: { title: 'Villa', place: 5, room_types: 'many' as never, highlights: [3 as never] }, trip: { title: 'x', dates: { start: '2026-02-30', end: 'later' } } }));
    expect([odd.kind, odd.title, odd.tickets!.length, asBooking(stay(), odd).ok]).toEqual(['stay', 'Villa', 1, true]);
  });

  it('never throws: when the rich booking fails, the thin one is answered', () => {
    let reads = 0;
    const option = { get title() { if (reads++ === 0) throw new Error('odd option'); return 'Villa Sol'; } };
    const f = sync(stay({ option }));
    expect([f.kind, f.title, f.details, f.tickets]).toEqual(['stay', 'Villa Sol', [{ label: 'Paid', value: 'Demo payment' }], undefined]);
  });
});

describe('the made-up parts', () => {
  it('are the same for the same seed and have the shapes of real ones', () => {
    const [a, b] = [fakesFor('ap_1'), fakesFor('ap_1')];
    const draw = (f: ReturnType<typeof fakesFor>) => [f.pnr(), f.eTickets(3), f.seats(8), f.flightBookingId(), f.stayBookingId(), f.hotelBookingNumber(), f.terminal(), f.fareType(), f.ref()];
    const one = draw(a);
    expect(draw(b)).toEqual(one);
    expect(draw(fakesFor('ap_2'))).not.toEqual(one);
    const [pnr, tickets, seats, fid, sid, hotel, terminal, fare, ref] = one as [string, string[], string[], string, string, string, string, string, string];
    expect(pnr).toMatch(PNR);
    expect(tickets.map((t) => t.length)).toEqual([13, 13, 13]);
    expect(Number(tickets[1]) - Number(tickets[0])).toBe(1);
    expect(seats.every((s) => /^\d{1,2}[A-F]$/.test(s))).toBe(true);
    expect(new Set(seats).size).toBe(8);
    expect([fid, sid, hotel, terminal, fare, ref]).toEqual([expect.stringMatching(/^IF\d{14}$/), expect.stringMatching(/^IH\d{16}$/), expect.stringMatching(/^\d{10}$/), expect.stringMatching(/^Terminal [123]$/), expect.stringMatching(/^[A-Z]+$/), expect.stringMatching(/^DEMO-[0-9A-F]{6}$/)]);
  });
});
