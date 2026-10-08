# App ↔ Server contract: the Server team's answer to v1 draft rev 2

**From:** the Server team (Nishanth, Rahul). **To:** the App team (Saket). **Date:** 8 Oct 2026.
**Status:** proposal for **rev 3**. Once you agree, this plus your rev 2 becomes the one contract; the Server's
`docs/API.md` and the Postman collection will follow its section numbers exactly.

We accept rev 2 as the shape of the App ↔ Server API, including the `/app/v1` prefix, your paths and names, the
`Idempotency-Key` header, the error body, the two message read modes, the one WebSocket, and the §7 table. Your
section numbers are used below. Three kinds of entries:

| Mark | Meaning |
|---|---|
| 🔁 **Change** | We do it differently; the new rule is given with the reason |
| ➕ **Addition** | An endpoint or field the app needs that rev 2 does not have (from the designs / the alignment PDF) |
| ℹ️ **Note** | Behaviour you should know about; no change to your calls |

Anything not listed is accepted as written.

---

## §1 Conventions

**§1.1 Base and CORS** · 🔁 The base is the Server's own address (today
`https://server-production-2202go.up.railway.app/app/v1`), not `api.<env>.go.example`. CORS allows exactly the PWA
origins, the headers `Authorization`, `Content-Type` and `Idempotency-Key`, **no credentials** (there is no cookie,
see §1.2) and therefore no `X-Go-Client`.

**§1.2 Authentication** · 🔁 **Sign-in is Supabase Auth, not `/auth/google`.** The Server does not issue tokens.

- The PWA signs in with `supabase-js`: `signInWithOAuth({ provider: "google" })` (PKCE). Supabase returns a session
  with an **access token (JWT, about 1 hour)** and a refresh token; `supabase-js` refreshes it on its own.
- Every request carries `Authorization: Bearer <session.access_token>`. The Server checks the signature against the
  project's published keys, the issuer, the expiry and the `authenticated` role, and creates the person on first
  sign-in from the Google name and photo, keyed by the Supabase user id (never the email).
- `401 unauthorized` → `supabase.auth.refreshSession()` once and retry; still 401 → sign in again.
- Sign-out: `supabase.auth.signOut()` plus `DELETE /me/devices/:device_id` for the push registration.
- **Where the refresh token lives in the browser is your choice**: `supabase-js` keeps it in `localStorage` by default;
  `@supabase/ssr` keeps it in cookies for Next.js, which gives you the httpOnly behaviour rev 2 wanted, without a
  Server route. We recommend `@supabase/ssr`.
- `POST /auth/google`, `POST /auth/refresh`, `POST /auth/logout`, the `go_refresh` cookie and the CSRF rules are
  **removed**. `is_new` → compare `Me.created_at` with now, or treat the first `GET /me` after sign-in as new.
- Test users (until Google is on in Supabase): email + password users exist in the project; the sign-in page and
  the `pnpm supabase:token` tool give you a real token of the same kind.

**Why.** It is built, tested on the real project and deployed; the admin team is enabling Google in Supabase; and it
takes a whole security surface (refresh-token rotation, cookie CSRF) off the Server.

**§1.2 membership** · 🔁 Not a member **and** unknown trip both answer `403 forbidden`. One answer for both is the
only way to never reveal that a trip exists; a person who left also gets a clear signal.

**§1.4 idempotency** · ℹ️ `Idempotency-Key` is the one mechanism for every write. `client_message_id` stays on
messages (for the "sending" bubble) and `press_id` on card taps (it becomes Go's `tap_id`). The Server keeps keys 24 h.

**§1.5 errors** · ℹ️ Adopted as written, including `field`, `retry_after_seconds`, `request_id` and the
`X-Request-Id` header. `422 invalid` is also the answer for an **unknown field** or a value of the **wrong type**
(bodies are strict; nothing is dropped silently).

**§1.7 privacy** · ➕ Two rules added:
- **Travelling from is private in the app.** `Person.from_city` and `earliest_leave` are returned **only to the person
  themselves** (`TripView.me.person`); other members' `Person` objects omit them. Go still receives them (it plans
  routes with them). The design copy "Only you and Go see this" is therefore true; please remove `from_city` from any
  member list.
- **Per-person booking data.** `Booking.passengers[]` and `Booking.documents[]` (§4.10) are returned only to the people
  in `for_person_ids`; everyone else sees the booking without them. Nobody can open another person's ticket.

---

## §2 Object shapes

**`Me`** · 🔁 `auth_provider: "google" | "email"` (`email` = a test user). ➕ `supabase_user_id` is **not** returned;
`person_id` is the only id.

**`TripSummary`** · 🔁 One image field, `photo_url?` (the destination photo Go sets), instead of `cover_url`,
`hero_url` and `illustration_url`. The illustration/avatar is the client's, chosen by destination or vibe.

**`MoneyView.me`** · 🔁 `budget_minor` becomes `budget: { min_minor, max_minor | null, currency } | null`, the same
range as everywhere else. The bar uses `max_minor` (or `min_minor` when there is no max).

**`Expense`** · ➕ gains `status` and `confirmations` (see §4.9 below).

**`Booking`** · ➕ gains `passengers`, `documents`, `details`, `return_journey` (filled by Go; see §4.10) and, on the
Server's side, is filtered per person as in §1.7.

**`NeedsYouItem.kind`** · ➕ gains `"expense"` (an expense waiting for my approval) and `"checkin"` (web check-in
open for my flight).

---

## §3 The live connection

Accepted. ℹ️ Two simplifications on the Server's side that change nothing for the client:
- On `subscribe` with `since_seq` the Server replays the messages changed after it (up to 200) and sends **one**
  `trip_changed` with the current `seq`; above 200 it sends `resync`.
- A `card` frame (Go replaced a card) **also** moves the message's `updated_seq`, so `GET …/messages?after_seq=` returns
  a replaced card after a long offline period. The frame itself still carries no `seq`.

---

## §4.1 Sign-in, session, Me

| Endpoint | |
|---|---|
| `POST /auth/google`, `/auth/refresh`, `/auth/logout` | 🔁 Removed (§1.2). |
| `PATCH /me` | ℹ️ `photo_upload_id` once uploads land; `photo_url` (an `https` link) is accepted meanwhile. |
| `POST /me/devices` | 🔁 v1 accepts `platform: "web_push"` only (the product is the PWA). At most 10 devices per person; the oldest is replaced silently. |
| `DELETE /me` | ℹ️ Accepted with your exact sequence. Lowest priority of the list; tell us if a store review needs it earlier. |

## §4.2 Home

ℹ️ `attention.kind = "task"` appears for: a pending visa checklist row for me (`label: "Visa details needed"`), web
check-in open for my flight (`"Web check-in is open"`), an expense waiting for my approval (`"1 expense to approve"`).
`GET /discover/ideas` is a curated list on the Server for now; `image_url` may be absent, keep a fallback illustration.

## §4.3 Invites

Accepted. ℹ️ A rotated code answers `state: "revoked"`.

## §4.4 Trips

| | |
|---|---|
| `POST /trips` | ℹ️ Also accepts our richer optional fields `destination { name, lat, lng, … }`, `vibe[]`, `plan_minor`, `currency` (default `INR`). `destination_hint` becomes the title when no title is given. |
| `stage` | 🔁 Rule: `new` = no destination **and** no dates; `planned` = destination **and** dates **and** (a confirmed `stay` booking or any confirmed booking); otherwise `deciding`. Computed from the trip's own fields, not from record lines. |
| `POST …/decisions/:id/close` | ℹ️ Organizer or opener, as you wrote. Also: a vote **closes by itself when everyone in the trip has voted**. |
| ➕ `PATCH /trips/:trip` | Body: any of `title`, `dates {start,end}`, `status`, `itinerary` (whole replacement). Any member. Behind the Board's "Change" buttons. Emits `trip.updated`. |
| ➕ `POST /trips/:trip/bookings/:booking_id/cancel-vote` | Opens a non-anonymous yes/no vote "Cancel this booking?" that closes in 24 h; passes only with more than half of the trip. The vote carries `cancels_booking_id`. A booking paid through the vault cannot be cancelled this way (`409`). |

## §4.5 Uploads

ℹ️ Storage is **Supabase Storage** (private bucket). `upload_url` is a signed upload URL; `PUT` the bytes with the
returned `headers`. Attachment and photo URLs in responses are **signed links valid 1 hour, minted when read**; if an
image fails to load after a long time on screen, re-read the message. Size and MIME checks in v1; EXIF location
stripping comes later; **no virus scanning** (files are only shared inside a trip).

## §4.6 The room

Accepted, both read modes as specified. ℹ️ The Server posts **system messages** (`author: { "kind": "system" }`,
text only, drawn as centred pills) for: trip created, someone joined/left, a vote decided ("Diwali won · Fri 6 – Mon
9 Nov"), a booking confirmed. **A person-opened poll** (composer → Poll) also gets a system message carrying the
`vote` card, so the poll appears in the room at once. These messages have a `seq` like any other.

## §4.7 Go's cards

Accepted (`press_id`, 3.5 s, `refused` toast on timeout, `go://` pass-through).

## §4.8 Votes, mandate, record

Accepted. `DELETE …/vote` and the flexible vote are behind `features.vote_retract` / `features.vote_flexible` until Go
confirms. ➕ `POST …/record/:line_id/redo` accepted as written.

## §4.9 Money

**➕ Expense approval (from the alignment PDF, page Z; not in rev 2).** Every expense that is not a vault payment
needs the people in its split to agree.

- `Expense` gains:

```json
"status": "pending" | "approved" | "disputed",
"confirmations": [ { "person_id": "p_priya", "state": "pending" | "approved" | "disputed", "at": "…", "reason"?: "…" } ]
```

  One entry per person in `split_person_ids` **other than the payer** (the payer is implicitly approved). `status` is
  `approved` when every entry is approved, `disputed` when any is disputed, else `pending`. An expense Go adds for a
  booking paid through the vault (`approval_id` set) starts `approved`: the group voted for it and the payer said
  "Yes, book it".
- ➕ `POST /trips/:trip/expenses` · body `{ "amount_minor", "note", "category", "split_person_ids", "booking_id"?,
  "paid_by_person_id"? }` (payer defaults to me) → `201 Expense`. A person adds an expense by hand ("Add a payment" in
  the designs).
- ➕ `POST /trips/:trip/expenses/:id/approve` → `200 Expense`. ➕ `POST …/expenses/:id/dispute { "reason"?: string }`
  → `200 Expense`. Only people with an entry; `409` when already in that state.
- ➕ `DELETE /trips/:trip/expenses/:id` → `200 { seq }`. The payer or the organizer.
- `PATCH …/expenses/:id` (your fix split) ℹ️ resets the confirmations of anyone whose share changed.
- **Money maths:** `pending` and `approved` expenses count in totals and transfers; a `disputed` expense is **left out
  of transfers** (and marked) until the payer fixes or removes it.
- **Needs you:** every pending entry is a `NeedsYouItem { kind: "expense", title: "Approve ₹1,700 · Airport cab",
  cta_label: "Approve", target: { expense_id } }`. **Push** (§8): `type: "expense"` to the people who must approve.
- **Transactions:** each row carries `expense_status` so the ledger can show the badge beside it, and the filter
  gains a value: `GET …/transactions?filter=disputed` (also `pending`) lists only those.
- ➕ `GET /trips/:trip/expenses?status=pending|approved|disputed` → `{ "items": [Expense], "seq" }`: the expenses in
  one state, newest first, for an "Approvals" / "Disputed" view and for the Trip home's "N expenses to approve" row.
  Without `status` it returns all of them.
- The `expense` card in the room shows Approve / Dispute to people with a pending entry (Server-owned buttons, like
  votes).

Everything else in §4.9 is accepted. ℹ️ `POST …/transfers/pay-link` hides nothing: a `upi://pay?pa=…` link carries the
id; it is a convenience, not a privacy measure.

## §4.10 Bookings, documents, itinerary

Accepted. ℹ️ **Several stays in one trip** need nothing new: each is a `Booking` of `kind: "stay"` with its own dates;
the Bookings tab lists them all, the itinerary places each by date, the Board's "Stay" row shows them in order, and
`TripSnapshot.stay` stays "the kind of stay", not a booking. ℹ️ `GET …/bookings/:id/documents/:doc` answers `302` to a
signed URL valid 10 minutes, only for the people the booking covers (or `visibility: "group"`).

## §4.11 Trip home

Accepted. ➕ **Calls** are built, not deferred:
- `GET /trips/:trip/cards?kind=call&state=dialing,talking` as written.
- Stop = card action `stop`; **Listen in** = card action `listen`, which returns `{ result: "open", url }` to a
  Go-hosted page (live transcript, mute, take over, hand back, end). Open it in the browser sheet like the vault.
- The ended call card carries `recording_url` (signed, expiring) and `duration_s`. "Share in group chat" uses
  ➕ `POST /trips/:trip/cards/:card_id/share` → `201 Message`: the Server copies the recording into the room without
  the bytes passing through the phone. Posting the `recording_url` as an attachment is **not** allowed.
- "Ask Go to call…" stays a message mentioning Go in v1.

## §4.12 Web check-in

Accepted and built, behind `features.checkin` until Go's side is live. ➕ `NeedsYouItem { kind: "checkin" }` and
`attention.task` when check-in is open for my flight. ℹ️ A paid seat is a payment: `PATCH …/checkin { seat }` on a
paid seat answers `{ "payment_required": true }` and Go posts a `pay` card; the seat is taken once the vault payment
lands.

## §4.13 You screen

Accepted. ℹ️ Forget me never reports success when Go did not answer.

## §4.14 Places, config, health

ℹ️ `GET /places/cities` is served from a bundled dataset (India, populated places), no third-party call at request
time. `GET /config.features` in v1: `web_push`, `checkin`, `visa`, `calls`, `vote_retract`, `vote_flexible`, `claim`,
`expense_approval` (true from day one).

## §5 Screen by screen

Only one change: **§5.11 Pay sheet** is removed as you wrote; **§5.10** gains the Approve / Dispute badge beside each
expense and on the Trip home "Pending on you".

## §8 Pushes

Accepted. 🔁 No `badge_count` in v1. ➕ `type: "expense"` ("Priya added Airport cab · your share ₹1,700. Approve?")
and `type: "checkin"` ("Web check-in is open for 6E 5313").

## §9 Additions from Go

All fourteen are proposed to Go's team in the Server's own document (`GO-CHANGES.md`), with two more: the expense
approval above (Go's `add_expense` creates a pending expense and learns of approvals through `expense.changed`) and
`Place.timezone`. Until each lands the app degrades exactly as your last column says; the Server passes the new fields
through as soon as Go sends them.

## §11 Open questions, answered

1 `stage`: rule above. 2 Quick start mapping: yes. 3 Settlements: Go sees them when `confirmed`. 4 Person-opened votes:
yes; the Server posts the card's message. 5 People editing the itinerary: `PATCH /trips/:trip`. 6 The budget frame
names nobody. 7 One commit hook feeds Go and the app. 8 Account deletion order: yes. 9 Rotated codes answer `revoked`.
10 VAPID keys are the Server's; the public key is in `GET /config`. 11 We ask Go for `Place.timezone`. 12 Retract:
`decision.voted` with `retracted: true`. 13 `claim` on a `notice` card: yes.

## §12 Acceptance scenarios

Scenario 1 becomes: sign in with Supabase (Google or a test user) → `GET /me`; a second sign-in returns the same
`person_id`. Scenario 17 (web session cookie) is dropped. ➕ Scenario 21: Priya adds an expense split 4 ways → three
`expense` items in "needs you", one push each; Rahul approves, Kabir disputes → the expense is `disputed`, leaves the
transfers, and the payer gets a push; Priya fixes the split → confirmations reset.

---

## What we need back from you

1. A yes/no on §1.2 (Supabase) and on the `from_city` privacy rule.
2. The Approve / Dispute UI for expenses (beside each row, in the `expense` card, on Trip home), or tell us to park
   the feature.
3. Confirmation that "Share in group chat" for call recordings should exist (`POST /trips/:trip/cards/:card_id/share`);
   otherwise the recording is view-only.
4. Anything in your rev 2 we marked ℹ️ that you'd rather we did your way.
