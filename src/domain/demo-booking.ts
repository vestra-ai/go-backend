// The demo's booking (docs/GO-TEAM-DEMO-PAYMENT.md): what the Server writes as booked when a payment is taken as done.
// This is the one place the fake booking and ticket module plugs in: `demoBookingFor` gets everything the Server knows
// about what was paid for and answers the booking's fields. What it answers is stored as it is and reaches the app as an
// ordinary Booking (journey, details, passengers, ticket files and all), so a richer fake ticket needs no change anywhere
// else. docs/DEMO-BOOKING-MODULE.md is the brief for that module.
import { randomBytes } from 'node:crypto';
import type { JourneyLike, Passenger } from './mappers.js';

/** An option as Go's options card (or the vote) showed it, as far as a booking needs it. */
export interface DemoOption {
  title?: string; label?: string; image_url?: string | null; refundable_until?: string | null; place?: unknown;
  journey?: JourneyLike | null; return_journey?: JourneyLike | null;
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
}

export interface DemoBookingFields {
  kind: string; title: string; vendor: string; ref: string;
  refundable_until?: string | null; starts_at?: string | null; ends_at?: string | null;
  journey?: JourneyLike | null; return_journey?: JourneyLike | null; place?: unknown; image_url?: string | null;
  details?: unknown[] | null; passengers?: Passenger[] | null;
  /** Ticket files (a PDF or a picture, at most 25 MB each), by link: the Server copies each into its own storage after the payment is saved. */
  documents?: DemoDocument[] | null;
}

export interface DemoDocument { name: string; mime: string; url: string; pages?: number; visibility: 'covered' | 'group' }

const BOOKING_KINDS = new Set(['stay', 'flight', 'train', 'bus', 'cab', 'activity']);

/** A reference that reads like a PNR and says what it is: `DEMO-4K7Q2M`. */
export const demoRef = () => `DEMO-${randomBytes(4).toString('hex').slice(0, 6).toUpperCase()}`;

/** The demo booking for a payment taken as done. The fake booking and ticket module replaces the body of this. */
export function demoBookingFor(s: DemoBookingSource): DemoBookingFields | Promise<DemoBookingFields> {
  const o = s.option ?? {};
  const ref = demoRef();
  const journey = o.journey ?? null;
  const last = o.return_journey ?? journey;
  return {
    kind: s.option_kind && BOOKING_KINDS.has(s.option_kind) ? s.option_kind : journey?.mode ?? 'other',
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
