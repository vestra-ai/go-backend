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
  required: ['question', 'kind', 'anonymous', 'options'],
  properties: {
    client_id: id, // the press's own key; optional when an Idempotency-Key header is sent (checked in the route)
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
  required: ['kind', 'title', 'vendor', 'ref', 'amount_minor', 'payer_person_id', 'for_person_ids'],
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

const cancelVote = {
  type: 'object',
  additionalProperties: false,
  properties: { client_id: id },
} as const;

// The account profile (PATCH /me). A photo link must be an https URL (photo_upload_id comes with uploads, phase 2).
// `from_city` is the default "travelling from" the app offers in new trips; `notifications_enabled` is the pushes switch.
// The UPI id has its own routes (PUT/DELETE /me/upi).
const patchMe = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    photo_url: { type: ['string', 'null'], format: 'uri', pattern: '^https://' },
    from_city: { type: ['string', 'null'], minLength: 1, maxLength: 60 },
    notifications_enabled: { type: 'boolean' },
  },
} as const;

// PUT /me/upi: the contract's own format rule for a UPI id (`^[\w.\-]{2,256}@[a-zA-Z]{2,64}$`). The value never appears in an answer.
const putUpi = {
  type: 'object',
  additionalProperties: false,
  required: ['upi_id'],
  properties: { upi_id: { type: 'string', minLength: 5, maxLength: 321, pattern: '^[\\w.\\-]{2,256}@[a-zA-Z]{2,64}$' } },
} as const;

// DELETE /me: the person must say so in the body.
const deleteMe = {
  type: 'object',
  additionalProperties: false,
  required: ['confirm'],
  properties: { confirm: { type: 'boolean', enum: [true] } },
} as const;

// A person's answers in one trip (the contract's JoinAnswers). `know` replaces the list (an empty list clears it); the two
// text answers clear with null. `vibe` becomes one "Vibe: …" entry of `know`; `spend_band` becomes the private budget answer.
const patchTripMe = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from_city: { type: ['string', 'null'], maxLength: 60 },
    earliest_leave: { type: ['string', 'null'], maxLength: 60 },
    know: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 80 } },
    vibe: { type: 'string', enum: ['beach', 'hills', 'city', 'any'] },
    spend_band: { type: 'string', enum: ['lt15', '15to25', 'gt25'] },
  },
} as const;

// POST /invites/:code/accept: the same answers, wrapped as the contract has them.
const acceptInvite = {
  type: 'object',
  additionalProperties: false,
  properties: { join_answers: patchTripMe },
} as const;

// The whole budget answer, replaced each time (DELETE …/me/budget withdraws it). `max_minor: null` means no upper limit; `currency`,
// when sent, must be the trip's.
const putBudget = {
  type: 'object',
  additionalProperties: false,
  required: ['min_minor'],
  properties: {
    min_minor: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    max_minor: { type: ['integer', 'null'], minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    currency: { type: 'string', maxLength: 3, pattern: '^[A-Z]{3}$' },
  },
} as const;

// POST /trips: everything optional (the app may create with only a name, or an idea tapped). `destination_hint` becomes the
// title when there is no title; `from_city` is saved as the organizer's own join answer. The richer fields are ours:
// `destination` is a contract Place, `vibe` the trip-level list only Go otherwise writes, `plan_minor` the group's plan.
const createTrip = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 80 },
    destination_hint: { type: 'string', minLength: 1, maxLength: 80 },
    dates: {
      type: 'object',
      additionalProperties: false,
      required: ['start', 'end'],
      properties: { start: { type: 'string', format: 'date' }, end: { type: 'string', format: 'date' } },
    },
    from_city: { type: 'string', minLength: 1, maxLength: 60 },
    destination: {
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
    vibe: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 40 } },
    stay: { type: 'string', minLength: 1, maxLength: 80 },
    plan_minor: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    currency: { type: 'string', maxLength: 3, pattern: '^[A-Z]{3}$' },
  },
} as const;

// POST /trips/:trip/read: up to a change number, or up to a message (its change number).
const readTrip = {
  type: 'object',
  additionalProperties: false,
  properties: {
    up_to_seq: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    message_id: id,
  },
} as const;

// A trip's details and status, edited by any member. Nothing is clearable. The itinerary replaces the whole itinerary (at most
// 30 days). Its days are checked against the contract's own Day and item definitions in the domain code and stored exactly as sent,
// including fields the server does not know, so its items are free-form here (see PASSTHROUGH).
const patchTrip = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 80 },
    dates: {
      type: 'object',
      additionalProperties: false,
      required: ['start', 'end'],
      properties: { start: { type: 'string', format: 'date' }, end: { type: 'string', format: 'date' } },
    },
    itinerary: { type: 'array', maxItems: 30, items: { type: 'object' } },
    status: { type: 'string', enum: ['planning', 'booked', 'on_trip', 'over'] },
  },
} as const;

// A reminder to the person who owes the caller (POST /trips/:trip/transfers/nudge).
const nudge = {
  type: 'object',
  additionalProperties: false,
  required: ['from_person_id'],
  properties: { from_person_id: id },
} as const;

// A device for pushes (POST /me/devices): v1 accepts Web Push only (the product is the PWA). `web_push` is a browser's push address
// and its two keys. The address must be an https address on a known push service (checked in the route); 2048 characters is a
// technical bound (the address is an index key and a database index entry cannot be much larger; real addresses are a few hundred).
// The keys are 256 characters at most (owner decision 6): real ones are far shorter.
const addDevice = {
  type: 'object',
  additionalProperties: false,
  required: ['platform', 'web_push'],
  properties: {
    platform: { type: 'string', enum: ['web_push'] },
    web_push: {
      type: 'object',
      additionalProperties: false,
      required: ['endpoint', 'keys'],
      properties: {
        endpoint: { type: 'string', format: 'uri', maxLength: 2048 },
        keys: {
          type: 'object',
          additionalProperties: false,
          required: ['p256dh', 'auth'],
          properties: { p256dh: { type: 'string', minLength: 1, maxLength: 256 }, auth: { type: 'string', minLength: 1, maxLength: 256 } },
        },
      },
    },
    locale: { type: 'string', maxLength: 35 },
    tz: { type: 'string', maxLength: 64 },
  },
} as const;

/** Every route's body definition, by name. */
export const bodies = { openVote, addBooking, updateBooking, cancelVote, patchMe, putUpi, deleteMe, patchTripMe, acceptInvite, putBudget, patchTrip, nudge, addDevice, createTrip, readTrip } as const;

/** Nodes the walk in tests/bodies.test.ts does not enter: they are checked against the contract's own definitions elsewhere. */
export const PASSTHROUGH: readonly string[] = ['patchTrip.itinerary[]'];

/** The only places `null` is a valid value ("clear this field"): `<definition>.<dotted path>`. */
export const CLEARABLE: readonly string[] = [
  'updateBooking.refundable_until', 'updateBooking.starts_at', 'updateBooking.ends_at', 'patchMe.photo_url', 'patchMe.from_city',
  'patchTripMe.from_city', 'patchTripMe.earliest_leave', 'acceptInvite.join_answers.from_city', 'acceptInvite.join_answers.earliest_leave', 'putBudget.max_minor',
];

export interface OpenVoteBody {
  client_id?: string;
  question: string;
  kind: 'choice' | 'yesno';
  anonymous: boolean;
  options: Array<{ label: string; image_url?: string; price_minor?: number; note?: string }>;
  closes_at?: string;
}

export interface AddBookingBody {
  client_id?: string;
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

export interface PatchMeBody {
  name?: string;
  photo_url?: string | null;
  from_city?: string | null;
  notifications_enabled?: boolean;
}

export interface PutUpiBody {
  upi_id: string;
}

export interface DeleteMeBody {
  confirm: true;
}

export type Vibe = 'beach' | 'hills' | 'city' | 'any';
export type SpendBand = 'lt15' | '15to25' | 'gt25';

export interface PatchTripMeBody {
  from_city?: string | null;
  earliest_leave?: string | null;
  know?: string[];
  vibe?: Vibe;
  spend_band?: SpendBand;
}

export interface AcceptInviteBody {
  join_answers?: PatchTripMeBody;
}

export interface PutBudgetBody {
  min_minor: number;
  max_minor?: number | null;
  currency?: string;
}

export interface CreateTripBody {
  title?: string;
  destination_hint?: string;
  dates?: { start: string; end: string };
  from_city?: string;
  destination?: { name: string; place_id?: string; address?: string; lat?: number; lng?: number; photo_url?: string };
  vibe?: string[];
  stay?: string;
  plan_minor?: number;
  currency?: string;
}

export interface ReadTripBody {
  up_to_seq?: number;
  message_id?: string;
}

export interface PatchTripBody {
  title?: string;
  dates?: { start: string; end: string };
  itinerary?: Array<Record<string, unknown>>;
  status?: 'planning' | 'booked' | 'on_trip' | 'over';
}

export interface NudgeBody {
  from_person_id: string;
}

export interface AddDeviceBody {
  platform: 'web_push';
  web_push: { endpoint: string; keys: { p256dh: string; auth: string } };
  locale?: string;
  tz?: string;
}

export interface CancelVoteBody {
  client_id?: string;
}

export const checkOpenVote = bodyChecker<OpenVoteBody>(bodies.openVote);
export const checkAddBooking = bodyChecker<AddBookingBody>(bodies.addBooking);
export const checkUpdateBooking = bodyChecker<UpdateBookingBody>(bodies.updateBooking);
export const checkCancelVote = bodyChecker<CancelVoteBody>(bodies.cancelVote);
export const checkPatchMe = bodyChecker<PatchMeBody>(bodies.patchMe);
export const checkPutUpi = bodyChecker<PutUpiBody>(bodies.putUpi);
export const checkDeleteMe = bodyChecker<DeleteMeBody>(bodies.deleteMe);
export const checkPatchTripMe = bodyChecker<PatchTripMeBody>(bodies.patchTripMe);
export const checkAcceptInvite = bodyChecker<AcceptInviteBody>(bodies.acceptInvite);
export const checkPutBudget = bodyChecker<PutBudgetBody>(bodies.putBudget);
export const checkCreateTrip = bodyChecker<CreateTripBody>(bodies.createTrip);
export const checkReadTrip = bodyChecker<ReadTripBody>(bodies.readTrip);
export const checkPatchTrip = bodyChecker<PatchTripBody>(bodies.patchTrip);
export const checkNudge = bodyChecker<NudgeBody>(bodies.nudge);
export const checkAddDevice = bodyChecker<AddDeviceBody>(bodies.addDevice);
