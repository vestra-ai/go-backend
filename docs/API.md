# Go: App ↔ Server API (contract rev 4, as the Server runs it)

**For:** the App team (Saket) and anyone building against the Server. **Date:** 10 Oct 2026.

This is the one contract the app builds against. It describes **exactly what the deployed Server does today**, and is
written from the code (`src/api/v1/*.ts`, `src/api/bodies.ts`, `src/domain/*`). Appendix C lists the same routes as the
code's route metadata, which a test counts (70).

**What changed from rev 3** (agreed by the App and Server teams on 10 Oct 2026; this revision removes routes and fields,
so it is not additive):

- **No private budgets.** One optional budget per person for the whole group, on the trip (§4.4).
- **No expense approval, no disputes, no payback confirmation.** An expense counts when it is added and a payback when
  it is recorded. Only the person who added an expense may fix or remove it (§4.9).
- **No push notifications and no Nudge.** Money movements show as lines in the room (§4.6) and `GET /home` lists what
  you owe (§4.2).
- **The starting city is visible to the group** (§1.7).
- **An invite link joins directly:** no "Not now" or "Decline" (§4.3).
- **New shapes from Go pass through:** labelled photos, a stay's price range and room types, the `rooms` card (§9).

Only the endpoints the app consumes are here. Dev sign-in and operator tools are in the [README](../README.md).

Object shapes the app reuses unchanged from the Server ↔ Go contract (`Message`, `Card`, `Person`, `Decision`,
`Booking`, `Expense`, `Money`, `RecordLine`, `Day`, `Place`, `Journey`, `TripSnapshot`, `CatchUp`, `PersonPage`, ...)
are defined at https://vestrago.vercel.app/llms-full.txt (1.0.0) plus the 1.1 additions in `contract/extensions-1.1.json`.
§2 lists the Server-only shapes and the fields added on top.

```
 App (PWA)  ──HTTP + one WebSocket──►  Server  ──signed WebSocket (llms-full.txt)──►  Go
 this page                             its database                                   Keshav's team
```

---

## Contents

- [Try it](#try-it)
- [1. Conventions](#1-conventions)
- [2. Object shapes](#2-object-shapes)
- [3. The live connection (WebSocket)](#3-the-live-connection-websocket)
- [4. Endpoints](#4-endpoints): [4.1 Me](#41-sign-in-session-and-me) · [4.2 Home](#42-home) · [4.3 Invites](#43-invites) · [4.4 Trips](#44-trips-create-read-my-answers) · [4.5 Uploads](#45-uploads) · [4.6 The room](#46-the-room) · [4.7 Go's cards](#47-gos-cards) · [4.8 Votes, mandate, record](#48-votes-the-mandate-and-the-trip-record) · [4.9 Money](#49-money) · [4.10 Bookings, documents, itinerary](#410-bookings-documents-and-the-itinerary) · [4.11 Trip home](#411-trip-home-needs-you-gos-cards) · [4.12 Web check-in](#412-web-check-in) · [4.13 You screen](#413-the-you-screen) · [4.14 Places, config, health](#414-places-config-and-health)
- [5. Screen by screen](#5-screen-by-screen)
- [6. Cards](#6-cards)
- [7. What the Server does for Go on every app action](#7-what-the-server-does-for-go-on-every-app-action)
- [8. No push notifications](#8-no-push-notifications)
- [9. Additions from Go, and the feature flags](#9-additions-from-go-and-the-feature-flags)
- [10. Internal routes (App team testing and support)](#10-internal-routes-app-team-testing-and-support)
- [Appendix A: limits and rate limits](#appendix-a-limits-and-rate-limits) · [Appendix B: timeouts](#appendix-b-timeouts-when-the-server-waits-on-go) · [Appendix C: endpoint index](#appendix-c-endpoint-index)

---

## Try it

**Locally, with nothing to set up.** `pnpm dev:stack` starts a temporary Postgres, a fake Go, a fake Supabase Auth
and the real Server:

| | |
|---|---|
| App API | `http://localhost:8080/app/v1` |
| A sign-in token | `curl 'http://127.0.0.1:54331/mint?name=Priya&email=priya@gmail.com'` gives a Supabase-style access token; send it as `Authorization: Bearer …`. The person is created on the first call. |
| Act as Go | `http://localhost:8090/sim`: `POST /sim/<method>` with Go's params (`open_vote`, `set_mandate`, `post_message`, ...); `GET /sim/state` shows what the fake Go has received. |
| The fake Go | answers every message that names it (`@Go …`): typing, a ✅, then a reply with one of its cards |

```bash
TOKEN=$(curl -s 'http://127.0.0.1:54331/mint?name=Priya' | jq -r .access_token)
curl -s localhost:8080/app/v1/me -H "authorization: Bearer $TOKEN"
curl -s localhost:8080/app/v1/trips -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -H "idempotency-key: $(uuidgen)" -d '{"title":"Goa 🌴","dates":{"start":"2026-11-06","end":"2026-11-09"}}'
```

**Against the deployed Server** (`https://server-production-2202go.up.railway.app/app/v1`), until Google sign-in is
on: `pnpm supabase:token --me https://server-production-2202go.up.railway.app` prints a real Supabase access token for a
test user (from `SUPABASE_TEST_EMAIL` / `SUPABASE_TEST_PASSWORD` in your `.env`) and calls `GET /app/v1/me` with it.
Send the token as `Authorization: Bearer …`. These are real Supabase tokens, the same kind Google sign-in gives.

§3 has a `wscat` example for the WebSocket.

---

## 1. Conventions

### 1.1 Base URL, versions, transport, CORS

| | |
|---|---|
| Base | `https://server-production-2202go.up.railway.app/app/v1` (production); `http://localhost:8080/app/v1` with the dev stack |
| Live connection | `wss://<same host>/app/v1/live?ticket=…` (§3) |
| Format | JSON, UTF-8, `Content-Type: application/json`. Uploads go straight to Supabase Storage (§4.5), never through the Server. |
| Versioning | Additive only inside `v1`. Clients ignore unknown fields, frame types and card kinds. |
| CORS | Exactly the origins in the Server's `APP_ORIGINS` (no wildcard). Allowed request headers: `Authorization`, `Content-Type`, `Idempotency-Key`. Methods: GET, POST, PUT, PATCH, DELETE. Headers the browser may read: `Retry-After`, `X-Request-Id`, `Idempotent-Replayed`. **No credentials mode** (there is no cookie) and no `X-Go-Client`. Every response carries `Vary: Origin`; a listed origin gets the access headers on every answer, errors included. A preflight is answered before sign-in and may be cached 10 minutes. The WebSocket is not a browser fetch: no CORS there. |

### 1.2 Authentication

**Sign-in is Supabase Auth. The Server issues no tokens and has no `/auth/*` routes.**

- The PWA signs in with `supabase-js` (`signInWithOAuth({ provider: "google" })`, PKCE). Supabase returns a session with
  an access token (a JWT, about 1 hour) and a refresh token; `supabase-js` refreshes it on its own. Where the refresh
  token lives in the browser is the app's choice (`@supabase/ssr` keeps it in a cookie).
- Every request carries `Authorization: Bearer <session.access_token>`. The Server checks the signature against the
  project's published keys, the issuer, the `authenticated` audience and role, and the expiry (30 s leeway). The
  anon/publishable key, anonymous users and tokens of another project are refused.
- **First sign-in creates the person** from the Supabase claims: name from Google (else the start of the email),
  photo if it is an `https` link, email kept on the Server only, `auth_provider` as Supabase reports it (`google`,
  or `email` for a test user). The person is keyed by the Supabase user id, never the email. Two first calls at the
  same moment make one person. `is_new` is not returned: compare `Me.created_at` with now.
- `401 unauthorized` → `supabase.auth.refreshSession()` once and retry; still 401 → sign in again. The message says
  which it was: `sign in first`, `the sign-in has expired: refresh it and try again`, `the sign-in token is not valid`.
- Sign-out: `supabase.auth.signOut()`. The Server keeps nothing per device.
- After `DELETE /me` the account's tokens are refused with 401 on every instance.
- Public (no sign-in): `GET /invites/:code` (a valid token, when sent, personalises `state`), `GET /config`, `GET /health`.
- **Membership: `403 forbidden` for both a non-member and an unknown trip.** Every `/trips/:trip/...` route checks the
  signed-in person is in that trip **now** (someone who left is not). A trip id that does not exist answers the same
  403, so ids cannot be probed. Sign-in, then membership, are checked before the query string and the body, so a
  stranger learns nothing about a route's rules (a bad `?limit=` from a non-member is 403, not 422).

### 1.3 Ids, money, time, JSON rules

- Ids are opaque strings of 1 to 64 characters. Never parse them.
- **Money is a whole number in the currency's minor unit**, field names end in `_minor`: ₹54,200 is
  `{ "amount_minor": 5420000, "currency": "INR" }`. Never a float. A trip has one currency (default `INR`).
- Times are ISO 8601 with an offset (`2026-11-06T18:10:00Z`); a time with no `Z` or offset is `422`. Dates are
  `YYYY-MM-DD`, a real calendar date from year 1. An itinerary time of day is `HH:MM`.
- Field names are `snake_case`. **In answers, null and missing mean the same thing**; the Server leaves null members out (except `Me`, whose empty members are `null`).
- **Bodies are strict.** Every write body is checked against its definition (`src/api/bodies.ts`): an unknown field, a
  value of the wrong type (`"5"` is not `5`), a missing required field, a string over its limit, an enum value that is
  not listed, all answer `422 invalid` with `field`. `null` is accepted only where this page says a field clears
  (`PATCH /me` `photo_url`/`from_city`, join answers `from_city`/`earliest_leave`, `PATCH /trips/:trip` `budget_per_person_minor`,
  booking `refundable_until`/`starts_at`/`ends_at`, reaction `emoji`, upload `width`/`height`/`duration_s`). Nothing
  is converted or dropped silently, on any route.
- Also refused with 422, on every route: a NUL character or an unpaired surrogate anywhere in a body, a `__proto__` key,
  nesting deeper than 32 levels. A body over Fastify's 1 MiB limit is `413 invalid`. JSON that cannot be read at all is
  `400 bad_request`. A POST that needs no body may be sent with none (or with `{}`).

### 1.4 Doing things once (idempotency)

| Mechanism | Used for | What the Server does |
|---|---|---|
| `Idempotency-Key: <uuid>` header (1 to 128 characters) | Every `POST`, `PUT`, `PATCH`, `DELETE` under `/app/v1` by a signed-in person | Stores the key with the answer for **24 hours**, scoped to `(person_id, method, path **including the query string**, key)`. A repeat with the same body returns the **first answer, same status and body**, marked `Idempotent-Replayed: true`. A repeat with a **different body** is `422 invalid`, message `idempotency_key_reused`, `field: "Idempotency-Key"`. Every status is stored, errors included, so a retry of a refused write is refused the same way. Two copies that race past the lookup may both run; the domain keys below still keep a double press to one write. |
| `client_message_id` (body) | Sending a message (§4.6) | Unique per `(trip, person, client_message_id)`: a repeat returns the same stored `Message`. The "sending" bubble. |
| `press_id` (body) | Tapping a Go card button (§4.7) | Becomes Go's `tap_id` (tied to the person): a double tap is one tap. |
| `client_id` (body, optional) | `POST /trips/:trip/decisions` | The press key the route accepts instead of the header. One of the two is required (`422`, `field: "client_id"`). |

Send an `Idempotency-Key` on every write. `POST /trips/:trip/bookings` and `POST …/bookings/:id/cancel-vote` have no
body key at all: without the header a retry creates a second one.

### 1.5 Errors

Every non-2xx answer has this body, and every answer (2xx too) carries `X-Request-Id`:

```json
{ "error": { "code": "conflict", "message": "decision d_01JA is closed", "field": null, "retry_after_seconds": null, "request_id": "a1b2c3d4e5f6" } }
```

| HTTP | `error.code` | When | Client retries? |
|---|---|---|---|
| 400 | `bad_request` | JSON that cannot be parsed, or a broken address (a stray `%`) | No |
| 401 | `unauthorized` | Missing, expired or invalid token; a deleted account's token | Refresh once, then sign in again |
| 403 | `forbidden` | Not in this trip or no such trip; not the author, the person responsible for an expense, the payer of a mandate, the organizer, the opener, or a covered person | No |
| 404 | `not_found` | Message, vote, line, expense, booking, document, card, fact, invite code not found; a route that does not exist; a check-in route while `features.checkin` is off | No |
| 409 | `conflict` | Clashes with current state: vote closed, message deleted, already cancelled, no mandate yet, a rotated invite link, a feature flag that is off (vote retract, flexible, calls) | No: re-read and decide again |
| 413 | `invalid` | Body over 1 MiB | No |
| 422 | `invalid` | A body or query rule (`field` names it when known), a rule about the trip (not in the trip, not an option, wrong currency, a seat not on the map...), `idempotency_key_reused`, `add_documents` while `features.visa` is off | No |
| 426 | `upgrade_required` | A plain GET on `/live` (it is a WebSocket) | No |
| 429 | `rate_limited` | Messages (30/min), reactions (20/min), card taps (10/min), votes (20/min), uploads (20/min), vault links (6/min), city search (5/s), invite preview (30/min/IP), Go busy (Appendix A). `retry_after_seconds` and the `Retry-After` header say how long | Yes, after that wait |
| 500 | `internal` | Server bug: quote the `request_id` | Yes, with backoff |
| 502 / 503 / 504 | `go_unavailable` | Something that needs Go did not get an answer (504 timeout, 503 Go refused, 502 Go's answer was wrong or Go left facts behind). A person is waiting: show the message, let them tap again. **Do not auto-retry** | Not automatically |
| 503 | `unavailable` | A call recording could not be fetched (`POST …/cards/:id/share`) | Later |

`message` is plain words safe to show; it names the field and the rule, never the value.

### 1.6 Pagination, caching, consistency

- Two paging styles: **opaque cursors** for the Transactions page (`?limit=&before=<cursor>` → `next_cursor`), and
  **change numbers** for messages (`before_seq` to scroll back, `after_seq` to catch up; §4.6).
- **`seq` is the trip's change number.** Every read of trip data (`TripView`, messages page, record, money, expenses,
  bookings, itinerary, needs-you) is built in one repeatable-read transaction and returns the `seq` it matches.
- `GET /trips/:trip` answers `ETag: "<seq>"`; send `If-None-Match` and get `304` when nothing moved.
- Cache headers: `Me`, home, invite preview, money, transactions and the ticket redirect are `private, no-store`; the
  trip is `private, no-cache`; ideas and the city search are `private, max-age=86400`; top cities `max-age=604800`.

### 1.7 Privacy rules the Server enforces on every app answer

- **No phone numbers, emails or UPI ids of other people.** `Person.has_upi` is a boolean. `Me` carries the caller's own
  email and a **masked** UPI id (`aar••••@okhdfc`); the full id never leaves the Server (except inside a `upi://pay`
  link the caller asks for, §4.9).
- **Travelling from is shared with the group.** Every member's `Person.from_city` and `earliest_leave` are returned to
  every member of the trip. The profile's default city in `Me` is the caller's own.
- **Per-person booking data.** `Booking.passengers[]` and `Booking.documents[]` are returned only to the people in
  `for_person_ids`; everyone else sees the booking without those two keys. A ticket file opens only for a covered
  person (or anyone in the trip when the document is `visibility: "group"`).
- **An anonymous vote has no `votes` list**, only `voted`, `of`, `tally` (and `flexible_count`). The caller gets their own `my_vote`.
- **When a person pauses Go, the room still sees their messages in full.** `withheld` is always `false` for the app.
- **A private itinerary item** (`audience: "private"`) is returned only to the people in its `person_ids`.
- **A message only some people can see.** When Go posts with `visible_to_person_ids`, only those people ever receive the
  message: not in a messages page (either mode), not in a single-message answer, not in a live `message` or `card` frame
  or the replay, not in `GET …/cards`, "needs you", the chat preview, unread counts or catch-up. To anyone else it does
  not exist: reacting to it, replying to it, "Ask Go about this", editing or deleting it, `POST …/read` with its id and
  a tap on its card answer as for an unknown message or card (`404`, or `422` where the route says so for an unknown id).
- **Passport and ID data never pass through the Server** (the visa form is Go's vault page, §4.1 vault link).
- System messages (`author.kind = "system"`) are not counted as unread. The money lines among them name amounts (§4.6):
  money in a trip is the whole group's business.
- **Nothing is sent to a phone.** The Server has no push notifications and stores no device or browser subscription.

---

## 2. Object shapes

Contract objects are unchanged. These are the Server-only shapes and the fields added on top of contract objects
(TypeScript for brevity; `snake_case` on the wire; a `?` field is left out when it has no value).

```ts
type Id = string; type Iso = string; type Currency = string;

// ---- who I am (§4.1) --------------------------------------------------------
interface Me {
  person_id: Id; name: string; email: string | null; photo_url: string | null;
  auth_provider: "google" | "email" | string | null;   // as Supabase reports it; "dev" with dev sign-in
  from_city: string | null;                            // profile default; per-trip answers live on Person.from_city
  has_upi: boolean; upi_id_masked: string | null;      // "aar••••@okhdfc"; Me keeps its empty members as null
  counts: { active_trips: number; past_trips: number };
  created_at: Iso;
  seq?: number | null;                                 // on PATCH /me and PUT/DELETE /me/upi only: the last change number written, null when nothing was sent to Go
}

// ---- home (§4.2) ------------------------------------------------------------
interface PersonLite { person_id: Id; name: string; photo_url?: string }
interface TripSummary {
  trip_id: Id; title: string; status: "planning" | "booked" | "on_trip" | "over";   // title: the automatic name (§4.4)
  stage: "new" | "deciding" | "planned";               // §4.4
  destination?: Place; dates?: { start: string; end: string };
  photo_url?: string;                                  // the destination's cover photo: `destination.photo_url`, else the first of `destination.photos` (§9)
  budget_per_person_minor?: number;                    // the group's one budget per person, when set (§4.4)
  people_preview: PersonLite[];                        // up to 4, organizer first, then joining order
  people_count: number;
  attention: { kind: "needs_you"; count: number } | { kind: "all_set" } | { kind: "collecting" } | { kind: "task"; label: string };
  last_activity_at: Iso;                               // the trip's last change, or its creation
}
/** One debt of mine on the home screen (§4.2): whom I owe, how much, in which trip. `to` is the stored person, even when they have left the trip. */
interface Owed { trip_id: Id; trip_title: string; to: PersonLite; amount_minor: number; currency: Currency }
interface PastTripSummary { trip_id: Id; title: string; photo_url?: string; dates?: { start: string; end: string }; people_count: number; all_settled: boolean }
/** One open item of mine on the home screen (§4.2): the trip's NeedsYouItem (§4.11), and which trip. `trip_title` is the automatic name (§4.4). */
type HomeNeedsYouItem = NeedsYouItem & { trip_id: Id; trip_title: string };
interface Idea { idea_id: string; name: string; tag: string; travel: { mode: "flight" | "car" | "train" | "bus"; duration_minutes: number }; image_url?: string; photos?: { url: string; label?: string }[]; best_months?: number[]; destination_hint: string }

// ---- one trip (§4.4) --------------------------------------------------------
interface TripView extends TripSnapshot {               // the contract's TripSnapshot as the app may see it (§1.7 applied)
  stage: "new" | "deciding" | "planned";
  me: { person: Person; last_read_seq: number; unread_count: number };
  // `budget` (from TripSnapshot) keeps the Go contract's shape; the app reads only `budget.per_person_minor` (absent when no budget is set)
  chat: { unread_count: number;                         // the same number as me.unread_count
          last_message?: { message_id: Id; author: Actor; text_preview: string; sent_at: Iso };   // preview ≤ 80 chars; system pills excluded; author.former as on a Message (§4.6)
          participants_preview: Array<{ kind: "go" } | { kind: "person"; person_id: Id }> };      // up to 4: Go first if it ever posted, then people by latest message
  needs_you_count: number;
  can: { invite: boolean; manage_trip: boolean };       // invite is always true; manage_trip = organizer
}
// Decision, in app reads only: a vote about cancelling a booking carries `cancels_booking_id` (never sent to Go);
// `flexible_count?` (1.1) when anyone voted "I'm flexible"; the single-vote routes add `my_vote`:
type DecisionForMe = Decision & { cancels_booking_id?: Id; flexible_count?: number; my_vote: { option_index: number } | { flexible: true } | null };

// ---- needs you (§4.11) ------------------------------------------------------
interface NeedsYouItem {
  item_id: string;    // stable per thing: vote:<decision>:<me> · mandate:<decision> · card:<card> · record_line:<line> · settle:<payee> · checkin:<booking>
  kind: "vote" | "mandate" | "card" | "record_line" | "settle_up" | "checkin";
  title: string; subtitle?: string; cta_label?: string; since: Iso;
  target: { message_id?: Id; card_id?: string; decision_id?: Id; line_id?: Id; booking_id?: Id;
            transfer?: { to_person_id: Id; amount_minor: number; currency: Currency }; cancels_booking_id?: Id };
}

// ---- money (§4.9) -----------------------------------------------------------
interface Transaction {
  transaction_id: Id; kind: "booking" | "payback";     // booking = an Expense (its id), payback = a Settlement (its id)
  occurred_at: Iso; payer_person_id: Id; verb: "paid" | "booked_with";   // booked_with when the expense names a booking
  to: { kind: "person"; person_id: Id } | { kind: "merchant"; name: string };   // merchant = the booking's vendor, else the note
  amount_minor: number; currency: Currency;
  method?: "upi" | "cash" | "card" | "bank_transfer" | "other";   // card only on an expense of a vault-paid booking; a payback carries its settlement's method
  note?: string; mine: boolean;                         // I am the payer, in the split, or the payee
  expense_id?: Id; booking_id?: Id; settlement_id?: Id;
}
interface Settlement {
  settlement_id: Id; from_person_id: Id; to_person_id: Id; amount_minor: number; currency: Currency;
  method: "upi" | "cash" | "bank_transfer" | "other"; note?: string; created_at: Iso;
}                                                       // no standing: a recorded payment counts at once and for good
interface MoneyView extends Money {                     // contract Money: currency, plan_minor?, spent_minor, by_category, transfers
  me: { spent_minor: number;                            // my share of the expenses, by each one's equal split
        by_category: Array<{ category: "stay" | "food" | "getting_around" | "activities" | "other"; amount_minor: number }>;
        owed_to_me: Transfer[]; i_owe: Transfer[] };    // my lines of the fewest-payments list
  seq: number;
}
// Expense is the contract's Expense, unchanged: no standing and no confirmations. Every expense that exists counts.

// ---- bookings (§4.10) -------------------------------------------------------
// Booking (contract) gains details?, return_journey?, passengers? (1.1) and, in app reads, documents?:
type BookingForApp = Booking & {
  details?: Array<{ label: string; value: string }>; return_journey?: Journey;
  passengers?: Array<{ person_id: Id; seat?: string; pnr?: string }>;           // covered people only
  documents?: Array<{ document_id: Id; name: string; mime: string; size_bytes: number; pages?: number; visibility: "covered" | "group"; url?: string }>;   // covered people only; url: a signed link valid 1 hour, fresh on every read (§4.10)
  added_by_person_id?: Id;
};
// Message (contract) gains quick_replies? ([{ label, text? }], Go's chips) and, on an upload-backed attachment, upload_id; a voice note is a file attachment with duration_s.
// In app reads a Message also has (§4.6):
//   visible_to_person_ids?: Id[]      // only these people can see it (you are always one of them): show "Only you can see this" / "Only you and Rahul". Absent = everyone
//   author: { kind: "person"; person_id: Id; former?: true }   // former: the author left the trip or deleted their account: draw "Former member", neutral avatar
//   reactions: Array<{ emoji: string; person_id?: Id; former?: true }>   // the same mark on a reaction by such a person
// A money line (a system message, §4.6) also carries, in app reads only:
//   ledger: { kind: "expense_added" | "expense_changed" | "expense_removed" | "payback"; expense_id?: Id; settlement_id?: Id }

// ---- web check-in (§4.12) ---------------------------------------------------
interface CheckinState {
  status: "not_open" | "open" | "working" | "done" | "failed" | "closed";
  opens_at?: Iso; closes_at?: Iso;
  flight?: { number?: string; carrier_name?: string; logo_url?: string; date?: string; origin?: { name: string; code: string; time: string }; destination?: { name: string; code: string; time: string } };
  passenger?: { name?: string; mobile_masked?: string; bags?: string };
  digi_yatra?: boolean; declaration?: boolean; seat?: string;
  companion?: { person_id: Id; seat?: string; next_to_seats?: string[] };     // the friend on the same booking (filled by the Server unless Go named one)
  seat_map?: { front_label?: string; columns?: string[]; aisle_after?: string; rows?: number[]; seats?: Array<{ id: string; row?: number; col?: string; state: "free" | "paid" | "taken" | "companion"; price_minor?: number; currency?: Currency }> };
  boarding_pass: Record<string, unknown> | null;        // null until done
  payment_required?: true; seat_price?: { amount_minor: number; currency: Currency };   // on PATCH only, for a paid seat
}
```

---

## 3. The live connection (WebSocket)

One WebSocket per signed-in app instance, carrying every trip the person has open plus the home screen.

**Ticket.** Browsers cannot set `Authorization` on a WebSocket, so first `POST /live/ticket` (bearer; body
`{ "device_id"?: string }`, strict) → `201 { "ticket": "tk_…", "expires_at" }`. The ticket is **single use and valid
30 seconds**. Then connect to `wss://…/app/v1/live?ticket=<ticket>`. A used, unknown or expired ticket completes the
handshake and then closes the socket with code **4401**.

**One socket per (person, device).** `device_id` is yours (keep it per browser profile); a second connect with the same
`device_id` closes the first with code **4000**. Without a `device_id` every connect is a new device. A socket that
misses two pongs is closed with **4002**.

### 3.1 Frames

Every frame is a JSON object with a `type`. Unknown types, and frames that are not JSON, are ignored both ways.

**Server → app**

| `type` | When | Body |
|---|---|---|
| `hello` | right after connect | `{ "type":"hello", "person_id", "server_time", "heartbeat_seconds": 25 }` |
| `message` | a message is new or changed (edit, delete, a reaction added or taken back, Go's reactions too) | `{ "type":"message", "trip_id", "message": Message }`: the **whole** message as it is now, card included. Upsert by `message_id`, place by `seq`. A message with `visible_to_person_ids` (and its `card` frames) goes only to those people. |
| `card` | Go replaced one of its cards in place (`replace_card`: a call moved on, a pay card became paid, people dropped from `for_person_ids`) | `{ "type":"card", "trip_id", "message_id", "card": Card }`. No `seq` in the frame, but the **message's `updated_seq` moves** (D9), so `GET …/messages?after_seq=` returns the replaced card after a long time offline. A `message` frame with the message at its new `updated_seq` follows. |
| `typing` | Go or a person started or stopped typing | `{ "type":"typing", "trip_id", "who": {"kind":"go"} \| {"kind":"person","person_id"}, "on": boolean, "until"?: Iso }`. Go's runs out 10 s after the Server heard it, a person's 6 s; `on: false` hides it at once. Not sent back to the one typing. |
| `trip_changed` | any change that is **not a message**: a vote cast or closed, mandate, record line, booking, expense, settlement, someone joined or left, itinerary, the group budget, trip details | `{ "type":"trip_changed", "trip_id", "seq", "kinds"?: ["decision","record"] }`. When `seq` is higher than the app holds, re-read what is showing. `kinds` (a hint, not always present) is one or more of `trip`, `people`, `decision`, `mandate`, `record`, `booking`, `expense`, `settlement`, `itinerary`, `budget`. |
| `home_changed` | my home screen's data moved: a trip created, joined, reset or renamed (title, destination, dates, status), someone left, or **my open items** changed: a vote opened, cast by me, closed or cancelled; a mandate set for me or answered; a Go card naming me posted or replaced; a record line naming me; money that changes what anyone owes | `{ "type":"home_changed" }`. Re-read `GET /home`. Still re-read home on resume. |
| `resync` | the Server cannot replay what the client missed | `{ "type":"resync", "trip_id" }`. Re-read the room from scratch (§3.3). |
| `error` | a `subscribe` was refused | `{ "type":"error", "trip_id", "code": "forbidden" \| "too_many_trips" }` |
| `ping` | every 25 s | `{ "type":"ping" }`. Answer `pong`. |

**App → server**

| `type` | Body | Notes |
|---|---|---|
| `subscribe` | `{ "type":"subscribe", "trips": [ { "trip_id", "since_seq": number } ] }` | When a trip's room or Trip screens open, and on every reconnect. `since_seq` is the highest `seq`/`updated_seq` the app holds for the trip (0 for none). **Replay rule:** the Server sends the messages changed after `since_seq` as `message` frames (oldest change first, up to **200** and under 900 KB), then **one** `trip_changed` with the trip's current `seq` when it moved. More than that is a `resync`. A trip the person is not in answers `error forbidden`; a 51st trip `error too_many_trips`. |
| `unsubscribe` | `{ "type":"unsubscribe", "trip_ids": [ … ] }` | When the person leaves a trip's screens. |
| `typing` | `{ "type":"typing", "trip_id", "on": boolean }` | Only for a trip this socket subscribed. At most one `on` per 2 s per trip (extra ones are dropped); `off` always goes through. Fanned out to the other subscribers; **never forwarded to Go**. |
| `pong` | `{ "type":"pong" }` | |

Inbound frames over 64 KB close the socket. Writes (sending a message, voting) are HTTP requests, not frames.

### 3.2 Ordering and what the app keeps

- Per trip, keep **the highest `seq` seen** (a message's `updated_seq` or a `trip_changed` `seq`).
- Frames are sent **after the change is committed**, from the same hook that writes Go's outbox row, so the app and Go
  are in step. Per trip, frames arrive in change-number order: a money action, a join, a leave, a vote closing, a poll
  opening or a booking sends `trip_changed` (its change number N) and then the `message` frame of its line in the room
  (N+1); a `message` frame is never sent ahead of an earlier `trip_changed`. Typing, `card` and `home_changed` carry no `seq` and are never replayed.
- Show your own message at once as "sending" (by `client_message_id`), then replace it with the stored `Message`
  from the `POST` answer or the `message` frame, whichever lands first.

### 3.3 Reconnect

1. Reconnect after 1, 2, 5, 10 s, then every 30 s (back to 1 s after a connect that works); at once on
   `visibilitychange → visible`. Each connect needs a fresh ticket.
2. On connect, `subscribe` every open trip with its stored `since_seq`.
3. On `resync`, or when the first `seq` jumps by more than one, read `GET /trips/:trip` and
   `GET /trips/:trip/messages?after_seq=…` again before trusting the socket. A message you cannot see
   (`visible_to_person_ids`, §4.6) still takes a change number, so you will see gaps in `seq`: harmless, the re-read finds nothing missing.
4. Correctness never depends on the socket: a pull-to-refresh or a resume re-reads the same endpoints.

### 3.4 Limits

One socket per (person, device); at most 50 subscribed trips per socket; a replay never exceeds 200 messages or
900 KB; inbound frames at most 64 KB; heartbeat 25 s, closed after 2 missed pongs.

### 3.5 Try it with wscat

```bash
TOKEN=$(curl -s 'http://127.0.0.1:54331/mint?name=Priya' | jq -r .access_token)
TICKET=$(curl -s localhost:8080/app/v1/live/ticket -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"device_id":"dev_laptop"}' | jq -r .ticket)
npx wscat -c "ws://localhost:8080/app/v1/live?ticket=$TICKET"
# > {"type":"subscribe","trips":[{"trip_id":"t_…","since_seq":0}]}
# < {"type":"message", …}  {"type":"trip_changed","trip_id":"t_…","seq":7}
# > {"type":"typing","trip_id":"t_…","on":true}
# > {"type":"pong"}        (after each ping)
```

---

## 4. Endpoints

All paths are under `/app/v1`. `:trip` is a `trip_id`. Unless stated, every route needs a signed-in member of the trip
(§1.2) and every write takes an `Idempotency-Key` (§1.4). "Go hears" names the event Go receives through the outbox,
in the same transaction as the change; "live" names the frame the app receives after the commit (§3). Record-card
buttons (vote, mandate, record, expense, settle up) are the **Server's own** and never reach Go.

### 4.1 Sign-in, session and "Me"

There are no `/auth/*` routes (§1.2).

| Method & path | Request | Answer | Errors | Go hears |
|---|---|---|---|---|
| `GET /me` | — | `Me` (`no-store`) | | — |
| `PATCH /me` | any of `name` (1-80), `photo_upload_id` (a `profile_photo` upload of yours, §4.5: taken **once**, it becomes the stored `photo_url`, a long-lived signed link), `photo_url` (an `https://` link, or `null` to clear; not together with `photo_upload_id`), `from_city` (1-60, or `null`). Strict; at least one field (`422`). | `Me` plus `seq`: the last change number written, or `null` when nothing changed or Go was not told | 422 (`photo_upload_id` when the upload is not yours, not a profile photo, already used or expired) | `person.updated` in **every active trip** the person is in, `changed` among `name`, `photo_url`. A new default city tells Go nothing. Live: `trip_changed` in each trip. |
| `PUT /me/upi` | `{ "upi_id": "name@bank" }`, matching `^[\w.\-]{2,256}@[a-zA-Z]{2,64}$` | `Me` (`has_upi: true`, `upi_id_masked`, `seq`) | 422 `upi_id` | `person.updated` `changed: ["has_upi"]` per active trip, **only when it flips** (replacing one id by another sends nothing) |
| `DELETE /me/upi` | — | `Me` (`has_upi: false`) | | `person.updated` `changed: ["has_upi"]` per active trip when it flips |
| `POST /me/vault-link` | `{ "start"?: "home" \| "add_card" \| "add_login" \| "add_documents", "display"?: "sheet" \| "embedded", "context"?: { "trip_id", "purpose": "visa" } }` (strict) | `{ "url", "expires_at" }` (Go's `Link`): open it **immediately**, never ahead of time. With no `display`, or `"sheet"`: in the system browser sheet, never a WebView. With `"display": "embedded"` (the vault's home only): in an `<iframe>` inside the app; Go's page allows framing only from the app's own origins and, when the person is done, posts `{ "type": "go-vault", "status": "saved" \| "cancelled" \| "failed" }` to `window.parent`: check `event.origin` is the link's origin, then close the frame. Adding a card or a login stays in the sheet. Links expire after 5 minutes. | 422 `display` when `embedded` is asked with a `start` other than `home` (Go is not asked); 422 `start` when `add_documents` and `features.visa` is off; 403 when `context.trip_id` is a trip you are not in; 502/503/504 `go_unavailable`; 429 above **6 a minute per person** (Go is not asked; a call refused with 422 or 403 above does not count), or Go busy | `vault_link { kind: "vault", person_id, start?, display?, context? }` (2 s) |
| `DELETE /me` | `{ "confirm": true }` (strict) | `202`, no body. In order: Go forgets the person everywhere (`forget_person`; **if Go does not answer, nothing else happens**: `502`), join answers cleared, the person leaves every trip (`person.left` each, with everything a leave does), their messages stay and read "Former member" with no photo, the room's pills that named them ("Priya joined", "Aarav paid Priya ₹5,800", in every trip they are or were in) are rewritten to "Former member" (each moves its `updated_seq`, so `?after_seq=` and a `message` frame bring it; no `edited_at`; not in a trip where someone else has the same name), email, phone, UPI id, default city go, live tickets are deleted, their tokens stop working | 502 `go_unavailable` | `forget_person`, `message.edited` per rewritten pill, then `person.left` per trip |

Rules: the signed-in `person_id` is the same person in every trip; `Me.counts` is computed (`active_trips` = trips I
am in that are not over, `past_trips` = over).

### 4.2 Home

`GET /home` → the whole screen in one read (`private, no-store`):

```json
{ "me": PersonLite, "trips": [TripSummary], "past_trips": [PastTripSummary], "owes": [Owed],
  "needs_you": { "items": [HomeNeedsYouItem], "total": 7 }, "seq_hint": 4812 }
```

- `trips`: trips I am in that are not `over`, latest activity first (the trip's last change, else its creation).
  Empty ⇒ the first-run state.
- `past_trips`: `status = "over"`; `all_settled` is true when `money.transfers` is empty.
- `owes`: **what I owe right now**: every transfer in which I am the one who pays, across all my trips, active ones
  first and then the ones that are over, each in the order above. `[]` when I owe nothing. What others owe me is not
  listed. `to` is the stored person even when they have left that trip. This is the home screen's "you owe Rahul ₹100";
  there is no Nudge and no notification.
- `stage` and `attention` are **computed by the Server**. `attention`, in this order: `task` when web check-in is open
  for my flight (`"Web check-in is open"`, `features.checkin`), else a `checklist` card row of mine still `todo`/`started`
  (`"<card title> needed"`, e.g. `"Indonesia e-VOA needed"`, `features.visa`); otherwise `needs_you` with the count when it is above zero,
  `all_set` for a `planned` trip, else `collecting`.
- `needs_you`: **every open item of mine** across my trips that are not `over`, one home card each: the same items as
  each trip's `GET /trips/:trip/needs-you` (§4.11), each with `trip_id` and `trip_title`. At most 50 are listed; `total`
  is the real count. Order: votes closing soonest first (a vote with no closing time after the timed ones), then
  mandates waiting on me, then Go's cards for me (only those with a button), then `settle_up`, then record lines by due date (undated last), then
  the rest (`checkin`); each group oldest `since` first. `{ "items": [], "total": 0 }` when there is nothing.
- **Tapping a home card opens the same action in a popup**, in its trip, from what the item's `target` carries:

  | `kind` | `target` | Load the popup with | Act with |
  |---|---|---|---|
  | `vote` | `decision_id`, `message_id` of the vote card (when there is one), `cancels_booking_id` | `GET /trips/:trip/decisions/:decision_id` (with `my_vote`) | `PUT /trips/:trip/decisions/:id/vote` |
  | `mandate` | `decision_id`, `card_id`, `message_id` of the mandate card | `GET /trips/:trip/decisions/:decision_id` (its `mandate`) | `POST /trips/:trip/decisions/:id/mandate/confirm` or `/decline` |
  | `card` | `card_id`, `message_id` | `GET /trips/:trip/cards` (no `kind`): the item whose `card.card_id` is `target.card_id`, its latest version | `POST /trips/:trip/cards/:card_id/actions` |
  | `settle_up` | `transfer { to_person_id, amount_minor, currency }` | nothing to load: the payee and the amount are in `target`, the name in the item's `title` | `POST /trips/:trip/settlements`, or `POST /trips/:trip/transfers/pay-link` |
  | `record_line` | `line_id` | `GET /trips/:trip/record`: the line with that `line_id` | — (Go or the people close it; `POST /trips/:trip/record/:line_id/undo`) |
  | `checkin` | `booking_id` | `GET /trips/:trip/bookings/:booking_id/checkin` | the check-in sheets (§4.12) |

  `message_id`, when present, also lets the app jump to the card in the room. An item can be gone by the time it is
  tapped (someone closed the vote): the popup's own read answers that, and home re-reads on `home_changed`.
- Titles (`TripSummary.title`, `PastTripSummary.title`, `Owed.trip_title`, `trip_title`) are the automatic name (§4.4).
- `seq_hint`: the highest `seq` among my trips. Nothing to act on.
- Live: `home_changed` ⇒ re-read (§3.1: it also fires when my open items change).

`GET /discover/ideas?from_city=<name ≤ 60>&limit=<1-20, default 8>` → `{ "items": [Idea], "from_city": string | null }`
(`private, max-age=86400`). A curated table on the Server: the rows for the city asked for (else my profile `from_city`,
else none), falling back to a general set when the city has none. Tapping an idea ⇒ `POST /trips` with its
`destination_hint`. **Photos (rev 5):** once Go has answered about a place, the idea carries `photos` (up to 12 of
`{ url, label? }`), `image_url` is the first of them unless the idea has a curated image, and `best_months` (1 to 12) and Go's `tag` and way there may
replace the curated ones. The Server asks Go about each idea at most once a day, in the background; nobody waits on
it. Until Go has answered, `photos` and `image_url` are absent: **keep the fallback illustration**.

### 4.3 Invites

**A link joins directly.** The app shows the public preview while the person signs in and calls `accept` as soon as they
are signed in. There is no "Not now", no "Decline" and no list of pending invites.

| Method & path | Request | Answer | Errors |
|---|---|---|---|
| `GET /invites/:code` **public** (a valid token personalises `state`) | — | `{ "code", "state": "pending" \| "already_member" \| "expired" \| "revoked", "trip": { "trip_id", "title", "destination"?, "dates"?, "photo_url"? }, "inviter": PersonLite, "people_preview": [PersonLite], "joined_count" }`. **Read-only**: it never changes anything. `revoked` = the organizer rotated the link; `expired` = the trip is over. A link in either state shows only the trip's name and picture: `people_preview: []`, `joined_count: 0`, no `dates`. `trip.title` is the automatic name (§4.4). | 404 bad code; 429 above 30/min per IP address |
| `POST /invites/:code/accept` | `{ "join_answers"?: JoinAnswers }` (§4.4; strict) | `200 { "trip_id", "seq", "landing": "chat" \| "trip_home" }`. `chat` when the room already has a message from Go or a person. Already a member: the trip's current `seq` and the landing, nothing else happens. Someone who left and comes back is a member again with the new answers. | 404 bad code; 409 rotated link or trip over; 422 |

Accepting: Go hears `person.joined` with the answers; the Server posts the system message "Priya joined"; everyone in
the trip receives `trip_changed kinds: ["people"]` and `home_changed`; open votes gain one in `of`. Codes are random URL-safe strings of 12 characters.

### 4.4 Trips: create, read, my answers

| Method & path | Who | Request | Answer | Errors | Go hears / live |
|---|---|---|---|---|---|
| `POST /trips` | anyone | **Everything optional** (strict): `title` (1-80), `destination_hint` (1-80; becomes the title when there is none, else "New trip", and the `destination` `{ name }` when none is sent, so a trip made from an Idea starts at stage `deciding`), `dates { start, end }` (`YYYY-MM-DD`, start ≤ end), `from_city` (1-60; saved as **your** join answer), `destination` (contract `Place`: `name` 1-120, `place_id` ≤ 256, `address` ≤ 200, `lat`, `lng`, `photo_url`, `photos` ≤ 12 × `{ url, label? 1-40 }`), `vibe` (≤ 10 strings ≤ 40), `stay` (≤ 80), `plan_minor` (≥ 0), `currency` (`^[A-Z]{3}$`, default `INR`) | `201 TripView` (`people` = you as organizer, `invite_url` set) | 422 | `trip.created` is change **1**; the system message "Trip created · Aarav joined" is change 2, so `TripView.seq` is 2. Live: `trip_changed kinds: ["trip","people"]`, `home_changed` |
| `GET /trips/:trip` | member | `?include=people,decisions,bookings,expenses,money,itinerary,record` keeps only those parts (the rest of the view always comes); `If-None-Match` | `TripView` (§2) with `ETag: "<seq>"`, `private, no-cache`; `304` when the ETag matches | 403; 422 `include` for an unknown part | — |
| `PATCH /trips/:trip` | **any member** | any of `title` (1-80), `dates { start, end }`, `status` (`planning` \| `booked` \| `on_trip` \| `over`, in any direction), `itinerary` (the **whole** itinerary: ≤ 30 days, each a contract `Day`, ≤ 262,144 bytes as JSON, item `booking_id`s must be this trip's; fields the Server does not know, including the 1.1 `person_ids`, `audience`, `Day.image_url`, are stored as sent), `budget_per_person_minor` (**the group's one budget**: a whole number ≥ 1 in the trip's currency, the same for everyone; `null` clears it, the only field here that can be cleared). Strict; at least one field | `{ "seq" }`, or `{ "seq": null }` when nothing differed (key order inside objects is ignored) | 422; a bad itinerary day names the exact field, e.g. `itinerary[0].items[0].category` | `trip.updated` by the person naming only the fields that differed (`budget` for the budget). Live: `trip_changed` |
| `GET /trips/:trip/invite` | member | — | `{ "invite_url", "code" }` (`invite_url` is `<PUBLIC_BASE_URL>/invite/<code>`) | | — |
| `POST /trips/:trip/invite/rotate` | **organizer** | — | `{ "invite_url", "code" }`. The old link answers `state: "revoked"` from now on and cannot be accepted | 403 | nothing (Go reads the link with the trip) |
| `GET /trips/:trip/me` | member | — | `{ "from_city", "earliest_leave", "know", "role", "go_paused" }`: your own answers in this trip | | — |
| `PUT /trips/:trip/me/join-answers` | member | `JoinAnswers` (below); strict; at least one field | your own `Person` (whole) plus `seq` (`null` when nothing changed) | 422 | `person.updated` with `changed` among `from_city`, `earliest_leave`, `know` (only what differs). Live: `trip_changed` |
| `PATCH /trips/:trip/me` | member | `{ "go_paused": boolean }` (required; strict) | your own `Person` (whole) plus `seq`. While paused your messages reach Go with no words; the room sees them in full | 422 | `person.updated` `changed: ["go_paused"]`. Live: `trip_changed kinds: ["people"]` |
| `POST /trips/:trip/leave` | member | — | `204` | 403 | `person.left`; the system message "Priya left"; an open vote that was waiting only for you closes. Live: `trip_changed kinds: ["people"]`, `home_changed`; your sockets get those and the "… left" line, then stop following the trip (subscribing again is `error forbidden`) |
| `POST /trips/:trip/read` | member | `{ "up_to_seq"?: number }` or `{ "message_id"?: Id }` (strict; both optional) | `204`. Marks the room read up to that change number (it never moves back, and never goes past the trip's latest change) and notes you opened the room now (catch-up uses it). An empty body only notes the visit | 422 `message_id` not in the trip | — |

**`JoinAnswers`** (strict): `from_city` (≤ 60, `null` clears), `earliest_leave` (≤ 60, `null` clears), `know` (≤ 20
strings of 1-80; replaces the list, `[]` clears), `vibe` (`beach` \| `hills` \| `city` \| `any`). `vibe` is stored as one
`know` entry `"Vibe: beach"` (replacing an earlier one): group- and Go-visible, not the trip-level `TripSnapshot.vibe`.
`spend_band` no longer exists (`422`).

**The group's budget.** Nobody is asked for a budget beforehand and nobody has a private one. The group agrees one
amount per person in the chat, and a trip carries it as `budget_per_person_minor`: any member sets or clears it with
`PATCH /trips/:trip`, and Go will set it from the chat once it supports that (§9). The app reads it as
`TripView.budget.per_person_minor` and `TripSummary.budget_per_person_minor` (both absent when no budget is set). The
other members of `TripView.budget` (`lowest`, `answered`, `of`) keep the Go contract's shape and mean nothing to the app.
Go's in-app link `go://trips/<trip>/sheet/budget` opens the group budget editor.

**The automatic name.** A trip whose stored `title` is still exactly `"New trip"` and which has a destination with a
name is shown as `"<destination.name> <year>"`, for example `"Hampi 2026"`: the year of `dates.start` when dates are
set, else the current year in India (Asia/Kolkata). It is worked out on every app read: `TripView.title`, the home
cards (`TripSummary.title`, `PastTripSummary.title`, `Owed.trip_title`, `needs_you[].trip_title`) and the invite
preview's `trip.title`. Nothing is stored and no event is sent; Go's `read_trip` and events keep `"New trip"`. A title a
person or Go set is shown as it is. When the destination or dates change, `trip_changed` (and `home_changed`) bring the
new name on the next read.

**`stage`** (on `TripSummary` and `TripView`, computed from the trip's own fields, never from record lines):
`new` = no destination **and** no dates; `planned` = destination **and** dates **and** at least one confirmed booking
(of any kind); otherwise `deciding`.

### 4.5 Uploads

`POST /uploads` → `201`. Storage is a private Supabase bucket; the file never passes through the Server.

```json
// request (strict)
{ "purpose": "chat_attachment" | "profile_photo", "kind": "photo" | "file" | "audio",
  "mime": "image/jpeg", "name": "ticket.pdf", "size_bytes": 482113, "width": 1280, "height": 960, "duration_s": null }
// answer
{ "upload_id": "up_01JA…", "upload_url": "https://<ref>.supabase.co/storage/v1/object/upload/sign/go-files/…?token=…",
  "headers": { "content-type": "image/jpeg", "x-upsert": "false" }, "expires_at": "…", "max_size_bytes": 26214400 }
```

1. `PUT` the bytes to `upload_url` with exactly the returned `headers`. The URL is good for 2 hours (`expires_at`).
2. Name the `upload_id` in a message (§4.6, `attachments: [{ "upload_id", "caption"? }]`), or, for a `profile_photo`,
   in `PATCH /me { "photo_upload_id" }` (§4.1). In a message the Server resolves it to a contract `PhotoAttachment`
   (`kind: "photo"`, `url`, `width`, `height`, `caption`) or `FileAttachment` (`kind: "file"`, `url`, `name`, `mime`,
   `size_bytes`, `duration_s` for a voice note), plus `upload_id`; as a profile photo it becomes `Me.photo_url`. An
   upload is used **once**, by the person who signed it, for the purpose it was signed for, within **24 hours** (`422`
   naming `attachments[i].upload_id` or `photo_upload_id` otherwise). Unused uploads are deleted after 24 hours.
   **20 uploads a minute per person** (`429`).
3. Rules: `kind: photo` takes `image/jpeg|png|webp|heic`; `file` takes `application/pdf` or an image; `audio` takes
   `audio/mp4|mpeg|webm|ogg`; at most **25 MB**; a `profile_photo` must be a `photo`. `name` ≤ 200, `mime` ≤ 100,
   `width`/`height` 1-100000 or null, `duration_s` 0-86400 or null. **No EXIF stripping and no virus scanning** in v1
   (files are only shared inside a trip).
4. **Every attachment and recording link in an answer is a signed link valid 1 hour, minted when the message is read**
   (an `<img>` cannot send `Authorization`). If an image fails to load after a long time on screen, re-read the message.
5. A voice note is `kind: "audio"` at upload, sent as a message with one attachment.

### 4.6 The room

| Method & path | Request | Answer | Errors | Go hears / live |
|---|---|---|---|---|
| `GET /trips/:trip/messages` | **History mode:** no cursor (the newest page) or `?before_seq=<n>`, `limit` 1-100 (default 50). **Changes mode:** `?after_seq=<n>`, `limit` 1-200 (default 200). Never both | `{ "messages": [Message], "has_more", "seq" }` (`seq` = the trip change number the page matches) | 422 `after_seq` when both cursors are sent; 422 `limit` | — |
| `POST /trips/:trip/messages` | below | `201 Message` (the stored message, signed links) | 422; 429 above 30/min (`retry_after_seconds: 10`) | `message.created` (`withheld: true` and no text when you paused Go). Live: `message` |
| `PATCH /trips/:trip/messages/:id` | `{ "text" }` (1-4000; strict) | `200 Message` (`edited_at` set) | 403 not yours; 404; 409 deleted | `message.edited`. Live: `message` |
| `DELETE /trips/:trip/messages/:id` | — | `200 Message` (`deleted: true`, no text, no attachments) | 403; 404; 409 already deleted | `message.deleted`. Live: `message` |
| `PUT /trips/:trip/messages/:id/reaction` | `{ "emoji": "🔥" \| null }` (1-16 chars; strict). **One reaction per person per message**: a new emoji replaces the old one, `null` takes it back. The same emoji again (or `null` with none) changes nothing | `200 Message` | 404; 409 deleted; 429 above **20 a minute per person per trip** | `reaction.removed` then `reaction.added` on a switch, each its own change; `updated_seq` is the last. Live: `message` |
| `GET /trips/:trip/catch-up` | `?force=1` to ask Go whatever the gap (testing) | `200 CatchUp` (Go's `summary`, `items`), or `204` when not away long enough, when Go did not answer within its time, or when Go had nothing to say (no summary and no items) | 502/503 `go_unavailable`; 429 | `catch_up { trip_id, person_id, since }` (3 s) where `since` = your last `POST …/read` (else your join). Asked when you were away **3 hours or more**, or have **15 or more** unread messages from others. Nothing is posted. |

**The two read modes**

| | History mode | Changes mode |
|---|---|---|
| Ask with | nothing (newest page), or `before_seq=<n>` | `after_seq=<n>` (the highest change number the app holds) |
| Returns | messages **posted** before `n` (`seq < n`) | messages **posted or changed** after `n` (`updated_seq > n`): edits, deletes, reactions, **replaced cards** |
| Page | the newest `limit` that match | the first `limit` that match |
| Sorted by | `seq` ascending (oldest first in the page) | `updated_seq` ascending |
| `has_more` | older ones exist: ask again with `before_seq` = the smallest `seq` in the page | more changes exist: ask again with `after_seq` = the last message's `updated_seq` |

Upsert by `message_id`, place by `seq`, whichever mode brought the message.

**`POST /trips/:trip/messages` body** (strict):

```json
{ "client_message_id": "cm_3f9a…", "text": "in, but only after 6pm fri",
  "attachments": [ { "upload_id": "up_01JA…", "caption": "Seats" } ], "reply_to": "m_0122", "about_message_id": null, "mentions": ["p_priya"] }
```

- `client_message_id` (1-64) is **required**: a repeat returns the same stored `Message`.
- `text` (1-4000) and/or `attachments` (≤ 10); one of them (`422 text`). Each attachment is `{ upload_id, caption? ≤ 500 }`
  (§4.5) or a contract `Attachment` (a shared `location` from the 1.1 overlay, for example).
- `mentions` (≤ 30 ids, deduplicated): every id must be in the trip now (`422`, `field: "mentions[1]"`).
- `reply_to` / `about_message_id` must be messages of **this** trip (`422`).
- The Server sets `mentions_go: true` when the text has `@Go` (or starts "Go," / "Go:" / "hey Go,"), **or** it replies
  to one of Go's messages, **or** `about_message_id` is set ("Ask Go about this", even without naming Go).
- `withheld` is always `false` in app reads. A reaction without `person_id` is Go's. A message whose `author.kind` is
  `go` must look like Go; `quick_replies` on it are chips whose tap sends `text ?? label` as your own message.
- **Former members.** `author: { "kind": "person", "person_id", "former": true }` when the author has left the trip or
  deleted their account; a reaction by such a person has `"former": true` too. They are not in `TripView.people`
  (active members only): draw "Former member" with a neutral avatar. Someone who joins again loses the mark. App reads only.
- **Only some people can see it.** A message of Go's may carry `visible_to_person_ids` (1-30 ids; each traveller's own
  flight options and booking flow, a note for the organizer). You only ever receive it when you are in the list: show
  "Only you can see this" (or name the others). Everyone else never receives it in any read, frame or count (§1.7), and
  reacting to it, replying to it, "Ask Go about this", editing or deleting it is `404`/`422` as for an unknown message.
  It still takes a change number: people outside the list see a gap in `seq`, which is harmless. `has_more` and `limit`
  count only the messages you can see. A person in the list who leaves stops seeing the trip, as with any leave.
- **System messages.** The Server posts messages with `author: { "kind": "system" }`, text only, drawn as centred
  pills: "Trip created · Rahul joined", "Priya joined", "Priya left", "Villa Sol won · 4 votes", "BLR → GOX booked",
  the **money lines** below, and the anchor of a **person-opened poll** (text = the question, `card: { kind: "vote",
  card_id, decision_id, fallback_text }`). They have a `seq` like any message, do not count as unread, are never the
  chat preview, and do not trigger a catch-up. Each also reaches Go as `message.created` (a record Go never answers).
- **Money lines.** Every money movement, whoever makes it (Go included), posts a line in the same transaction, as the
  change number right after the movement's own:

  | Movement | Text | `ledger` (app reads only) |
  |---|---|---|
  | an expense is added | `Priya added Airport cab · ₹1,700 · split 4 ways`; `· paid by Kabir` before the split when the payer is someone else; `Go added Villa Sol · ₹54,200 · paid by Rahul · split 4 ways` when Go added it | `{ kind: "expense_added", expense_id }` |
  | a split is fixed (the people changed) | `Priya changed the split of Airport cab · ₹1,700 · 3 ways` | `{ kind: "expense_changed", expense_id }` |
  | an expense is removed | `Priya removed Airport cab · ₹1,700` | `{ kind: "expense_removed", expense_id }` |
  | a payback is recorded | `Aarav paid Rahul ₹5,800` | `{ kind: "payback", settlement_id }` |

  The text is fixed when posted. Draw current amounts from the row the `ledger` ids name (`GET …/expenses`,
  `GET …/transactions`), and treat a row that is gone as removed. There is no card on these messages. Go reads the text
  only. Live: `trip_changed` for the movement, then the `message` frame of the line.

### 4.7 Go's cards

`POST /trips/:trip/cards/:card_id/actions` (strict):

```json
{ "action_id": "pick", "option_id": "opt_flight_1", "press_id": "9a1c3c2e-…", "payload": { "trip": "round" } }
```

- `action_id`: `^[a-z][a-z_]{0,31}$`. `option_id` only when the button was on one option (`per_option`). `press_id`
  (1-64) becomes Go's `tap_id`, tied to you (nobody can replay your press and get your answer); without it the
  Server makes one per call. `payload { trip: "oneway" | "round" }` (1.1) goes to Go as it is.
- The button must be on the card **as it stands now**: when Go has replaced the card (a pay card that is paid, expired or
  declined), a tap on a button it no longer has answers `422 invalid`, `field: "action_id"`, and never reaches Go.
- **10 taps a minute per person per trip** (`429 rate_limited`); a repeat of a `press_id` already counted is free, so a
  double tap or a retry never costs a tap.
- Only for a card on one of Go's messages of kind `options`, `working`, `call`, `pay`, `notice`, `checklist` or `rooms`,
  that you can see (`404 not_found` otherwise, the same as an unknown card, when the message's `visible_to_person_ids` leaves you out; `422 card_id` for a record card: `vote`, `mandate`, `expense`, ... are the Server's).
- The Server sends `card_tap { tap_id, trip_id, card_id, action_id, person_id, option_id?, payload? }` and waits 3.5 s.
  The answer is Go's `CardActionResult`, passed through:

```json
{ "result": "done",    "toast": "Noted. Go will reply in the room." }
{ "result": "open",    "url": "https://brain.go.example/vault/approve?link=lk_4Rt8Zp2Lq", "expires_at": "…" }
{ "result": "refused", "toast": "Only Rahul can approve this payment." }
```

- **When Go does not answer in time, refuses the request, is busy or answers badly: `200 { "result": "refused",
  "toast": "Go didn't answer. Try again." }`** (never an HTTP error for that). Disable the button while the tap is on its
  way; do not retry on your own; a new press is a new `press_id`.
- `open`: open the URL at once in the system browser sheet or a new tab (never a WebView, never ahead of time). A URL with
  the **`go://`** scheme is an in-app route (`go://trips/<trip>/sheet/budget`, `…/bookings/<booking>`, `…/checkin/<booking>`,
  §9); `https://` opens the browser sheet. `listen` on a live `call` card answers `open` with Go's listen-in page.
- Show a button only to the people in `only_for_person_ids` (absent = everyone); `per_option` puts it on every option.
- The vault link is `POST /me/vault-link` (§4.1).
- **Voting on the options card** (rev 5): when one of Go's `options` cards carries **`decision_id`**, the vote is on
  the card. Draw a **Vote** button on each option, with no "Put it to a vote" step. The vote itself is the Server's
  `Decision` (in `TripView`, or `GET /trips/:trip/decisions/:id`): the card's option with `option_id` X is the
  decision option whose **`option_ref` is X**, and its position in `decision.options` is the `option_index` to send to
  `PUT /trips/:trip/decisions/:id/vote`. Show the tally from `decision.tally` at that same index, and my choice from
  `my_vote`. Re-read the decision on `trip_changed` with `kinds: ["decision"]`. The Vote button is the app's own: it is
  not one of the card's `actions` and never goes to `…/cards/:card_id/actions`.
  **"See more"** is the card action `more_options` (sent like any card button): Go answers `done`, adds the new options
  to **the same vote** and posts a new message whose options card carries the same `decision_id`. The decision then
  has more options (up to 20), the tally has grown with zeros, and votes already cast are unchanged. Both messages
  show Vote buttons for the one vote. A "needs you" `vote` item's `target.message_id` is the newest message whose card
  carries the vote. When the vote closes, draw the cards without Vote buttons and the result from the decision. A
  place or stay option may carry `url` (https): show it as a small "View on ixigo" link inside the option's details.
- **An option's Details** (rev 5): `GET /trips/:trip/cards/:card_id/options/:option_id/details`, asked when a person
  opens Details on an option of one of Go's `options` cards. Answers Go's `OptionFullDetails`: everything the card's
  own `details` has (`gallery_urls`, `caption`, `why`, `costs`, `total_minor`, `amenities`, `activities`, `facts`,
  `cancellation`, `rating`, `review_count`, `go_note`) plus `address`, `map { lat, lng }`, `check_in`, `check_out`
  (`"14:00"`), `property_type`, `stars`, `rooms` (`RoomType[]`, with photos), `policies`, `reviews` (up to 10 of
  `{ rating, text, date: "YYYY-MM-DD" or "YYYY-MM", source }`), `nearby` (`{ name, distance_m? }`) and `url`. Every
  field is optional: draw what is there. The Server asks Go (3 s) and keeps a whole answer for an hour. **`complete:
  false`** means partial: Go is still collecting reviews or photos, or Go was not asked (you are over the limit) or did
  not answer, and this is the last answer kept or what the card carries; show it and ask again when Details is next
  opened. `404` when the card or option is not one you can see, or Go no longer has it. `go_unavailable` (`409` while
  Go has not switched this on) or `429` come only when there is nothing at all to show. **10 lookups of Go a minute per
  person per trip**; an answer already kept is free. When Go replaces the card, what was kept is dropped and the next
  open asks Go again. `Cache-Control: private, no-store`.
- **Go's live view** (rev 5): a `working` card may carry `live_url`, an `https` page of Go's own that shows the browser
  Go is driving, view only. While the card's `state` is `running` or `needs_you`, open it in an in-app panel
  (`<iframe>`); Go's page allows framing only from the app's origins. The link is valid about 15 minutes and Go sends a
  fresh one by `replace_card` at a step change, so always use the one on the card as it stands. **Never log it, store it
  or put it in an error report**: its token is in the `#fragment`, and whoever holds the link can watch. When the task
  ends the card keeps `screenshot_url` (the last frame) and `live_url` is gone. A card showing one person's own account
  comes on a message only they can see (`visible_to_person_ids`).

### 4.8 Votes, the mandate, and the trip record

| Method & path | Who | Request | Answer | Errors | Go hears / live |
|---|---|---|---|---|---|
| `GET /trips/:trip/decisions/:id` | member | — | `Decision` + `my_vote` (`{ option_index }` \| `{ flexible: true }` \| `null`), + `cancels_booking_id` on a cancellation vote | 404 | — |
| `POST /trips/:trip/decisions` | any member | `{ "client_id"? (1-64), "question" (1-200), "kind": "choice" \| "yesno", "anonymous": boolean, "options": [2-10 × { "label" (1-120), "image_url"?, "price_minor"? (≥ 0, shown in the trip's currency), "note"? (≤ 120) }], "closes_at"? (ISO, in the future) }`. Strict; `client_id` **or** an `Idempotency-Key` is required | `201 { "decision": Decision + my_vote, "message": Message }`: the Server posts the system message carrying the `vote` card, so the poll shows in the room at once. `of` = people in the trip now (a joiner adds one, a leaver who had not voted removes one) | 422 | `decision.opened` by you. Live: `message`, `trip_changed kinds: ["decision"]` |
| `PUT /trips/:trip/decisions/:id/vote` | member | `{ "option_index": 0-9 }` **or** `{ "flexible": true }` (never both or neither: `422`). Cast or move your vote until the vote closes. `flexible` needs `features.vote_flexible` (`409` otherwise); it counts in `voted` and `flexible_count`, not in `tally` | `200 Decision` + `my_vote` (the closed decision when your vote was the last) | 404; 409 closed or cancelled; 422 `option_index` out of range; 429 above **20 votes a minute per person** (taking one back counts) | `decision.voted` (`person_id` and `option_index` omitted when anonymous; `flexible: true` when so). **The vote closes by itself when everyone has voted.** Live: `trip_changed kinds: ["decision"]` |
| `DELETE /trips/:trip/decisions/:id/vote` | member | — | `200 Decision` + `my_vote: null`. Needs `features.vote_retract` | 409 flag off, vote not open, or you have not voted | `decision.voted` with `retracted: true` and the new totals |
| `POST /trips/:trip/decisions/:id/close` | **organizer or opener** | — | `200 Decision` (`result_index` set unless nobody voted or the top tied) | 403; 409 already closed/cancelled | `decision.closed`, then, when there is a result, `record.changed` (the **decided** line, by the system) and the system message "Villa Sol won · 4 votes" (a yes/no vote names its question: "Scuba on day 2? Yes won · 2 votes", and so does its decided line). Live: `trip_changed kinds: ["decision","record"]`, then the pill's `message`, in change-number order |
| `POST /trips/:trip/decisions/:id/cancel` | organizer or opener | — | `200 Decision` (`status: "cancelled"`). No record line | 403; 409 not open | `decision.cancelled` by you |
| `POST /trips/:trip/decisions/:id/mandate/confirm` | **the payer** | — | `200 Mandate` (`confirmed_at` set). "Yes, book it": Go may then ask for a spend approval and post a `pay` card | 403 not the payer; 409 no mandate | `mandate.confirmed`. Live: `trip_changed kinds: ["mandate"]` |
| `POST /trips/:trip/decisions/:id/mandate/decline` | the payer | — | `200 Mandate` (`declined_at` set). A new `set_mandate` clears both | 403; 409 | `mandate.declined` |
| `GET /trips/:trip/record` | member | `?include_undone=true` adds `undone` lines (draw them struck through) | `{ "lines": [RecordLine], "seq" }`, oldest first; `active` and `done` by default | | — |
| `POST /trips/:trip/record/:line_id/undo` | any member | — | `200 RecordLine` (`status: "undone"`); already undone: the line unchanged | 404 | `record.changed` `change: "undone"` by you. Go never undoes a line or writes one back |
| `POST /trips/:trip/record/:line_id/redo` | any member | — | `200 RecordLine` (`active` again) | 404; 409 when it was not undone | `record.changed` `change: "updated"` |

Rules: a vote also closes by itself at `closes_at` (a Server job, within 15 s) and when everyone in the trip has
voted. The `decided` and `booked` lines are written by the Server; `agreed`, `open`, `doing` by Go. "I'm flexible" and
taking a vote back are behind flags until Go confirms them (§9). "Who books for the group" (`claim`) is an ordinary card
tap (§4.7); the Server has nothing to add. **The payment itself is not an app endpoint**: Approve on the `pay` card is a
card action returning `open` to the vault page; the payer confirms with Face ID there, never in the app.

### 4.9 Money

**No approval, no disputes, no confirmation.** An expense counts from the moment it is added until it is removed. A
payback counts from the moment it is recorded, for good. People sort disagreements out among themselves: the person who
added an expense fixes its split or removes it.

| Method & path | Who | Request | Answer | Errors | Go hears / live |
|---|---|---|---|---|---|
| `GET /trips/:trip/money` | member | — | `MoneyView` (§2), `private, no-store`. Both the "Everyone" and "Just me" views come from this one answer | 403 | — |
| `GET /trips/:trip/transactions` | member | `?filter=all \| booking \| payback \| mine` (default `all`) `&limit=1-100` (default 50) `&before=<cursor>` | `{ "items": [Transaction], "total_count", "next_cursor": string \| null }`, newest first. `total_count` counts **all** rows whatever the filter (the "All 7" chip) | 422 `filter` (the old `pending` and `disputed` included), `limit`, `before` (not a cursor from this list) | — |
| `GET /trips/:trip/expenses` | member | — | `{ "items": [Expense], "seq" }`, newest first: every expense that stands | 422 `status` (the old `?status=` filter is gone; any non-empty value is refused) | — |
| `POST /trips/:trip/expenses` | any member | `{ "amount_minor" (≥ 1), "note" (1-120), "category": stay \| food \| getting_around \| activities \| other, "split_person_ids" (1-30, in the trip), "booking_id"? (this trip's), "paid_by_person_id"? (default: you) }` (strict). **To split with people chosen by @-mention, send their ids as `split_person_ids`** | `201 Expense` + `seq`. In the trip's currency, split equally (odd minor units go one each to the first people in joining order). It counts at once | 422 | `expense.changed` `change: "added"`, then the room's line (§4.6). Live: `trip_changed kinds: ["settlement","expense"]`, `message` |
| `PATCH /trips/:trip/expenses/:id` | **the person responsible** (below) | `{ "split_person_ids" (1-30, in the trip now), "note"? (1-120) }` ("Fix split") | `200 Expense` + `seq` | 403; 404; 422 | `expense.changed` `change: "updated"` on `GO_CONTRACT=1.1`; on `1.0` (today) a change number and no event: Go reads the expense on its next `read_trip`. The room's line when the people changed |
| `DELETE /trips/:trip/expenses/:id` | the person responsible | — | `200 { "seq" }` | 403; 404 not in this trip or already removed | `expense.changed` `change: "removed"`, then the room's line |
| `POST /trips/:trip/settlements` | any member | `{ "to_person_id" (another member), "amount_minor" (≥ 1), "currency" (the trip's), "method": upi \| cash \| bank_transfer \| other, "note"? (1-120) }` ("Record a payment") | `201 { "settlement": Settlement, "transfers": [Transfer], "seq" }`. It counts at once and for good: the transfer shrinks | 422 `to_person_id` (yourself, or not in the trip), `currency` | `settlement.recorded` in the same transaction, then the room's line. Live: `trip_changed kinds: ["settlement","expense"]`, `message` |
| `POST /trips/:trip/transfers/pay-link` | the one who owes | `{ "to_person_id", "amount_minor" (≥ 1; the app prefills what is owed) }` | `{ "upi_uri": "upi://pay?pa=…&pn=…&am=1700.00&cu=INR&tn=…", "expires_at" (+10 min, advisory: the Server keeps nothing) }`. The link carries the payee's UPI id: a convenience, not a privacy measure | 409 payee not in the trip or has no UPI id (`has_upi: false`: offer Record a payment instead); 422 `to_person_id` when you do not owe them right now | nothing |

**Who may fix the split of an expense or remove it** (`403` for anyone else):
1. the person who added it (`added_by_person_id`), while they are in the trip;
2. when nobody added it (Go did) or the adder has left the trip: the payer, while they are in the trip;
3. when neither is in the trip: the organizer.

Being the organizer gives no right of its own, and neither does being named as the payer by someone else. A split can be
fixed after the payer has left; only the people in the new split must be in the trip.

**Money maths** (the same for the app and for Go's `read_trip`):
- Every expense counts in `spent_minor`, `by_category` and `transfers`. Every recorded payback counts.
- `transfers` is the fewest payments that square everyone up right now (balances paired first, then biggest debtor
  pays biggest creditor), never a share of one expense. "Settled" = no transfer from me to that person.
- One currency per trip; every amount is in it.
- A payback cannot be undone or removed. One recorded by mistake is put right by the other person recording one back.
- A payback's payee must be in the trip. **A debt to someone who has left the trip stays in `transfers` and in
  `GET /home` `owes`, and cannot be closed by recording a payback.**

**Needs you:** every transfer where I owe is `{ kind: "settle_up", title: "Settle up with Rahul", subtitle: "₹5,800 left
of your share", cta_label: "Record", target: { transfer } }`. Nothing asks anyone to approve an expense.

**Removed in rev 4** (each answers `404 not_found`): `POST …/expenses/:id/approve`, `POST …/expenses/:id/dispute`,
`POST …/settlements/:id/confirm`, `POST …/settlements/:id/dispute`, `POST …/transfers/nudge`. `Expense` has no `status`
or `confirmations`; `Settlement` has no `status` or `responded_at`; `Transaction` has no `expense_status` or
`settlement_status`.

### 4.10 Bookings, documents and the itinerary

| Method & path | Who | Request | Answer | Errors | Go hears / live |
|---|---|---|---|---|---|
| `GET /trips/:trip/bookings` | member | — | `{ "items": [Booking], "seq" }`: every booking, `confirmed` and `cancelled`, newest first. `passengers[]` and `documents[]` only in bookings that cover you, each document with its `url` (a signed link valid 1 hour); `details` and `return_journey` for everyone | | — |
| `GET /trips/:trip/bookings/:id` | member | — | `Booking` (same rule) | 404 not in this trip | — |
| `GET /trips/:trip/bookings/:id/documents/:document_id` | a **covered person**, or anyone in the trip when the document is `visibility: "group"` | — | `302` to a **signed link valid 10 minutes** (`private, no-store`). Render the PDF client-side from it; "Share to the group" is a normal message with the file attached | 403 not covered; 404 booking not in the trip, or document not on this booking | — |
| `POST /trips/:trip/bookings` | any member | `AddBooking` (below), strict | `201 Booking` as you see it (the covered-people rule above; `documents: []` for now) plus `seq`. Stored `confirmed`, in the trip's currency, with you as `added_by_person_id`; **no expense** is created | 422 | `booking.changed` `change: "added"` by you, then `record.changed` (the **booked** line: a decided line of the vote it names becomes booked, else a new line), then the system message "<title> booked". Live: `trip_changed kinds: ["booking","record"]` |
| `PATCH /trips/:trip/bookings/:id` | any member, any booking | any of `ref` (1-80), `refundable_until`, `starts_at`, `ends_at` (ISO; `null` clears a time); strict; at least one field | `{ "seq" }`, or `{ "seq": null }` when nothing differed | 404; 409 the booking is cancelled; 422 ends before starts | `booking.changed` `change: "updated"`. Live: `trip_changed kinds: ["booking"]` |
| `POST /trips/:trip/bookings/:id/cancel-vote` | any member | `{}` (strict; send an `Idempotency-Key`) | `201 { "decision_id", "seq" }` | 404; 409 already cancelled, **paid through the vault**, or a cancellation vote is already open (the message names it) | `decision.opened` by you; the system message carrying the vote card. Live: `message`, `trip_changed kinds: ["decision"]` |
| `GET /trips/:trip/itinerary` | member | `?scope=everyone` (default) \| `me` | `{ "days": [Day], "seq" }`. `days: []` is "No plan yet" | 422 `scope` | — |

**`AddBooking`** (the contract's `AddBooking` fields without `request_id`/`approval_id`): required `kind` (`stay` \|
`flight` \| `train` \| `bus` \| `cab` \| `table` \| `activity` \| `other`), `title` (1-120), `vendor` (1-80), `ref`
(1-80), `amount_minor` (≥ 0), `payer_person_id`, `for_person_ids` (1-30; all in the trip); optional `refundable_until`,
`starts_at`, `ends_at` (ISO; ends not before starts), `journey` and `return_journey` (`{ mode: flight \| train \| bus \|
cab, origin, destination (each { name 1-80, code? ≤ 8 }), depart_at, arrive_at, carrier_name? ≤ 60, carrier_code? ≤ 8,
number? ≤ 20, logo_url?, stops? ≥ 0 }`), `details` (≤ 20 × `{ label 1-40, value 1-120 }`), `passengers` (≤ 30 ×
`{ person_id (one of for_person_ids), seat? ≤ 8, pnr? ≤ 20 }`), `place` (`{ name 1-120, place_id? ≤ 256, address? ≤
200, lat?, lng?, photo_url?, photos? ≤ 12 × { url, label? 1-40 } }`), `image_url`, `decision_id` (a **closed** vote of this trip that is not a cancellation
vote). Render `image_url`/`logo_url` only when they are `http(s)` links.

**Documents.** When Go's `add_booking` names `documents[]` (1.1), the Server copies each file from Go's link into its own
storage in the background (PDF or image, ≤ 25 MB; a file that cannot be copied is skipped and logged) and serves it only
through short signed links, never Go's link. A booking added by a person has no documents. Each document in a read (the
bookings list, one booking, `TripView.bookings`) carries **`url`**: a signed link to the file, **valid 1 hour**, minted on
that read. Open or download it directly; when it has run out, read the booking again for a fresh one (the documents route
above still works as a stable link). A document may arrive without `url` if Storage could not sign it at that moment: use
the documents route.

**Demo bookings (the demo payment).** A booking written when the payer taps Approve on Go's pay card carries a ticket file
a moment after the tap: a **PDF e-ticket** for each leg of a flight, train or bus, or a **PDF hotel voucher** for a stay
(ixigo-style, marked DEMO, `visibility: "covered"`). The booking itself is answered at once, without the file; when the
file lands the Server sends **`trip_changed kinds:["booking"]`** with a new `seq` (and `home_changed` to the covered
people): read the booking again to get `documents[]`. If the Server cannot render, the booking stays without a file.

**Cancelling by vote.** The Server opens a yes/no vote that is **not anonymous** and closes **24 hours** after it opens:
question "Cancel this booking? <title>", options "Cancel: <title>" (index 0) and "Keep: <title>" (index 1; titles cut to
112 characters). Voting, changing a vote, closing early and calling it off work as for any vote. **The booking is
cancelled only if "Cancel" gets more than half of everyone in the trip at the moment the vote closes**: people who do
not vote count against, a tie does not cancel, someone who voted and then left still counts. If "Keep" has more votes
the result is "Keep"; otherwise the vote ends with no result and the booking stays. When it passes the booking becomes
`cancelled` in the same moment (`booking.changed` `cancelled` by the system) and the decided line is written. Cancelling
records the group's decision only: **nothing is cancelled with the vendor.** Such a vote carries `cancels_booking_id` in
`TripView.decisions[]`, in `GET …/decisions/:id` and in its `needs-you` item (ordinary votes have no such key): use it to
pick the cancellation component and to hide "Propose cancelling" on a booking that already has an **open** one.

**Itinerary scopes.** `everyone` is the stored itinerary minus `private` items that do not name you. `me` ("Just me")
keeps items that name you in `person_ids`, items `shared` or `group`, and items that name nobody; an item tied to a
booking that covers you is **reworded from the booking**: "BLR → GOX · 6E 5313, Seat 14A, lands Mopa 9:55 pm". Items keep
`person_ids` and `audience` (1.1) for face stacks and badges. Go writes the itinerary with `update_trip`; people with
`PATCH /trips/:trip` (§4.4). Several stays in one trip need nothing new: each is a `Booking` of `kind: "stay"`.

### 4.11 Trip home: "needs you", Go's cards

`GET /trips/:trip/needs-you` → `{ "items": [NeedsYouItem], "seq" }`, computed by the Server from its own rows, per person:

| `kind` | Shows for | `title` / `subtitle` / `cta_label` | `target` | Leaves when |
|---|---|---|---|---|
| `vote` | each open vote I have not voted in | the question / "closes in 1 hour" (or "2 of 5 voted") / "Vote" | `decision_id`, `message_id` of the vote card when there is one, `cancels_booking_id` on a cancellation vote | I vote, or it closes or is cancelled |
| `mandate` | the payer, while the mandate is unanswered | "Yes, book it? Villa Sol, up to ₹55,000" / the question / "Yes, book it" | `decision_id`, `card_id`, `message_id` | I answer (a new mandate shows it again) |
| `card` | the people in a Go card's `for_person_ids`, when the card has something to press (an action, or a checklist suggestion's `cta`); a notice with no buttons is information, never an item | the card's `fallback_text` / its `title` / its first action's label (else the `cta`'s) | `card_id`, `message_id` | Go removes me with `replace_card` |
| `record_line` | the people in an `open`, `active` line's `person_ids` | the line's text / "due 2026-11-01" | `line_id` | the line is done, undone, agreed or doing |
| `settle_up` | each net transfer where I owe | "Settle up with Rahul" / "₹5,800 left of your share" / "Record" | `transfer { to_person_id, amount_minor, currency }` | the transfer is gone (a settlement recorded) |
| `checkin` | each confirmed flight covering me whose cached check-in state is open (`features.checkin`) | "Web check-in is open" / "6E 5313 · Fri 6 Nov · closes 19:40" / "Check in now" | `booking_id` | the check-in is done or closed |

`TripView.needs_you_count` and the home card use this list's length. A change moves `trip_changed`; re-read. `GET /home`
lists the same items across all my active trips in `needs_you` (§4.2), with what each popup opens.

`GET /trips/:trip/cards?kind=<kind>&state=<a,b>` → `{ "items": [ { "message_id", "card": Card, "posted_at" } ] }`: the
**latest version** of each card in the room (after `replace_card`), newest first, at most 100. `kind` is any card kind
(`^[a-z_,]+$`); `state` is a comma list for kinds with a `state` (`call`: `dialing,talking,ended,failed`; `working`:
`running,needs_you,done,failed`; `pay`: `waiting,paid,declined,expired,failed`). A card on a message you cannot see (`visible_to_person_ids`) is left out; cards are not filtered by `for_person_ids` here. The
Trip home's "Go's calls" reads `?kind=call&state=dialing,talking`; the live `card` frame updates them in place; the
elapsed clock is the client's from `started_at`. "Stop the call" is the card action `stop`; **Listen in** is the card
action `listen` (Go answers `open` with its page: transcript, mute, take over, hand back, end). "Ask Go to call…" is a
normal message mentioning Go.

`POST /trips/:trip/cards/:card_id/share` (`features.calls`, else `409`) → `201 Message`: for an **ended `call` card with
a `recording_url`**, the Server copies the recording into its own storage (audio, ≤ 25 MB) and posts a message **by
you**, "Call with Villa Sol · Late check-in until 11 pm confirmed", with the recording as one file attachment (`name`,
`mime`, `size_bytes`, `duration_s`, a signed link minted on every read). Go hears `message.created`. One message per
card: sharing again answers the first. `404` not one of Go's cards; `409` not an ended call with a recording; `503
unavailable` when the recording could not be fetched. Posting the `recording_url` yourself as an attachment is not
allowed. The ended card itself carries `recording_url` (Go's signed, expiring link) and `duration_s` when Go recorded.

The chat button on Trip home reads `TripView.chat`; no extra endpoint.

### 4.12 Web check-in

Behind `features.checkin`: with the flag off all three routes answer `404 not_found`, for members too, so the app's flag
and the Server agree. Go performs the check-in on the airline site; the Server keeps a copy of what Go found per covered
person on a flight, so the sheets, the strip and the home card read it without asking Go every time.

| Method & path | Who | Request | Answer | Errors | Go |
|---|---|---|---|---|---|
| `GET /trips/:trip/bookings/:booking_id/checkin` | a person the **flight** booking covers | — | `CheckinState` (§2) | 403 not a flight, or does not cover you; 404 booking not in the trip, or flag off; 502 `go_unavailable` when Go is away and nothing is cached | `get_checkin { trip_id, booking_id, person_id }` (2 s). The answer is cached; Go's `working` keeps what is cached; Go away ⇒ the cached state. The first time a state is `open`, everyone the booking covers gets a row, and the strip's `checkin` item |
| `PATCH …/checkin` | covered person | `{ "digi_yatra"?: boolean, "declaration"?: boolean, "seat"?: "14A" (`^[0-9]{1,3}[A-Z]{1,2}$`), "mobile"?: "+91 98765 43210" }`; strict; at least one field | the updated `CheckinState`. Your answers go into the cached state (fetched from Go first when there is none); nothing reaches Go until `complete`. `mobile` comes back masked in `passenger.mobile_masked`. **A paid seat** (`state: "paid"` or `price_minor > 0`) is **not** set: the answer is `200 { ...state, "payment_required": true, "seat_price": { amount_minor, currency } }`; the vault pays first (Go posts a `pay` card) and Go sets the seat when the payment lands | 409 the check-in is not open (not yet, done, closed, or Go still working); 409 the seat is `taken`; 422 `seat` not on the map or not choosable | none |
| `POST …/checkin/complete` | covered person | `{}` (send an `Idempotency-Key`) | `200 CheckinState` with `status: "done"` and the `boarding_pass`; or `202` with `status: "working"` (Go finishes on the airline site and updates by `replace_card`; read `GET …/checkin` again for the pass) | 409 open the check-in first, not open, or Go says `failed` (Go's message; your answers are kept so you can fix and retry); 422 `declaration` not accepted, or no `seat`; 502 `go_unavailable` | `submit_checkin { trip_id, booking_id, person_id, digi_yatra, declaration, seat, mobile? }` (2 s) |

Go may also announce "check-in is open" by posting a `notice` card whose link is `go://trips/<trip>/checkin/<booking_id>`:
the Server then marks the state open for the people the card names (else everyone the booking covers). `companion` is the friend on the same booking and their seat, filled by
the Server from the booking's `passengers` unless Go named one.

### 4.13 The You screen

Every route asks Go for the **signed-in person only**.

| Method & path | Server → Go | Answer | Errors |
|---|---|---|---|
| `GET /me/go` | `get_person { person_id }` (2 s) | `PersonPage` (`carry_over`, `facts[]` with `fact_id`, `topic`, `text`, `trip_id`, `message_id`?, `said_at`). A fact with a `message_id` opens that message; without one it came from the join answers | 502/503/504 `go_unavailable` ("Couldn't load what Go knows. Try again."); 429 |
| `PATCH /me/go` | `update_person { person_id, carry_over }` | `{ "ok": true }`. Body `{ "carry_over": boolean }` (required; strict; off by default) | `go_unavailable` (put the switch back) |
| `DELETE /me/go/facts/:fact_id` | `delete_fact { person_id, fact_id }` | `{ "ok": true }` | 404 Go has no such fact (remove it from the screen); `go_unavailable` |
| `DELETE /me/go?trip_id=<id>` | `forget_person { person_id, trip_id? }` | `ForgetResult { "deleted_facts", "remaining_facts": 0 }`. With `trip_id`: that trip (also one you have left); without: everywhere. **Then** the Server clears your join answers (`from_city`, `earliest_leave`, `know`) in those trips and sends `person.updated` where you are still a member. **Never says you were forgotten when Go failed**: `502` when Go reports facts left, `go_unavailable` when it did not answer. Safe to repeat | 403 a trip you were never in; 502/503/504 |

Pause Go is `PATCH /trips/:trip/me { go_paused }` (§4.4). Forget me does not touch messages, votes, bookings, expenses
or record lines, and does not stop Go learning from new messages; pausing does.

### 4.14 Places, config and health

| Method & path | Request | Answer |
|---|---|---|
| `GET /places/cities` | `?q=<text ≤ 80>&country=IN&limit=<1-8, default 8>` | `{ "items": [ { "id", "name", "region": "Madhya Pradesh, India", "lat", "lng", "population" } ] }`: populated places whose name **starts with** `q` (accents and case ignored), biggest first, one per name and state, ≤ 8. `q` under two characters returns the top list. Served from a bundled dataset (India for now; another `country` is `422`), no third-party call. **5 requests per second per person** (`429`). `private, max-age=86400` |
| `GET /places/cities/top` | `?country=IN&limit=` | `{ "items": [ …same shape… ] }`, the biggest cities. `private, max-age=604800` |
| `GET /config` **public** | — | `{ "contract": "1.0.0", "min_client_version": "1.0.0", "currency_default": "INR", "features": { "checkin", "visa", "calls", "vote_retract", "vote_flexible", "claim" } }`. Read it at boot; §9 says what each flag hides. There is no `web_push`, `expense_approval` or `vapid_public_key` any more |
| `GET /health` **public** | — | `{ "ok": true, "go": boolean \| null }` (`go` = the socket to Go is open). Also at `/health` |

Use `name` as `from_city` (≤ 60) and show `region` as the secondary line; `id` is stable. Strip accents only for
matching, never for display. A 400 ms debounce and cancelling the previous request are client-side.

---

## 5. Screen by screen

How the app's screens map to this page, where it is not obvious:

- **Paying** is always the vault page behind a card action (§4.7). There is no pay sheet in the app.
- **Expenses** have no Approve / Dispute badge and no Nudge: an expense simply counts, and money movements show as lines
  in the room (§4.6, §4.9).
- **The trip board** (the top-right panel) is gone from the app; "needs you" stays on the dashboard (§4.11).
- **No private budget screen, no invite "Not now" / "Decline", no notification settings** (§4.3, §4.4, §8).
- **Sign-in** is Supabase sign-in; there are no `/auth/*` routes (§1.2).
- **Images:** the Server has one image per trip, `photo_url` (plus `photos` when sent, §9); any illustration is the
  client's.
- **Catch-up** takes no `since` (§4.6).

---

## 6. Cards

The app draws all 13 contract kinds plus the 1.1 `checklist` and `rooms`, and `fallback_text` for any kind it does not know.
**Record cards are drawn from the Server's own rows** (`vote`, `mandate`, `ticket`, `expense`, `settle_up`, `day`,
`plan`, `budget`), redrawn from the GETs after `trip_changed`. **Go cards are drawn from the card itself** (`options`,
`working`, `call`, `pay`, `notice`, `checklist`, `rooms`); the Server stores a card **exactly as it arrived** and never rewrites
it, so every 1.1 field (option `details`, `return_journey`, `price_oneway_minor`, `price_round_minor`, `option_kind:
"cab"`, `recording_url`, `duration_s`, `checklist.rows`, `go://` links) reaches the app untouched, and a `card` frame
replaces it in place.

| What the screen shows | Card | Drawn from | Buttons go to |
|---|---|---|---|
| Place / dates / stay polls (voters, countdown, "Details", "I'm flexible") | `vote` (a `Decision`) | Server rows (`GET …/decisions/:id`) | §4.8 (`PUT …/vote`) |
| Group budget ask, travel ask, private teaser, "check-in is open" | `notice` + an action opening a `go://` route | the card | §4.7 |
| Visa status, who lands when, packing | `checklist` (rows of people with `todo` \| `started` \| `done` \| `info`) | the card; rows updated by `replace_card` | §4.7 |
| "One person books for all" → "Rahul is booking for all 4" → Yes, book it → Approve | `notice` (`claim` action) → `mandate` → `pay` | card / Server rows / card | §4.7 / §4.8 / §4.7 (vault) |
| Booking progress → ticket | `working` → `ticket` | card / Server rows (`GET …/bookings/:id`) | §4.7 |
| "Added to the money" (no buttons to approve or dispute) | `expense`; the room's money lines are system messages with `ledger`, not cards (§4.6) | Server rows | §4.9 |
| Settle up (UPI, Record) | `settle_up` | Server rows (`GET …/money`) | §4.9 |
| Plan, day, budget | `plan`, `day`, `budget` | Server rows | — |
| Live and ended calls (Stop, Listen in, recording) | `call` | the card, updated in place; `GET …/cards?kind=call` | §4.7, §4.11 |
| Flights / stays / cabs Go found (Pick, one-way / round) | `options` | the card | §4.7 with `payload` |
| Room sets for a stay: who shares with whom, by room type (rev 4, when Go sends it) | `rooms` | the card | §4.7; `option_id` carries the `arrangement_id` |
| Chips under a Go message | `quick_replies` on the `Message` (not a card) | the message | a normal `POST …/messages` |

Show a button only to `only_for_person_ids`; `per_option` puts it on every option; "checked N min ago" from `checked_at`.

---

## 7. What the Server does for Go on every app action

Every app write that changes a trip takes the trip's **next change number**, stores the change and the outbox event in
one transaction, then sends the live frame. The outbox delivers events to Go one at a time per trip, in order, with the
contract's retry ladder. This is the complete map.

| App action | Endpoint | Change number | Event to Go (`send_event`) | Other Server → Go request | Live frame |
|---|---|---|---|---|---|
| Create a trip | `POST /trips` | yes (**1**; the pill is 2) | `trip.created` | — | `trip_changed`, `home_changed` |
| Join | `POST /invites/:code/accept` | yes | `person.joined` (with the answers) | — | `message` (pill), `trip_changed people`, `home_changed` to all |
| Rotate the link | `POST …/invite/rotate` | no | none | — | — |
| Leave | `POST …/leave` | yes | `person.left` | — | `message` (pill), `trip_changed people`, `home_changed` |
| Join answers | `PUT …/me/join-answers` | yes | `person.updated` (`changed` = what differed) | — | `trip_changed` |
| The group's budget | `PATCH /trips/:trip` `budget_per_person_minor` | yes | `trip.updated` `changed: ["budget"]` by the person | — | `trip_changed trip, budget` |
| Pause / resume Go | `PATCH …/me` | yes | `person.updated` `["go_paused"]` | — | `trip_changed people` |
| Trip details | `PATCH /trips/:trip` | yes | `trip.updated` by the person (`title`, `dates`, `itinerary`, `status`) | — | `trip_changed` |
| Name / photo / UPI | `PATCH /me`, `PUT`/`DELETE /me/upi` | yes, **per active trip** | `person.updated` (`name`, `photo_url`, `has_upi` when it flips) | — | `trip_changed` per trip |
| Default city, read marker, uploads | `PATCH /me`, `POST …/read`, `POST /uploads` | no | none | — | — |
| Delete my account | `DELETE /me` | yes, per trip | `person.left` per trip (after `forget_person`) | `forget_person` (everywhere) | `trip_changed`, `home_changed` |
| Send a message | `POST …/messages` | yes | `message.created` (`withheld: true`, no text, when the author paused Go) | — | `message` |
| Edit / delete | `PATCH` / `DELETE …/messages/:id` | yes | `message.edited` / `message.deleted` | — | `message` |
| React | `PUT …/messages/:id/reaction` | yes (one per change) | `reaction.removed` and/or `reaction.added` | — | `message` |
| Open a vote | `POST …/decisions` | yes | `decision.opened` by the person | — | `message` (the vote card pill), `trip_changed decision` |
| Vote / move / flexible | `PUT …/vote` | yes | `decision.voted` (anonymous: totals only) | — | `trip_changed decision` |
| Take a vote back | `DELETE …/vote` | yes | `decision.voted` `retracted: true` | — | `trip_changed decision` |
| Close (button, everyone voted, or `closes_at`) | `POST …/close`, or inside a vote / leave, or the job | yes | `decision.closed`, then `record.changed` `added` (decided line) by the system | — | `message` (pill), `trip_changed decision, record` |
| Cancellation vote passes | (when it closes) | yes | also `booking.changed` `cancelled` by the system | — | `trip_changed decision, booking, record` |
| Call a vote off | `POST …/cancel` | yes | `decision.cancelled` | — | `trip_changed decision` |
| Yes, book it / Not now | `POST …/mandate/confirm` \| `decline` | yes | `mandate.confirmed` / `mandate.declined` | — | `trip_changed mandate` |
| Undo / redo a line | `POST …/record/:id/undo` \| `redo` | yes | `record.changed` `undone` / `updated` | — | `trip_changed record` |
| Add / fix / remove an expense | `POST`, `PATCH`, `DELETE …/expenses` | yes (two: the change, then its line in the room) | `expense.changed` `added` / `updated` (1.1 only) / `removed`; none for the line | — | `trip_changed settlement, expense`, then `message` (the line) |
| Record a payment | `POST …/settlements` | yes (two: the payment, then its line) | `settlement.recorded`; none for the line | — | `trip_changed settlement, expense`, then `message` (the line) |
| Pay link | `POST …/transfers/pay-link` | no | none | — | — |
| Add a booking by hand | `POST …/bookings` | yes (two) | `booking.changed` `added`, then `record.changed` (booked line) by the system | — | `message` (pill), `trip_changed booking, record` |
| Edit a booking | `PATCH …/bookings/:id` | yes | `booking.changed` `updated` | — | `trip_changed booking` |
| Propose cancelling | `POST …/bookings/:id/cancel-vote` | yes | `decision.opened` | — | `message`, `trip_changed decision` |
| Tap a Go card button (`claim` included) | `POST …/cards/:id/actions` | **no** | none | **`card_tap`** (3 s) | — |
| Share a call recording | `POST …/cards/:id/share` | yes | `message.created` | — | `message` |
| Catch-up | `GET …/catch-up` | no | none | **`catch_up`** (3 s) | — |
| What Go knows, carry-over, delete a fact | `GET` / `PATCH /me/go`, `DELETE …/facts/:id` | no | none | `get_person`, `update_person`, `delete_fact` (2 s) | — |
| Forget me | `DELETE /me/go` | yes where answers were cleared | `person.updated` (`from_city`, `earliest_leave`, `know`) | `forget_person` (2 s) | `trip_changed` |
| Vault link | `POST /me/vault-link` | no | none | `vault_link` (2 s) | — |
| Check-in: read / answers / complete | `GET`, `PATCH`, `POST …/checkin` | no | none | `get_checkin` / — / `submit_checkin` (2 s) | — |
| Typing | live socket | no | **none** (never to Go) | — | `typing` |

**What the Server writes without being asked:** the `decided` and `booked` record lines; the system messages (§4.6); the
automatic vote close at `closes_at` and when everyone has voted; the booking cancelled by a passed vote; the outbox row
for every change; the money lines in the room (§4.6, for Go's `add_expense` too); the "needs you" strip. **A `replace_card` from Go** takes a change number on the
message (`updated_seq`) but sends **no event**; the app gets the `card` frame (and finds the card again with
`after_seq`).

---

## 8. No push notifications

The Server sends nothing to a phone: no Web Push, no device registration, no notification switch, no Nudge. The routes
`POST /me/devices`, `DELETE /me/devices/:device_id` and `POST …/transfers/nudge` are gone (`404`), as are
`Me.notifications_enabled`, `features.web_push` and `vapid_public_key`.

What takes their place, all inside the app:

| Used to be a push | Now |
|---|---|
| Go named me, or a card needs me | the message in the room (unread count) and the "needs you" item (§4.11) |
| a vote is about to close | the vote's "needs you" item, with "closes in 1 hour" |
| I owe money; someone reminded me | `GET /home` `owes` and the trip's `settle_up` item (§4.2, §4.9) |
| an expense was added; someone paid me back | the money line in the room (§4.6) |
| a friend joined | the "Priya joined" pill in the room |
| web check-in opened | the `checkin` "needs you" item and the home card's task (§4.12) |

---

## 9. Additions from Go, and the feature flags

Some features depend on Go. They were proposed to Go's team in [`GO-CHANGES.md`](GO-CHANGES.md) (contract 1.1; the rev 4
items are its section 6). The Server already **passes the 1.1 fields through** wherever Go sends them (the contract check
is extended by `contract/extensions-1.1.json`, additively), and has built the Go-dependent features behind the flags in
`GET /config.features`. A flag flips to on the day Go ships that item.

| Flag | Default | On the Server, with the flag **off** | What the app hides |
|---|---|---|---|
| `checkin` | false | `GET`/`PATCH`/`POST …/bookings/:id/checkin[/complete]` answer `404`; no `checkin` needs-you items or `attention.task`; Go's "check-in is open" notice is an ordinary card | the "Web check-in is open" card, the Preview link and the check-in sheets (the airline's site is used) |
| `visa` | false | `POST /me/vault-link { start: "add_documents" }` answers `422 start`; a pending `checklist` row does not drive `attention.task` (checklist cards still show in the room) | the visa form entry point |
| `calls` | false | `POST …/cards/:id/share` answers `409` (the `listen` action and `recording_url` still pass through when Go sends them) | Listen in, the recording player and "Share in group chat" |
| `vote_retract` | false | `DELETE …/decisions/:id/vote` answers `409` | untapping a picked option (moving the vote still works) |
| `vote_flexible` | false | `PUT …/vote { flexible: true }` answers `409` | "I'm flexible" (send it as a message meanwhile) |
| `claim` | false | nothing: a `claim` tap is an ordinary `card_tap`, passed through | "I'll book it" (Go picks the payer and posts the mandate card directly) |

**Passed through with no flag** (each appears only once Go sends it): option `details`; `return_journey`,
`price_oneway_minor`, `price_round_minor`, `option_kind: "cab"`, `card_tap.payload`; `quick_replies`; `go://` links;
`location` attachments and `duration_s`; `Booking.details`, `passengers`, `documents`, `return_journey` (the Server
stores Go's documents and applies the covered-people rule); `ItineraryItem.person_ids`, `audience`, `Day.image_url` (the
Server filters `private` items and builds `scope=me`); `settlement.recorded` (sent when a payback is recorded); the
`checklist` card; `recording_url`, `duration_s`, `listen`; `Place.timezone`; `expense.changed` `updated`.

**New in rev 4, with no flag** (each does nothing until Go sends it; shapes in [`GO-CHANGES.md`](GO-CHANGES.md) §6):

| What | Shape the app receives | Where |
|---|---|---|
| Several labelled photos for a destination or a stay | `photos: [{ url, label? }]` (≤ 12; `label` ≤ 40, e.g. "Deluxe room") on `Place`, `Option` and `DecisionOption`. `photo_url` / `image_url` stay as the cover. When `details.gallery_urls` also arrives, show `photos` | `TripView.destination`, options cards, votes. A person may send `photos` inside `destination` (`POST /trips`) and `place` (`POST …/bookings`) |
| A stay's price as a range | `price_min_minor`, `price_max_minor` on `Option` and `DecisionOption`: **per person for the whole stay** | options cards, votes |
| Room types of a stay | `room_types: [{ room_type_id, label, sleeps, price_minor, photos? }]` (≤ 10); `price_minor` is **per room for the whole stay**; all in the option's currency | options cards, votes |
| Room sets after a stay is picked | the `rooms` card: `{ card_id, kind: "rooms", fallback_text, for_person_ids?, title, option_id?, arrangements: [{ arrangement_id, label?, rooms: [{ room_type_id, label, person_ids, price_minor }], total_minor, per_person: [{ person_id, amount_minor }] }], actions }` | the room; `GET …/cards?kind=rooms`; "needs you" for `for_person_ids`. A tap is `POST …/cards/:card_id/actions` with `option_id` = the `arrangement_id` (§4.7) |
| The group budget set by Go | `budget_per_person_minor` through Go's `update_trip` | the same fields as §4.4 |
| Different room prices | no new shape: Go adds one expense per room, split among that room's people | §4.9 |
| Flight options for one person | an `options` card with `for_person_ids` and `only_for_person_ids` naming them; everyone sees it, only they can act. When Go also sends `visible_to_person_ids` (official since 1.2), only they see it at all | §4.6, §4.7 |
| A message only some people can see | `visible_to_person_ids` on the `Message` (official in Go's 1.2 `post_message`): each traveller's own options and booking flow, an organizer-only note | §1.7, §4.6 |

**Designed, not built** (waiting for Go's team to agree its half): paying for a seat or extra baggage at check-in
through the same `pay` card and vault as a stay (`CheckinState.extras`, `extra_ids`; `GO-CHANGES.md` §6.5). Until then
the paid seat of §4.12 answers `payment_required` and nothing more happens.

**Open with Go's team** (no schema change): Go tolerating
`author.kind = "system"` in `read_messages` (and not replying to the money lines), a `replace_card` moving `updated_seq`, and Go posting nothing for
person-opened votes (the Server does).

---

## 10. Internal routes (App team testing and support)

Not part of the app's API and never called from the app or the web app: these are for the App team's testing and
support, from a terminal or a script, on **any** person or trip. They live under `/internal/v1` (not `/app/v1`) and are
not in Appendix C.

- **Off unless `INTERNAL_API_KEY` is set** (a Railway variable, docs/DEPLOY.md). Every request must send the header
  `x-internal-key: <INTERNAL_API_KEY>` (compared in constant time). With the variable unset, or the header missing or
  wrong, every route answers `404 not_found` exactly as an unknown path does, before any rule about the body or query.
- **No CORS, ever**: no `Access-Control-*` headers and no preflight answer, even for the web app's own origins, so a
  browser page cannot call them and the key stays off the web.
- **30 calls a minute** per caller address (`429 rate_limited` with `Retry-After`, then the usual error shape).
- **Logged**, one line per call: `[internal] <route> <person=… | trip=… | by email> → <status>`. Never a name, an email
  or the key.
- No bearer token. The answers and errors otherwise use the app's shapes (§1.5).

| Method & path | Request | Answer | Errors | Does |
|---|---|---|---|---|
| `GET /internal/v1/people?email=<email>` | — | `{ "person_id", "name", "created_at", "deleted": boolean }` (`no-store`) | 404 no such email | Looks a person up by their sign-in email, ignoring case. A deleted account has no email left, so it is not found. |
| `DELETE /internal/v1/people/:person_id` | — | `202`, no body | 404 unknown or already deleted; 502 Go could not forget (nothing was deleted) | **The same account deletion as `DELETE /me`** (§4.1): Go forgets the person everywhere, their join answers go, they leave every trip, their messages and the pills that named them read "Former member", their email, phone, UPI id and photo go, their tokens get `401`. |
| `POST /internal/v1/people/:person_id/forget` | `{ "trip_id"? }` | Go's count: `{ "deleted_facts", "remaining_facts": 0 }` | 404 unknown person; 403 never in that trip; 502/504 Go did not answer | **The same as `DELETE /me/go`** (§4.13): Go forgets the person in one trip, or everywhere without `trip_id`; the Server clears their join answers there too. |
| `POST /internal/v1/trips/:trip_id/reset` | — | `{ "deleted": true }` | 404 no such trip | **Destructive, for test trips only.** Hard-deletes the trip and everything in it in one transaction: messages, reactions, votes and decisions, record lines, bookings with their documents and check-ins, expenses, settlements, spend approvals and option picks, invites, the people's memberships, Go's request answers and the outbox (events not yet sent are never sent). The people themselves stay, as do their uploads and files in Storage. Everyone who was in the trip gets `home_changed`. Go is told nothing: its next `read_trip` answers `not_found`, which the contract reads as "this trip is gone". Cannot be undone. |

## Appendix A: limits and rate limits

As the code enforces them today. The per-minute limits are counted **per Server instance** (in memory; with several
instances the real limit is that many times higher). Every `429` carries `retry_after_seconds` and `Retry-After`.

| Thing | Limit |
|---|---|
| Message text | 4,000 characters (a system message is cut to 4,000) |
| Attachments per message | 10; each ≤ 25 MB; caption ≤ 500 |
| `mentions` | 30 |
| Messages | **30 per minute per person per trip** (`429`, `retry_after_seconds: 10`) |
| Reactions | **20 per minute per person per trip** |
| Card taps | **10 per minute per person per trip**; a repeat of a `press_id` already counted is free |
| Option details | **10 lookups of Go per minute per person per trip**; an answer kept in the last hour is free |
| Votes | **20 per minute per person** (cast, moved or taken back) |
| Typing frames | 1 `on` per 2 s per trip per socket; a person's typing runs out after 6 s, Go's after 10 s |
| City search | **5 per second per person** |
| Invite preview (`GET /invites/:code`) | **30 per minute per IP address** |
| `POST /me/vault-link` | **6 per minute per person**, counting only the calls that reach Go (not a 422 or 403) |
| Uploads (`POST /uploads`) | **20 per minute per person** |
| Idempotency-Key | 1 to 128 characters; kept 24 hours |
| Live socket | 1 per (person, device); 50 trips per socket; replay ≤ 200 messages and < 900 KB (else `resync`); inbound frame ≤ 64 KB; ticket 30 s, single use; heartbeat 25 s, 2 missed pongs |
| Message pages | history: `limit` 1-100 (default 50); changes: 1-200 (default 200) |
| Transactions page | `limit` 1-100 (default 50) |
| Cards query | 100 newest cards |
| Uploads | ≤ 25 MB; MIME allow-list (§4.5); upload URL good 2 h; unused upload deleted after 24 h; `name` ≤ 200 |
| Trip | title 80, `destination_hint` 80, `stay` 80, `vibe` 10 × 40 (on create), itinerary 30 days and ≤ 262,144 bytes as JSON, nesting ≤ 32 levels, `budget_per_person_minor` ≥ 1 |
| Join answers | `from_city` 60, `earliest_leave` 60, `know` 20 × 80 |
| Vote | question 200, options 2-10, label 120, note 120, `option_index` 0-9 |
| Booking | title 120, vendor 80, ref 80, `for_person_ids` 30, `details` 20 × (40, 120), `passengers` 30 (seat 8, pnr 20), stop name 80, code 8, carrier name 60, carrier code 8, number 20, place name 120, address 200, `place_id` 256, `photos` 12 (label 1-40) |
| Expense | note 120, split 1-30 |
| Settlement | note 120; `currency` `^[A-Z]{3}$` |
| Profile | name 80, UPI id `^[\w.\-]{2,256}@[a-zA-Z]{2,64}$`, `photo_url` an `https://` link |
| Check-in | seat `^[0-9]{1,3}[A-Z]{1,2}$`, mobile `^\+?[0-9 ]{5,20}$` |
| Card action | `action_id` ≤ 32 (`^[a-z][a-z_]{0,31}$`), ids ≤ 64 |
| Body | ≤ 1 MiB (`413`); no NUL, no unpaired surrogate, no `__proto__` |
| Per trip (contract) | people 30, decisions 100, bookings 100, expenses 500, record lines 300 |

Every `429` carries `retry_after_seconds` in the body and a `Retry-After` header.

## Appendix B: timeouts when the Server waits on Go

| Server → Go | Go's limit | The Server waits | If it fails, the app sees |
|---|---|---|---|
| `send_event` (the outbox) | 2 s | 2.5 s | nothing: the outbox retries after 1 s, 5 s, 30 s, 2 min, 10 min, then every 10 min, and gives up after 24 h |
| `card_tap` | 3 s | 3.5 s | `200 { "result": "refused", "toast": "Go didn't answer. Try again." }` (also when Go refuses, is busy or answers badly) |
| `catch_up` | 3 s | 3.5 s | `204` on a timeout; `go_unavailable` (502/503) or `429` on another failure |
| `get_person`, `update_person`, `delete_fact`, `forget_person`, `vault_link` | 2 s | 2.5 s | `504 go_unavailable` (timeout), `503` (Go refused), `502` (Go's answer did not match the contract, or facts remain after forgetting), `429 rate_limited` with `Retry-After` (Go busy), `404`/`409` passed through |
| `get_checkin` | 2 s | 2.5 s | the cached state, or `502 go_unavailable` when there is none |
| `submit_checkin` | 2 s | 2.5 s | `502 go_unavailable` (your answers are kept) |
| `forget_person` inside `DELETE /me` | 2 s | 2.5 s | `502 go_unavailable` and nothing is deleted |
| Go → Server (all 18 requests) | 2 s | — | per `llms-full.txt` |

## Appendix C: endpoint index

The routes in the route metadata of `src/api/v1/*.ts` (71, counted by a test; dev-only routes excluded), kept in step by hand. Paths are under `/app/v1`. The internal routes (§10) are not app routes and are not listed.

| § | Method | Path | Sign-in |
|---|---|---|---|
| §3 | `POST` | `/live/ticket` | bearer |
| §3 | `GET` | `/live` | WebSocket, `?ticket=` |
| §4.1 | `GET` | `/me` | bearer |
| §4.1 | `PATCH` | `/me` | bearer |
| §4.1 | `PUT` | `/me/upi` | bearer |
| §4.1 | `DELETE` | `/me/upi` | bearer |
| §4.1 | `POST` | `/me/vault-link` | bearer |
| §4.1 | `DELETE` | `/me` | bearer |
| §4.2 | `GET` | `/home` | bearer |
| §4.2 | `GET` | `/discover/ideas` | bearer |
| §4.3 | `GET` | `/invites/:code` | public |
| §4.3 | `POST` | `/invites/:code/accept` | bearer |
| §4.4 | `POST` | `/trips` | bearer |
| §4.4 | `GET` | `/trips/:trip` | bearer |
| §4.4 | `PATCH` | `/trips/:trip` | bearer |
| §4.4 | `GET` | `/trips/:trip/invite` | bearer |
| §4.4 | `POST` | `/trips/:trip/invite/rotate` | bearer |
| §4.4 | `GET` | `/trips/:trip/me` | bearer |
| §4.4 | `PUT` | `/trips/:trip/me/join-answers` | bearer |
| §4.4 | `PATCH` | `/trips/:trip/me` | bearer |
| §4.4 | `POST` | `/trips/:trip/leave` | bearer |
| §4.4 | `POST` | `/trips/:trip/read` | bearer |
| §4.5 | `POST` | `/uploads` | bearer |
| §4.6 | `GET` | `/trips/:trip/messages` | bearer |
| §4.6 | `POST` | `/trips/:trip/messages` | bearer |
| §4.6 | `PATCH` | `/trips/:trip/messages/:id` | bearer |
| §4.6 | `DELETE` | `/trips/:trip/messages/:id` | bearer |
| §4.6 | `PUT` | `/trips/:trip/messages/:id/reaction` | bearer |
| §4.6 | `GET` | `/trips/:trip/catch-up` | bearer |
| §4.7 | `POST` | `/trips/:trip/cards/:card_id/actions` | bearer |
| §4.7 | `GET` | `/trips/:trip/cards/:card_id/options/:option_id/details` | bearer, member |
| §4.8 | `GET` | `/trips/:trip/decisions/:id` | bearer |
| §4.8 | `POST` | `/trips/:trip/decisions` | bearer |
| §4.8 | `PUT` | `/trips/:trip/decisions/:id/vote` | bearer |
| §4.8 | `DELETE` | `/trips/:trip/decisions/:id/vote` | bearer |
| §4.8 | `POST` | `/trips/:trip/decisions/:id/close` | bearer |
| §4.8 | `POST` | `/trips/:trip/decisions/:id/cancel` | bearer |
| §4.8 | `POST` | `/trips/:trip/decisions/:id/mandate/confirm` | bearer |
| §4.8 | `POST` | `/trips/:trip/decisions/:id/mandate/decline` | bearer |
| §4.8 | `GET` | `/trips/:trip/record` | bearer |
| §4.8 | `POST` | `/trips/:trip/record/:line_id/undo` | bearer |
| §4.8 | `POST` | `/trips/:trip/record/:line_id/redo` | bearer |
| §4.9 | `GET` | `/trips/:trip/money` | bearer |
| §4.9 | `GET` | `/trips/:trip/transactions` | bearer |
| §4.9 | `GET` | `/trips/:trip/expenses` | bearer |
| §4.9 | `POST` | `/trips/:trip/expenses` | bearer |
| §4.9 | `PATCH` | `/trips/:trip/expenses/:id` | bearer |
| §4.9 | `DELETE` | `/trips/:trip/expenses/:id` | bearer |
| §4.9 | `POST` | `/trips/:trip/settlements` | bearer |
| §4.9 | `POST` | `/trips/:trip/transfers/pay-link` | bearer |
| §4.10 | `GET` | `/trips/:trip/bookings` | bearer |
| §4.10 | `GET` | `/trips/:trip/bookings/:id` | bearer |
| §4.10 | `GET` | `/trips/:trip/bookings/:id/documents/:document_id` | bearer |
| §4.10 | `POST` | `/trips/:trip/bookings` | bearer |
| §4.10 | `PATCH` | `/trips/:trip/bookings/:id` | bearer |
| §4.10 | `POST` | `/trips/:trip/bookings/:id/cancel-vote` | bearer |
| §4.10 | `GET` | `/trips/:trip/itinerary` | bearer |
| §4.11 | `GET` | `/trips/:trip/cards` | bearer |
| §4.11 | `POST` | `/trips/:trip/cards/:card_id/share` | bearer |
| §4.11 | `GET` | `/trips/:trip/needs-you` | bearer |
| §4.12 | `GET` | `/trips/:trip/bookings/:booking_id/checkin` | bearer |
| §4.12 | `PATCH` | `/trips/:trip/bookings/:booking_id/checkin` | bearer |
| §4.12 | `POST` | `/trips/:trip/bookings/:booking_id/checkin/complete` | bearer |
| §4.13 | `GET` | `/me/go` | bearer |
| §4.13 | `PATCH` | `/me/go` | bearer |
| §4.13 | `DELETE` | `/me/go/facts/:fact_id` | bearer |
| §4.13 | `DELETE` | `/me/go` | bearer |
| §4.14 | `GET` | `/places/cities` | bearer |
| §4.14 | `GET` | `/places/cities/top` | bearer |
| §4.14 | `GET` | `/config` | public |
| §4.14 | `GET` | `/health` | public |
