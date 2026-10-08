# Go: App ↔ Server API contract (v1 draft, rev 2)

Derived page by page from the current Go web app (Next.js PWA, `go-frontend`), and aligned with the Server↔Go contract the Server team already planned (`https://vestrago.vercel.app/llms-full.txt`, contract version 1.0.0).

**Audience:** the Server team (Nishanth's), and the coding agent they feed this to. **Read this whole page first, then build in the order of [Build order](#build-order).**

**What changed in rev 2** (after a check against `llms-full.txt` and the app code)
- Taking a vote back is **not** in Go's contract: `DELETE …/vote` is now 🔶 (§4.8, §9.13).
- New: who books for the group ("one person books for all", the `claim` card action, §4.8, §9.14).
- Web sessions keep the refresh token in an **httpOnly cookie**, not in JavaScript (§1.2, §4.1).
- `GET /invites/:code` no longer changes anything; "Not now" is `POST /invites/:code/later` (§4.3).
- `GET …/messages` spells out its two modes and their sort orders (§1.6, §4.6).
- Smaller fixes: record lines and `include_undone` (§4.8), payment methods (§2), the "Stay?" chip (§5.11), trip-level `vibe` (§4.4, §11), the invite push replaced by a "friend joined" push (§8; invite links are not addressed to an account).
- A build order (§0).

---

## Contents

- [0. How this relates to what the Server team already planned](#0-how-this-relates-to-what-the-server-team-already-planned)
  - [Status legend (used on every endpoint and card)](#status-legend-used-on-every-endpoint-and-card)
  - [Rules of precedence](#rules-of-precedence)
  - [One difference from the Server team's assumptions](#one-difference-from-the-server-teams-assumptions)
  - [Build order](#build-order)
- [1. Conventions](#1-conventions)
  - [1.1 Base URL, versions, transport](#11-base-url-versions-transport)
  - [1.2 Authentication](#12-authentication)
  - [1.3 Ids, money, time, JSON rules (identical to `llms-full.txt` Basics)](#13-ids-money-time-json-rules-identical-to-llms-fulltxt-basics)
  - [1.4 Doing things once (idempotency)](#14-doing-things-once-idempotency)
  - [1.5 Errors](#15-errors)
  - [1.6 Pagination, caching, consistency](#16-pagination-caching-consistency)
  - [1.7 Privacy rules the Server enforces on every App response](#17-privacy-rules-the-server-enforces-on-every-app-response)
- [2. Object shapes](#2-object-shapes)
- [3. The live connection (WebSocket)](#3-the-live-connection-websocket)
  - [3.1 Frames](#31-frames)
  - [3.2 Ordering and what the app keeps](#32-ordering-and-what-the-app-keeps)
  - [3.3 Reconnect](#33-reconnect)
  - [3.4 Limits](#34-limits)
- [4. Endpoints](#4-endpoints)
  - [4.1 Sign-in, session and "Me"](#41-sign-in-session-and-me)
  - [4.2 Home](#42-home)
  - [4.3 Invites](#43-invites)
  - [4.4 Trips: create, read, my answers](#44-trips-create-read-my-answers)
  - [4.5 Uploads (photos, files, voice notes)](#45-uploads-photos-files-voice-notes)
  - [4.6 The room: messages, replies, reactions, "Ask Go about this", catch-up](#46-the-room-messages-replies-reactions-ask-go-about-this-catch-up)
  - [4.7 Go's cards: taps, "open this page", the vault](#47-gos-cards-taps-open-this-page-the-vault)
  - [4.8 Votes, the mandate ("Yes, book it"), and the trip record](#48-votes-the-mandate-yes-book-it-and-the-trip-record)
  - [4.9 Money: Expenses tab, Transactions, "Record a payment", settle up](#49-money-expenses-tab-transactions-record-a-payment-settle-up)
  - [4.10 Bookings, tickets and the itinerary](#410-bookings-tickets-and-the-itinerary)
  - [4.11 Trip home: "needs you", Go's calls, the chat button](#411-trip-home-needs-you-gos-calls-the-chat-button)
  - [4.12 Web check-in (boarding pass)](#412-web-check-in-boarding-pass)
  - [4.13 "What Go knows about you", forget me, pause Go (the You screen)](#413-what-go-knows-about-you-forget-me-pause-go-the-you-screen)
  - [4.14 Places, config and health](#414-places-config-and-health)
- [5. Screen by screen: what each page reads, writes and listens to](#5-screen-by-screen-what-each-page-reads-writes-and-listens-to)
  - [5.1 Welcome: `/`](#51-welcome)
  - [5.2 App home: `/home`](#52-app-home-home)
  - [5.3 Profile: `/profile`](#53-profile-profile)
  - [5.4 Invite landing: `/invite/:code`](#54-invite-landing-invitecode)
  - [5.5 Who's coming: `/trips/new`](#55-whos-coming-tripsnew)
  - [5.6 Trip home: `/trips/:id`](#56-trip-home-tripsid)
  - [5.7 Itinerary: `/trips/:id/itinerary`](#57-itinerary-tripsiditinerary)
  - [5.8 Bookings: `/trips/:id/bookings`](#58-bookings-tripsidbookings)
  - [5.9 Ticket viewer: `/trips/:id/bookings/:bid/ticket`](#59-ticket-viewer-tripsidbookingsbidticket)
  - [5.10 Expenses: `/trips/:id/expenses` and Transactions](#510-expenses-tripsidexpenses-and-transactions)
  - [5.11 Chat: `/trips/:id/chat`](#511-chat-tripsidchat)
  - [5.12 Boarding pass: `/trips/:id/checkin/pass`](#512-boarding-pass-tripsidcheckinpass)
  - [5.13 Offline: `/~offline`](#513-offline-offline)
- [6. Cards: how the app draws every card kind](#6-cards-how-the-app-draws-every-card-kind)
- [7. What the Server must do for Go on every App action (no change to the Server↔Go plan)](#7-what-the-server-must-do-for-go-on-every-app-action-no-change-to-the-servergo-plan)
- [8. Push notifications](#8-push-notifications)
- [9. Additions the app needs from Go's contract (proposed)](#9-additions-the-app-needs-from-gos-contract-proposed)
- [10. Migration notes for the front-end (so both teams share one picture)](#10-migration-notes-for-the-front-end-so-both-teams-share-one-picture)
  - [10.1 Why payments never happen in the app (the one rule to keep)](#101-why-payments-never-happen-in-the-app-the-one-rule-to-keep)
- [11. Open questions for the Server team and Go](#11-open-questions-for-the-server-team-and-go)
- [12. Acceptance scenarios (an end-to-end check the two teams can run)](#12-acceptance-scenarios-an-end-to-end-check-the-two-teams-can-run)
- [Appendix A: limits and rate limits (defaults; tune freely)](#appendix-a-limits-and-rate-limits-defaults-tune-freely)
- [Appendix B: timeouts when the Server waits on Go (from `llms-full.txt`)](#appendix-b-timeouts-when-the-server-waits-on-go-from-llms-fulltxt)
- [Appendix C: endpoint index](#appendix-c-endpoint-index)

---


## 0. How this relates to what the Server team already planned

The Server team's prompt covers one layer: the signed WebSocket from the **Server to Go** (socket client, `send_event` outbox, answers to Go's 18 requests). Their own guide says the other layer is open: *"The `/app/...` paths are examples: the app's API is yours to design."*

This document defines that other layer, **App ↔ Server**, from what every screen of the current app actually reads and writes.

```
 App (PWA / mobile)  ──HTTP + live WebSocket──►  Server  ──signed WebSocket (llms-full.txt)──►  Go
   this document                                  its database                                   Keshav's team
```

| Layer | Owner of the spec | Status |
|---|---|---|
| Server ↔ Go (socket, 18 Go requests, 8 Server requests, 20 events, 13 card kinds, spend check, vault) | `llms-full.txt` | **Unchanged and adopted as is.** Where this page and `llms-full.txt` disagree about Server↔Go, **`llms-full.txt` wins.** |
| App ↔ Server (HTTP + live connection) | **this document** | New. Where it disagrees with the examples in the App guide, this page wins. |
| Additions the app needs from Go's contract | §9 | **Proposed.** Needs a yes from Keshav's team. Nothing in §9 blocks the rest. |

### Status legend (used on every endpoint and card)

| Mark | Meaning |
|---|---|
| ✅ **Contract** | Already in `llms-full.txt`. Reuse the object and rule exactly. |
| 🆕 **Server-only** | New App↔Server behaviour. Pure Server work, no change to Go. |
| 🔶 **Needs Go** | Needs a contract addition (§9). The app degrades as described until it lands. |

### Rules of precedence

1. **The guide wins** (their rule, kept): when a rule is unclear, follow `llms-full.txt`, or ask. Never guess.
2. **The App talks only to the Server.** It never connects to Go and never holds `GO_SIGNING_SECRET`. The only direct contact is opening a Go page (the vault, watching Go work) from a link the Server hands over, in the system browser sheet, never a WebView.
3. **Record cards are drawn from the Server's own rows** (`vote`, `mandate`, `ticket`, `expense`, `settle_up`, `day`, `plan`, `budget`). **Go cards are drawn from the card itself** (`options`, `working`, `call`, `pay`, `notice`). The Server stores a card exactly as it arrived (`raw.card`) and never rewrites it.
4. **`person_id` always comes from the session**, never from the request body.

### One difference from the Server team's assumptions

Their App guide assumes a **Flutter** app (`url_launcher`, `LaunchMode.inAppBrowserView`). The app this contract was derived from is a **Next.js PWA**. The API is client-agnostic, but three things differ and are handled here: push is **Web Push** (VAPID) as well as APNs/FCM (§8), sign-in is **Google Identity Services** returning an ID token (§4.1), and Go pages open with `window.open` / an in-app browser tab. Passkeys (Face ID) still work, because it is a real browser, not a WebView.

### Build order

The Server team's own plan (socket client → outbox → Go's 18 requests) comes first and is unchanged; the App layer reads and writes the same tables. Then build the App layer in this order. Each step is usable by the app on its own.

| Step | Build | Sections | Marks |
|---|---|---|---|
| 1 | Conventions: error body, `Idempotency-Key` store, `X-Request-Id`, CORS, `GET /config`, `GET /health` | §1, §4.14 | 🆕 |
| 2 | Sign-in and sessions, `Me`, devices | §1.2, §4.1 | 🆕 |
| 3 | Trips and invites: create, read (`TripView`), invite preview/accept/later/decline, join answers, budget, pause Go, mark read | §4.3, §4.4 | ✅ + 🆕 |
| 4 | The live connection: ticket, `subscribe`, `message` / `card` / `typing` / `trip_changed` / `home_changed`, replay and `resync` | §3 | 🆕 |
| 5 | The room: messages (both read modes), send, reactions, uploads, catch-up, Go card taps, vault link | §4.5, §4.6, §4.7 | ✅ + 🆕 |
| 6 | Votes (cast and move), mandate, trip record, "needs you", `GET …/cards` | §4.8, §4.11 | ✅ + 🆕 |
| 7 | Home, money (`MoneyView`, transactions), bookings, itinerary (`scope=everyone`), You screen, places | §4.2, §4.9, §4.10, §4.13, §4.14 | ✅ + 🆕 |
| 8 | Pushes | §8 | 🆕 |
| 9 | Server-only extras: settlements, pay link, nudge, fix split, invite rotate | §4.9, §4.4 | 🆕 |
| 10 | **Only after Keshav's team agrees:** everything 🔶 in §9 (taking a vote back, claim, flexible vote, check-in, calls, documents, checklist, ...). Ship each behind a `features` flag in `GET /config`. | §9 | 🔶 |

Do not start a 🔶 item before step 10: its shape may change when Go's team answers.

---

## 1. Conventions

### 1.1 Base URL, versions, transport

| | |
|---|---|
| Base | `https://api.<env>.go.example/app/v1` (the three routes the Server guide gives as examples, `/app/trips/:tripId/cards/:cardId/actions`, `/app/me/go`, `/app/me/vault-link`, are adopted under this prefix) |
| Live connection | `wss://api.<env>.go.example/app/v1/live` (§3) |
| Format | JSON, UTF-8, `Content-Type: application/json`. Uploads go straight to object storage (§4.5). |
| Versioning | Additive only inside `v1` (new fields, new endpoints, new frame types). Clients ignore unknown fields and unknown frame/card kinds. A breaking change is a new `/app/v2`. |
| CORS | Allow-list the PWA origin(s) exactly (no `*`). `Authorization`, `Idempotency-Key` and `X-Go-Client` are allowed headers. `Access-Control-Allow-Credentials: true` (needed for the refresh cookie, §1.2). |

### 1.2 Authentication

- `POST /auth/google` exchanges a Google ID token for a session (§4.1). The Server verifies the token's signature against Google's keys and checks `iss`, `aud` (our client id), `exp`, and `email_verified`. The person is keyed by Google's `sub`, never by email.
- Requests carry `Authorization: Bearer <access_token>`. Access tokens are short-lived (15 minutes). A refresh token rotates on every use (§4.1).
- **Where the refresh token lives depends on the client:**

| Client (`device.platform`) | Access token | Refresh token |
|---|---|---|
| `web` (the PWA) | In memory only (never `localStorage`) | **An httpOnly cookie** set by the Server: `go_refresh=…; HttpOnly; Secure; SameSite=Strict; Path=/app/v1/auth; Max-Age=2592000`. It is **never** in a response body, so page JavaScript (and any XSS) cannot read it. |
| `ios`, `android` | In memory | In the response body; the app keeps it in the Keychain / Keystore. |

- **CSRF:** only `/auth/refresh` and `/auth/logout` read the cookie. Those two routes require the header `X-Go-Client: web` (a custom header forces a CORS preflight) **and** an `Origin` on the allow-list; otherwise `403 forbidden`. Every other route uses the `Authorization` header only, so it is not exposed to CSRF.
- On a page load the PWA calls `POST /auth/refresh` first (the cookie rides along) to get an access token; a `401` means signed out.
- Every route below is authenticated unless marked **public**. Public: `GET /invites/:code` (§4.3), `GET /config`, `GET /health`.
- Every trip route checks that the signed-in person is **in that trip now** (a person who left is not). Otherwise `403 forbidden`. An unknown trip is `404 not_found` (never reveal that a trip exists to a non-member).

### 1.3 Ids, money, time, JSON rules (identical to `llms-full.txt` Basics)

- Ids are opaque strings of 1 to 64 characters. The app never parses them. (The prototype used literals such as `"goa"` and `"rahul"`; the real app must not.)
- **Money is a whole number in the smallest unit plus a currency**, field names end in `_minor`: ₹54,200 is `{ "amount_minor": 5420000, "currency": "INR" }`. Never a float. **The prototype stores whole rupees; its API adapter multiplies by 100 on the way out and divides on the way in.** A trip has one currency.
- Times are ISO 8601 with an offset (UTC `Z` preferred). Dates without a time are `YYYY-MM-DD`. An itinerary time of day is `HH:MM` local to the destination.
- Field names are `snake_case`. **Null and missing mean the same thing.** Unknown fields are ignored. Unknown enum values must not crash a client (render a safe fallback).

### 1.4 Doing things once (idempotency)

Networks drop and phones sleep, so every write must be safe to send twice.

| Mechanism | Used for | Server must |
|---|---|---|
| `Idempotency-Key: <uuid>` header | Every `POST`, `PUT`, `PATCH`, `DELETE` that creates or changes something (all writes in this document unless noted) | Store the key with the response for 24 hours, scoped to `(person_id, method, path)`. A repeat returns the **first response, same status code and body**. A repeat with a different body is `422 invalid` (`idempotency_key_reused`). |
| `client_message_id` (body) | Sending a chat message (§4.6) | Unique per `(trip_id, person_id, client_message_id)`. Lets the app show "sending" and then replace the bubble with the stored message. |
| `press_id` (body) | Tapping a button on a Go card (§4.7) | Becomes the `tap_id` sent to Go, so a double tap that gets through is one tap. |
| `request_id` | Go → Server writes | As in `llms-full.txt`: unique `(trip_id, request_id)`, same answer on repeat. Not an app concern. |

### 1.5 Errors

Every non-2xx response has this body. `code` names are the contract's, plus the HTTP-only ones.

```json
{
  "error": {
    "code": "conflict",
    "message": "This vote is already closed.",
    "field": null,
    "retry_after_seconds": null,
    "request_id": "req_01JA7Q3V8Z"
  }
}
```

| HTTP | `error.code` | Meaning | Client retries? |
|---|---|---|---|
| 400 | `bad_request` | Body could not be parsed | No |
| 401 | `unauthorized` | Missing, expired or invalid token | Refresh once, then sign in again |
| 403 | `forbidden` | Not in this trip, or not allowed (e.g. not the payer) | No |
| 404 | `not_found` | Trip, card, message, line or other id does not exist for this person | No |
| 409 | `conflict` | Clashes with current state (vote closed, mandate already answered) | No: re-read and decide again |
| 422 | `invalid` | Body does not match the contract; `field` names the field | No |
| 429 | `rate_limited` | `retry_after_seconds` says how long | Yes, after that wait |
| 500 | `internal` | Server bug | Yes, with backoff |
| 502/504 | `go_unavailable` | Something that needs Go (catch-up, "what Go knows", vault link, card tap) did not get an answer in time | **Not automatically.** A person is waiting: show the message and let them tap again. |
| 503 | `unavailable` | Down for a moment (deploy) | Yes, with backoff |

`message` is plain words safe to show to a person. It is at most 500 characters. Include `X-Request-Id` on every response.

### 1.6 Pagination, caching, consistency

- There are **two paging styles, on purpose**:
  - **Opaque cursors** for lists that are only read page by page (transactions): `?limit=50&before=<cursor>` returning `{ "items": [...], "next_cursor": "..." | null }`. The app never builds or parses a cursor.
  - **Change numbers** for messages, because the same numbers are the sync point for the live connection: `before_seq` (scroll back) and `after_seq` (catch up on changes), returning `{ "messages": [...], "has_more": boolean, ... }`. The two modes sort differently; §4.6 spells them out.
- **`seq` is the trip's change number.** Any read of trip data returns the `seq` it is consistent with. Build snapshots from one transaction so `seq` matches the data (same rule as `read_trip`).
- `GET /trips/:id` supports `ETag` / `If-None-Match` (the ETag is `seq`) so a refetch after `trip_changed` is cheap when nothing moved.
- Respond to all list endpoints with `Cache-Control: private, no-store` (data is per person).

### 1.7 Privacy rules the Server enforces on every App response

These mirror `llms-full.txt` People and privacy, and apply to the App as well as to Go:

- **Other people's budget answers are never returned**, only the summary (`lowest` band, `answered`, `of`). The caller's own answer is returned in `me.budget`.
- **No phone numbers, emails or UPI ids of other people.** `has_upi` is a boolean. The UPI id stays on the Server (a pay link is built there, §4.9).
- **An anonymous vote has no `votes` list**, only `voted`, `of`, `tally`. The Server still knows who voted (for the "needs you" strip), and returns that person's own `my_vote`.
- **When a person pauses Go, the room still sees their messages in full.** `withheld` is only ever for Go: the App always receives the text.
- **Passport and ID data never passes through the Server** (§9.8).

---

## 2. Object shapes

The App reuses these objects from `llms-full.txt` **unchanged**: `Message`, `Actor`, `Attachment`, `Reaction`, `Card` (all 13 kinds), `CardAction`, `Person`, `Decision`, `DecisionOption`, `Mandate`, `Booking`, `Expense`, `Money`, `Transfer`, `RecordLine`, `Proof`, `Day`, `ItineraryItem`, `Place`, `Journey`, `BudgetSummary`, `TripSnapshot`, `CatchUp`, `PersonPage`, `Fact`, `ForgetResult`, `Link`, `CardActionResult`.

Fields the app needs on top of them are listed in §9 (marked 🔶). The new, **Server-only** shapes follow. They are TypeScript-style for brevity; every field name is `snake_case` on the wire.

```ts
type Id = string;
type Iso = string;          // ISO 8601 with offset
type Currency = string;     // ISO 4217, e.g. "INR"

// ---- who I am -------------------------------------------------------------
interface Me {
  person_id: Id;
  name: string;                        // ≤ 80
  email: string;                       // the signed-in account's own email (never shown to others)
  photo_url?: string;
  auth_provider: "google";
  from_city?: string;                  // profile default; per-trip answers live on Person.from_city
  has_upi: boolean;
  upi_id_masked?: string;              // "aar••••@okhdfc"; the full id never leaves the Server
  notifications_enabled: boolean;      // the single "Trip notifications" switch
  counts: { active_trips: number; past_trips: number; pending_invites: number };
  created_at: Iso;
}

// ---- home -----------------------------------------------------------------
interface PersonLite { person_id: Id; name: string; photo_url?: string }

interface TripSummary {
  trip_id: Id;
  title: string;                       // "Goa 🌴"
  status: "planning" | "booked" | "on_trip" | "over";   // = TripSnapshot.status
  stage: "new" | "deciding" | "planned";               // see §4.4 "stage"
  destination?: Place;
  dates?: { start: string; end: string };              // client formats "Fri 6 – Mon 9 Nov" and "in 34 days"
  cover_url?: string;                  // home card photo
  hero_url?: string;                   // trip home hero photo
  illustration_url?: string;           // chat header / share card avatar
  people_preview: PersonLite[];        // up to 4, organizer first
  people_count: number;
  attention:                           // drives the card's status line
    | { kind: "needs_you"; count: number }             // "2 things pending on you"
    | { kind: "all_set" }                              // "You're all set"
    | { kind: "collecting" }                           // "Go is collecting everyone's answers"
    | { kind: "task"; label: string };                 // e.g. "Visa details needed"
  last_activity_at: Iso;
}

interface InviteSummary {
  code: string;
  trip: { trip_id: Id; title: string; cover_url?: string; illustration_url?: string; dates?: { start: string; end: string } };
  inviter: PersonLite;
  people_preview: PersonLite[];        // who is already in, invite-card order
  joined_count: number;
  received_at: Iso;
}

interface PastTripSummary {
  trip_id: Id;
  title: string;
  illustration_url?: string;
  dates?: { start: string; end: string };
  people_count: number;
  all_settled: boolean;                // "all settled"
}

interface Idea {                       // 🆕, §4.4. Curated or Go-suggested destination ideas
  idea_id: string;
  name: string;                        // "Coorg"
  tag: string;                         // "Coffee hills"
  travel: { mode: "flight" | "car" | "train" | "bus"; duration_minutes: number };
  image_url: string;
}

// ---- one trip -------------------------------------------------------------
interface TripView extends TripSnapshot {   // the contract's TripSnapshot, as the App may see it
  stage: "new" | "deciding" | "planned";
  me: {
    person: Person;
    budget: { min_minor: number; max_minor: number | null; currency: Currency } | null;  // MY private answer only
    last_read_seq: number;
    unread_count: number;
  };
  chat: {                                   // for the "Chat" floating button
    unread_count: number;
    last_message?: { message_id: Id; author: Actor; text_preview: string; sent_at: Iso };
    participants_preview: Array<{ kind: "go" } | { kind: "person"; person_id: Id }>;   // up to 4
  };
  needs_you_count: number;
  can: { invite: boolean; manage_trip: boolean };   // manage_trip = organizer
}

// ---- needs you (the strip + trip home "Pending on you") -------------------
interface NeedsYouItem {
  item_id: string;                          // stable per underlying thing
  kind: "vote" | "mandate" | "card" | "record_line" | "settle_up";
  title: string;                            // plain words, e.g. "Where do we stay?"
  subtitle?: string;                        // e.g. "closes in 1 hour"
  cta_label?: string;                       // e.g. "Vote", "Yes, book it", "Settle up"
  since: Iso;
  target: {
    message_id?: Id; card_id?: string; decision_id?: Id; line_id?: Id;
    transfer?: { to_person_id: Id; amount_minor: number; currency: Currency };
  };
}

// ---- money ----------------------------------------------------------------
interface Transaction {                     // the Transactions page rows: bookings + paybacks, newest first
  transaction_id: Id;
  kind: "booking" | "payback";              // booking = an Expense (optionally tied to a Booking); payback = a Settlement
  occurred_at: Iso;
  payer_person_id: Id;
  verb: "paid" | "booked_with";
  to: { kind: "person"; person_id: Id } | { kind: "merchant"; name: string; logo_url?: string; emoji?: string };
  amount_minor: number;
  currency: Currency;
  method?: "upi" | "cash" | "card" | "bank_transfer" | "other";  // "card" only on bookings paid through the vault;
                                            // paybacks carry their Settlement.method (never "card": the app cannot record a card payback)
  note?: string;
  mine: boolean;                            // I am the payer or a payee/share-holder
  expense_id?: Id; booking_id?: Id; settlement_id?: Id;
}

interface Settlement {                      // 🆕 a payment between two people made outside Go (UPI, cash...)
  settlement_id: Id;
  from_person_id: Id;
  to_person_id: Id;
  amount_minor: number;
  currency: Currency;
  method: "upi" | "cash" | "bank_transfer" | "other";
  note?: string;
  status: "pending_confirmation" | "confirmed" | "disputed";
  created_at: Iso;
  responded_at?: Iso;
}

interface MoneyView extends Money {         // contract Money + what the Expenses tab needs
  me: {
    budget_minor: number | null;            // my private ceiling (null until I set one)
    spent_minor: number;                    // my share of everything, by split
    by_category: Array<{ category: "stay" | "food" | "getting_around" | "activities" | "other"; amount_minor: number }>;
    owed_to_me: Transfer[];                 // subset of transfers that touch me
    i_owe: Transfer[];
  };
  seq: number;
}
```

`TripView.stage` is explained in §4.4. `Settlement` is a Server-owned object that needs a Server decision about whether Go sees it (§9.11).


---

## 3. The live connection (WebSocket)

One WebSocket per signed-in app instance, carrying every trip the person has open plus the home screen. The Server team's guide recommends four server→app messages and says the shapes are the app and Server teams' to own. This section fixes them. (Server-sent events would also work; WebSocket is chosen because the app also sends typing on it.)

`GET wss://…/app/v1/live?ticket=<ticket>`

Browsers cannot set an `Authorization` header on a WebSocket, so the app first calls `POST /live/ticket` (authenticated) and receives a **single-use ticket valid for 30 seconds**: `{ "ticket": "tk_…", "expires_at": "…" }`. A used or expired ticket closes the socket with code `4401`.

### 3.1 Frames

Every frame is a JSON object with a `type`. Unknown `type`s are ignored.

**Server → app**

| `type` | When | Body |
|---|---|---|
| `hello` | Right after connect | `{ "type":"hello", "person_id", "server_time", "heartbeat_seconds": 25 }` |
| `message` | A message is new or changed (edit, delete, a reaction added or taken back, Go's reactions included) | `{ "type":"message", "trip_id", "message": Message }`. The **whole** `Message`, unchanged, Go's card included. The app replaces the message with the same `message_id`. |
| `card` | Go replaced one of its cards in place (`replace_card`): live call, working task, pay card to paid, people removed from `for_person_ids` | `{ "type":"card", "trip_id", "message_id", "card": Card }`. **No `seq`**: a card update is not a trip change. |
| `typing` | Go (or a person) started or stopped typing | `{ "type":"typing", "trip_id", "who": {"kind":"go"} \| {"kind":"person","person_id"}, "on": boolean, "until": Iso }`. Show "Go is typing…" until `until` (10 s after the Server got Go's `typing` notification) or Go's next message lands. `"on": false` hides it at once. No `seq`. |
| `trip_changed` | Any change to the trip that is **not a message**: vote cast or closed, mandate, record line, booking, expense, settlement, someone joined/left, itinerary, budget summary | `{ "type":"trip_changed", "trip_id", "seq": number, "kinds": ["decision","record"] }`. When `seq` is higher than the app holds, the app re-reads what it is showing. `kinds` (optional hint) lets it re-read only what moved: `trip`, `people`, `decision`, `mandate`, `record`, `booking`, `expense`, `settlement`, `itinerary`, `budget`. |
| `home_changed` | The home screen's data moved: a trip created or joined, an invite kept for later, accepted or declined, a trip's `attention` changed | `{ "type":"home_changed" }`. The app re-reads `GET /home`. |
| `resync` | The Server cannot replay what the client missed | `{ "type":"resync", "trip_id" }`. The app re-reads the room from scratch (§3.3). |
| `ping` | Every `heartbeat_seconds` | `{ "type":"ping" }`. Reply with `pong`. Close the socket after 2 missed pongs. |

**App → server**

| `type` | Body | Notes |
|---|---|---|
| `subscribe` | `{ "type":"subscribe", "trips": [ { "trip_id", "since_seq": number } ] }` | Subscribe when a trip's room or Trip screens open. The Server replays `message` and `trip_changed` frames after `since_seq` (up to 500, else `resync`). The Server rejects trips the person is not in with `{ "type":"error", "trip_id", "code":"forbidden" }`. |
| `unsubscribe` | `{ "type":"unsubscribe", "trip_ids": [ … ] }` | When the person leaves a trip's screens. |
| `typing` | `{ "type":"typing", "trip_id", "on": boolean }` | Rate-limit: at most one per 2 s per trip. Fanned out to the other subscribers as a `typing` frame with `who.kind="person"`. **Never forwarded to Go** (their rule). A person's typing line runs out 6 s after the last frame. |
| `pong` | `{ "type":"pong" }` | |

Writes (sending a message, voting, etc.) are **HTTP requests**, not socket frames, so they get idempotency keys and normal status codes.

### 3.2 Ordering and what the app keeps

- The app keeps, per trip, **the highest `seq` it has seen** (a message's `updated_seq`, or a `trip_changed` `seq`).
- The Server sends the live frame **after the change is committed** (same place it writes the outbox row for Go), so the app and Go are in step.
- Typing, `card` and `home_changed` frames carry no `seq` and are never replayed.
- Show a person's own message immediately as "sending" (with its `client_message_id`), then replace it when the Server returns or pushes the stored message.

### 3.3 Reconnect

1. Reconnect after 1, 2, 5, 10 s, then every 30 s (reset to 1 s after a connect that works). On `visibilitychange → visible` reconnect at once.
2. On connect, send `subscribe` for every open trip with the stored `since_seq`.
3. If the Server answers `resync`, or the first frame's `seq` jumps by more than one, read `GET /trips/:id` and `GET /trips/:id/messages?after_seq=…` again before trusting the socket.
4. Sockets drop and phones sleep: **correctness never depends on the socket**. A pull-to-refresh or an app resume re-reads the same endpoints.

### 3.4 Limits

One live socket per `(person, device)`. A second device is allowed. At most 50 subscribed trips per socket. Frames over 1 MB are never sent (messages are paged).

---

## 4. Endpoints

All paths are under `/app/v1`. `:trip` is a `trip_id`. Unless stated, every write needs an `Idempotency-Key` (§1.4) and a signed-in member (§1.2).

### 4.1 Sign-in, session and "Me"

Used by: Welcome (`/`), Profile (`/profile`).

| Method & path | Purpose | Request | Response | Marks |
|---|---|---|---|---|
| `POST /auth/google` | "Continue with Google". Creates the account on first sign-in. | `{ "id_token": "…", "nonce": "…", "device": { "platform": "web"\|"ios"\|"android", "name"?: string, "tz"?: "Asia/Kolkata", "locale"?: "en-IN" } }` | `200 { "access_token", "expires_in": 900, "refresh_token"?, "me": Me, "is_new": boolean }`. **Web:** no `refresh_token` in the body; it is set as the `go_refresh` cookie (§1.2). **Native:** `refresh_token` in the body. | 🆕 |
| `POST /auth/refresh` | Rotate the session | **Web:** no body; the `go_refresh` cookie plus `X-Go-Client: web`. **Native:** `{ "refresh_token" }`. | `200 { "access_token", "expires_in", "refresh_token"? }` (web: a new cookie instead of the body field). The old refresh token is invalid after use; reuse of an old one revokes the whole session family. | 🆕 |
| `POST /auth/logout` | "Sign out" | **Web:** no body (cookie + `X-Go-Client: web`), optional `{ "device_id" }`. **Native:** `{ "refresh_token", "device_id"? }` | `204`. Revokes the session, clears the cookie (`Max-Age=0`) and removes that device's push registration. | 🆕 |
| `GET /me` | Profile card + settings rows | none | `Me` | 🆕 |
| `PATCH /me` | Edit profile and the notifications switch | any of `{ name, photo_upload_id, from_city, notifications_enabled }` | `Me`. Changing `name`, `photo_url` or `from_city` emits `person.updated` for **every active trip** the person is in (`changed: ["name"]`…). | 🆕 + ✅ event |
| `PUT /me/upi` | "Payment methods → UPI". The id stays on the Server. | `{ "upi_id": "name@bank" }` (validated `^[\w.\-]{2,256}@[a-zA-Z]{2,64}$`) | `Me` (`has_upi: true`, `upi_id_masked`). Emits `person.updated` `changed: ["has_upi"]`. | ✅ (`has_upi`) |
| `DELETE /me/upi` | Remove it | none | `Me` | ✅ |
| `POST /me/devices` | Register for pushes (§8) | `{ "platform": "web_push"\|"ios"\|"android", "web_push": { "endpoint", "keys": { "p256dh", "auth" } }?, "token"?: string, "locale"?, "tz"? }` | `201 { "device_id" }` | 🆕 |
| `DELETE /me/devices/:device_id` | Unregister | none | `204` | 🆕 |
| `DELETE /me` | Delete account (store and privacy requirement) | `{ "confirm": true }` | `202`. The Server sends Go `forget_person` (everywhere), clears join answers, removes the person from every trip (`person.left`), anonymises their messages as "Former member", deletes email and UPI. | 🆕 + ✅ `forget_person` |

**Rules**
- The signed-in `person_id` is the same person in every trip (their guide). There is no separate member id.
- `Me.counts` powers the Profile row "1 active · 2 past · 1 invite" (computed, never a literal).
- **Prototype-only controls ("Reset demo", "Jump to artboard") are not part of the product and have no endpoint.**

### 4.2 Home

Used by: App home (`/home`), both its states (first-run zero state and returning).

`GET /home` → one round trip for the whole screen:

```json
{
  "me": { "person_id": "p_aarav", "name": "Aarav Shah", "photo_url": "https://cdn.go.example/people/p_aarav.jpg" },
  "trips": [ TripSummary ],
  "invites": [ InviteSummary ],
  "past_trips": [ PastTripSummary ],
  "seq_hint": 4812
}
```

- `trips`: trips I am in that are not `over`, newest activity first. Empty ⇒ the app shows the first-run state (hero card, ideas carousel, "Not sure where? Ask Go").
- `invites`: invites I kept for later with "Not now" (`POST /invites/:code/later`, §4.3) and have not accepted or declined since. Invite links are shared outside the app (WhatsApp, Messages), so the Server only knows an invite is "mine" once I act on it.
- `past_trips`: `status = over`, newest first. `all_settled` is true when `money.transfers` is empty.
- `attention` on each trip is **computed by the Server** (the app never counts anything itself): `needs_you` when `needs_you_count > 0`, else `all_set` for a `planned` trip, else `collecting`. A trip may carry `attention.kind = "task"` with a `label` when one specific high-priority item exists (for example a pending visa); the rule is the Server's.
- Realtime: `home_changed` frame ⇒ re-read.

`GET /discover/ideas?from_city=<name>&limit=8` → `{ "items": [Idea], "from_city": "Bengaluru" }`. Used by the first-run "Ideas for your crew · From Bengaluru" carousel. **Source is the Server's choice** (curated table by origin city, or Go). Cache 24 h. Every idea links to `POST /trips` with `destination_hint` set (§4.4).

### 4.3 Invites

Used by: `/invite/[code]` (friend taps a link), App home invite cards, Share sheet.

| Method & path | Purpose | Request | Response |
|---|---|---|---|
| `GET /invites/:code` **public** | Landing preview behind the invite sheet. Works signed out so link unfurls (title, image) work. **Read-only: it never changes anything**, because browsers, link previews and crawlers fetch GETs on their own. When signed in, `state` is personal (`already_member`, `declined`). | none | `{ "code", "state": "pending"\|"already_member"\|"declined"\|"expired"\|"revoked", "trip": { "trip_id","title","destination"?,"dates"?,"cover_url"?,"hero_url"?,"illustration_url"? }, "inviter": PersonLite, "people_preview": [PersonLite], "joined_count": number }` |
| `POST /invites/:code/accept` | "Accept & join" | `{ "join_answers"?: JoinAnswers }` (§4.4) | `200 { "trip_id", "seq": number, "landing": "chat" \| "trip_home" }` (`chat` when the trip already has a running thread; the Server decides). Emits `person.joined` (change number from the trip's counter), a system message "Rahul joined" (§4.6), and a `home_changed`. |
| `POST /invites/:code/later` | "Not now" on the invite landing: keep the invite on my home screen for later. Idempotent. | none | `204`. The invite appears in my home `invites` (sends `home_changed`). |
| `POST /invites/:code/decline` | "Decline" on a home invite card. **The inviter is not told** (the UI promises "Priya won't be told"). | none | `204`. The invite leaves my home `invites` and `state` becomes `declined` for me; I can still accept later from the link. |

**Rules**
- An invite code is bound to a trip; it never reveals other members' contact details. The public preview shows names and photos of who is in (`people_preview`), nothing else. Codes are random, at least 10 characters, and `GET /invites/:code` is rate-limited per IP (30/min) so codes cannot be guessed.
- Accepting twice is a no-op returning the first answer. A person already in the trip gets `state: "already_member"` and `POST …/accept` returns `landing` only.
- When not signed in, the app sends the person through sign-in with `return_to=/invite/:code`.
- Expiry and revocation are the organizer's control (`POST /trips/:trip/invite/rotate`, §4.4).

### 4.4 Trips: create, read, my answers

Used by: Home FAB "New trip", Who's coming (`/trips/new`), trip shell (every `/trips/:id/*` screen), Quick start sheet, "Travelling from" sheet, Budget sheet, Pause Go.

| Method & path | Purpose | Request | Response | Marks |
|---|---|---|---|---|
| `POST /trips` | Create a trip (the "Who's coming?" screen shows its invite link) | `{ "title"?: string, "destination_hint"?: string, "dates"?: {start,end}, "from_city"?: string }`. All optional: the app may create with only a name or an idea tapped. Defaults: title from the hint or "New trip". | `201 TripView` (`people` = just me, `invite_url` set, `seq: 1`). Emits `trip.created` (change number **1**). | ✅ |
| `GET /trips/:trip` | The whole trip as the App may see it. Supports `?include=people,decisions,bookings,expenses,money,itinerary,record` to trim. | none | `TripView` (§2). `ETag: "<seq>"`. | ✅ + 🆕 |
| `GET /trips/:trip/invite` | The link and code for the Share sheet | none | `{ "invite_url", "code" }` | ✅ |
| `POST /trips/:trip/invite/rotate` | Organizer only. Invalidates the old link. | none | `{ "invite_url", "code" }` | 🆕 |
| `POST /trips/:trip/leave` | Leave a trip (recommended; not in the current UI) | none | `204`. Emits `person.left`. | ✅ event |
| `PUT /trips/:trip/me/join-answers` | Quick start sheet and "Travelling from" sheet. Also the join answers sent with an accept. | `JoinAnswers` | `Person` | ✅ |
| `PUT /trips/:trip/me/budget` | Budget sheet ("Your budget range") | `{ "min_minor": number, "max_minor": number \| null, "currency": "INR" }` | `{ "budget": {…mine}, "summary": BudgetSummary, "seq": number }` | 🆕 |
| `DELETE /trips/:trip/me/budget` | Clear my answer | none | `{ "summary": BudgetSummary, "seq": number }` | 🆕 |
| `PATCH /trips/:trip/me` | Pause or resume Go in this trip | `{ "go_paused": boolean }` | `Person` | ✅ |
| `POST /trips/:trip/read` | Mark the room read up to a point (drives unread counts and catch-up) | `{ "up_to_seq": number }` (or `{ "message_id" }`) | `204` | 🆕 |

**`JoinAnswers`**

```json
{
  "from_city": "Bengaluru",
  "earliest_leave": "Fri after 6 pm",
  "know": ["Vegetarian", "Window seat"],
  "vibe": "beach",
  "spend_band": "15to25"
}
```

- `from_city` ≤ 60, `earliest_leave` ≤ 60, `know` ≤ 20 items. These are **group-visible** answers and become `Person.from_city`, `earliest_leave`, `know`; the Server emits `person.joined` (first time) or `person.updated` with `changed`. (Contract ✅.)
- `vibe` (`beach|hills|city|any`) and `spend_band` (`lt15|15to25|gt25`) come from the Quick start sheet. **Server rule:** `vibe` is stored as one extra `know` entry ("Beach") so the group and Go can see it. It is **one person's** preference and is **not** the trip-level `TripSnapshot.vibe` (a list such as `["beaches","food"]` that only Go writes, through `update_trip`); the Server never writes `TripSnapshot.vibe` from a join answer. Go sees the `know` entry and may update the trip's vibe from it. `spend_band` is stored as **my private budget answer** with these bands: `lt15` → `{min_minor: 0, max_minor: 1500000}`, `15to25` → `{1500000, 2500000}`, `gt25` → `{2500000, null}`, then handled exactly like `PUT …/me/budget`. (This reuses existing contract concepts and needs no Go change. If the Server team prefers a separate field, say so.)
- The "Skip anything" rule: every field optional.

**Budget semantics (very important, from `llms-full.txt`)**
- The answer is **private to the person**. The Server stores it, recomputes `BudgetSummary` (`lowest` = the lowest band anyone picked, `answered`, `of`), and emits `trip.updated` with **`changed: ["budget"]` and `by: {"kind":"system"}`** (never the person, or Go could back out an individual answer from how the lowest band moved).
- The app's slider runs ₹5,000 to ₹60,000 in ₹1,000 steps (`min_minor: 500000`, `max_minor: 6000000`, step `100000`); the Server validates `min_minor < max_minor` when `max_minor` is not null, both ≥ 0, in the trip currency.
- `GET /trips/:trip` returns only **my own** answer in `me.budget` and the summary in `budget`.

**`stage`** (new on `TripSummary` / `TripView`, computed by the Server; the app uses it to choose zero state versus populated Trip home, and the home status line):
- `new` — no decided or agreed record lines yet.
- `deciding` — at least one decided/agreed line, but not yet `planned`.
- `planned` — destination **and** dates are decided **and** at least one of {stay decided/booked, any booking confirmed}. The trip home then shows the populated layout. (The prototype enters this state at the end of the scripted chat; in the product it is derived from the trip's own rows. **Please confirm the rule or change it; the app only needs the three values.**)

### 4.5 Uploads (photos, files, voice notes)

Used by: the chat composer (attach menu: Photo, Ticket or PDF; voice note) and the profile photo.

`POST /uploads` → `201`

```json
// request
{ "purpose": "chat_attachment" | "profile_photo",
  "kind": "photo" | "file" | "audio",
  "mime": "image/jpeg",
  "name": "ticket.pdf",
  "size_bytes": 482113,
  "width": 1280, "height": 960,
  "duration_s": null }
// response
{ "upload_id": "up_01JA…",
  "upload_url": "https://storage…/presigned-put",
  "headers": { "Content-Type": "image/jpeg" },
  "expires_at": "2026-10-08T07:12:00Z",
  "max_size_bytes": 26214400 }
```

1. The app `PUT`s the bytes straight to `upload_url`.
2. It then references `upload_id` in a message (§4.6). The Server resolves it to a `PhotoAttachment` or `FileAttachment` (contract ✅: `kind`, `url`, `width`, `height`, `caption`, `name`, `mime`, `size_bytes`) with a **permanent, access-controlled URL** (only trip members can fetch).
3. Server checks on the first use: size, MIME allow-list (`image/jpeg|png|webp|heic`, `application/pdf`, `audio/mp4|mpeg|webm|ogg`), virus scan, strips EXIF location from photos. An unused upload expires after 24 hours.
4. A **voice note** is `kind: "audio"` sent as a `FileAttachment` with the audio MIME. The app shows a play control. (`duration_s` on the attachment is a small 🔶 addition, §9.7.)


### 4.6 The room: messages, replies, reactions, "Ask Go about this", catch-up

Used by: Chat (`/trips/:id/chat`): message list, composer, attach menu, voice note, long-press menu (reactions, Reply, Ask Go, Copy), reply and ask-Go trays, fact chips, catch-up banner.

| Method & path | Purpose | Request | Response | Marks |
|---|---|---|---|---|
| `GET /trips/:trip/messages` | First load and scroll-back (**history mode**), and the gap fill after a reconnect (**changes mode**) | Either `?limit=50[&before_seq=<n>]` or `?after_seq=<n>&limit=200`, never both (`422`). See the table below. | `{ "messages": [Message], "has_more": boolean, "seq": number }` (`seq` = the trip's change number this page is consistent with). Page under 1 MB; when `limit` would go over, send fewer with `has_more: true`. | ✅ (`MessagesPage`) |
| `POST /trips/:trip/messages` | Send | see below | `201 Message` (the stored message) | ✅ |
| `PUT /trips/:trip/messages/:message_id/reaction` | Long-press → react. **One reaction per person per message**: a new emoji replaces the old one; `emoji: null` removes it. | `{ "emoji": "🔥" \| null }` | `200 Message` | ✅ |
| `PATCH /trips/:trip/messages/:message_id` | Edit own message (recommended; not in the current UI) | `{ "text" }` | `200 Message` (`edited_at` set) | ✅ event |
| `DELETE /trips/:trip/messages/:message_id` | Delete own message (recommended; not in the current UI) | none | `200 Message` (`deleted: true`, text null) | ✅ event |
| `GET /trips/:trip/catch-up?since=<iso>` | The "while you were away" banner | `since` = my `last_read` time | `200 CatchUp` or `204` (not away long enough, or Go did not answer within 3 s) | ✅ (`catch_up`) |

**The two read modes of `GET /trips/:trip/messages`**

| | History mode | Changes mode |
|---|---|---|
| Ask with | no cursor (newest page), or `before_seq=<n>` to scroll back | `after_seq=<n>` (the highest change number the app holds, §3.2) |
| Returns | messages **posted** before `n`: `seq < n` | messages **posted or changed** after `n`: `updated_seq > n` (edits, deletes and reactions included), exactly like Go's `read_messages` |
| Page | the newest `limit` (default 50, max 100) that match | the first `limit` (default 200, max 200) that match |
| Sorted by | `seq`, ascending (oldest first in the page) | `updated_seq`, ascending (oldest change first) |
| `has_more` | older messages exist: ask again with `before_seq` = the smallest `seq` in this page | more changes exist: ask again with `after_seq` = the last message's `updated_seq` |
| Each message | as it is **now** (edited text, current reactions, deleted flag) | as it is **now** |

The app **upserts by `message_id`** and always **places** a message in the list by its `seq` (posting order), whichever mode brought it. A message brought by changes mode may be older than anything on screen: update it if it is loaded, otherwise ignore it.

**`POST /trips/:trip/messages` body**

```json
{
  "client_message_id": "cm_3f9a…",
  "text": "in, but only after 6pm fri",
  "attachments": [ { "upload_id": "up_01JA…", "caption": "Seats" } ],
  "reply_to": "m_0122",
  "about_message_id": null,
  "mentions": ["p_priya"]
}
```

Server rules (✅ contract, restated):
- Needs `text`, an attachment, or both. `text` ≤ 4,000 characters (Go's own `post_message` is capped at 2,000). Attachments ≤ 10.
- The Server sets `mentions_go: true` when the text @mentions or names Go, **or** it replies (`reply_to`) to one of Go's messages, **or** `about_message_id` is set ("Ask Go about this", even if the text does not name Go). `about_message_id` is **not** `reply_to`: a reply is part of the conversation; "Ask Go about this" asks about the message and the room sees the question with that message quoted.
- `mentions` is validated: every id must be a person in this trip now (`422 invalid`, `field: "mentions[1]"`).
- `reply_to` / `about_message_id` must be messages of **this** trip (`422`).
- Takes the trip's **next change number**, stores the message with `seq = updated_seq`, inserts the `message.created` outbox row in the same transaction, then fans out the live `message` frame.
- When the author has paused Go, the **event to Go** carries `withheld: true` with no text or attachments; the **App** still receives the full text (§1.7).
- Rate limit: 30 messages per minute per person per trip → `429` with `retry_after_seconds`.
- **System messages.** The Server itself posts messages whose `author` is `{"kind":"system"}` (for example "Trip created · Rahul joined", "Priya joined") for `trip.created` and `person.joined`. The app draws them as small centred pills. Text only.

**The composer's four attach options**
- *Photo* and *Ticket or PDF* → upload (§4.5), then `attachments`.
- *Location* → needs a `LocationAttachment` 🔶 (§9.7).
- *Poll* → opens a person-started vote (§4.8, `POST /trips/:trip/decisions`) and the Server posts a message carrying a `vote` card. It is not a message the app composes.
- *Voice note* → `kind: "audio"` upload, sent as a message with one attachment.

**Message list rules the UI relies on**
- A reaction by **Go has no `person_id`** (the app draws Go's character and the name "Go").
- Reactions are part of the message; a reaction change moves `updated_seq`.
- `withheld` never reaches the app as true for people's messages (see §1.7); for Go's messages it is always false.
- A message with a `card` is Go's. Show the card under the text in the same message.

**Typing:** on the live socket only (§3.1).

### 4.7 Go's cards: taps, "open this page", the vault

Used by: every card in the room, the Trip home "Pending" and "Go's calls" cards, pay and approval flows.

`POST /trips/:trip/cards/:card_id/actions` ✅ (the Server guide's own route)

```json
{ "action_id": "pick", "option_id": "opt_flight_1", "press_id": "9a1c3c2e-…" }
```

- `action_id`: lowercase words joined by underscores, ≤ 32 characters. `option_id` only when the button was on one option (`per_option: true`). `press_id` becomes the `tap_id` (their rule: a double tap is one tap). If `press_id` is missing, the Server makes `tap_<uuid>`.
- **Idempotency:** a repeat with the same `press_id` returns the first answer. Do **not** retry on your own after an error; a new tap is a new `press_id`.
- The Server checks the person is in the trip, then sends Go `card_tap { tap_id, trip_id, card_id, action_id, person_id, option_id? }` and waits up to **3.5 s** (3 s plus network).
- Response is Go's `CardActionResult`, passed through:

```json
{ "result": "done",    "toast": "Noted. Go will reply in the room." }
{ "result": "open",    "url": "https://brain.go.example/vault/approve?link=lk_4Rt8Zp2Lq", "expires_at": "2026-10-05T09:06:30Z" }
{ "result": "refused", "toast": "Only Rahul can approve this payment." }
```

- If Go does not answer in time: `200 { "result": "refused", "toast": "Go didn't answer. Try again." }`. (Their example returns a refusal, not an HTTP error.)
- **Record-card buttons never go to Go** (voting, "Yes, book it", settle up, undo): they are the Server's own endpoints in §4.8 and §4.9.
- **Showing buttons:** only to the people in `only_for_person_ids`; absent means everyone; `per_option` shows the button on every option. Go also checks who tapped and answers `refused`, but hiding the button is what keeps the room clear.

**Opening Go's pages** (`result: "open"`, and the vault link below): open the URL immediately in the system browser sheet or a new tab, never a WebView, never ahead of time, never in a push. Links expire 5 minutes after they are made. A link is for the person who tapped; it is not for sharing.

`POST /me/vault-link` ✅ (their route, "My vault")

```json
// request
{ "start": "home" | "add_card" | "add_login" }
// response (Go's Link)
{ "url": "https://brain.go.example/vault/home?link=lk_…", "expires_at": "…" }
```

Server → Go: `vault_link { kind: "vault", person_id: <session>, start }`, 2 s timeout, `go_unavailable` on failure. The app asks **only when the person taps**.

**App-internal links on cards (🔶 §9.4).** Several of Go's cards in the current UI open an **in-app sheet**, not a web page: "Add my budget" opens the budget sheet, "Check in now" opens check-in, "Open the plan" opens the itinerary. Rather than a new result type, the app treats an `open` result whose URL uses the scheme **`go://`** as an in-app route (for example `go://trips/t_goa/sheet/budget`, `go://trips/t_goa/bookings/b_flight`), and any `https://` URL as a browser-sheet page. The Server passes both through untouched.

### 4.8 Votes, the mandate ("Yes, book it"), and the trip record

Used by: place / dates / stay poll cards, the vote card, the mandate card, the "needs you" strip, Board sheet, Trip home "Done", pay flow.

**Votes** (record cards: Server-owned buttons) ✅ objects, 🆕 endpoints

| Method & path | Purpose | Request | Response |
|---|---|---|---|
| `GET /trips/:trip/decisions/:decision_id` | Redraw a vote card from the Server's own rows | none | `Decision & { "my_vote": { "option_index": number } \| null }` |
| `POST /trips/:trip/decisions` | A person starts a vote (the composer's "Poll" attach option). Go starts its own through `open_vote`. | `{ "question", "kind": "choice"\|"yesno", "anonymous": boolean, "options": [DecisionOption], "closes_at"? }` | `201 { "decision": Decision, "message": Message }` (the Server posts the message with the `vote` card). Sets `opened_by_person_id`. Emits `decision.opened`. |
| `PUT /trips/:trip/decisions/:decision_id/vote` | Cast or change my vote (tapping another option moves it) | `{ "option_index": number }` | `200 Decision` + `my_vote`. Emits `decision.voted` (`person_id` and `option_index` are **omitted** when the vote is anonymous). |
| `DELETE /trips/:trip/decisions/:decision_id/vote` 🔶 | Take my vote back (the dates poll lets you untap the option you picked) | none | `200 Decision`. **Not in Go's contract yet:** `decision.voted` only covers voting and changing a vote, so there is no event that says a vote was withdrawn. Proposed in §9.13. **Until it lands this route is off** (`features.vote_retract = false` in `GET /config`) and the app keeps the selected option selected; a person can still move their vote. |
| `POST /trips/:trip/decisions/:decision_id/close` | Close now. Allowed for the organizer and the person who opened it. Closes also automatically at `closes_at` (Server job). | none | `200 Decision` (`result_index` set unless nobody voted or the top options tied) |
| `POST /trips/:trip/decisions/:decision_id/cancel` | Call a vote off (recommended; the guide's flow has the organizer calling one off). Organizer or opener only. | none | `200 Decision` (`status: "cancelled"`). Emits `decision.cancelled`. No record line is written. |

Rules: voting on a closed or cancelled vote is `409 conflict`; an out-of-range `option_index` is `422`; only trip members vote; `voted`/`of`/`tally` are always returned; `votes[]` is omitted for anonymous votes (the Server still stores who voted); when a vote closes the Server writes the **decided** record line itself and emits `decision.closed` + `record.changed`. A tie or no votes leaves `result_index` empty and writes no line (Go then asks the group).

**"I'm flexible, any of these work"** (the dates poll's dashed button) has no counterpart in the contract. Until Go's contract carries it (🔶 §9.6) the app sends it as an ordinary chat message ("Flexible, any of these work").

**Who books for the group ("one person books for all")** 🔶 §9.14. After a stay vote closes, the app shows a card with the total and one button for **anyone** in the trip ("I'll book it"); the first person to tap becomes the booker, and everyone else then sees "Rahul is booking for all 4" with a live dot. In Go's contract the payer is chosen by Go, in `set_mandate` (`payer_person_id`); nothing lets a person volunteer. Proposed, with **no new App endpoint**:
- Go posts that card as a `notice` card with one action `{ "action_id": "claim", "label": "I'll book it" }` and no `only_for_person_ids`.
- The tap is an ordinary card action (§4.7, `POST …/cards/:card_id/actions`). Go takes the **first** `claim` it gets, calls `set_mandate` with that person as `payer_person_id`, answers `done`, and replaces the card (no buttons, body "Rahul is booking for all 4"). A later tap gets `refused` with a toast such as "Rahul is already booking this."
- From there the normal mandate flow below runs: the new payer sees "Yes, book it".
- **Until it lands:** Go picks the payer (the organizer by default) in `set_mandate` and posts the mandate card straight away; the app shows the booker row and no "I'll book it" button.

**Mandate** (the "Yes, book it" / "Not now" buttons) ✅ objects, 🆕 endpoints. Go sets the mandate with `set_mandate`; the Server draws the card.

| Method & path | Purpose | Response |
|---|---|---|
| `POST /trips/:trip/decisions/:decision_id/mandate/confirm` | The **payer** taps "Yes, book it". Sets `confirmed_at`. | `200 Mandate`. Emits `mandate.confirmed`. |
| `POST /trips/:trip/decisions/:decision_id/mandate/decline` | The payer taps "Not now". Sets `declined_at`. | `200 Mandate`. Emits `mandate.declined`. |

Rules: only `mandate.payer_person_id` may call these (`403 forbidden` for anyone else); the buttons are shown to the payer only; a new mandate (`set_mandate` again) clears both timestamps; `409` if the decision has no mandate.

**The payment itself is not an App endpoint.** After "Yes, book it", Go checks the price and asks the Server for a spend approval (`request_spend_approval`, Server↔Go, ✅ in `llms-full.txt`), then posts a `pay` card for the payer. **Approve** is a normal card action (§4.7) that returns `{result:"open", url: <vault page>}`; the payer confirms with Face ID in the vault, never in the app. See §10.1: the prototype's in-app "Pay sheet" must go.

**The trip record** ✅ objects, 🆕 endpoints

| Method & path | Purpose | Response |
|---|---|---|
| `GET /trips/:trip/record` | The record lines for the Board sheet / Trip home "Done" / "Pending" | `{ "lines": [RecordLine], "seq": number }`, oldest first. **By default it returns `active` and `done` lines only.** With `?include_undone=true` it also returns `undone` lines, which the app draws struck through (the Board sheet's history). Go never rewrites an undone line. |
| `POST /trips/:trip/record/:line_id/undo` | Anyone in the trip can undo a line | `200 RecordLine` (`status: "undone"`). Emits `record.changed` `change: "undone"`. Go never undoes a line. |
| `POST /trips/:trip/record/:line_id/redo` | Take an undo back (recommended) | `200 RecordLine` |

The `decided` and `booked` lines are **written by the Server**, from closed votes and confirmed bookings. `agreed`, `open`, `doing` are written by Go (`add_record_line` / `update_record_line`).

### 4.9 Money: Expenses tab, Transactions, "Record a payment", settle up

Used by: Expenses (`/trips/:id/expenses`, "Everyone" and "Just me"), Transactions (`/expenses/transactions`), Record a payment sheet, the `settle_up` and `expense` cards, the Trip home "Settle up" item.

| Method & path | Purpose | Response | Marks |
|---|---|---|---|
| `GET /trips/:trip/money` | Everything the Expenses tab draws | `MoneyView` (§2): contract `Money` (`plan_minor`, `spent_minor`, `by_category`, `transfers`) + `me` (my budget, my share spent, by category, what I owe and am owed). `scope` is not a parameter: **both views come from one response**; the Server computes my share by each expense's `split_person_ids` (equal split). | ✅ + 🆕 |
| `GET /trips/:trip/transactions` | The Transactions page | `?filter=all\|booking\|payback\|mine&limit=50&before=<cursor>` → `{ "items": [Transaction], "total_count": number, "next_cursor" }`. `filter=mine` = I am the payer or a payee. `total_count` powers the "All 7" chip (the count of **all** transactions regardless of filter). | 🆕 |
| `POST /trips/:trip/settlements` | "Record a payment": money I sent outside Go (UPI, cash) | `{ "to_person_id", "amount_minor", "currency", "method": "upi"\|"cash"\|"bank_transfer"\|"other", "note"? }` → `201 { "settlement": Settlement, "transfers": [Transfer], "seq": number }` | 🆕 (+ 🔶 §9.11) |
| `POST /trips/:trip/settlements/:id/confirm` | The payee confirms "I got it" | `200 Settlement` (`confirmed`) | 🆕 |
| `POST /trips/:trip/settlements/:id/dispute` | The payee says "I didn't get this" | `200 Settlement` (`disputed`) | 🆕 |
| `POST /trips/:trip/transfers/pay-link` | The `settle_up` card's **UPI** button | `{ "to_person_id", "amount_minor" }` → `{ "upi_uri": "upi://pay?pa=…&pn=…&am=…&cu=INR&tn=…", "expires_at" }`. Built on the Server because the UPI id never leaves it. `409` if the payee has no UPI id (`has_upi: false`). | 🆕 |
| `POST /trips/:trip/transfers/nudge` | The `settle_up` card's **Nudge** button (a friendly push to the person who owes) | `{ "from_person_id" }` → `204`. At most one nudge per debtor per 24 h (`429` after). | 🆕 |
| `PATCH /trips/:trip/expenses/:expense_id` | The `expense` card's **Fix split** | `{ "split_person_ids": [..], "note"?: string }` → `200 Expense`. Emits `expense.changed`. | 🆕 |

Rules:
- A trip has **one currency**. All amounts are in it (`422` otherwise).
- `Settlement` recomputes `transfers` ("the fewest payments that square everyone up right now") and emits `trip_changed` with `kinds: ["settlement","expense"]`. A settlement starts as `pending_confirmation`; the payee gets a push ("Rahul, Aarav says he paid you ₹5,800. Got it?"). The UI copy promises "Rahul gets a ping to confirm he got it". Until confirmed, the Server counts it **provisionally**: the transfer shrinks and the row shows as pending. A dispute puts the amount back.
- The prototype's "settled" state is `transfers` containing no entry from me to that person.
- Expense **creation** by a person (a "add expense" form) is not in the current UI; the contract's `add_expense` is Go-only. Recommended later: `POST /trips/:trip/expenses`.
- The Expenses "Just me" view's **budget bar** uses `me.budget_minor` (my private budget answer, §4.4) against `me.spent_minor`. "Edit budget" reopens the budget sheet (`PUT /trips/:trip/me/budget`).

### 4.10 Bookings, tickets and the itinerary

Used by: Bookings (`/trips/:id/bookings`), Ticket viewer (`/bookings/:id/ticket`), Itinerary (`/trips/:id/itinerary`, map and list, "Everyone" and "Just me"), the `ticket`, `day` and `plan` cards.

| Method & path | Purpose | Response | Marks |
|---|---|---|---|
| `GET /trips/:trip/bookings` | The Bookings tab list and the Trip home rows | `{ "items": [Booking], "seq" }` (all kinds; `confirmed` and `cancelled`) | ✅ (+ 🔶 §9.9 fields) |
| `GET /trips/:trip/bookings/:booking_id` | One booking (the `ticket` card redraws from this) | `Booking` | ✅ |
| `GET /trips/:trip/bookings/:booking_id/documents/:document_id` | The ticket PDF for the viewer, Save and Share | `302` to a **signed URL** valid 10 minutes (`Content-Disposition: inline`). Only trip members, only for people the booking covers (`for_person_ids`) unless the document is marked group-visible. | 🔶 §9.9 |
| `POST /trips/:trip/bookings` | A person records a booking (e.g. one made outside Go): recommended; not in the current UI | Request: `AddBooking` fields without `request_id`/`approval_id`. Response: `201 Booking`. Emits `booking.changed` `change: "added"`. | ✅ event |
| `GET /trips/:trip/itinerary?scope=everyone\|me` | Itinerary list and map | `{ "days": [Day], "seq" }`. `scope=me` returns **my personalised view**: items that are mine, shared with me, or for the group, with my own wording (e.g. "BLR → GOX · 6E 5313, Seat 14A, lands Mopa 9:55 pm" instead of "You + Arjun land at Mopa"), and **omits** other people's private items. | ✅ + 🔶 §9.10 |

Rules:
- A **zero state** is data-driven: `GET …/bookings` with `items: []` ⇒ the app shows "no bookings yet"; `days: []` ⇒ "No plan yet".
- The ticket viewer shows PDF pages with a page counter ("1 / 2") and a toolbar (Download, Share). The app renders the PDF client-side from the signed URL. **Share to the group** posts a normal chat message with the document as a `FileAttachment` (`POST /trips/:trip/messages`), not a special endpoint.
- The **map** is drawn by the client from `Place.lat/lng` on items and bookings; there is no map endpoint. The app's route line between origin and destination comes from the booking's `journey`.
- `Day`/`ItineraryItem` are written by Go through `update_trip` (itinerary). The Server never invents items.

### 4.11 Trip home: "needs you", Go's calls, the chat button

Used by: Trip home (`/trips/:id`): Pending on you, Go's calls, Ask Go form, Done list, chat floating button; the "needs you" strip in the room.

`GET /trips/:trip/needs-you` 🆕 (✅ rules)

```json
{
  "items": [
    { "item_id": "vote:d_when:p_aarav", "kind": "vote",
      "title": "Pick dates", "subtitle": "closes in 1 hour", "cta_label": "Vote",
      "since": "2026-10-05T04:10:00Z",
      "target": { "decision_id": "d_when", "message_id": "m_0150" } },
    { "item_id": "mandate:d_villa", "kind": "mandate",
      "title": "Yes, book Villa Sol?", "cta_label": "Yes, book it", "since": "…",
      "target": { "decision_id": "d_villa", "card_id": "c_villa_mandate", "message_id": "m_0170" } },
    { "item_id": "card:c_cab", "kind": "card", "title": "Airport cab to Villa Sol",
      "subtitle": "Fri 9:55 pm · with Arjun", "cta_label": "Book ₹1,600", "since": "…",
      "target": { "card_id": "c_cab", "message_id": "m_0181" } },
    { "item_id": "settle:p_rahul", "kind": "settle_up", "title": "Settle up with Rahul",
      "subtitle": "₹5,800 left of your villa share", "cta_label": "Record",
      "since": "…", "target": { "transfer": { "to_person_id": "p_rahul", "amount_minor": 580000, "currency": "INR" } } }
  ],
  "seq": 120
}
```

The list is **computed by the Server from its own rows, per person**, with exactly these sources (their table, plus the money line):

| `kind` | Shows for | Leaves when |
|---|---|---|
| `vote` | each person who has not voted in an open vote | they vote, or the vote closes/cancels |
| `mandate` | the payer, while the mandate has neither `confirmed_at` nor `declined_at` | they answer. A new mandate clears both, so it shows again. |
| `card` | the people in a Go card's `for_person_ids` | Go removes them with `replace_card` |
| `record_line` | the people in an `open`, `active` line's `person_ids` | the line is done, undone, agreed or doing |
| `settle_up` | a person who owes (from `money.transfers`) | the transfer is paid (a settlement recorded and confirmed) |

`needs_you_count` on `TripView` and `TripSummary` is this list's length. A change moves `trip_changed`; the app re-reads.

**Go's calls and other live cards.** Calls are `call` cards inside messages. The Trip home "Go's calls" section needs them without scanning the whole chat:

`GET /trips/:trip/cards?kind=call&state=dialing,talking` 🆕 → `{ "items": [ { "message_id", "card": Card, "posted_at" } ] }`

- Generic: `kind` is any card kind, `state` filters cards that have a `state` field (`call`, `working`, `pay`). Returns the **latest version** of each card (after `replace_card`).
- The live elapsed clock (`01:12`) is computed by the client from `started_at`. The `card` live frame (§3.1) updates it in place.
- `Stop the call` is a card action (§4.7, `action_id: "stop"`).
- **"Ask Go to call…"** (the form with vendor chips and free text): **in v1 it is a normal chat message** mentioning Go, e.g. `@Go call Villa Sol: late check-in around 11 pm on Fri 6 Nov` (`POST /trips/:trip/messages`). Go answers in the room, tells the group who it will call and gives 30 seconds to say stop (their call flow), then posts the call card. A structured request (`request_task`) is 🔶 §9.5.
- **Listen in / mute / take over / hand back, call recording playback:** 🔶 §9.5.

**The chat button on Trip home** reads `TripView.chat` (last message preview, unread count, participant avatars); no extra endpoint.

### 4.12 Web check-in (boarding pass)

Used by: Trip home "Web check-in is open" card, Check-in sheets (details, seat), Boarding pass page (`/trips/:id/checkin/pass`), the flights row "Web check-in opens Wed 4 Nov · Preview".

**This whole domain is 🔶** (§9.12): it is not in `llms-full.txt`. The app needs it to work for the screens as built. The proposed resource is Server-owned state that mirrors what Go does on the airline site:

`GET /trips/:trip/bookings/:booking_id/checkin` 🔶 →

```json
{
  "status": "not_open" | "open" | "done",
  "opens_at": "2026-11-04T08:40:00+05:30",
  "closes_at": "2026-11-06T19:40:00+05:30",
  "flight": { "number": "6E 5313", "carrier_name": "IndiGo", "logo_url": "…", "date": "2026-11-06",
              "origin": {"name":"Bengaluru T1","code":"BLR","time":"20:40"},
              "destination": {"name":"Goa · Mopa","code":"GOX","time":"21:55"} },
  "passenger": { "name": "Aarav Shah", "mobile_masked": "+91 98••• ••210", "bags": "7 kg cabin · 15 kg check-in" },
  "digi_yatra": true,
  "declaration": true,
  "seat": "14A",
  "companion": { "person_id": "p_arjun", "seat": "14B", "next_to_seats": ["14A","14C"] },
  "seat_map": { "front_label": "FRONT OF PLANE", "columns": ["A","B","C","D","E","F"], "aisle_after": "C",
                "rows": [12,13,14,15,16,17,18],
                "seats": [ { "id":"14A","row":14,"col":"A","state":"free"|"paid"|"taken"|"companion","price_minor": 45000 } ] },
  "boarding_pass": { "passenger": "AARAV SHAH", "boarding": "20:00", "departs": "20:40", "gate": null, "zone": "2", "seq": "087",
                     "barcode": { "format": "qr"|"pdf417"|"aztec", "payload": "M1SHAH/AARAV…" } } | null
}
```

`PATCH …/checkin { "digi_yatra"?, "declaration"?, "seat"?, "mobile"? }` → updated state (seat must be `free`, `paid` or the companion-adjacent choice; `409` if `taken`). `POST …/checkin/complete` → state with `status: "done"` and the pass. A **paid seat** (₹450) is a payment: it must go through the **vault** (spend approval, payer's Face ID), exactly like any other payment (see §10.1), never an in-app "Pay".

Who performs the check-in on the airline site is Go (its computer); the proposed Server↔Go methods are in §9.12. The app only calls the three Server routes above.

### 4.13 "What Go knows about you", forget me, pause Go (the You screen)

Used by: Profile (`/profile`), the message box notice "Go can't see your messages in this trip".

All ✅ (their routes `/app/me/go`, shown under the `/app/v1` prefix). `person_id` is the **session**, never the request.

| Method & path | Purpose | Server → Go | Response |
|---|---|---|---|
| `GET /me/go` | "What Go knows about you" | `get_person { person_id }` (2 s) | `PersonPage` (`carry_over`, `facts[]` with `topic`, `text`, `trip_id`, `message_id`, `said_at`). The app shows the trip's title next to each fact (join to my trips). A fact with a `message_id` opens that message; without one it came from the join answers. On failure: `go_unavailable`; the app keeps the rest of the screen and shows "Couldn't load what Go knows. Try again." |
| `PATCH /me/go` | "Remember me in my next trips" (carry-over, **off by default**) | `update_person { person_id, carry_over }` | `{ "ok": true }`. On failure the app puts the switch back and shows "Couldn't save. Try again." |
| `DELETE /me/go/facts/:fact_id` | Remove one fact | `delete_fact { person_id, fact_id }` | `{ "ok": true }`. `404` means already gone: remove it from the screen. |
| `DELETE /me/go?trip_id=<id>` | "Forget me in this trip" (with `trip_id`) or "Forget me everywhere" (without) | `forget_person { person_id[, trip_id] }` | `ForgetResult { deleted_facts, remaining_facts: 0 }`. Then **the Server** clears the person's join answers (`from_city`, `earliest_leave`, `know`) in those trips and emits `person.updated` for each. **Never tell the person they were forgotten when Go failed**: show "Go couldn't forget you just now. Try again." Safe to repeat. |
| `PATCH /trips/:trip/me { go_paused }` | Pause Go in a trip (also in §4.4) | none (Go learns from the `person.updated` event) | `Person` |

Forget me does **not** touch messages, votes, bookings, expenses or record lines (they belong to the trip). It does not stop Go learning from new messages; pausing does.

### 4.14 Places, config and health

| Method & path | Purpose | Response |
|---|---|---|
| `GET /places/cities?q=<text>&country=IN&limit=8` | The "Other city" search in the Quick start and "Travelling from" sheets. **Replaces the prototype's direct browser calls to a third-party geocoder** (rate limits, privacy, outages). The Server caches and rate-limits, and may use any provider. | `{ "items": [ { "id", "name", "region": "Madhya Pradesh, India", "lat", "lng", "population"? } ] }`, biggest first, ≤ 8, populated places only, deduplicated by name+state. `q` shorter than 2 characters returns the same as the top list. |
| `GET /places/cities/top?country=IN` | The dropdown before anything is typed ("Top cities in India") | `{ "items": [ …same shape… ] }` ranked by population, cached 7 days |
| `GET /config` **public** | Boot config | `{ "contract": "1.0.0", "min_client_version": "1.0.0", "currency_default": "INR", "features": { "web_push": true, "checkin": false, "visa": false, "vote_retract": false, "claim": false }, "vapid_public_key": "…" }` |
| `GET /health` **public** | Liveness | `{ "ok": true }` |

`GET /places/cities` rules: `id` is the provider's stable id (not a name). The app uses `name` as `from_city` (≤ 60 chars) and shows `region` as the secondary line. Strip accents only for matching, never for display. A 400 ms debounce and cancelling the previous request are client-side; the Server must still tolerate 5 requests/second/person (`429` above that).


---

## 5. Screen by screen: what each page reads, writes and listens to

This is the proof that the contract covers the app: every route and sheet in the current frontend, with the exact calls behind it. "Live" means a frame from §3.

### 5.1 Welcome: `/`

| UI | Call |
|---|---|
| "Continue with Google" | Google Identity Services returns an ID token → `POST /auth/google`. On success route to `/home`. A signed-in visitor is redirected to `/home` without showing the screen. |
| Terms and Privacy links | static pages (not an API) |
| Offline | the service worker shows `/~offline` |

### 5.2 App home: `/home`

| UI | Reads | Writes | Live |
|---|---|---|---|
| Header "Welcome back / Your trips", avatar (taps to Profile) | `GET /home` (`me`) | — | `home_changed` |
| **Returning state:** Invites (Accept, Decline), Your trips (trip cards with photo, title, dates, countdown, member faces, status line), Past trips | `GET /home` (`invites`, `trips`, `past_trips`) | Accept → `POST /invites/:code/accept` then open the landing. Decline → `POST /invites/:code/decline`. | `home_changed`, and `trip_changed` for open trips |
| **First-run state:** hero "Start your first group trip", Ideas for your crew (From *city*), "Not sure where? Ask Go" | `GET /home` (empty `trips`), `GET /discover/ideas?from_city=…` | Create trip → `POST /trips` | — |
| "New trip" button | — | `POST /trips` → route to `/trips/new?trip=:id` | — |
| Trip status line ("2 things pending on you", "You're all set", "Go is collecting everyone's answers", a task label) | `TripSummary.attention` | — | `home_changed` |

### 5.3 Profile: `/profile`

| UI | Reads | Writes |
|---|---|---|
| Identity card (name, email, "Signed in with Google") | `GET /me` | `PATCH /me` (name, photo) |
| Travelling from | `Me.from_city` (the sheet in chat edits the **per-trip** answer) | `PATCH /me { from_city }` sets the profile default |
| Your trips ("1 active · 2 past · 1 invite") | `Me.counts` | — |
| Payment methods | `Me.has_upi`, `upi_id_masked` | `PUT/DELETE /me/upi`; cards → `POST /me/vault-link { start:"add_card" }` |
| Trip notifications switch | `Me.notifications_enabled` | `PATCH /me { notifications_enabled }` (and `POST /me/devices` on first enable) |
| What Go knows about you, Delete a fact, Remember me, Forget me | §4.13 | §4.13 |
| Sign out | — | `POST /auth/logout` |
| "Prototype controls: Reset demo, Jump to artboard" | **not in the product** | — |

### 5.4 Invite landing: `/invite/:code`

| UI | Reads | Writes |
|---|---|---|
| Trip hero behind the sheet; "*Rahul* invited you"; "Goa crew · Diwali · Fri 6 – Mon 9 Nov · Rahul, Priya and 1 more are in"; "When you join" list (chat added, Go asks dates and budget, bookings/budget stay private) | `GET /invites/:code` (public) | — |
| "Accept & join" | — | `POST /invites/:code/accept` → route by `landing` (`chat` or `trip_home`) |
| "Not now" | — | `POST /invites/:code/later` (keeps it on my home screen), then route to `/home` |
| Unknown or expired code | `404`, or `state: "expired"` | — |

The "When you join" bullets are static product copy (client).

### 5.5 Who's coming: `/trips/new`

| UI | Reads | Writes | Live |
|---|---|---|---|
| Title "Who's coming to *Goa*?" | `GET /trips/:trip` | `POST /trips` was called from Home | — |
| Crew card (organizer + empty slots, then "Rahul and Priya are in") and the crew list | `TripView.people` | — | `trip_changed` (kind `people`) as friends join. **The prototype's simulated joins (timers) become real `person.joined` events.** |
| Invite link field + Copy | `TripView.invite_url` (`GET /trips/:trip/invite`) | — | — |
| "Share in WhatsApp group" and the Share sheet (WhatsApp, Messages, Gmail, More, Copy link, the recent group) | `invite_url` | — (the app uses the device's native share and `wa.me`; **sharing needs no API**) | — |
| "Skip", "Next · open trip chat" | — | route to `/trips/:id/chat` | — |

### 5.6 Trip home: `/trips/:id`

| UI | Reads | Writes | Live |
|---|---|---|---|
| Hero (photo, title with emoji, "Fri 6 – Mon 9 Nov", "in 34 days", member faces) and the collapsing compact header | `GET /trips/:trip` | — | `trip_changed` |
| Tabs Home · Itinerary · Bookings · Expenses | — | — | — |
| **Zero state** (before the plan exists): Go status card with progress ("0 of 5 decided"), Next up rows (Pick a place, Pick dates, Find a stay, Set your budget, Sort your travel) each with a button, "Invite more people" | `TripView.stage = "new"`; progress from `record` (the five decisions are record lines/decisions); the next-up rows are **static copy** whose buttons deep-link to the chat | — | `trip_changed` |
| **Pending on you** (check-in, settle up, airport cab, votes…) | `GET /trips/:trip/needs-you` | settle → Record payment sheet (§4.9); others open the card/sheet | `trip_changed` |
| **Go's calls** (live call cards, carousel when 2+, dots, elapsed clock) | `GET /trips/:trip/cards?kind=call&state=dialing,talking` | Stop → card action `stop` (§4.7) | `card` frame updates in place |
| "Add another call" / "Ask Go to call" form (vendor chips, free text) | — | a chat message mentioning Go (§4.11) | — |
| Listen in (sheet: live transcript, mute, take over, hand back, End call) | the live call card | **🔶 §9.5** | `card` |
| Last call · Recording (sheet: outcome, player, 1×/1.5×/2×, transcript, Share in group chat, Save) | the ended `call` card (`outcome`, `transcript`) | Share → chat message with attachment | — |
| **Done** list (Villa Sol booked, Flights booked, Cab booked, Settled up, Budget set, Dates set) with expandable rows (call options + booking details) | `GET /trips/:trip/record` (decided/booked/done lines) + `GET /trips/:trip/bookings` | expandable row → "Call Villa Sol" starts a call (message to Go) | `trip_changed` |
| Web check-in card (open) and "Web check-in opens Wed 4 Nov · Preview" | §4.12 🔶 | §4.12 🔶 | — |
| **Chat button** (avatars, last message, unread badge) | `TripView.chat` | — | `message` |
| Share sheet (top-right) | `invite_url` | — | — |

### 5.7 Itinerary: `/trips/:id/itinerary`

| UI | Reads | Notes |
|---|---|---|
| Scope toggle "Everyone / Just me", view toggle Map / List, area toggle (whole trip / destination) | `GET /trips/:trip/itinerary?scope=everyone\|me` | Switching scope refetches (or the app caches both). View and area are client state mirrored in the URL. |
| Day cards with timeline rows (time, emoji, title, sub, face stack or private badge) | `days[].items[]` | `status` (`booked/planned/idea`), `category`. 🔶 `person_ids` and `audience` (§9.10) drive the face stack and the private/shared badge. |
| Map with route line and selectable spots, detail card with a button | `Place.lat/lng` on items and bookings | Drawn client-side; no endpoint. |
| Zero state "No plan yet" with "Ask Go to draft a plan" and "Pick dates first" | `days: []` | Buttons deep-link to the chat. |

### 5.8 Bookings: `/trips/:id/bookings`

| UI | Reads | Notes |
|---|---|---|
| Booked list (ticket cards: travel out, stay, travel back; stub shows ticket count or BOOKED) | `GET /trips/:trip/bookings` | One card per `Booking`. A round-trip flight is **one** booking with `journey` plus a return journey (§9.2/§9.9), the prototype shows it as two cards (out and back) because the data model was split. |
| Zero state | `items: []` | |
| Tap a ticket | route to the ticket viewer | |

### 5.9 Ticket viewer: `/trips/:id/bookings/:bid/ticket`

| UI | Reads | Writes |
|---|---|---|
| Toolbar (title, "6E5313-K7QX2M.pdf · 2 pages", Download, Share), PDF pages with a "1 / 2" counter, Save and Share bar | `GET …/documents/:document_id` (signed URL) | Share to group → `POST /trips/:trip/messages` with the file attached |

### 5.10 Expenses: `/trips/:id/expenses` and Transactions

| UI | Reads | Writes |
|---|---|---|
| Scope toggle "Everyone / Just me" | `GET /trips/:trip/money` (`MoneyView`, both views in one response) | — |
| Spend summary (total, caption, split bar, stay / travel tiles; "Just me" shows the budget bar and "Edit budget") | `MoneyView.by_category`, `me.*` | Edit budget → `PUT /trips/:trip/me/budget` |
| Settle up card (who pays whom, Record) | `MoneyView.transfers`, `me.i_owe`, `me.owed_to_me` | Record → sheet below |
| Recent transactions (5) and "See all N" | first page of `GET /trips/:trip/transactions` | — |
| **Record a payment** sheet (amount prefilled with what I owe that person, Paid via chips UPI/Cash/Bank transfer/Other, note; "Rahul gets a ping to confirm he got it") | `MoneyView.me.i_owe` | `POST /trips/:trip/settlements`; the payee confirms or disputes |
| Transactions page: filter chips "All 7 · Bookings · Paybacks · Mine", date-grouped rows, "Record a payment" | `GET /trips/:trip/transactions?filter=…` | same sheet |
| `settle_up` / `expense` cards in the room | `MoneyView`, `Expense` | UPI → `POST …/transfers/pay-link`; Nudge → `POST …/transfers/nudge`; Fix split → `PATCH …/expenses/:id` |
| Zero state (no transactions) | `transactions.total_count = 0` | |

### 5.11 Chat: `/trips/:id/chat`

| UI | Reads | Writes | Live |
|---|---|---|---|
| Header (trip avatar, title, "Rahul and Priya joined", faces), Board button, Share button | `GET /trips/:trip` | — | `trip_changed` |
| **Fact chips** Where? / When? / Stay? / Budget / From | derived **client-side from `TripView`**: `destination` → Where, `dates` → When, **the picked stay** → Stay, `budget.lowest` (or my `me.budget`) → Budget, `me.person.from_city` → From. A chip is "set" when its value exists. **Stay is not `TripView.stay`**: in the contract that field is "the kind of stay" ("villa with a pool"), not the villa the group chose. The Stay chip shows the `booked` record line's booking (`Booking.place.name` or `title`) when there is one, else the winning option of the closed stay vote (the `decided` line's `decision_id` → `options[result_index].label`), else it is unset. | tapping an unset chip scrolls to its card or asks Go (message); set chips open the Board. Budget → budget sheet; From → "Travelling from" sheet. | `trip_changed` |
| Message list, bubbles with reactions, quotes (`reply_to`, `about_message_id`), Go typing, system pills | `GET /trips/:trip/messages` | send / react (§4.6) | `message`, `typing`, `card` |
| Catch-up banner | `GET /trips/:trip/catch-up?since=` | dismiss is client-only | — |
| "Needs you" strip | `GET /trips/:trip/needs-you` | — | `trip_changed` |
| Long-press: reactions, Reply, **Ask Go about this**, Copy | — | reaction; reply and ask-Go send a message (§4.6); Copy is client-only | — |
| Composer: text, attach menu (Photo, Ticket or PDF, Location, Poll), voice note | — | §4.5, §4.6, §4.8 | `typing` (outgoing) |
| Go's cards in messages | §6 | §4.7, §4.8 | `card` |
| **Quick start sheet** (vibe, spend each, travelling from) | — | `PUT /trips/:trip/me/join-answers` | `trip_changed` |
| **Travelling from** sheet | `me.person.from_city`; `GET /places/cities` | `PUT /trips/:trip/me/join-answers { from_city }` | — |
| **Budget sheet** | `me.budget`, `TripView.budget` | `PUT /trips/:trip/me/budget`; the sheet auto-closes 0.9 s after "Saved privately ✓" (client behaviour) | `trip_changed` (`budget`) |
| **Place details / Stay details** sheets (photo, why rows, cost breakdown, activities, amenities, cancellation, "Vote") | the option's details | Vote → `PUT …/decisions/:id/vote` | — (**🔶 §9.1: option details**) |
| **Pay sheet** (UPI or card, split note, "Pay ₹43,200 & book") | **removed in the product** | the pay card's Approve → vault (§4.7) | `card` |
| **Route sheet** (Flight/Train/Bus, one-way/round, filters, time slots) and **Time sheet** | the `options` cards Go posted (`option_kind` flight/train/bus), **filtered on the client** | "Book" → card action `pick` with the option (+ round-trip choice) (§9.2) | `card` |
| **Cab sheet** | an `options` card (cab options) | "Book" → card action `pick` | `card` |
| **Just-for-me** sheet (my flight, seat, PNR, return flight) | `Booking` for me | — | — |
| **Visa** sheet and the visa status card | 🔶 §9.8 | 🔶 §9.8 | `card` |
| **Board** sheet (Where, When, Stay with live vote, Budget, Travel, "Go reminds you to book your return", spend vs budget) | `GET /trips/:trip` + `GET …/record` + `GET …/money` (`me`) | row buttons deep-link into the chat or open a sheet | `trip_changed` |
| **Share invite** sheet | `invite_url` | native share (no API) | — |

### 5.12 Boarding pass: `/trips/:id/checkin/pass`

| UI | Reads | Writes |
|---|---|---|
| Steps 1 Details · 2 Seat · 3 Boarding pass, success note "Checked in. Seat 14A, next to Arjun.", boarding pass card (passenger, boarding, departs, gate, zone, seq, QR), DigiYatra, Go note | `GET …/bookings/:bid/checkin` 🔶 | Save to wallet (client/OS), Download → the booking's boarding-pass document |

### 5.13 Offline: `/~offline`

Static; served by the service worker. Needs **no API**. Reads that already succeeded are cached by the app (§10).

---

## 6. Cards: how the app draws every card kind

The app draws all **13** contract kinds and shows `fallback_text` for any kind it does not know. This table maps what the current frontend draws (its own 15 scripted card kinds) onto the contract, and marks the gaps.

| Frontend card (today) | Contract card | Drawn from | Status |
|---|---|---|---|
| Place poll (3 places, voters' faces, "Details", "Show more places", countdown) | `vote` (a `Decision`: `kind: choice`, `closes_at`, options with `image_url`, `note`) | Server rows | ✅ + 🔶 option details (§9.1). "Show more places" = a quick reply (§9.3). |
| Dates poll (3 weekends, fit tags like "Works for all 4 · 1 leave", "I'm flexible") | `vote` | Server rows; fit text in `DecisionOption.note` | ✅ + 🔶 flexible (§9.6) |
| Stay poll (3 villas, rating, price, voters) | `vote` (+ `options` card when Go first shows them) | Server rows | ✅ + 🔶 §9.1 |
| Budget ask ("Add my budget": opens the sheet) | `notice` + action opening `go://trips/:id/sheet/budget` | the card | ✅ + 🔶 §9.4 |
| Travel ask ("Sort your travel") | `notice` + action opening the route sheet | the card | ✅ + 🔶 §9.4 |
| Visa ask / Visa status (who has sent theirs) | `notice` and a **`checklist`** card | the card | 🔶 §9.8 |
| Pay ask ("One person books for all": stay total, "Free cancellation", "I'll book it", then "Rahul is booking for all 4") | `notice` with a `claim` action, then `mandate`, then `pay` | the card / Server rows / the card | 🔶 `claim` (§4.8, §9.14); ✅ mandate and pay (§4.8, §10.1) |
| Booking progress (steps, "Watch", paying, paid, ticket stub, late-arrival bubble) | `working` → `ticket` | the card / Server rows | ✅ |
| Receipt ("Added to the money · Rahul paid ₹43,200 · split 4 ways") | `expense` | Server rows | ✅ |
| Plan card (hero, seal, days, "Open the plan") | `plan` (+ `day`) | Server rows (itinerary) | ✅ + small 🔶 `Day.image_url` (§9.10) |
| Quick replies ("TAP TO REPLY · 🏖️ Beach · ⛰️ Mountains") and the Go nudge pill ("Go suggests places from the chat") | a **`quick_replies`** list on Go's message | the message | 🔶 §9.3 |
| Progress pill ("Go checked everyone's calendars") | a plain Go message | the message | ✅ |
| Who lands when (table of arrivals, suggestion) | **`checklist`** | the card | 🔶 §9.8 |
| Private teaser ("Just for you", opens private details) | `notice` + action opening `go://trips/:id/bookings/:bid` | the card | ✅ + 🔶 §9.4 |
| Call (live and ended) | `call` | the card (updated in place) | ✅ (+ 🔶 recording and listen-in, §9.5) |
| Options (flights/stays Go found, "checked 3 min ago", Pick / Put it to a vote) | `options` | the card | ✅ (+ 🔶 §9.1, §9.2) |
| Settle up, Expense, Day, Budget cards | `settle_up`, `expense`, `day`, `budget` | Server rows | ✅ |

**Rendering rules (all ✅ from the guide):** show a button only to `only_for_person_ids`; `per_option` buttons appear on every option; show "checked N min ago" from `checked_at`; show `fallback_text` for an unknown kind or a record card whose row is not found; Go cards are replaced in place by `card` frames; record cards redraw from `GET`s after `trip_changed`.


---

## 7. What the Server must do for Go on every App action (no change to the Server↔Go plan)

Every App write that changes a trip takes the trip's **next change number**, stores the change, inserts the **outbox event** in the same transaction, then sends the live frame. The outbox, `send_event` retry schedule, one-at-a-time-per-trip ordering and the 18 Go requests are exactly as in `llms-full.txt`. This table is the **complete** map from App endpoints to Go-bound traffic, so nothing is forgotten.

| App action | Endpoint | Change number? | Event to Go (`send_event`) | Other Server → Go request |
|---|---|---|---|---|
| Create trip | `POST /trips` | yes (**1**) | `trip.created` | — |
| Join a trip | `POST /invites/:code/accept` | yes | `person.joined` (the join answers, never the budget) | — |
| Leave a trip | `POST /trips/:trip/leave` | yes | `person.left` | — |
| Save join answers / "Travelling from" / Quick start | `PUT …/me/join-answers` | yes | `person.updated` (`changed` lists the fields) | — |
| Save my budget | `PUT/DELETE …/me/budget` | yes | `trip.updated` **`changed:["budget"]`, `by:{kind:"system"}`** | — |
| Pause / resume Go | `PATCH …/me { go_paused }` | yes | `person.updated` `changed:["go_paused"]` | — |
| Update name / photo / UPI | `PATCH /me`, `PUT /me/upi` | yes, **per active trip** | `person.updated` (`name`, `photo_url`, `has_upi`) | — |
| Send a message | `POST …/messages` | yes | `message.created` (`withheld:true` and no text when the author paused Go) | — |
| Edit / delete a message | `PATCH`/`DELETE …/messages/:id` | yes | `message.edited` / `message.deleted` | — |
| React / remove a reaction | `PUT …/messages/:id/reaction` | yes (one per change) | `reaction.added` / `reaction.removed` | — |
| Start a vote | `POST …/decisions` | yes | `decision.opened` | — |
| Cast / move a vote | `PUT …/vote` | yes | `decision.voted` (no `person_id`/`option_index` when anonymous) | — |
| Take a vote back 🔶 | `DELETE …/vote` (off until §9.13 lands) | yes | proposed: `decision.voted` with `retracted: true` (§9.13) | — |
| Call a vote off | `POST …/decisions/:id/cancel` | yes | `decision.cancelled` | — |
| A vote closes (button or `closes_at`) | `POST …/close`, or a Server job | yes | `decision.closed`, then `record.changed` (the decided line) | — |
| Payer taps "Yes, book it" / "Not now" | `POST …/mandate/confirm\|decline` | yes | `mandate.confirmed` / `mandate.declined` | — |
| Undo / redo a record line | `POST …/record/:id/undo\|redo` | yes | `record.changed` (`undone` / `updated`) | — |
| Add a booking by hand | `POST …/bookings` | yes | `booking.changed` (`added`) | — |
| Fix a split | `PATCH …/expenses/:id` | yes | `expense.changed` | — |
| Record a payment (settlement) | `POST …/settlements` | yes | 🔶 §9.11 (see there) | — |
| Tap a button on a Go card (including "I'll book it", §9.14) | `POST …/cards/:id/actions` | **no** | none | **`card_tap`** (3 s) |
| Open the room after a while | `GET …/catch-up` | no | none | **`catch_up`** (3 s) |
| "What Go knows", carry-over, delete a fact, forget me, vault link | §4.13, §4.7 | no | none (forget me then triggers `person.updated` for cleared join answers) | `get_person`, `update_person`, `delete_fact`, `forget_person`, `vault_link` (2 s) |
| Typing (person) | live socket | no | **none** (people's typing never reaches Go) | — |
| Keep an invite for later / decline it | `POST /invites/:code/later\|decline` | no | none (the person is not in the trip) | — |
| Reading | `GET`s | no | none | — |

**What the Server writes without being asked** (their rules, restated so the App developer knows they will appear): `decided` and `booked` record lines (from votes and bookings), system messages for joins, the outbox row for every change, the "needs you" strip, pushes (§8), automatic vote close at `closes_at`.

**A `replace_card` from Go** takes **no** change number and sends **no** event; the Server stores the new card on its message and sends the live `card` frame only.

---

## 8. Push notifications

The Server sends a push **only when someone needs to look now.** Never for every message. This is the Server guide's table plus the three cases the current UI adds (marked +).

| When | Who | Title / body | `type` |
|---|---|---|---|
| Go names people in a message (`mentions` on Go's message) | those people | Go's text | `mention` |
| Go posts a new card with `for_person_ids` (a `replace_card` is not new) | those people | the card's `fallback_text` | `card` |
| A vote is about to close (default: 1 hour before `closes_at`) | people who have not voted | "Where do we stay? closes in 1 hour" | `vote_closing` |
| Someone owes money (from `money.transfers`) | the person who owes | "You owe Kabir ₹680 for the airport cab" | `owe` |
| + Someone recorded a payment to you | the payee | "Aarav says he paid you ₹5,800. Got it?" (opens the confirm/dispute action) | `settlement` |
| + A friend pressed **Nudge** | the debtor | "Rahul is nudging you for ₹5,800" (max one per 24 h) | `nudge` |
| + A friend joined your trip (optional) | the organizer | "Priya joined Goa 🌴" | `joined` |

**Payload** (identical for Web Push, APNs and FCM). **Never put a vault link in a push.**

```json
{
  "type": "mention",
  "trip_id": "t_goa",
  "message_id": "m_0133",
  "title": "Goa 🌴",
  "body": "Priya, here are three Friday evening flights from Delhi, all under ₹6k.",
  "deep_link": "/trips/t_goa/chat?msg=m_0133",
  "tag": "t_goa:m_0133",
  "badge_count": 2
}
```

- `trip_id` and `message_id` are always in the data so a tap opens the room at that message.
- Respect `Me.notifications_enabled` (the single switch). Recommended: honour a per-trip mute later.
- Web Push uses VAPID; the PWA's service worker shows the notification and routes `deep_link` on click. Dedupe with `tag`. Drop a push if the person has the room open and focused (a live frame already showed it).
- Remove a device registration on `410 Gone` (Web Push) or an invalid-token response (FCM/APNs).

---

## 9. Additions the app needs from Go's contract (proposed)

Everything above works with `llms-full.txt` as is. These are the places where the current screens need **more than the contract carries**. Each is small and additive within version 1 (new optional fields, new action ids, new kinds; an old reader ignores them). **Until a row lands, the app degrades as described in the last column**, so none blocks the Server team.

| # | Addition | Why the screen needs it | Proposed shape | Until it lands |
|---|---|---|---|---|
| 9.1 | **Option details** on `Option` and `DecisionOption` | The Place and Stay details sheets show a hero photo, "why this fits" rows, a cost breakdown, activities, amenities, a cancellation line, and "Vote". Neither object carries it. | `details?: { gallery_urls?: string[]; caption?: string; why?: string[]; costs?: [{label, emoji?, amount_minor, currency}]; total_minor?: number; amenities?: string[]; activities?: string[]; facts?: [{label, value}]; cancellation?: string; rating?: number; review_count?: number; go_note?: string }` | The sheet shows only `title`, `subtitle`, `image_url`, `price`, `highlights` |
| 9.2 | **Round trips and cabs** on `Option` | The route sheet prices one-way and round trip and shows two legs; the cab sheet lists cabs. `Option` has one `journey`; `option_kind` has no `cab`. | `Option.return_journey?: Journey`; `Option.price_oneway_minor?`, `Option.price_round_minor?` (keep `price_minor` as the price shown); `option_kind` gains `"cab"` (Journey already allows `mode: "cab"`). Card action `pick` carries `trip: "oneway"\|"round"`: `CardTap.payload?: { trip: "oneway"\|"round" }` | One-way only; cab shown as a generic option |
| 9.3 | **`quick_replies`** on Go's messages | The room shows chips under a Go message ("TAP TO REPLY · Beach · Mountains · Not sure, suggest some") and a "next step" pill ("Goa won the vote · pick dates next", "Show more places"). A tap **sends that text as the person**; it is not a Go-side button. | `Message.quick_replies?: [ { label: string (≤ 40), text?: string } ]`; `PostMessage.quick_replies?` the same. The chip sends `text ?? label` as a normal message (so it reaches Go as `message.created`). | Go says the options in plain text |
| 9.4 | **App-internal links** from card buttons | "Add my budget" opens the budget sheet; "Check in now" opens check-in; "Open the plan" opens the itinerary. Today's `open` result opens a **web page** in the browser sheet. | Allow `ActionOpen.url` with the **`go://`** scheme (e.g. `go://trips/t_goa/sheet/budget`, `go://trips/t_goa/sheet/route`, `go://trips/t_goa/bookings/b_flight`, `go://trips/t_goa/checkin/b_flight`). **No schema change**, only a documented scheme. `https://` stays "open in the browser sheet". | Go sends a plain `https` page, or a quick reply that makes it post the sheet's content as a message |
| 9.5 | **Calls: start, listen, take over, recording** | Trip home has an "Ask Go to call" form; the Listen sheet streams the transcript with Mute / Take over / Hand back / End call; the Recording sheet plays the call with 1×/1.5×/2× and a transcript. `call` card has `transcript` and `outcome` only. | (a) `request_task` Server→Go request `{ trip_id, person_id, kind: "call", business, goal }` → `{ accepted: true, message_id? }`; v1 alternative is a chat message (§4.11). (b) `CallCard.recording_url?`, `CallCard.duration_s?`. (c) Listen-in as a **Go-hosted page** reached with a card action `listen` returning `open` (like "Watch"), with Mute / Take over / Hand back inside it, rather than rebuilding live audio in the app. `stop` already exists. | "Ask Go to call" sends a message; Listen shows the live `last_line` and transcript from the card; no audio |
| 9.6 | **Flexible vote** | The dates poll has "I'm flexible, any of these work". `Decision` has only `option_index`. | `DecisionVotedData.flexible?: boolean` (no `option_index`); `Decision.flexible_count?: number`; endpoint `PUT …/vote { "flexible": true }`. A flexible vote counts as "voted" and leaves the tally unchanged. | Sent as a chat message |
| 9.7 | **Attachments: location and voice** | The attach menu has Location; voice notes need a length for the player. | `LocationAttachment { kind: "location", lat, lng, name?, address? }`; `FileAttachment.duration_s?` | Location sent as a text message with a maps link; voice as a plain file |
| 9.8 | **Documents via the vault, and a `checklist` card** | The Bali visa flow collects passport page, photo, name, passport number, date of birth, expiry, **and the group sees only "sent"**. The visa status card and the "Who lands when" card are tables of people with a status. | (a) **Passport and ID data never touch the Server or the chat.** `vault_link.start` gains `"add_documents"`; the app opens Go's vault page for the form (Face ID / passkey). (b) New card kind **`checklist`**: `{ kind:"checklist", title, subtitle?, due_at?, rows: [{ person_id, status: "todo"\|"started"\|"done"\|"info", label?, sub? }], suggestion?: {text, cta?}, actions? }`. Used for visa status, who-lands, packing lists. | Visa and who-lands shown as `notice` cards with the table written into `body` |
| 9.9 | **Booking details and documents** | The booking card shows detail rows ("Check-in: Fri 6 Nov, 2 pm", "Guests: 4"...). The ticket viewer opens a PDF. `Booking` has neither. | `Booking.details?: [{ label, value }]`; `Booking.documents?: [{ document_id, name, mime, size_bytes, pages?, visibility: "covered"\|"group" }]`; `Booking.return_journey?` (see 9.2); `Booking.passengers?: [{ person_id, seat?, pnr? }]` | The viewer shows a placeholder |
| 9.10 | **Itinerary: whose is it, and personalised views** | The list shows a face stack or a "private" badge per row, and the "Just me" view rewords rows for me ("BLR → GOX · 6E 5313, Seat 14A" vs "You + Arjun land at Mopa"). `ItineraryItem` has no people. Plan card day images. | `ItineraryItem.person_ids?: string[]`; `ItineraryItem.audience?: "group"\|"shared"\|"private"` (`private` items are only returned to those in `person_ids`); `Day.image_url?`. The Server builds `scope=me` from these plus bookings. | Everyone sees everything; no face stacks |
| 9.11 | **Settlements** | "Record a payment" records money one person sent another outside Go and the payee confirms. The contract has expenses and **computed** transfers but no way to record a payment. | A `Settlement` object (§2) and an event `settlement.recorded` (Server→Go) carrying it, so Go sees that a transfer shrank and stops nagging; Go may need `read_trip.money` to already account for confirmed settlements. **Server decision:** whether Go sees `pending_confirmation` settlements. Recommended: Go sees them only when `confirmed`. | The Server counts them in `MoneyView`/`transfers`; Go catches up from `read_trip`'s `money` |
| 9.12 | **Web check-in** | See §4.12. Details, DigiYatra, declaration, seat map (paid / taken / next to a friend), boarding pass, "Web check-in opens Wed 4 Nov". | Server→Go requests: `get_checkin { trip_id, booking_id, person_id }` → the `CheckinState` in §4.12 (includes `seat_map`); `submit_checkin { trip_id, booking_id, person_id, digi_yatra, declaration, seat }` → `{ status: "done"\|"working"\|"failed", boarding_pass? }` (**a 3 s limit is not enough for an airline site**: allow it to answer `working` and finish by `replace_card`/event). A paid seat uses the existing spend-approval and vault flow. Also an event `checkin.changed` or a `notice` card with a `go://…/checkin/:id` link when check-in opens. | Feature flag `features.checkin = false`; the Trip home card and the preview link hide; the airline's own site is used |
| 9.13 | **Taking a vote back** | The dates poll lets a person untap the option they picked. `decision.voted` only covers voting and changing a vote; nothing says a vote was withdrawn, so Go's `voted` count would be wrong. | `DecisionVotedData.retracted?: true` (with `option_index` absent); `voted` and `tally` are the new totals. In an anonymous vote `person_id` is left out as today. Endpoint: `DELETE …/decisions/:id/vote` (§4.8). | `features.vote_retract = false`: the route answers `409 conflict` and the app keeps the picked option selected (moving the vote still works) |
| 9.14 | **Who books: the `claim` action** | The "One person books for all" card lets anyone volunteer to book and pay; the first tap wins and the room sees who is booking. The contract has Go choose `payer_person_id` in `set_mandate`, with no way for a person to volunteer. | No schema change: a documented card action `claim` on a `notice` card. Go answers the **first** `claim` with `done`, calls `set_mandate` with that person as payer, and replaces the card ("Rahul is booking for all 4", no buttons); later claims get `refused` ("Rahul is already booking this."). | `features.claim = false`: Go picks the payer (organizer by default) and posts the mandate card directly |

The current UI also **does** one thing that is not contract-shaped but needs no addition: the **fact chips** (§5.11) are derived from `TripView`, not from a Go message.

---

## 10. Migration notes for the front-end (so both teams share one picture)

The current app is a **prototype driven by a scripted scenario and an in-memory store**. Wiring it to this contract changes the following. They are listed so the Server team can see what the client will stop doing.

1. **Remove the scenario engine.** Stages (`kickoff → places → dates → budget → stays → pay → book → travel → plan`), the stage-gated message list, the next-step pill state machine and every timer (`GO_REPLY_MS`, `RAHUL_CLAIMS_MS`, `simulateJoins`, the dates nudge) are gone. The room is **only** `GET …/messages` plus live frames. Go's messages, pills and cards come from Go.
2. **API adapter at the edge.** Whole rupees → `amount_minor` (×100), camelCase → snake_case, literal ids (`"goa"`, `"rahul"`) → opaque ids, `Date` strings → ISO. Derived labels in the UI ("in 34 days", "Fri 6 – Mon 9 Nov", "₹21.8k") are computed **on the client from the data**, not stored.
3. **Auth.** The `signInWithGoogle()` stub becomes `POST /auth/google`; the access token lives in memory only, the refresh token in the Server's httpOnly cookie (§1.2), and every page load starts with `POST /auth/refresh`; a route guard sends signed-out people to `/` and returns them to `return_to` after sign-in (invite links).
4. **The in-app Pay sheet and the seat payment are removed.** A payment is: payer taps "Yes, book it" (mandate) → Go posts a `pay` card → **Approve** → vault page in a browser sheet (Face ID) → Go updates the card. The same for a ₹450 seat. The "UPI or card" radio is the vault's job. (See §4.8 and §4.12.)
5. **Cities.** The Quick start / "Travelling from" city search stops calling a third-party geocoder from the browser and uses `GET /places/cities` and `/top`.
6. **Chat bubbles for people** use `Person` (name, photo); the avatar **tone colour** is derived client-side from `person_id` (it is not data). Go is always drawn as Go, never a person.
7. **Zero states are data-driven**: empty `bookings.items`, empty `days`, `transactions.total_count = 0`, `stage = "new"`, empty `trips`.
8. **No literals for money or members**: "split 4 ways", "₹10,800 stay share", "3 joined" come from `split_person_ids`, `MoneyView.me`, `people_count`.
9. **Persisted state** (`go-proto-v1` in localStorage) is replaced by the API plus a small read cache for offline (the last `GET /home`, `GET /trips/:id`, the last 50 messages), plus a queue for sends (`client_message_id`) that retries after reconnect.
10. **Prototype controls** (Reset demo, Jump to artboard, `?preset=`) are dev-only and not shipped.

### 10.1 Why payments never happen in the app (the one rule to keep)

From the Server guide: *a payment needs two separate approvals and Go produces neither.* The Server's **signed spend approval** (from votes, the cap, and the payer's "Yes, book it") plus **the payer's own Face ID in the vault**. If a change lets one approval stand in for the other, or lets anything Go says count as one, the change is wrong. The app therefore has **no** "pay" endpoint of its own: it only opens Go's vault page from a link the Server hands over.

---

## 11. Open questions for the Server team and Go

1. **`stage` rule** (§4.4): is "planned = destination and dates decided and (a stay decided/booked or any booking)" right? The app needs three values (`new`, `deciding`, `planned`) from a Server-side rule.
2. **Quick start answers** (§4.4): is mapping the person's `vibe` to an extra `know` entry (leaving the trip-level `TripSnapshot.vibe` to Go) and `spend_band` to the private budget answer acceptable?
3. **Settlements** (§9.11): does Go see them, and from which status?
4. **People who create votes** (§4.8): confirm that `opened_by_person_id` is intended for person-started votes (the composer's Poll). If not, drop that attach option.
5. **Itinerary writes by people**: only Go writes the itinerary today (`update_trip`). Does a person ever edit a day? (The current UI does not.)
6. **`trip.updated` for the budget** is `by: system` (their rule). Does the live `trip_changed` frame to the **App** also hide who answered? (This contract says yes: it never names the person.)
7. **Live fan-out under load:** one socket per device with `subscribe`. Any objection to sharing it between Go-bound outbox and App frames (same commit hook)?
8. **Account deletion** (§4.1): confirm the Server clears join answers and anonymises messages, and that `forget_person` without `trip_id` is called first.
9. **Where does the invite code live** when the organizer rotates it: are old links `revoked` or silently redirect?
10. **Web Push for the PWA**: confirm VAPID keys are managed by the Server (the app only calls `POST /me/devices`).
11. **Time zones:** `earliest_leave` and `Day.date` are free text / local dates; confirm the destination's time zone is carried on `Place`, or add `timezone` to `Place`.
12. **Taking a vote back** (§9.13): can `decision.voted` carry `retracted: true`, or does Go prefer a separate `decision.unvoted` event?
13. **Who books** (§9.14): is the `claim` card action on a `notice` card the right shape, and does Go take the first claim?

---

## 12. Acceptance scenarios (an end-to-end check the two teams can run)

1. **Sign in** with Google → `Me`; second sign-in with the same account returns the same `person_id`; `is_new` is false.
2. **Create a trip** → `trip.created` is change **1**; `GET /trips/:id` has `people=[me]`, an `invite_url`.
3. **A friend opens the link signed out** → public preview; signs in; **accepts** → `person.joined` is change 2 and the organizer's phone gets a `message` (system "…joined") and a `trip_changed` live frame with `kinds:["people"]`.
4. **Send a message** twice with the same `Idempotency-Key`/`client_message_id` → one stored message, same `message_id`, one `message.created` outbox row.
5. **Mention Go** → `mentions_go: true`; Go's reply arrives as `typing` then `message`; no push for non-mentions.
6. **Ask Go about this** → `about_message_id` set, `mentions_go: true` even without naming Go.
7. **Vote** → `decision.voted`; a second vote moves it; an anonymous vote returns no `votes` list; closing writes a `decided` record line and `decision.closed`.
8. **Mandate**: only the payer can confirm; another person gets `403`; confirming emits `mandate.confirmed`; the "needs you" strip empties for the payer.
9. **Card tap**: a double tap with one `press_id` sends **one** `card_tap`; when Go is down the app gets `{"result":"refused","toast":"Go didn't answer. Try again."}`.
10. **Private budget**: two people answer; `TripView.budget` shows only `lowest`, `answered`, `of`; neither person can read the other's answer; the event has `by.kind = "system"`.
11. **Pause Go**: that person's next message reaches Go as `withheld: true` with no text, but the other members still read it in full.
12. **Record a payment** → transfers shrink, payee gets a push, **confirm** keeps it, **dispute** restores the amount.
13. **Forget me** → `remaining_facts: 0`, join answers cleared, `person.updated` emitted, messages remain; when Go is down the person is **not** told they were forgotten.
14. **Reconnect**: kill the live socket for a minute while two messages and a vote arrive; reconnecting with `since_seq` replays them in order, or `resync` triggers a re-read; nothing is lost and nothing duplicates.
15. **A `replace_card`** (a call moves from dialing to talking) updates the card in place on every phone with no change number and no event to Go.
16. **A person who left a trip** gets `403` on every route of that trip, and does not appear in `people`.
17. **Web session**: after `POST /auth/google` from the PWA, the body has no `refresh_token`, the `go_refresh` cookie is `HttpOnly; Secure; SameSite=Strict`; `POST /auth/refresh` without `X-Go-Client: web` or from another origin is `403`; reusing an old refresh token revokes the session.
18. **Invite preview is read-only**: fetching `GET /invites/:code` (signed in or out, any number of times) changes nothing; only `POST …/later` puts it on my home screen; `POST …/decline` takes it off and the inviter is not told.
19. **Message read modes**: edit an old message and react to another; `GET …/messages?after_seq=n` returns both in `updated_seq` order; `GET …/messages?before_seq=m` returns posting order and never repeats a page.
20. **Who books** (once §9.14 lands): two people tap "I'll book it" at once; exactly one becomes `payer_person_id`, the other gets `refused`.

---

## Appendix A: limits and rate limits (defaults; tune freely)

| Thing | Limit |
|---|---|
| Message text | 4,000 chars (Go's own 2,000) |
| Attachments per message | 10; each ≤ 25 MB; photos ≤ 12 MP |
| `mentions` | 30 |
| Messages | 30/min/person/trip |
| Typing frames | 1 per 2 s per trip |
| Reactions | 20/min/person/trip |
| Card taps | 10/min/person/trip (a repeat of one `press_id` is free) |
| Votes | 20/min/person |
| City search | 5/s/person |
| Invite preview (`GET /invites/:code`, public) | 30/min/IP |
| `POST /auth/refresh` | 30/min/session |
| Settlement nudge | 1 per debtor per 24 h |
| `POST /me/vault-link` | 6/min/person |
| Uploads | 20/min/person |
| People per trip | 30 · decisions 100 · bookings 100 · expenses 500 · record lines 300 · itinerary days 30 (their `TripSnapshot` limits) |

Every `429` carries `retry_after_seconds`.

## Appendix B: timeouts when the Server waits on Go (from `llms-full.txt`)

| Server → Go | Answer within | If it fails, the App sees |
|---|---|---|
| `send_event` | 2 s | nothing (outbox retries 1 s, 5 s, 30 s, 2 min, 10 min, then every 10 min, give up after 24 h) |
| `card_tap` | 3 s (wait 3.5 s) | `200 {result:"refused", toast}` |
| `catch_up` | 3 s (wait 3.5 s) | `204` (show the room without it) |
| `get_person`, `update_person`, `delete_fact`, `forget_person`, `vault_link` | 2 s | `502 go_unavailable`; the app shows its "Try again" copy; **never** says a person was forgotten |
| Proposed `get_checkin`, `submit_checkin`, `request_task` (§9) | 2 s, allowed to answer `working` | `go_unavailable` or a working state |
| Go → Server (all 18 requests) | 2 s | per `llms-full.txt` |

## Appendix C: endpoint index

| § | Method | Path |
|---|---|---|
| 4.1 | POST | `/auth/google`, `/auth/refresh`, `/auth/logout` |
| 4.1 | GET / PATCH / DELETE | `/me` |
| 4.1 | PUT / DELETE | `/me/upi` |
| 4.1 | POST / DELETE | `/me/devices`, `/me/devices/:device_id` |
| 3 | POST | `/live/ticket` (and `GET /live` WebSocket) |
| 4.2 | GET | `/home`, `/discover/ideas` |
| 4.3 | GET / POST | `/invites/:code`, `/invites/:code/accept`, `/invites/:code/later`, `/invites/:code/decline` |
| 4.4 | POST | `/trips`, `/trips/:trip/leave`, `/trips/:trip/invite/rotate`, `/trips/:trip/read` |
| 4.4 | GET | `/trips/:trip`, `/trips/:trip/invite` |
| 4.4 | PUT / DELETE / PATCH | `/trips/:trip/me/join-answers`, `/trips/:trip/me/budget`, `/trips/:trip/me` |
| 4.5 | POST | `/uploads` |
| 4.6 | GET / POST | `/trips/:trip/messages`, `/trips/:trip/catch-up` |
| 4.6 | PUT / PATCH / DELETE | `/trips/:trip/messages/:message_id[/reaction]` |
| 4.7 | POST | `/trips/:trip/cards/:card_id/actions`, `/me/vault-link` |
| 4.8 | GET / POST / PUT / DELETE | `/trips/:trip/decisions[/:id[/vote\|close\|cancel\|mandate/confirm\|mandate/decline]]` (`DELETE …/vote` is 🔶) |
| 4.8 | GET / POST | `/trips/:trip/record`, `/trips/:trip/record/:line_id/undo\|redo` |
| 4.9 | GET | `/trips/:trip/money`, `/trips/:trip/transactions` |
| 4.9 | POST / PATCH | `/trips/:trip/settlements[/:id/confirm\|dispute]`, `/trips/:trip/transfers/pay-link\|nudge`, `/trips/:trip/expenses/:id` |
| 4.10 | GET / POST | `/trips/:trip/bookings[/:id[/documents/:doc]]`, `/trips/:trip/itinerary` |
| 4.11 | GET | `/trips/:trip/needs-you`, `/trips/:trip/cards` |
| 4.12 | GET / PATCH / POST | `/trips/:trip/bookings/:id/checkin[/complete]` (🔶) |
| 4.13 | GET / PATCH / DELETE | `/me/go`, `/me/go/facts/:fact_id` |
| 4.14 | GET | `/places/cities`, `/places/cities/top`, `/config`, `/health` |
