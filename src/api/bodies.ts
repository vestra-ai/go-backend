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

// The account profile. `upi_id` has a length limit only (no format rule): 1-100. A photo link must be an http(s) URL.
// `from_city` is the default "travelling from" the app offers in new trips; `notifications_enabled` is the pushes switch.
const patchMe = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    photo_url: { type: ['string', 'null'], format: 'uri', pattern: '^https?://' },
    upi_id: { type: ['string', 'null'], minLength: 1, maxLength: 100 },
    from_city: { type: ['string', 'null'], minLength: 1, maxLength: 60 },
    notifications_enabled: { type: 'boolean' },
  },
} as const;

// A person's answers in one trip. `know` replaces the list (an empty list clears it); the two text answers clear with null.
const patchTripMe = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from_city: { type: ['string', 'null'], maxLength: 60 },
    earliest_leave: { type: ['string', 'null'], maxLength: 60 },
    know: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 80 } },
  },
} as const;

// The whole budget answer, replaced each time. It cannot be withdrawn, so nothing here is clearable.
const putBudget = {
  type: 'object',
  additionalProperties: false,
  required: ['min_minor'],
  properties: {
    min_minor: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    max_minor: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
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

/** Every route's body definition, by name. */
export const bodies = { openVote, addBooking, updateBooking, cancelVote, patchMe, patchTripMe, putBudget, patchTrip, nudge, addDevice, postMessage, putReaction, cardAction, castVote, upload, liveTicket } as const;

/** Nodes the walk in tests/bodies.test.ts does not enter: they are checked against the contract's own definitions elsewhere. */
export const PASSTHROUGH: readonly string[] = ['patchTrip.itinerary[]', 'postMessage.attachments[]'];

/** The only places `null` is a valid value ("clear this field", or "not known"): `<definition>.<dotted path>`. */
export const CLEARABLE: readonly string[] = [
  'updateBooking.refundable_until', 'updateBooking.starts_at', 'updateBooking.ends_at', 'patchMe.photo_url', 'patchMe.upi_id', 'patchMe.from_city', 'patchTripMe.from_city', 'patchTripMe.earliest_leave',
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
  upi_id?: string | null;
  from_city?: string | null;
  notifications_enabled?: boolean;
}

export interface PatchTripMeBody {
  from_city?: string | null;
  earliest_leave?: string | null;
  know?: string[];
}

export interface PutBudgetBody {
  min_minor: number;
  max_minor?: number;
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

export interface PostMessageBody {
  client_message_id: string;
  text?: string;
  attachments?: unknown[];
  reply_to?: string;
  about_message_id?: string;
  mentions?: string[];
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

export const checkOpenVote = bodyChecker<OpenVoteBody>(bodies.openVote);
export const checkAddBooking = bodyChecker<AddBookingBody>(bodies.addBooking);
export const checkUpdateBooking = bodyChecker<UpdateBookingBody>(bodies.updateBooking);
export const checkCancelVote = bodyChecker<CancelVoteBody>(bodies.cancelVote);
export const checkPatchMe = bodyChecker<PatchMeBody>(bodies.patchMe);
export const checkPatchTripMe = bodyChecker<PatchTripMeBody>(bodies.patchTripMe);
export const checkPutBudget = bodyChecker<PutBudgetBody>(bodies.putBudget);
export const checkPatchTrip = bodyChecker<PatchTripBody>(bodies.patchTrip);
export const checkNudge = bodyChecker<NudgeBody>(bodies.nudge);
export const checkAddDevice = bodyChecker<AddDeviceBody>(bodies.addDevice);
export const checkPostMessage = bodyChecker<PostMessageBody>(bodies.postMessage);
export const checkPutReaction = bodyChecker<PutReactionBody>(bodies.putReaction);
export const checkCardAction = bodyChecker<CardActionBody>(bodies.cardAction);
export const checkCastVote = bodyChecker<CastVoteBody>(bodies.castVote);
export const checkUpload = bodyChecker<UploadBody>(bodies.upload);
export const checkLiveTicket = bodyChecker<LiveTicketBody>(bodies.liveTicket);
