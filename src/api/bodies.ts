// The body of every route this feature adds, one definition per route (JSON Schema 2020-12). Each route owns
// its definition: limits, formats and enumerations come from the design or the contract (contract/go.json),
// never invented here, and the contract's request schemas are not reused because they are for Go's requests.
// Rules for every definition (tests/bodies.test.ts walks them): each object sets `additionalProperties: false`;
// `null` appears only at the paths named in CLEARABLE; every string has a `maxLength`, an `enum` or a `format`;
// every array has a `maxItems`.
import { bodyChecker } from './input.js';

const id = { type: 'string', minLength: 1, maxLength: 64 } as const;

const openVote = {
  type: 'object',
  additionalProperties: false,
  required: ['client_id', 'question', 'kind', 'anonymous', 'options'],
  properties: {
    client_id: id,
    question: { type: 'string', minLength: 1, maxLength: 200 },
    kind: { type: 'string', enum: ['choice', 'yesno'] },
    anonymous: { type: 'boolean' },
    options: {
      type: 'array',
      minItems: 2,
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label'],
        properties: {
          label: { type: 'string', minLength: 1, maxLength: 120 },
          image_url: { type: 'string', format: 'uri' },
          price_minor: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          note: { type: 'string', maxLength: 120 },
        },
      },
    },
    closes_at: { type: 'string', format: 'date-time' },
  },
} as const;

const dateTime = { type: 'string', format: 'date-time' } as const;
const uri = { type: 'string', format: 'uri' } as const;
const stop = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, code: { type: 'string', maxLength: 8 } },
} as const;

// Booking limits are the contract's (Booking, Journey, Place); `kind` is its BookingKind enumeration.
const addBooking = {
  type: 'object',
  additionalProperties: false,
  required: ['client_id', 'kind', 'title', 'vendor', 'ref', 'amount_minor', 'payer_person_id', 'for_person_ids'],
  properties: {
    client_id: id,
    kind: { type: 'string', enum: ['stay', 'flight', 'train', 'bus', 'cab', 'table', 'activity', 'other'] },
    title: { type: 'string', minLength: 1, maxLength: 120 },
    vendor: { type: 'string', minLength: 1, maxLength: 80 },
    ref: { type: 'string', minLength: 1, maxLength: 80 },
    amount_minor: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    payer_person_id: id,
    for_person_ids: { type: 'array', minItems: 1, maxItems: 30, items: id },
    refundable_until: dateTime,
    starts_at: dateTime,
    ends_at: dateTime,
    journey: {
      type: 'object',
      additionalProperties: false,
      required: ['mode', 'origin', 'destination', 'depart_at', 'arrive_at'],
      properties: {
        mode: { type: 'string', enum: ['flight', 'train', 'bus', 'cab'] },
        origin: stop,
        destination: stop,
        depart_at: dateTime,
        arrive_at: dateTime,
        carrier_name: { type: 'string', maxLength: 60 },
        carrier_code: { type: 'string', maxLength: 8 },
        number: { type: 'string', maxLength: 20 },
        logo_url: uri,
        stops: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      },
    },
    place: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        place_id: { type: 'string', maxLength: 256 },
        address: { type: 'string', maxLength: 200 },
        lat: { type: 'number', minimum: -90, maximum: 90 },
        lng: { type: 'number', minimum: -180, maximum: 180 },
        photo_url: uri,
      },
    },
    image_url: uri,
    decision_id: id,
  },
} as const;

const updateBooking = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ref: { type: 'string', minLength: 1, maxLength: 80 },
    refundable_until: { type: ['string', 'null'], format: 'date-time' },
    starts_at: { type: ['string', 'null'], format: 'date-time' },
    ends_at: { type: ['string', 'null'], format: 'date-time' },
  },
} as const;

/** Every route's body definition, by name. */
export const bodies = { openVote, addBooking, updateBooking } as const;

/** The only places `null` is a valid value ("clear this field"): `<definition>.<dotted path>`. */
export const CLEARABLE: readonly string[] = ['updateBooking.refundable_until', 'updateBooking.starts_at', 'updateBooking.ends_at'];

export interface OpenVoteBody {
  client_id: string;
  question: string;
  kind: 'choice' | 'yesno';
  anonymous: boolean;
  options: Array<{ label: string; image_url?: string; price_minor?: number; note?: string }>;
  closes_at?: string;
}

export interface AddBookingBody {
  client_id: string;
  kind: string;
  title: string;
  vendor: string;
  ref: string;
  amount_minor: number;
  payer_person_id: string;
  for_person_ids: string[];
  refundable_until?: string;
  starts_at?: string;
  ends_at?: string;
  journey?: Record<string, unknown>;
  place?: Record<string, unknown>;
  image_url?: string;
  decision_id?: string;
}

export interface UpdateBookingBody {
  ref?: string;
  refundable_until?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
}

export const checkOpenVote = bodyChecker<OpenVoteBody>(bodies.openVote);
export const checkAddBooking = bodyChecker<AddBookingBody>(bodies.addBooking);
export const checkUpdateBooking = bodyChecker<UpdateBookingBody>(bodies.updateBooking);
