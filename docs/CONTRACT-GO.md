# Go: the Server ↔ Go contract (as the Server runs it after rev 4)

**For:** Go's team. **Date:** 10 Oct 2026. **This file holds the contract only:** the connection, what the Server sends
Go, what Go may ask the Server, the shapes added on top of contract 1.0, and what is still open. Background, reasons and
the history of each proposal are in [`GO-CHANGES.md`](GO-CHANGES.md); the covering note is
[`GO-TEAM-ASKS-REV4.md`](GO-TEAM-ASKS-REV4.md); the App ↔ Server side is [`CONTRACT-APP.md`](CONTRACT-APP.md).

It describes the Server as of contract rev 4 (10 Oct 2026).

**Where the shapes are defined.** The base is contract **1.0.0**: `https://vestrago.vercel.app/llms-full.txt`, held in
this repository as `contract/go.json` (shapes), `contract/methods.json` (methods) and `contract/socket.json`. The 1.1
additions the Server accepts are in `contract/extensions-1.1.json`, laid over 1.0 additively: nothing in 1.0 is removed,
tightened or made required. Section 5 lists every addition. Where this page and those files differ, the files are
what the Server checks against.

```
 App (PWA)  ──HTTP + one WebSocket──►  Server  ──one signed WebSocket, JSON-RPC 2.0──►  Go
```

---

## 1. The connection

| | |
|---|---|
| Transport | One WebSocket, opened **by the Server** to Go at `/v1/socket?instance=<name>`. Frames are JSON-RPC 2.0, at most 1 MiB each. |
| Signature | Header `x-go-signature: t=<unix seconds>,v1=<hex>` on the upgrade, where `v1 = HMAC-SHA256(secret, "<t>\n" + "GET\n" + "<target>\n")` with an empty body. **`<target>` is the path with its query string, exactly as sent** (`/v1/socket?instance=…`), not the path alone. A fresh signature on every connect; Go accepts each once. |
| Keep-alive | The Server pings every 20 s and closes a socket idle for 40 s. It reconnects after 1, 2, 5, 10, then every 30 s. |
| Both directions | The Server sends requests to Go (section 2) and Go sends requests to the Server (section 4) over the same socket. Every request is checked against the contract before it is acted on; one that does not match is answered with error `422`, `data.code: "invalid"`. |
| `null` | Null and missing mean the same. The Server drops null members from what Go sends before checking, and leaves empty members out of what it sends. So Go cannot clear a field by sending `null`. |
| Version switch | The Server runs with `GO_CONTRACT=1.0` (today) or `1.1`. It changes exactly one thing: whether `expense.changed` with `change: "updated"` is sent (section 3). Everything else on this page is the same on both. |

## 2. What the Server asks of Go

| Method | Params → result | Go answers within | The Server waits | When |
|---|---|---|---|---|
| `send_event` | `Event` → `EventAccepted` | 2 s | 2.5 s | every change to a trip (section 3) |
| `card_tap` | `CardTap` → `CardActionResult` | 3 s | 3.5 s | a person tapped a button on one of Go's cards |
| `catch_up` | `CatchUpRequest` → `CatchUp` | 3 s | 3.5 s | a person came back after 3 hours away or with 15 unread messages from others |
| `get_person` | `GetPerson` → `PersonPage` | 2 s | 2.5 s | "what Go knows about me" |
| `update_person` | `UpdatePerson` → `Ok` | 2 s | 2.5 s | carry-over on or off |
| `delete_fact` | `DeleteFact` → `Ok` | 2 s | 2.5 s | remove one fact |
| `forget_person` | `ForgetPerson` → `ForgetResult` | 2 s | 2.5 s | forget me in one trip or everywhere; also the first step of deleting an account |
| `vault_link` | `CreateLink` → `Link` | 2 s | 2.5 s | a short-lived link to the person's vault page |
| `get_checkin` (1.1) | `GetCheckin` → `CheckinState` | 2 s | 2.5 s | one person's web check-in on a flight booking (behind the Server's `checkin` flag, off today) |
| `submit_checkin` (1.1) | `SubmitCheckin` → `SubmitCheckinResult` | 2 s | 2.5 s | that person's check-in answers |

- **`card_tap`** is forwarded only for a card on one of Go's messages whose kind is `options`, `working`, `call`, `pay`,
  `notice`, `checklist` or `rooms`. The params are `{ tap_id, trip_id, card_id, action_id, person_id, option_id?,
  payload? }`. `tap_id` is fixed per person and press, so a double tap is one tap. On a `rooms` card `option_id` carries
  the `arrangement_id`. If Go does not answer in time, refuses, or answers with something that is not a
  `CardActionResult`, the person sees "Go didn't answer. Try again."
- **`catch_up`**: system messages (section 3.3) do not count towards the 15.

## 3. Events: what Go hears

Every change to a trip takes that trip's next change number (`seq`) and is written, with its event, in one database
transaction. Events for one trip are delivered one at a time, in `seq` order.

**Delivery and retries.** The Server retries an event only when Go answers `429`, `500` or `503`, or does not answer
in time: after 1 s, 5 s, 30 s, 2 min, 10 min, then every 10 min (a `429` with `retry_after_seconds` is retried after
that long instead). It gives up after 24 hours. **Any other error answer (`422` included) marks the event failed, and
the trip's next event goes on.** So an event Go refuses, or one the Server gave up on, is skipped: when Go sees a `seq`
gap it cannot explain (section 3.3 lists the expected ones), it should `read_trip`.

Every event is `{ event_id, trip_id, seq, occurred_at, type, data }`.

### 3.1 The events

| `type` | Sent when | `data` (shapes in `go.json` unless marked) |
|---|---|---|
| `trip.created` | a person creates a trip (always `seq` 1) | the `TripSnapshot` |
| `trip.updated` | a person or Go changes the title, destination, dates, vibe, stay, itinerary, status or **the group budget** | `{ by, changed: [...] }`. `changed` names the fields (`"budget"` for the budget), **not the new values**: read the trip |
| `person.joined` | someone joins by invite link | `{ person }` with their join answers |
| `person.updated` | name, photo, UPI flag (when it flips), starting city, earliest leave, what Go should know, or Pause Go changed; also after "forget me" clears a person's join answers | `{ person, changed: [...] }`, `changed` among `name`, `photo_url`, `has_upi`, `from_city`, `earliest_leave`, `know`, `go_paused` (the 1.0 enum also has `role`, which the Server does not send today) |
| `person.left` | someone leaves, or deletes their account | `{ person_id }` |
| `message.created` · `message.edited` | a person's message, or Go's own | `{ message }`. From someone who paused Go: `withheld: true`, no text, attachments or mentions |
| `message.deleted` | a person deletes their message | `{ message_id }` |
| `reaction.added` · `reaction.removed` | a reaction | per `go.json` |
| `decision.opened` · `decision.voted` · `decision.closed` · `decision.cancelled` | votes | per `go.json`; an anonymous vote carries totals only; 1.1 adds `flexible` and `retracted` on `decision.voted` |
| `mandate.set` · `mandate.confirmed` · `mandate.declined` | "Yes, book it" | per `go.json` |
| `record.changed` | a line of the trip record | `{ line, change, by }` |
| `booking.changed` | a booking added, updated, or cancelled (including by a passed group vote, `by: system`) | `{ booking, change: "added" \| "updated" \| "cancelled", by }` |
| `expense.changed` | an expense added or removed; **on `GO_CONTRACT=1.1` only**, also `change: "updated"` when a person fixes its split (with `by_person_id`) | `{ expense, change, by }` |
| `settlement.recorded` (1.1) | **a person records a payback** | `{ settlement_id, from_person_id, to_person_id, amount_minor, currency, method: "upi" \| "cash" \| "bank_transfer" \| "other", note?, status: "confirmed", recorded_at, confirmed_at }` |

### 3.2 What changed in rev 4

- **`settlement.recorded` is sent when the payback is recorded**, in the same transaction, on both `GO_CONTRACT` values
  (the real Go accepted this event on 8 Oct 2026). Nobody confirms or disputes a payback any more: `status` is always
  `"confirmed"` and `confirmed_at` equals `recorded_at`. A payback counts at once, for good, and cannot be undone.
- **No expense approval.** `Expense` carries no `status` and no `confirmations`, in events and in `read_trip`.
  `expense.changed` is never sent with `approved` or `disputed`. Every expense counts in `money` from the moment it is
  added until it is removed.
- **A fixed split on contract 1.0 sends no event.** Go 1.0's `expense.changed` knows only `added` and `removed` (on
  8 Oct 2026 the real Go refused `approved`, answering that those two are the accepted values; `updated` itself has
  never been sent to it). So on `GO_CONTRACT=1.0` the change takes its `seq` with no event and Go sees the new split
  on its next `read_trip`.
- **Budget.** `trip.updated` with `changed: ["budget"]` comes by the person (or Go) who set the group budget. It is no
  longer sent by `system` when someone joins or leaves, and join answers no longer include a spend band.
- **No push notifications.** `mentions` and `for_person_ids` still drive the app's "needs you" list; nobody's phone
  buzzes.
- **Starting city.** `Person.from_city` and `earliest_leave` are now shown to the whole group in the app. Go receives
  them as before.

### 3.3 System messages

The Server posts messages with `author: { "kind": "system" }` and text only: "Trip created · Rahul joined", "Priya
joined", "Priya left", "Villa Sol won · 4 votes", "Villa Sol booked", the anchor of a poll a person opened (with a
`vote` card), and, new in rev 4, **a line for every money movement, including the expenses Go adds**:

```
Priya added Airport cab · ₹1,700 · split 4 ways
Go added Villa Sol · ₹54,200 · paid by Rahul · split 4 ways
Priya changed the split of Airport cab · ₹1,700 · 3 ways
Priya removed Airport cab · ₹1,700
Aarav paid Rahul ₹5,800
```

Each takes a `seq` (the one right after the change it describes) and appears in `read_messages`. **No event is sent
for a system message**, so Go will see a `seq` it received no event for. The expected `seq` values with no event are:
a system message, a fixed split on contract 1.0, and a `replace_card` (which moves the message's `updated_seq`). They
are a record; Go should not reply to them.

## 4. What Go may ask of the Server

The Server answers within 2 s. When it cannot, it answers error `503`, `data.code: "unavailable"`: **send the request
again with the same `request_id`**. A write repeated with the same `request_id` is done once and answered with the
first answer, including one that finished after the 503. A method the Server does not know is answered with JSON-RPC
error `-32601`; params that do not match the contract with `422`, `data.code: "invalid"`.

| Method | Params → result | The event it produces |
|---|---|---|
| `read_trip` | `ReadTrip` → `TripSnapshot` | none |
| `read_messages` | `ReadMessages` → `MessagesPage` | none |
| `post_message` | `PostMessage` → `PostMessageResult` | `message.created` |
| `replace_card` | `ReplaceCard` → `ReplaceCardResult` | none (the message's `updated_seq` moves) |
| `typing` | `GoTyping` (a notification, no answer) | none |
| `add_reaction` · `remove_reaction` | → `WriteResult` | `reaction.added` · `reaction.removed` |
| `update_trip` | `UpdateTrip` → `WriteResult` | `trip.updated` by Go |
| `open_vote` · `close_vote` | `OpenDecision` · `CloseDecision` | `decision.opened` · `decision.closed` |
| `set_mandate` | `SetMandate` → `WriteResult` | `mandate.set` |
| `add_record_line` · `update_record_line` | | `record.changed` |
| `add_booking` · `update_booking` | `AddBooking` · `UpdateBooking` | `booking.changed` |
| `add_expense` | `AddExpense` → `AddExpenseResult` | `expense.changed` `added`, then the Server's money line in the room |
| `request_spend_approval` | `RequestSpendApproval` → `SpendApprovalResult` | none |
| `cancel_spend_approval` | `CancelSpendApproval` → `Ok` | none |

- **`read_trip` · budget.** `TripSnapshot.budget` when no group budget is set: `{ "answered": 0, "of": N }`. When it is
  set to X: `{ "lowest": { "min_minor": X, "max_minor": X, "currency" }, "answered": N, "of": N, "per_person_minor": X }`,
  N being the people in the trip. `per_person_minor` is the one addition; the rest is the 1.0 shape.
- **`read_trip` · money.** `money.transfers` is the fewest payments that square everyone up, from every expense and
  every recorded payback. Go reads it and never works it out.
- **`update_trip`** accepts `budget_per_person_minor` (1.1): a whole number ≥ 1 in the trip's currency. A frame carrying
  only that field is accepted. A value different from the stored one is saved and `trip.updated changed: ["budget"]` is
  sent by Go; the same value again changes nothing and sends no event. Missing or `null` means unchanged, so Go cannot
  clear the budget; a person clears it in the app.
- **`add_expense`** always creates an expense that counts at once, split equally among `split_person_ids` (odd minor
  units go one each to the first people in joining order). `approval_id` (1.1) names the vault payment it belongs to
  and changes nothing else. **For rooms at different prices, send one `add_expense` per room**, split among that
  room's people.
- **`request_spend_approval`** is granted only for a closed `choice` vote that has a mandate the payer confirmed, in the
  mandate's currency, at or under its cap, refundable when the mandate requires it, with no other approval for that vote
  still waiting. The payer is always the mandate's payer. Anything else is denied with a reason.
- **`post_message` · cards.** A card is stored exactly as sent and reaches the app unchanged, so every field below
  passes through. `mentions` and a card's `for_person_ids` put the message in those people's "needs you" list.
- **`update_booking`** with `status: "cancelled"` cancels a booking. A booking a person added by hand can also be
  cancelled by a group vote (Go hears `booking.changed cancelled`, `by: system`); a booking paid through the vault cannot.

## 5. Shapes added on top of contract 1.0

All optional, all checked when present.

| Where | Addition |
|---|---|
| `Place` | `timezone` (≤ 64); **`photos`** |
| `Option` (options card) | `details` (`OptionDetails`), `return_journey`, `price_oneway_minor`, `price_round_minor`; **`photos`, `price_min_minor`, `price_max_minor`, `room_types`** |
| `DecisionOption` (`open_vote`) | `details`; **`photos`, `price_min_minor`, `price_max_minor`, `room_types`** |
| `OptionsCard` | `option_kind: "cab"` |
| `Card` | the `checklist` card; **the `rooms` card** |
| `CallCard` | `recording_url`, `duration_s` |
| `Message` · `PostMessage` | `quick_replies`: up to 6 of `{ label 1-40, text? ≤ 2000 }` |
| `Attachment` | a `location` attachment; `duration_s` on a file attachment |
| `Booking` · `AddBooking` | `details`, `return_journey`, `passengers`, `documents` |
| `ItineraryItem` · `Day` | `person_ids`, `audience`; `Day.image_url` |
| `CardTap` | `payload: { trip: "oneway" \| "round" }` |
| `CreateLink` | `start: "add_documents"` and `context` (the visa form) |
| `Decision` · `DecisionVotedData` | `flexible_count`; `flexible`, `retracted` |
| `AddExpense` | `approval_id` |
| `ExpenseChangedData` | `change: "updated"`, `by_person_id` |
| `UpdateTrip` | **`budget_per_person_minor`** (whole number ≥ 1) |
| `BudgetSummary` | **`per_person_minor`** |
| `Event` | `settlement.recorded` |

**New in rev 4** (bold above):

```jsonc
// Photo: on Place, Option, DecisionOption and RoomType, up to 12
{ "url": "https://…/deluxe.jpg", "label": "Deluxe room" }            // label optional, 1 to 40 characters

// On Option and DecisionOption
"price_min_minor": 900000, "price_max_minor": 1500000,                // per person for the whole stay
"room_types": [                                                       // up to 10
  { "room_type_id": "rt_deluxe", "label": "Deluxe room", "sleeps": 2, "price_minor": 2400000, "photos": [ … ] }
]                                                                     // price_minor: per room for the whole stay; sleeps 1 to 30; label 1 to 60

// The rooms card
{ "card_id": "c_rooms_1", "kind": "rooms", "fallback_text": "…", "title": "Rooms at Villa Sol",
  "option_id": "opt_stay_2", "for_person_ids": ["p_rahul"],
  "arrangements": [                                                   // 1 to 10
    { "arrangement_id": "ar_1", "label": "2 Deluxe",
      "rooms": [ { "room_type_id": "rt_deluxe", "label": "Deluxe room", "person_ids": ["p_rahul", "p_priya"], "price_minor": 2400000 } ],   // 1 to 15 rooms; 1 to 30 people in a room
      "total_minor": 4800000,
      "per_person": [ { "person_id": "p_rahul", "amount_minor": 1200000 } ] }               // up to 30
  ],
  "actions": [ { "action_id": "pick", "label": "Choose", "style": "primary", "per_option": true } ] }   // optional, up to 3
```

Required on a `rooms` card: `card_id`, `fallback_text`, `kind`, `title`, `arrangements`; on an arrangement:
`arrangement_id`, `rooms`, `total_minor`, `per_person`; on a room: `room_type_id`, `label`, `person_ids`, `price_minor`;
on a room type: `room_type_id`, `label`, `sleeps`, `price_minor`; on a photo: `url`. Ids are up to 64 characters,
`title` and an arrangement's `label` up to 80. All prices are in the option's currency. `photos` replaces the earlier
`details.gallery_urls`, which is still accepted; when both arrive the app shows `photos`.

A person may also enter `photos` on a new trip's destination and on a booking's place, so `photos` and
`budget.per_person_minor` are the two additions a Go on 1.0 can see in `read_trip`, `trip.created` and
`booking.changed`.

## 6. What Go is asked to do (no shape change)

- **Flight options per person.** Post flight `options` cards per person, searched from that person's `from_city`, with
  `for_person_ids` and each action's `only_for_person_ids` naming them. The card is visible in the room; only that
  person can act on it.
- **One expense per room**, as in section 4.
- **Do not announce the expenses Go adds.** The Server posts the line in the room.
- **Treat system messages as a record.**
- **`go://trips/<trip>/sheet/budget`** now opens the group budget editor in the app. There is no private budget sheet.

## 7. Open: designed, not built

**Paying for a seat or extra baggage at check-in.** Today, when a person picks a priced seat the Server tells the app a
payment is required and nothing reaches Go. Proposed, and built only once Go's team agrees:

- `CheckinState` gains `extras`: up to 10 of `{ id, kind: "baggage" | "other", label, price_minor, currency }`.
- `submit_checkin` gains `extra_ids`, and the Server sends the chosen seat and extras, priced or not, when the person
  completes check-in. Go answers `working`, posts its usual `pay` card, and finishes after the payment.
- The approval: `request_spend_approval` today needs a vote and a confirmed mandate (section 4), which a personal seat
  or bag does not have. Proposed: a personal form naming the flight booking and the traveller in place of
  `decision_id`, granted only when that person is in the trip, the booking covers them, their check-in is submitted and
  waiting, the currency matches and the amount is at most the total of what they chose; the payer is that traveller.
- Questions for Go: what the signed approval should carry in place of `decision_id`; how `add_booking` or the vault
  refers to it afterwards; and what state the check-in returns to when the payment is abandoned or fails.

**For Go to confirm:**

1. Go calls `read_trip` after `trip.updated` and `person.updated` to see the new values.
2. Go on 1.0 tolerates the two extra fields named at the end of section 5 (it accepted extra fields on 8 Oct 2026).
3. Go accepts `expense.changed` with `change: "updated"` before the Server is switched to `GO_CONTRACT=1.1`.
4. The expected `seq` values with no event (section 3.3) are not treated as missed events, and an unexplained gap makes
   Go read the trip (section 3).
5. Go verifies the signature over the path with its query string (section 1).
