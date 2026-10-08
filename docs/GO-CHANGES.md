# Server ↔ Go: changes the app needs (proposal for contract 1.1)

**Draft for Keshav's team, 8 Oct 2026.** Everything in `llms-full.txt` (1.0.0) stays as it is; this page lists only
what is **new**. Every change is additive (an optional field, a new enum value, a new action id, a new card kind, or a
new request), so a reader of 1.0.0 keeps working. Each item says why a screen needs it, the exact shape, what our
server does with it, and how the app behaves until it lands. Items are grouped by size so you can take them in order.

Audience: Go's team (Keshav), with the Server team (Nishanth, Rahul) and the App team (Saket) in copy.

---

## 0. Where we stand

Implemented and live on the Server (Railway, `https://server-production-2202go.up.railway.app`, Supabase Postgres):

| Area | State |
|---|---|
| Signed socket | One outbound connection per instance, fresh signature per connect, reconnect 1/2/5/10/30 s, idle close at 40 s, pending requests resent |
| Go → Server | All **18** requests validated against `socket.json`, answered within the 2 s limit (slowest seen: 92 ms), idempotent per `(trip_id, request_id)` |
| Server → Go | `send_event` through a per-trip ordered outbox with the contract's retry ladder; `card_tap`, `catch_up`, `get_person`, `update_person`, `delete_fact`, `forget_person`, `vault_link` with the contract's timeouts |
| Events | All **20** event types emitted. Real-Go test on 6 Oct: 19 of 20 accepted; `booking.changed` not reached because the spend approval was refused on your side (below) |
| Spend approvals | Ed25519 JWS (`EdDSA`, `typ: go-spend+jws`), 10 min expiry, claims in contract order. **Our public key is in `go-spend-public.pem` and still needs installing in Go's vault** |
| Cards | Stored exactly as received (`raw.card`), `replace_card` in place, `only_for_person_ids` / `for_person_ids` / `per_option` honoured; record cards drawn from our rows |
| Privacy | Budget answers private (`trip.updated changed:["budget"] by:system`), no phone/email/UPI to Go, paused people `withheld: true`, anonymous votes without `votes[]` |

Open behaviour issues from that test are listed in part 4; they need no contract change.

---

## 1. Group A: small, additive, unblocks most screens

### 1.1 Option details (details sheets)

**Why.** The Place details and Stay details sheets show a hero photo, "why Go picked it", a rough cost per person,
things to do, amenities, a cancellation line, rating and review count. `Option` and `DecisionOption` carry none of it.

**Shape.** On both `Option` (options card) and `DecisionOption` (`open_vote`), optional:

```json
"details": {
  "gallery_urls": ["https://…"],
  "caption": "Beaches · 1h flight from Bengaluru",
  "why": ["Fits everyone's budget (₹15–25k each)", "Dry, sunny weather in November"],
  "costs": [{ "label": "Stay, 3 nights", "emoji": "🏠", "amount_minor": 1000000, "currency": "INR" }],
  "total_minor": 2100000,
  "amenities": ["Private pool", "3 bedrooms", "Kitchen"],
  "activities": ["Beaches", "Scooter rides", "Sunset spots"],
  "facts": [{ "label": "Getting there", "value": "About 8 hours by road" }],
  "cancellation": "Free cancellation till 1 Nov",
  "rating": 4.7, "review_count": 212,
  "go_note": "Cheapest option. You could all drive down together."
}
```

**Server.** Stored and passed through to the app unchanged. **Until it lands:** the sheet shows `title`, `subtitle`,
`image_url`, `price_minor` and `highlights` only.

### 1.2 Round trips and cabs (route sheet, cab sheet)

**Why.** The route sheet prices one way and round trip and shows both legs; the cab sheet lists cabs. `Option` has one
`journey`; `option_kind` has no `cab`.

**Shape.**
- `Option.return_journey?: Journey`
- `Option.price_oneway_minor?`, `Option.price_round_minor?` (keep `price_minor` as the price the card shows)
- `option_kind` gains `"cab"` (`Journey.mode` already allows `cab`)
- `card_tap` gains `payload?: { "trip": "oneway" | "round" }`, sent with `pick` when the person chose

**Server.** `payload` is passed from the app's `POST …/cards/:id/actions` body to `card_tap` unchanged. **Until it
lands:** one way only; a cab shows as a generic option.

### 1.3 Quick replies (chips under Go's messages)

**Why.** "TAP TO REPLY · 🏖️ Beach · ⛰️ Mountains · Not sure, suggest some" and the "next step" pill. A tap **sends
that text as the person's own message**; it is not a card button and never a `card_tap`.

**Shape.** `post_message.quick_replies?: [{ "label": "🏖️ Beach", "text"?: "Beach" }]` (label ≤ 40, up to 6). Stored
on the `Message` and returned by `read_messages` too.

**Server.** Pass-through. The tap arrives at Go as an ordinary `message.created` with `text ?? label`. **Until it
lands:** Go says the choices in plain text.

### 1.4 App-internal links from card buttons (`go://`)

**Why.** "Add my budget" opens the budget sheet, "Open the plan" opens the itinerary, "View my details" opens my
booking. Today an `open` result means a web page in the browser sheet.

**Shape.** No schema change. `ActionOpen.url` may use the scheme **`go://`**, which the app treats as an in-app route:

| Route | Opens |
|---|---|
| `go://trips/<trip_id>/sheet/budget` | the budget sheet |
| `go://trips/<trip_id>/sheet/route` · `…/sheet/cab` | the route / cab sheets (on an options card) |
| `go://trips/<trip_id>/bookings/<booking_id>` | my booking (just-for-me) |
| `go://trips/<trip_id>/itinerary` · `…/bookings` · `…/expenses` | a Trip tab |
| `go://trips/<trip_id>/checkin/<booking_id>` | check-in (group C) |

`https://` keeps meaning "open in the browser sheet". **Server:** passes both through. **Until it lands:** Go sends a
plain message asking the person to open the sheet.

### 1.5 Flexible vote (dates poll)

**Why.** "I'm flexible, any of these work". `Decision` only has `option_index`.

**Shape.** `decision.voted` data gains `flexible?: true` (then no `option_index`); `Decision.flexible_count?: number`.
A flexible vote counts toward `voted` and leaves `tally` unchanged. Anonymous votes omit `person_id` as today.

**Server.** New app route `PUT …/vote { "flexible": true }`. **Until it lands:** the app sends "Flexible, any of
these work" as a message.

### 1.6 Attachments: location and voice length

**Shape.** `Attachment` gains `{ "kind": "location", "lat", "lng", "name"?, "address"? }`; `FileAttachment` gains
`duration_s?` (voice notes are `kind: "file"` with an audio MIME). **Server:** stores and forwards both. **Until it
lands:** location goes as a text message with a maps link; voice as a plain file.

### 1.7 Booking details, passengers and documents (bookings tab, ticket viewer, just-for-me)

**Why.** The booking card shows detail rows, the just-for-me sheet shows my seat and PNR, the ticket viewer opens a
PDF. `Booking` has none of these, and there is no way for a file Go obtained to reach the server.

**Shape.** On `add_booking` / `Booking`, optional:

```json
"details": [{ "label": "Check-in", "value": "Fri 6 Nov, 2 pm" }, { "label": "Guests", "value": "4" }],
"return_journey": { …Journey… },
"passengers": [{ "person_id": "p_aarav", "seat": "14A", "pnr": "K7QX2M" }],
"documents": [{ "document_id": "doc_1", "name": "6E5313-K7QX2M.pdf", "mime": "application/pdf",
                "size_bytes": 184233, "pages": 2, "visibility": "covered" | "group",
                "url": "https://…signed link valid ≥ 10 min…" }]
```

**Server.** On `add_booking` the server fetches each `documents[].url` once, stores the file in its own bucket, and
serves it only to the people the booking covers (`for_person_ids`) unless `visibility: "group"`. `passengers` and
`documents` are shown only to covered people; everyone else sees the booking without them. **Until it lands:** the
viewer shows a placeholder; "who lands when" has no seat/PNR.

### 1.8 Itinerary: whose item is it (face stacks, "Just me" view)

**Shape.** `ItineraryItem.person_ids?: string[]`, `ItineraryItem.audience?: "group" | "shared" | "private"`,
`Day.image_url?`. **Server:** `private` items are returned only to the people in `person_ids`; the app's
`scope=me` view is built from these plus the person's bookings. **Until it lands:** everyone sees everything.

### 1.9 Taking a vote back

**Shape.** `decision.voted` data gains `retracted?: true` (then no `option_index`); `voted` and `tally` are the new
totals. **Server:** app route `DELETE …/decisions/:id/vote`, off behind a feature flag until you confirm.
**Alternative if you prefer:** a separate `decision.unvoted` event; say which.

### 1.10 Who books for the group: the `claim` action

**Why.** After a stay vote closes the room shows "One person books for all" with one button for anyone, "I'll book it".
The first tap wins; everyone else sees "Rahul is booking for all 4". Today only Go picks `payer_person_id`, in
`set_mandate`.

**Shape.** No schema change: a documented card action `claim` on a `notice` card with no `only_for_person_ids`. Go
takes the **first** `claim` it receives (`card_tap` with `action_id: "claim"`), answers `done`, calls `set_mandate`
with that person as `payer_person_id`, and replaces the card ("Rahul is booking for all 4", no buttons). Later claims
get `refused` with a toast such as "Rahul is already booking this."

**Server.** Nothing new: it's an ordinary tap. **Until it lands:** Go picks the payer (organizer by default) and posts
the mandate card directly.

### 1.11 `Place.timezone`

**Shape.** `Place.timezone?: "Asia/Kolkata"` (IANA). **Why.** Itinerary times are local to the destination; the app
needs the zone to show countdowns and "lands 9:55 pm" correctly for international trips. **Until it lands:** the app
assumes the device zone.

---

## 2. Group B: new events, requests and a card kind

### 2.1 `settlement.recorded` (Record a payment)

**Why.** People settle up outside Go (UPI, cash). The payee confirms in the app. The contract has expenses and
computed `transfers` but no way to tell Go a transfer shrank, so Go would keep nudging.

**Shape.** New Server → Go event `settlement.recorded`:

```json
{ "settlement_id": "st_…", "from_person_id": "p_aarav", "to_person_id": "p_rahul",
  "amount_minor": 580000, "currency": "INR", "method": "upi" | "cash" | "bank_transfer" | "other",
  "note"?: "villa + groceries", "status": "confirmed", "recorded_at": "…", "confirmed_at": "…" }
```

**Server.** Sent **only when the payee confirms** (Go never sees pending or disputed ones). `read_trip.money.transfers`
already accounts for confirmed settlements, so Go also catches up on its own. **Until it lands:** Go learns from
`read_trip` only.

### 2.2 `checklist` card and documents through the vault (visa, who lands when, packing)

**Why.** The visa flow collects a passport page, a photo, name, passport number, date of birth and expiry; **the group
sees only "Sent"**. The visa status card and the "who lands when" card are tables of people with a status.

**Shape.**
- `vault_link.start` gains `"add_documents"` (the app opens Go's vault page for the form; **passport data never
  touches the Server or the chat**). Optionally `vault_link.context?: { "trip_id", "purpose": "visa" }`.
- New card kind **`checklist`**:

```json
{ "kind": "checklist", "card_id": "c_visa", "title": "Indonesia e-VOA", "subtitle"?: "…", "due_at"?: "2026-12-10",
  "rows": [{ "person_id": "p_aarav", "status": "todo" | "started" | "done" | "info", "label"?: "Not yet", "sub"?: "Passport, photo" }],
  "suggestion"?: { "text": "You and Arjun land together. Share a cab?", "cta"?: { "action_id": "cab", "label": "Book" } },
  "actions"?: [ …CardAction… ], "fallback_text": "…" }
```

**Server.** Pass-through; `replace_card` updates rows in place. **Until it lands:** Go writes the table into a
`notice` card's body.

### 2.3 Calls: recording, listening in, structured requests

**Shape.**
- (a) `CallCard.recording_url?` (a Go-hosted, signed, expiring link), `CallCard.duration_s?`, in addition to
  `transcript` and `outcome`.
- (b) A card action `listen` on a live `call` card that returns `{ "result": "open", "url": … }` to a **Go-hosted
  page** with the live transcript and Mute / Take over / Hand back / End call. `stop` stays as it is.
- (c) Optional, later: Server → Go `request_task { trip_id, person_id, kind: "call", business, goal }` →
  `{ accepted: true, message_id? }`. In v1 "Ask Go to call…" is a normal message mentioning Go.

**Until it lands:** the Listen sheet shows the card's `last_line` and transcript; no audio.

### 2.4 How booking PDFs reach the server

Covered in 1.7: Go includes a fetchable `url` per document in `add_booking`; the server copies the file once. If you
would rather push, we can give you a presigned PUT in the `add_booking` answer; say which you prefer.

### 2.5 Expense approval (the people in a split agree to it)

**Why.** The Expenses screens ask the people in a split to approve an expense that was added by hand or by Go, with
the approval shown beside each row and on the trip home. Vault payments are exempt (the group voted and the payer said
"Yes, book it").

**Shape.** `Expense` gains `status: "pending" | "approved" | "disputed"` and
`confirmations: [{ person_id, state: "pending" | "approved" | "disputed", at, reason? }]`, one entry per person in
`split_person_ids` other than the payer. `expense.changed` gains the `change` values `"approved"` and `"disputed"`
(data: the `Expense`, plus `by_person_id`).

**Go.** `add_expense` without an `approval_id` creates a **pending** expense (the Server fills `confirmations`); with
an `approval_id` (a vault payment) it is `approved` at once. A `disputed` expense is left out of `money.transfers` until
the payer fixes the split or removes it, so Go should not nag about it; the room text can say who disputed and why.
**Until it lands:** the Server still applies the rule; Go simply sees the new fields in `read_trip` and the extra
`change` values (an unknown `change` should not crash Go).

---

## 3. Group C: web check-in

**Why.** Trip home shows "Web check-in is open", the details step (name, mobile, bags, DigiYatra, declaration), a seat
map (free / paid / taken / next to a friend) and a boarding pass. Go performs the check-in on the airline site.

**Shape.** Two Server → Go requests, both allowed to answer `working` and finish later by event or `replace_card`:
- `get_checkin { trip_id, booking_id, person_id }` → `CheckinState` (`status`, `opens_at`, `closes_at`, `flight`,
  `passenger`, `digi_yatra`, `declaration`, `seat`, `companion`, `seat_map`, `boarding_pass`), as drafted in the app
  contract §4.12.
- `submit_checkin { trip_id, booking_id, person_id, digi_yatra, declaration, seat, mobile? }` →
  `{ status: "done" | "working" | "failed", boarding_pass? }`.
- A paid seat uses the existing spend-approval and vault flow (payer's Face ID), never an in-app payment.
- An event or a `notice` card with a `go://…/checkin/<booking_id>` link when check-in opens.

**Server.** Three app routes behind `features.checkin`. **Until it lands:** the card and the preview link are hidden
and people use the airline's site.

---

## 4. Clarifications and behaviour (no schema change)

1. **Server-authored messages.** For joins ("Rahul joined"), decided/booked pills, and the message that carries the
   `vote` card of a **person-opened** vote, the Server will post messages with `author: { "kind": "system" }`. They
   take a change number and appear in `read_messages`, but **no event is sent** (Go already received
   `person.joined` / `decision.opened`). Please confirm Go tolerates `author.kind = "system"`. (Today Go posts no card
   for person-opened votes, so the room shows nothing for them.)
2. **`replace_card` and change numbers.** To let a phone that was offline fetch a replaced card, the Server will give
   the message a new `updated_seq` on `replace_card`, still with **no event**. Your own `read_messages after_seq` may
   therefore return a message whose only change is the card you replaced. Please confirm that is harmless.
3. **Quick start answers.** A person's vibe arrives as a `know` entry such as `"Vibe: beach"`; the trip-level `vibe`
   stays yours (`update_trip`). A spend band arrives through the budget summary only.
4. **Destination photo.** The app's home and trip hero use `destination.photo_url` from `update_trip`; please set it
   whenever you set a destination.
5. **Private details.** Seats, PNRs and ticket files are shown only to the people a booking covers. Please keep them
   out of group-visible card bodies and messages (the "Sent you your flight details privately 🔒" pattern is right).
7. **What Go 1.0 already accepts (tried on 8 Oct 2026 against the live brain).** The new Server sent, and Go
   accepted: `settlement.recorded` (B1) as a new event type; `expense.changed` carrying `status` and `confirmations`
   (B4); `booking.changed` carrying `details` and `passengers` (A7); and the Server's `system` messages (item 1): Go
   read them, answered the room and commented on the vote result. **The one refusal:** `expense.changed` with
   `change: "approved"`: `Invalid option: expected one of "added"|"removed" at data.change`. So B4's `approved` /
   `disputed` and the `updated` change (a re-split) are the only parts the Server holds back until you confirm them
   (its `GO_CONTRACT=1.1` switch); meanwhile Go sees an expense's state on its next `read_trip`.
6. **Issues already logged on 6 Oct** (`docs/REAL-GO-TESTING.md`): the spend approval refused with no page opened
   (our public key); Go's reasoning in room text; `mentions` never sent, so no pushes; mandates for things Go can't
   book; `open` record lines never closed with `update_record_line` (they stay in everyone's "needs you" strip);
   a wrong place saved on `update_trip`.

---

## 5. What the Server will do on its side for each group

| Group | Server work once you confirm |
|---|---|
| A | Pass the new fields through (no strict schemas block them), add `payload` to `card_tap`, the flexible/retract routes behind flags, document storage and the covered-people rule, `scope=me` filtering |
| B | Send `settlement.recorded` on confirm; pass `checklist` cards and `add_documents` links through; expose `recording_url` and the `listen` action; fill `confirmations` on every `add_expense` and send `expense.changed` approved/disputed |
| C | The three check-in routes, live behind `features.checkin` until `get_checkin` / `submit_checkin` answer on your side |

The Server builds support for **all three groups now**, each behind a feature flag the app reads from `GET /config`,
so a flag flips to on the day your side ships. Reply with a yes/no per item, or a different shape. The chat screens
are built around group A items 1.1–1.3 and 1.10, so those unblock the most.
