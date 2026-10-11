# Go: the Server ↔ Go contract (as the Server runs it after rev 4)

**For:** Go's team. **Date:** 10 Oct 2026. **This file holds the contract only:** the connection, what the Server sends
Go, what Go may ask the Server, the shapes added on top of contract 1.0, and what is still open. Background, reasons and
the history of each proposal are in [`GO-CHANGES.md`](GO-CHANGES.md); the covering note is
[`GO-TEAM-ASKS-REV4.md`](GO-TEAM-ASKS-REV4.md); the App ↔ Server side is [`CONTRACT-APP.md`](CONTRACT-APP.md).

It describes the Server as of contract rev 4 (10 Oct 2026), after the first integration run against production Go on
10 Oct 2026 (what changed in that run is marked "since 10 Oct").

**Where the shapes are defined.** Go's official contract **1.3.0**, from `vestra-ai/go-brain` `packages/contract`
(branch `build`, commit `de37966d`, taken 11 Oct 2026), held in this repository as `contract/go.json` (shapes), `contract/methods.json`
(methods) and `contract/socket.json`; the signing and spend-approval test vectors are identical to Go's. The Server
checks every frame against those files. `contract/extensions-1.1.json` (now `1.3.0+server-checkin`) adds only the two
web check-in requests (section 2), not in Go's contract yet. `visible_to_person_ids` on `PostMessage` and `Message` was
the Server's overlay until 1.2 made it official. Where this page and those files differ, the files are what the Server
checks against.

```
 App (PWA)  ──HTTP + one WebSocket──►  Server  ──one signed WebSocket, JSON-RPC 2.0──►  Go
```

---

## 1. The connection

| | |
|---|---|
| Transport | One WebSocket, opened **by the Server** to Go at `/v1/socket?instance=<name>&server=<deployment>`: `instance` names the process and changes on every deploy; `server` is the deployment's one name (`GO_SERVER_NAME`, production `go-server-prod`), the same on every instance and deploy. Frames are JSON-RPC 2.0, at most 1 MiB each. |
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
  `notice`, `checklist` or `rooms`, and (since 10 Oct) only when the tapped `action_id` is one of the card's buttons as it
  stands now: a tap on a button that a `replace_card` removed (a paid, expired or declined pay card) is refused by the
  Server and never reaches Go. The params are `{ tap_id, trip_id, card_id, action_id, person_id, option_id?,
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
gap it cannot explain, it should `read_trip`. The only `seq` values with no event by design are a fixed split on
`GO_CONTRACT=1.0` (section 3.2) and a `replace_card` (which moves the message's `updated_seq`).

Every event is `{ event_id, trip_id, seq, occurred_at, type, data }`.

### 3.1 The events

| `type` | Sent when | `data` (shapes in `go.json` unless marked) |
|---|---|---|
| `trip.created` | a person creates a trip (always `seq` 1) | the `TripSnapshot` |
| `trip.updated` | a person or Go changes the title, destination, dates, vibe, stay, itinerary, status or **the group budget** | `{ by, changed: [...] }`. `changed` names the fields (`"budget"` for the budget), **not the new values**: read the trip |
| `person.joined` | someone joins by invite link | `{ person }` with their join answers |
| `person.updated` | name, photo, UPI flag (when it flips), starting city, earliest leave, what Go should know, or Pause Go changed; also after "forget me" clears a person's join answers | `{ person, changed: [...] }`, `changed` among `name`, `photo_url`, `has_upi`, `from_city`, `earliest_leave`, `know`, `go_paused` (the 1.0 enum also has `role`, which the Server does not send today) |
| `person.left` | someone leaves, or deletes their account | `{ person_id }` |
| `message.created` · `message.edited` | a person's message, or Go's own; a system line (section 3.3) is `message.created`, and `message.edited` only when an account deletion rewrites a name out of it | `{ message }`. From someone who paused Go: `withheld: true`, no text, attachments or mentions |
| `message.deleted` | a person deletes their message | `{ message_id }` |
| `reaction.added` · `reaction.removed` | a reaction | per `go.json` |
| `decision.opened` · `decision.voted` · `decision.closed` · `decision.cancelled` | votes | per `go.json`; an anonymous vote carries totals only; 1.1 adds `flexible` and `retracted` on `decision.voted` |
| `mandate.set` · `mandate.confirmed` · `mandate.declined` | "Yes, book it" | per `go.json` |
| `record.changed` | a line of the trip record | `{ line, change, by }` |
| `booking.changed` | a booking added, updated, or cancelled (including by a passed group vote, `by: system`) | `{ booking, change: "added" \| "updated" \| "cancelled", by }` |
| `expense.changed` | an expense added or removed; **on `GO_CONTRACT=1.1` only**, also `change: "updated"` when a person fixes its split (with `by_person_id`) | `{ expense, change, by }` |
| `settlement.recorded` (1.1) | **a person records a payback** | `{ settlement: Settlement, by }`: `Settlement` is `{ settlement_id, from_person_id, to_person_id, amount_minor, currency, method: "upi" \| "cash" \| "bank_transfer" \| "other", note?, status: "confirmed", recorded_at, confirmed_at }` and `by` the person who recorded it (the official 1.1 shape, since 10 Oct) |

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

Each takes a `seq` (the one right after the change it describes), appears in `read_messages`, and **since 10 Oct is
sent to Go as `message.created`** with `author: { "kind": "system" }` and the text (the poll's anchor also carries its
`vote` card), so Go never has to re-read the trip for one of them (Go's ask). They are a record: Go never answers,
thanks or reacts to them. On an account deletion the "… left" line, like the events around it, names the person
"Former member": Go has just forgotten them. The earlier lines that named them ("Priya joined", "Aarav paid Priya
₹5,800") are rewritten to "Former member" at the same moment, each as its own change: a `message.edited` with
`author: { "kind": "system" }`, the same `message_id` and the new text, so your copy loses the name too. (Not when
someone else who is or was in the trip has the same name: those lines stay as they are.)

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
- **`read_trip` · title.** `title` is the stored title, `"New trip"` included. The app shows a trip still called "New
  trip" as "<destination> <year>" (for example "Hampi 2026"); that name is worked out on the app's reads only, is
  never stored, and is never in `read_trip`, the snapshot or an event. To name the trip, Go sends `update_trip { title }`.
- **A test trip that was reset.** The App team can delete a test trip and everything in it (an internal route, never
  used on real trips). Nothing more is sent about it, events not yet delivered included, and every request naming it
  answers `404 not_found`, `read_trip` too: the trip no longer exists.
- **Every error the Server answers is logged** on our side as one line: the method, the code, `trip_id`, `request_id`,
  the field when known, and the message (never the params). Quote the `request_id` when asking us about a refusal.
- **`update_trip`** accepts `budget_per_person_minor` (1.1): a whole number ≥ 1 in the trip's currency. A frame carrying
  only that field is accepted. A value different from the stored one is saved and `trip.updated changed: ["budget"]` is
  sent by Go; the same value again changes nothing and sends no event. Missing or `null` means unchanged, so Go cannot
  clear the budget; a person clears it in the app.
- **`add_expense`** always creates an expense that counts at once, split equally among `split_person_ids` (odd minor
  units go one each to the first people in joining order). `approval_id` (1.1) names the vault payment it belongs to
  and changes nothing else. **For rooms at different prices, send one `add_expense` per room**, split among that
  room's people.
- **`request_spend_approval`** has two forms (1.3: `RequestSpendApproval = RequestPersonalSpendApproval |
  RequestGroupSpendApproval`). A repeat of the same `request_id` gets the same answer, token included, in both. 1.2's
  ticket form (`kind: "ticket"`, `for_person_id`) is gone with 1.3: the Server answers it `422`.
  - **The group form** (`decision_id`) is granted only for a closed `choice` vote that has a mandate the payer confirmed,
    in the mandate's currency, at or under its cap, refundable when the mandate requires it, with no confirmed booking for
    that vote and no other approval for it still waiting. Denials, in this order: `decision_not_found`,
    `decision_not_closed`, `no_mandate`, `payer_declined`, `payer_has_not_confirmed`, `currency_mismatch`, `over_cap`,
    `not_refundable`, **`already_booked`** (1.2; before 1.2 this was `approval_outstanding` with a detail "this vote is
    already booked"), `approval_outstanding`. Once the booking is cancelled a new approval can be granted. The payer is
    always the mandate's payer.
  - **The personal form** (1.3: `personal: { person_id, card_id, option_id }`, no `decision_id`) is a person's own
    payment: their ticket, or a seat or bag at check-in. The Server grants it against **its own record of that
    person's tap**, never your word: each time a person taps an option on one of your `options` cards (`card_tap` with
    `option_id`), the Server keeps the pick (who, card, option, the option's `price_minor` and `currency` as the card
    showed them, and when) before it sends you the tap, even when you then do not answer. The checks, in this order:
    1. `personal.person_id` is in the trip now; else **`not_in_trip`**.
    2. That person tapped **that option on that card** in the **last 30 minutes**, and the card is one they may
       pick from: one of your cards, on a message they can see, and **not addressed to someone else**. A card whose
       `for_person_ids` names people is theirs only when it names them (or its message's `visible_to_person_ids` does);
       a card that names nobody is the room's, and anyone in the room may pick from it for themselves when its
       `option_kind` is `flight`, `train` or `bus` and it carries no `decision_id`. Else
       **`no_pick`**. (Your guide and simulator ask for the card to name the person; the Server also takes a room's
       card, since you book a room's flights card for whoever taps it.) Your booking may wait up to 30 minutes for an
       ixigo login: a pick older than 30 minutes when you ask is `no_pick`, and the person picks again.
    3. The amount fits the price the card showed when they tapped: same `currency`, and
       `amount_minor ≤ floor(price_minor × 1.05)` (fares move). An option that showed no price fits no amount. Else
       **`no_pick`**: ask them to pick again at today's price.
    4. No unused, uncancelled, unexpired approval for the same person, card and option (a second tap on the same
       option is the same pick); else **`approval_outstanding`**.
    5. No confirmed booking made with an approval for the same person, card and option; else **`already_booked`**.
       A cancelled booking does not count.

    The signed claims carry `personal` (the same three ids) in place of `decision_id`, and `payer_person_id` =
    `personal.person_id`, in Go's key order (`… trip_id, personal, payer_person_id …`). The Server never signs claims
    that fail Go's `spendFormProblem`.

    The card is read **as it stands when you ask**: the message not deleted, that option still on the card, and the
    person still named in `for_person_ids` (or the message still visible to them). If you `replace_card` the options
    card after the pick and drop the option or the person, the answer is `no_pick`: ask first, then replace.
- **`add_booking` with a personal approval:** send no `decision_id`, `for_person_ids: [personal.person_id]` exactly,
  and `payer_person_id: personal.person_id`; `amount_minor` at most the approval's, in its currency. Anything else is
  `409` (`data.code: "conflict"`) and the approval stays unused. On success the approval is marked used, as for a group
  one. A group approval cannot be used for a booking with no `decision_id`, nor a personal approval for one with a vote.
- **`vault_link` · `display`** (1.3): the Server passes the app's `display` through. It asks for `embedded` only with
  `start` `home` (or none); for any other page it refuses the app itself (`422`) and does not ask you.
- **`WorkingCard.live_url`** reaches the app on the card and is written nowhere else: not in the Server's logs, and
  blanked in its test traffic log. **You do not get it back:** the card in `message.created`, `message.edited` and
  `read_messages` comes without `live_url`, so the link is not kept in the Server's queue of events. Everything else on
  the card is as you sent it.
- **`get_option_details`** (1.3): the Server asks when a member who can see the card opens an option's Details, with
  that person's id, and waits 3 s. A whole answer is kept an hour per trip, card and option, and served to anyone who
  can see the card. `complete: false` is shown and not kept. A `409`, a timeout or an answer outside the contract
  shows the last kept answer, else the card's own `details`; a `404` drops what was kept. `replace_card` drops what was
  kept for that card, so the next open asks you again. At most 10 asks a minute per person per trip.
- **`place_info`** (1.3): asked by a background job, never while a person waits; about each idea of the home
  carousel at most once every 24 hours once you have answered in full (hourly until then), one idea every 15 seconds, and not while the socket
  is down. `{ name, from_city? }`: `from_city` is absent for the ideas shown when the person's city is unknown. A whole
  answer's `place.photos` (the first 12), `tag`, `best_months` and, when a city was sent, `travel` are kept (`cab` and
  `drive` are shown as car). A refusal or an answer with no photos leaves the kept photos as they were. `complete:
  false` is not kept as the idea's answer, except that an idea with no photo yet takes the photos it brings (you mark
  a place partial while it lacks only its best months). An idea you have not yet answered about in full is asked about
  again after **1 hour**, not 24. The photo links are handed to the app as you sent them and kept until your next answer, so they must not expire.
- **`OptionsCard.decision_id`** (1.3): `post_message` with an `options` card that carries a `decision_id` is accepted
  only when that vote is in the trip and **open**; otherwise `422`. So: `open_vote` first, then post the card. Give each
  `DecisionOption` the card option's `option_id` as its **`option_ref`**: that is how the app matches a card option to
  the vote's option. A `vote` or `mandate` card may still name a closed vote.
- **`add_vote_options`** (1.3): `{ request_id, trip_id, decision_id, options: 1 to 10 DecisionOption }` → `{ seq }`. The
  options are kept as sent and take the next indexes; votes already cast stay. Refused: `404` when the vote is not
  this trip's; `409` when it is not open, or is not a `choice` vote; `422` when the vote would hold more than **20**
  options (the message says how many it has), a `currency` is not the trip's, or an `option_ref` is one the vote
  already has or appears twice in the request (send only options not shown before). Your guide and simulator allow adding to a yes/no vote; the
  Server answers that `409`. The Server then sends
  **`decision.options_added { decision_id, options, by: { kind: "go" } }`**. A repeat of the same `request_id` adds
  nothing and gets the same `seq`. Then post the new message with its options card carrying the same `decision_id`. An `options` card may hold up to 10 options, and
  `OptionsCard.decision_id`, `Option.url`, `WorkingCard.live_url` pass through to the app as you send them.
- **`post_message` · cards.** A card is stored exactly as sent and reaches the app unchanged, so every field below
  passes through. `mentions` and a card's `for_person_ids` put the message in those people's "needs you" list; for a card, only
  when it has something to press (an action, or a suggestion's `cta`). A notice with no buttons naming someone ("ixigo
  login skipped") is shown in the room but never waits in their list.
- **`post_message` · `visible_to_person_ids`** (official since 1.2, optional): a message only some people can see. 1 to 30
  ids (a repeated id is stored once), each a person in the trip now (otherwise `422`, `data.code: "invalid"`, nothing stored); left out or
  `null` means everyone, as before. Only those people see the message in the app: in the room, live, in "needs you",
  in the chat preview and unread counts; to anyone else it does not exist (a tap on its card from them never reaches
  you). Use it for each traveller's own flight options and booking flow, or a note for one person ("your ixigo money
  applies here"). A later `replace_card` keeps the message's list. **You still see every message**: `read_messages`
  returns them all with `visible_to_person_ids`, and `message.created` carries it. The message takes a change number
  like any other, so people outside the list see a gap in `seq`, which is harmless.
- **`update_booking`** with `status: "cancelled"` cancels a booking. A booking a person added by hand can also be
  cancelled by a group vote (Go hears `booking.changed cancelled`, `by: system`); a booking paid through the vault cannot.

## 5. Shapes added on top of contract 1.0

All in Go's official contract 1.3.0 (section "Where the shapes are defined"), all optional, all checked when present.
On 10 Oct 2026 **production Go still answered contract 1.0.0** on `/v1/health`, did not send any of the rev 4 shapes
below, and refused `expense.changed` `change: "updated"`, which is why production runs `GO_CONTRACT=1.0`.

| Where | Addition |
|---|---|
| `Place` | `timezone` (≤ 64); **`photos`** |
| `Option` (options card) | `details` (`OptionDetails`), `return_journey`, `price_oneway_minor`, `price_round_minor`; **`photos`, `price_min_minor`, `price_max_minor`, `room_types`** |
| `DecisionOption` (`open_vote`) | `details`; **`photos`, `price_min_minor`, `price_max_minor`, `room_types`** |
| `OptionsCard` | `option_kind: "cab"` |
| `Card` | the `checklist` card; **the `rooms` card** |
| `CallCard` | `recording_url`, `duration_s` |
| `Message` · `PostMessage` | `quick_replies`: up to 6 of `{ label 1-40, text? ≤ 2000 }`; `visible_to_person_ids` (1-30 person ids; official since 1.2, section 4) |
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
  person can act on it. Add `visible_to_person_ids` naming them (section 4) and only they see it at all.
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
  waiting, the currency matches and the amount is at most the total of what they chose; the payer is that traveller. 1.3's personal form (section 4) covers a person's own pick on an options card; Go's guide says a seat or bag at check-in uses it too, "the check-in pick being the option", which needs that pick to reach the Server as a card tap.
- Questions for Go: what the signed approval should carry in place of `decision_id`; how `add_booking` or the vault
  refers to it afterwards; and what state the check-in returns to when the payment is abandoned or fails.

**For Go to confirm:**

1. Go calls `read_trip` after `trip.updated` and `person.updated` to see the new values.
2. Go on 1.0 tolerates the two extra fields named at the end of section 5 (it accepted extra fields on 8 Oct 2026).
3. Go accepts `expense.changed` with `change: "updated"` before the Server is switched to `GO_CONTRACT=1.1` (staging
   does; production refused it on 10 Oct).
4. The two `seq` values with no event by design (section 3) are not treated as missed events, and an unexplained gap
   makes Go read the trip.
5. Go verifies the signature over the path with its query string (section 1).
