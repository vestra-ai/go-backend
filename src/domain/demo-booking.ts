// The demo's booking (docs/GO-TEAM-DEMO-PAYMENT.md): what the Server writes as booked when a payment is taken as done.
// This is the one place the fake booking and ticket module plugs in: `demoBookingFor` gets everything the Server knows
// about what was paid for and answers the booking's fields. What it answers is stored as it is and reaches the app as an
// ordinary Booking (journey, details, passengers, ticket files and all). docs/DEMO-BOOKING-MODULE.md is the brief for
// that module; the module itself is src/demo/ (the fields in booking.ts, the ixigo-style PDFs in tickets/).
import { randomBytes } from 'node:crypto';
import { journeyBooking, printable, stayBooking } from '../demo/booking.js';
import type { DemoTicket } from '../demo/tickets/index.js';
import type { JourneyLike, Passenger } from './mappers.js';

/** An option as Go's options card (or the vote) showed it, as far as a booking needs it. */
export interface DemoOption {
  title?: string; label?: string; image_url?: string | null; refundable_until?: string | null; place?: unknown;
  journey?: JourneyLike | null; return_journey?: JourneyLike | null;
  room_types?: Array<{ label?: string; sleeps?: number }> | null; highlights?: string[] | null;
}

export interface DemoBookingSource {
  trip_id: string;
  approval_id: string;
  /** The pay card's own words: who is paid and for what. */
  merchant: string;
  purpose: string;
  amount_minor: number;
  currency: string;
  payer_person_id: string;
  /** Who the booking covers: the person alone for their own pick, everyone in the trip for a group payment. */
  for_person_ids: string[];
  /** The options card's kind (stay, flight, ...), when the paid option was found on one. */
  option_kind?: string;
  /** The option that was paid for, when it was found: the person's pick, or the vote's winning option. */
  option?: DemoOption;
  /** The covered people and the payer, with their names (the email is never shown to anyone but its owner). */
  people?: Array<{ person_id: string; name: string; email?: string }>;
  /** The trip: a stay's check-in and check-out are its dates (`YYYY-MM-DD`) when it has them. */
  trip?: { title: string; destination?: { name: string; address?: string | null; timezone?: string | null } | null; dates?: { start: string; end: string } | null };
}

export interface DemoBookingFields {
  kind: string; title: string; vendor: string; ref: string;
  refundable_until?: string | null; starts_at?: string | null; ends_at?: string | null;
  journey?: JourneyLike | null; return_journey?: JourneyLike | null; place?: unknown; image_url?: string | null;
  details?: unknown[] | null; passengers?: Passenger[] | null;
  /** Ticket files (a PDF or a picture, at most 25 MB each), by link: the Server copies each into its own storage after the payment is saved. */
  documents?: DemoDocument[] | null;
  /** Ticket files the Server renders itself after the payment is saved (src/demo/attach.ts): an e-ticket per leg, or a hotel voucher. */
  tickets?: DemoTicket[] | null;
}

export interface DemoDocument { name: string; mime: string; url: string; pages?: number; visibility: 'covered' | 'group' }

const BOOKING_KINDS = new Set(['stay', 'flight', 'train', 'bus', 'cab', 'activity']);

/** A reference that reads like a PNR and says what it is: `DEMO-4K7Q2M`. */
export const demoRef = () => `DEMO-${randomBytes(4).toString('hex').slice(0, 6).toUpperCase()}`;

/**
 * The demo booking for a payment taken as done. A journey (flight, train, bus, cab) gets its carrier, times, seats and
 * PNRs and an e-ticket per leg; a stay gets its dates, room and refund rules and a hotel voucher; anything else, and a
 * payment whose option was not found, gets the thin booking titled from the option or the purpose, with no file.
 * Synchronous and never throws: if building the rich booking fails on odd input, the thin one is answered.
 */
export function demoBookingFor(s: DemoBookingSource, now: Date = new Date()): DemoBookingFields | Promise<DemoBookingFields> {
  const o = s.option;
  const kind = s.option_kind && BOOKING_KINDS.has(s.option_kind) ? s.option_kind : o?.journey?.mode ?? 'other';
  try {
    if (o && s.option_kind === 'stay') return stayBooking(s, o, now);
    if (o && printable(o.journey)) return journeyBooking(s, o, kind);
  } catch (err) {
    console.error(`[tickets] the demo booking for approval ${s.approval_id} fell back to the thin one`, err instanceof Error ? err.message : err);
  }
  return thinBooking(s, kind);
}

/** The booking with only what the option says as it is: its title (else the purpose), journey, place and picture. */
function thinBooking(s: DemoBookingSource, kind: string): DemoBookingFields {
  const o = s.option ?? {};
  const ref = demoRef();
  const journey = o.journey ?? null;
  const last = o.return_journey ?? journey;
  return {
    kind,
    title: (o.title ?? o.label ?? s.purpose).slice(0, 120),
    vendor: s.merchant.slice(0, 80),
    ref,
    refundable_until: o.refundable_until ?? null,
    starts_at: journey?.depart_at ?? null,
    ends_at: last?.arrive_at ?? null,
    journey,
    return_journey: o.return_journey ?? null,
    place: o.place ?? null,
    image_url: o.image_url ?? null,
    details: [{ label: 'Paid', value: 'Demo payment' }],
    passengers: journey ? s.for_person_ids.map((person_id) => ({ person_id, pnr: ref })) : null,
  };
}
