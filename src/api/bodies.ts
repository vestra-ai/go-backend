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
// Labelled photos of a place (rev 4, GO-CHANGES 6.2): up to 12, each a link and what it shows ("Deluxe room", "Pool").
const photos = {
  type: 'array',
  maxItems: 12,
  items: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: uri, label: { type: 'string', minLength: 1, maxLength: 40 } } },
} as const;
const stop = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, code: { type: 'string', maxLength: 8 } },
} as const;

const journey = {
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
} as const;

// Booking limits are the contract's (Booking, Journey, Place) and the 1.1 overlay's (BookingDetail, Passenger; GO-CHANGES 1.7);
// `kind` is its BookingKind enumeration. A repeat is covered by the Idempotency-Key header (no press key in the body).
const addBooking = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'title', 'vendor', 'ref', 'amount_minor', 'payer_person_id', 'for_person_ids'],
  properties: {
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
    journey,
    return_journey: journey,
    details: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'value'],
        properties: { label: { type: 'string', minLength: 1, maxLength: 40 }, value: { type: 'string', minLength: 1, maxLength: 120 } },
      },
    },
    passengers: {
      type: 'array',
      maxItems: 30,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['person_id'],
        properties: { person_id: id, seat: { type: 'string', maxLength: 8 }, pnr: { type: 'string', maxLength: 20 } },
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
        photos,
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

// POST …/bookings/:id/cancel-vote takes no fields (a repeat is covered by the Idempotency-Key header); the body is still strict.
const cancelVote = {
  type: 'object',
  additionalProperties: false,
  properties: {},
} as const;

// The account profile (PATCH /me). The photo is a `profile_photo` upload of the person's (app contract §4.1: `photo_upload_id`,
// resolved to a stored link) or a plain https link; never both (checked in the domain). `from_city` is the default
// "travelling from" the app offers in new trips. The UPI id has its own routes
// (PUT/DELETE /me/upi).
const patchMe = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    photo_upload_id: id,
    photo_url: { type: ['string', 'null'], format: 'uri', pattern: '^https://' },
    from_city: { type: ['string', 'null'], minLength: 1, maxLength: 60 },
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
// text answers clear with null. `vibe` becomes one "Vibe: …" entry of `know`.
const patchTripMe = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from_city: { type: ['string', 'null'], maxLength: 60 },
    earliest_leave: { type: ['string', 'null'], maxLength: 60 },
    know: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 80 } },
    vibe: { type: 'string', enum: ['beach', 'hills', 'city', 'any'] },
  },
} as const;

// POST /invites/:code/accept: the same answers, wrapped as the contract has them.
const acceptInvite = {
  type: 'object',
  additionalProperties: false,
  properties: { join_answers: patchTripMe },
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
        photos,
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
    // The group's budget: one amount per person, the same for everyone, in the trip's currency. null clears it (the one field here that can be cleared).
    budget_per_person_minor: { type: ['integer', 'null'], minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  },
} as const;

// "Pause Go in this trip" (PATCH /trips/:trip/me): while paused the person's messages reach Go with no words.
const pauseGo = {
  type: 'object',
  additionalProperties: false,
  required: ['go_paused'],
  properties: { go_paused: { type: 'boolean' } },
} as const;

// A message from a person (app contract §4.6). `client_message_id` is the message's own repeat key. Each attachment is
// `{ upload_id, caption? }` or a contract Attachment; both are checked in the domain (see PASSTHROUGH). Limits are the
// contract's Message limits: 4,000 characters, 10 attachments, 30 mentions.
const postMessage = {
  type: 'object',
  additionalProperties: false,
  required: ['client_message_id'],
  properties: {
    client_message_id: id,
    text: { type: 'string', minLength: 1, maxLength: 4000 },
    attachments: { type: 'array', maxItems: 10, items: { type: 'object' } },
    reply_to: id,
    about_message_id: id,
    mentions: { type: 'array', maxItems: 30, items: id },
  },
} as const;

// A new text for your own message (PATCH /trips/:trip/messages/:id): the contract's 4,000 characters.
const editMessage = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: { text: { type: 'string', minLength: 1, maxLength: 4000 } },
} as const;

// Your one reaction on a message: an emoji (the contract's 16-character limit), or null to take it back.
const putReaction = {
  type: 'object',
  additionalProperties: false,
  required: ['emoji'],
  properties: { emoji: { type: ['string', 'null'], minLength: 1, maxLength: 16 } },
} as const;

// A press on a Go card (app contract §4.7). `action_id` and `option_id` are the contract's; `payload` is GO-CHANGES 1.2 (one way or round trip).
const cardAction = {
  type: 'object',
  additionalProperties: false,
  required: ['action_id'],
  properties: {
    action_id: { type: 'string', maxLength: 32, pattern: '^[a-z][a-z_]{0,31}$' },
    option_id: id,
    press_id: id,
    payload: { type: 'object', additionalProperties: false, properties: { trip: { type: 'string', enum: ['oneway', 'round'] } } },
  },
} as const;

// A vote: for an option, or "I'm flexible" (one or the other: checked in the route).
const castVote = {
  type: 'object',
  additionalProperties: false,
  properties: {
    option_index: { type: 'integer', minimum: 0, maximum: 9 },
    flexible: { type: 'boolean', enum: [true] },
  },
} as const;

// A file the app is about to upload (app contract §4.5). The MIME allow-list and the 25 MB ceiling are checked in the route;
// the dimensions and the voice note's length may be null (the contract's example sends `"duration_s": null`).
const upload = {
  type: 'object',
  additionalProperties: false,
  required: ['purpose', 'kind', 'mime', 'size_bytes'],
  properties: {
    purpose: { type: 'string', enum: ['chat_attachment', 'profile_photo'] },
    kind: { type: 'string', enum: ['photo', 'file', 'audio'] },
    mime: { type: 'string', minLength: 1, maxLength: 100 },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    size_bytes: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    width: { type: ['integer', 'null'], minimum: 1, maximum: 100000 },
    height: { type: ['integer', 'null'], minimum: 1, maximum: 100000 },
    duration_s: { type: ['number', 'null'], minimum: 0, maximum: 86400 },
  },
} as const;

// A ticket for the live socket (app contract §3): the device id lets a second connect from the same device replace the first.
const liveTicket = {
  type: 'object',
  additionalProperties: false,
  properties: { device_id: id },
} as const;

// ---- §4.13 and the vault: two small bodies that go to Go as they are.
// "Remember me in future trips" (PATCH /me/go).
const carryOver = {
  type: 'object',
  additionalProperties: false,
  required: ['carry_over'],
  properties: { carry_over: { type: 'boolean' } },
} as const;

// The vault link (POST /me/vault-link): where the page opens, and for `add_documents` which trip's visa it is for (GO-CHANGES 2.2).
const vaultLink = {
  type: 'object',
  additionalProperties: false,
  properties: {
    start: { type: 'string', enum: ['home', 'add_card', 'add_login', 'add_documents'] },
    // 1.3 (rev 5 R8): where the app opens the page. `embedded` is inside the app, and only for the vault's home.
    display: { type: 'string', enum: ['sheet', 'embedded'] },
    context: {
      type: 'object',
      additionalProperties: false,
      required: ['trip_id', 'purpose'],
      properties: { trip_id: id, purpose: { type: 'string', enum: ['visa'] } },
    },
  },
} as const;

// ---- §4.9 money. Amounts are whole minor units above zero; the category and the lengths are the contract's Expense.
const amount = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const;
const people = { type: 'array', minItems: 1, maxItems: 30, items: id } as const;

// A person adds an expense by hand ("Add a payment"); the payer is the caller when not named.
const addExpense = {
  type: 'object',
  additionalProperties: false,
  required: ['amount_minor', 'note', 'category', 'split_person_ids'],
  properties: {
    paid_by_person_id: id,
    amount_minor: amount,
    note: { type: 'string', minLength: 1, maxLength: 120 },
    category: { type: 'string', enum: ['stay', 'food', 'getting_around', 'activities', 'other'] },
    split_person_ids: people,
    booking_id: id,
  },
} as const;

// "Fix split" (PATCH …/expenses/:id).
const patchExpense = {
  type: 'object',
  additionalProperties: false,
  required: ['split_person_ids'],
  properties: { split_person_ids: people, note: { type: 'string', minLength: 1, maxLength: 120 } },
} as const;

// "Record a payment" (POST …/settlements). The method is the app contract's Settlement.method; the note the contract's 120.
const recordSettlement = {
  type: 'object',
  additionalProperties: false,
  required: ['to_person_id', 'amount_minor', 'currency', 'method'],
  properties: {
    to_person_id: id,
    amount_minor: amount,
    currency: { type: 'string', maxLength: 3, pattern: '^[A-Z]{3}$' },
    method: { type: 'string', enum: ['upi', 'cash', 'bank_transfer', 'other'] },
    note: { type: 'string', minLength: 1, maxLength: 120 },
  },
} as const;

// The settle_up card's UPI button (POST …/transfers/pay-link).
const payLink = {
  type: 'object',
  additionalProperties: false,
  required: ['to_person_id', 'amount_minor'],
  properties: { to_person_id: id, amount_minor: amount },
} as const;

// The check-in sheets (app contract §4.12): DigiYatra, the declaration, a seat from the seat map, the mobile the airline texts.
const patchCheckin = {
  type: 'object',
  additionalProperties: false,
  properties: {
    digi_yatra: { type: 'boolean' },
    declaration: { type: 'boolean' },
    seat: { type: 'string', minLength: 2, maxLength: 8, pattern: '^[0-9]{1,3}[A-Z]{1,2}$' },
    mobile: { type: 'string', minLength: 5, maxLength: 20, pattern: '^\\+?[0-9 ]{5,20}$' },
  },
} as const;

/** Every route's body definition, by name. */
export const bodies = { openVote, addBooking, updateBooking, cancelVote, patchMe, putUpi, deleteMe, patchTripMe, acceptInvite, patchTrip, pauseGo, createTrip, readTrip, postMessage, editMessage, putReaction, cardAction, castVote, upload, liveTicket, carryOver, vaultLink, addExpense, patchExpense, recordSettlement, payLink, patchCheckin } as const;

/** Nodes the walk in tests/bodies.test.ts does not enter: they are checked against the contract's own definitions elsewhere. */
export const PASSTHROUGH: readonly string[] = ['patchTrip.itinerary[]', 'postMessage.attachments[]'];

/** The only places `null` is a valid value ("clear this field", or "not known"): `<definition>.<dotted path>`. */
export const CLEARABLE: readonly string[] = [
  'updateBooking.refundable_until', 'updateBooking.starts_at', 'updateBooking.ends_at', 'patchMe.photo_url', 'patchMe.from_city',
  'patchTripMe.from_city', 'patchTripMe.earliest_leave', 'acceptInvite.join_answers.from_city', 'acceptInvite.join_answers.earliest_leave', 'patchTrip.budget_per_person_minor',
  'putReaction.emoji', 'upload.width', 'upload.height', 'upload.duration_s',
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
  return_journey?: Record<string, unknown>;
  details?: Array<{ label: string; value: string }>;
  passengers?: Array<{ person_id: string; seat?: string; pnr?: string }>;
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
  photo_upload_id?: string;
  photo_url?: string | null;
  from_city?: string | null;
}

export interface PutUpiBody {
  upi_id: string;
}

export interface DeleteMeBody {
  confirm: true;
}

export type Vibe = 'beach' | 'hills' | 'city' | 'any';

export interface PatchTripMeBody {
  from_city?: string | null;
  earliest_leave?: string | null;
  know?: string[];
  vibe?: Vibe;
}

export interface AcceptInviteBody {
  join_answers?: PatchTripMeBody;
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
  budget_per_person_minor?: number | null;
}

export interface PauseGoBody {
  go_paused: boolean;
}

export interface AddExpenseBody {
  paid_by_person_id?: string;
  amount_minor: number;
  note: string;
  category: 'stay' | 'food' | 'getting_around' | 'activities' | 'other';
  split_person_ids: string[];
  booking_id?: string;
}

export interface PatchExpenseBody {
  split_person_ids: string[];
  note?: string;
}

export interface RecordSettlementBody {
  to_person_id: string;
  amount_minor: number;
  currency: string;
  method: 'upi' | 'cash' | 'bank_transfer' | 'other';
  note?: string;
}

export interface PayLinkBody {
  to_person_id: string;
  amount_minor: number;
}

export interface PatchCheckinBody {
  digi_yatra?: boolean;
  declaration?: boolean;
  seat?: string;
  mobile?: string;
}

export type CancelVoteBody = Record<string, never>;

export interface PostMessageBody {
  client_message_id: string;
  text?: string;
  attachments?: unknown[];
  reply_to?: string;
  about_message_id?: string;
  mentions?: string[];
}

export interface EditMessageBody {
  text: string;
}

export interface PutReactionBody {
  emoji: string | null;
}

export interface CardActionBody {
  action_id: string;
  option_id?: string;
  press_id?: string;
  payload?: { trip?: 'oneway' | 'round' };
}

export interface CastVoteBody {
  option_index?: number;
  flexible?: true;
}

export interface UploadBody {
  purpose: 'chat_attachment' | 'profile_photo';
  kind: 'photo' | 'file' | 'audio';
  mime: string;
  name?: string;
  size_bytes: number;
  width?: number | null;
  height?: number | null;
  duration_s?: number | null;
}

export interface LiveTicketBody {
  device_id?: string;
}

export interface CarryOverBody {
  carry_over: boolean;
}

export interface VaultLinkBody {
  start?: 'home' | 'add_card' | 'add_login' | 'add_documents';
  display?: 'sheet' | 'embedded';
  context?: { trip_id: string; purpose: 'visa' };
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
export const checkCreateTrip = bodyChecker<CreateTripBody>(bodies.createTrip);
export const checkReadTrip = bodyChecker<ReadTripBody>(bodies.readTrip);
export const checkPatchTrip = bodyChecker<PatchTripBody>(bodies.patchTrip);
export const checkPauseGo = bodyChecker<PauseGoBody>(bodies.pauseGo);
export const checkPostMessage = bodyChecker<PostMessageBody>(bodies.postMessage);
export const checkEditMessage = bodyChecker<EditMessageBody>(bodies.editMessage);
export const checkPutReaction = bodyChecker<PutReactionBody>(bodies.putReaction);
export const checkCardAction = bodyChecker<CardActionBody>(bodies.cardAction);
export const checkCastVote = bodyChecker<CastVoteBody>(bodies.castVote);
export const checkUpload = bodyChecker<UploadBody>(bodies.upload);
export const checkLiveTicket = bodyChecker<LiveTicketBody>(bodies.liveTicket);
export const checkCarryOver = bodyChecker<CarryOverBody>(bodies.carryOver);
export const checkVaultLink = bodyChecker<VaultLinkBody>(bodies.vaultLink);
export const checkAddExpense = bodyChecker<AddExpenseBody>(bodies.addExpense);
export const checkPatchExpense = bodyChecker<PatchExpenseBody>(bodies.patchExpense);
export const checkRecordSettlement = bodyChecker<RecordSettlementBody>(bodies.recordSettlement);
export const checkPayLink = bodyChecker<PayLinkBody>(bodies.payLink);
export const checkPatchCheckin = bodyChecker<PatchCheckinBody>(bodies.patchCheckin);
