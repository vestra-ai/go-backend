# Server ↔ Go: changes the app needs (proposal for contract 1.1)

**Draft for Keshav's team, 8 Oct 2026.** Everything in `llms-full.txt` (1.0.0) stays as it is; this page lists only
what is **new**. Every change is additive (an optional field, a new enum value, a new action id, a new card kind, or a
new request), so a reader of 1.0.0 keeps working. Each item says why a screen needs it, the exact shape, what our
server does with it, and how the app behaves until it lands. Items are grouped by size so you can take them in order.

Audience: Go's team (Keshav), with the Server team (Nishanth, Rahul) and the App team (Saket) in copy.

---

> **Rev 4 update, 10 Oct 2026.** The App and Server teams simplified the product: no private budgets, no expense
> approval or disputes, no payback confirmation, no push notifications; and richer stays (labelled photos, room types,
> room arrangements). Section 6 lists what that adds and withdraws. Where an earlier section is marked *rev 4*, the
> rev 4 text wins. The covering note for Go's team is [`GO-TEAM-ASKS-REV4.md`](GO-TEAM-ASKS-REV4.md).

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

*Rev 4:* `gallery_urls` is withdrawn in favour of `photos` (6.2). The Server still accepts it; when both arrive the app
shows `photos`.

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
| `go://trips/<trip_id>/sheet/budget` | the group budget editor (*rev 4*: there is no private budget sheet any more; the name is kept) |
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

**Why.** People settle up outside Go (UPI, cash) and record it in the app. The contract has expenses and computed
`transfers` but no way to tell Go a transfer shrank.

**Shape.** New Server → Go event `settlement.recorded`:

```json
{ "settlement_id": "st_…", "from_person_id": "p_aarav", "to_person_id": "p_rahul",
  "amount_minor": 580000, "currency": "INR", "method": "upi" | "cash" | "bank_transfer" | "other",
  "note"?: "villa + groceries", "status": "confirmed", "recorded_at": "…", "confirmed_at": "…" }
```

**Server.** *Rev 4:* sent **when the payment is recorded**, in the same transaction. Nobody confirms or disputes a
payment any more, so `status` is always `"confirmed"` and `confirmed_at` equals `recorded_at`; a recorded payment
counts in `read_trip.money.transfers` at once and cannot be undone. The real Go accepted this event on 8 Oct 2026.

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

### 2.5 Expense approval: withdrawn (*rev 4*)

The product no longer has expense approval or disputes. `Expense` carries no `status` and no `confirmations`, in events
and in `read_trip`; `expense.changed` is never sent with `approved` or `disputed`; every expense counts in `money` from
the moment it is added until it is removed. `add_expense.approval_id` keeps its meaning (the vault payment the expense
belongs to) and changes nothing else.

**What remains of this item:** `expense.changed` with `change: "updated"` when a person fixes an expense's split
(data: the whole `Expense`, plus `by_person_id`). The real Go refused it on 8 Oct 2026 (`422 Invalid option … at
data.change`), so on contract 1.0 the Server sends no event for a fixed split and Go sees it on its next `read_trip`.

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
- *Rev 4:* a paid seat or paid extra baggage is paid through Go's `pay` card and the vault (the traveller's Face ID), never
  an in-app payment. The shapes and the approval this needs are proposed in 6.5 and are not built until agreed.
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
   stays yours (`update_trip`). *Rev 4:* there is no spend band; the group's one budget is in 6.1.
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

---

## 6. Rev 4 (10 Oct 2026): additions and withdrawals

Names are proposals. Everything in 6.1 to 6.4 is additive, validated by the Server when present, stored and returned to
the app as sent, and inert until Go sends it. 6.5 is designed but **not built** until Go's team agrees its half.

### 6.1 One group budget

A trip has one optional budget per person, the same for everyone. People can set or clear it in the app.

- `update_trip` gains `budget_per_person_minor` (whole number ≥ 1, trip currency). Missing or `null` means unchanged, as
  for every `update_trip` field, so Go cannot clear it. The Server answers as for any `update_trip` and sends
  `trip.updated changed: ["budget"]` by Go when the value differs. The same value again changes nothing and sends no
  event.
- `TripSnapshot.budget` (`BudgetSummary`) gains optional `per_person_minor`. Not set: `{ "answered": 0, "of": N }`. Set to
  X: `{ "lowest": { "min_minor": X, "max_minor": X, "currency" }, "answered": N, "of": N, "per_person_minor": X }`. The
  rest is the 1.0 shape, so a 1.0 Go reads it as "everyone answered the same band".
- `trip.updated changed: ["budget"]` now comes by the person who set it. It is no longer sent by `system` on a join or a
  leave, and `JoinAnswers` has no `spend_band`.

### 6.2 Labelled photos

`Place`, `Option` and `DecisionOption` gain `photos`: up to 12 of `{ "url", "label"? }` (`label` ≤ 40, for example
"Deluxe room", "Pool"). `photo_url` / `image_url` stay as the single cover. Replaces `details.gallery_urls` (1.1).

### 6.3 A price range and room types on a stay

`Option` and `DecisionOption` gain `price_min_minor` and `price_max_minor` (**per person for the whole stay**) and
`room_types`: up to 10 of `{ "room_type_id", "label" ≤ 60, "sleeps" ≥ 1, "price_minor" ≥ 0, "photos"? }`, where
`price_minor` is **per room for the whole stay**. All in the option's currency. `sleeps` is 1 to 30.

### 6.4 The `rooms` card

A new Go card kind, posted after a stay is picked, showing the possible room sets and who shares with whom:

```json
{ "card_id", "kind": "rooms", "fallback_text", "for_person_ids"?, "title", "option_id"?,
  "arrangements": [ { "arrangement_id", "label"?,
      "rooms": [ { "room_type_id", "label", "person_ids": ["p_…"], "price_minor" } ],
      "total_minor", "per_person": [ { "person_id", "amount_minor" } ] } ],
  "actions"?: [ CardAction ] }
```

1 to 10 arrangements, 1 to 15 rooms each, `price_minor` per room. Limits the Server checks: 1 to 30 `person_ids` in a
room; up to 30 `per_person` rows; up to 3 `actions`; ids up to 64 characters; `title` and an arrangement's `label` up
to 80, a room's `label` up to 60 (none may be empty). Its buttons are Go's: a tap arrives as the usual
`card_tap`, with the existing `option_id` carrying the `arrangement_id`. `replace_card` updates it like any card.

### 6.5 Paying for a seat or extra baggage at check-in (needs agreement; not built)

- `CheckinState` gains `extras`: up to 10 of `{ "id", "kind": "baggage" | "other", "label", "price_minor", "currency" }`.
- `submit_checkin` gains `extra_ids`. The Server would send the chosen seat and extras, priced or not, when the person
  completes check-in; Go answers `working`, posts its usual `pay` card for anything priced, and finishes after payment.
  Today a paid seat reaches Go by no request at all.
- **The approval is the open question.** `request_spend_approval` is granted only for a closed vote whose payer confirmed
  the mandate. We propose a personal form naming the flight booking and the traveller in place of `decision_id`, granted
  only when that person is in the trip, the booking covers them, their check-in is submitted and waiting, the currency
  matches and the amount is at most the total of what they chose; the payer is always that traveller. On the Server two
  places assume a vote today: the signed approval's contents carry a vote id, and the check that a booking may use an
  approval compares against a vote.
- Questions: what should the signed approval carry in place of `decision_id`; how does `add_booking` or the vault refer
  to it afterwards; and to what state does the check-in return when the payment is abandoned or fails (we suggest `open`
  or `failed` with a message)?

### 6.6 One expense per room

No shape change. When people take differently priced rooms, please call `add_expense` once per room with
`split_person_ids` = the people in that room. The Server knows equal splits only, and this makes everyone owe the right
amount.

### 6.7 Flight options per person

No shape change. Flight choice is personal: please post flight `options` cards per person, searched from that person's
`from_city`, with `for_person_ids` and each action's `only_for_person_ids` naming them. (`from_city` and
`earliest_leave` are now shown to the whole group in the app; Go already receives both.)

### 6.8 Events in both directions: please confirm

Events name what changed, not the new value (`trip.updated` and `person.updated` carry `changed: [...]`); we assume Go
calls `read_trip` for the new value.

| What happens in the app | Event to Go |
|---|---|
| dates, title, status or itinerary changed | `trip.updated` |
| group budget set or cleared | `trip.updated` `changed: ["budget"]` |
| starting city, leaving time, notes, name, photo, UPI flag, pause | `person.updated` |
| expense added or removed | `expense.changed` |
| expense split fixed | `expense.changed` `updated` (1.1 only; see 2.5) |
| payback recorded | `settlement.recorded` |
| booking added, changed, or cancelled by the group's vote | `booking.changed` |
| vote opened, cast, closed, called off; mandate answered | `decision.*`, `mandate.*` |
| someone joined or left | `person.joined`, `person.left` |

In the other direction Go changes a trip with its existing requests, and the app hears each through its live
connection. Cancelling a booking is unchanged: a passed group vote marks a hand-added booking cancelled and Go hears
`booking.changed cancelled`; a booking paid through the vault still cannot be cancelled by a vote. The profile's default
city is not a Go field and is not sent.

### 6.9 Other notes

- **Money lines in the room.** The Server posts a system message for every money movement, including the expenses Go
  adds ("Go added Villa Sol · ₹54,200 · paid by Rahul · split 4 ways"). They appear in `read_messages` with
  `author: { "kind": "system" }` and text only; no event is sent for them. Please treat system messages as a record and
  do not reply to them. Go need not announce the expenses it adds.
- **No push notifications.** `mentions` and `for_person_ids` still drive the app's "needs you" list, but nobody's phone
  buzzes; do not rely on a push to bring someone back.
- **Unknown optional fields.** `budget.per_person_minor`, and `photos` inside a destination or place a person entered,
  reach a 1.0 Go in `read_trip`, `trip.created` and `booking.changed`. The real Go accepted extra fields on 8 Oct 2026;
  please confirm that holds.

