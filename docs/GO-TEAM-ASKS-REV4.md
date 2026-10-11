# For Go's team: what changes on the Server, and what we ask of Go

> **Record (10 Oct 2026).** The rev 4 asks sent to Go's team. The current contract is [`CONTRACT-GO.md`](CONTRACT-GO.md); see [`README.md`](README.md).

**From:** the Server team. **Date:** 10 Oct 2026. **Status:** built on the Server (contract rev 4). Everything in A and in B1 to B7 is in place and does
nothing until Go sends it; **B8 (check-in payments) is not built** and waits for your answer.
Field and event names below are proposals; tell us what you would rather call them and we will follow.

The App and Server teams agreed a simpler product: no private budgets, no expense approval or disputes, no payback
confirmation, no push notifications, and richer stay options (labelled photos, room types, room arrangements).
This page lists what that means for the Server ↔ Go contract (`llms-full.txt` 1.0.0 plus the 1.1 additions in our
`docs/GO-CHANGES.md`). It supersedes `GO-CHANGES.md` where they differ.

Three lists: **A** what the Server will send differently (please confirm Go tolerates it), **B** what we ask Go to
add, **C** points to confirm.

---

## A. What the Server sends differently

No new event type, enum value or card kind is sent to a Go running 1.0.

### A1. `settlement.recorded` is sent when a payback is recorded
Today it is sent when the payee confirms. Confirmation no longer exists: a recorded payback counts at once.
The shape is unchanged; `status` is always `"confirmed"` and `confirmed_at` equals `recorded_at`. There is no
pending or disputed payback any more, and no event when one is undone (it cannot be undone).

### A2. Expense approval is withdrawn
- `Expense` no longer carries `status` or `confirmations` (in events and in `read_trip`).
- `expense.changed` is never sent with `change: "approved"` or `"disputed"`.
- Every expense counts in `money` from the moment it is added until it is removed.
- `add_expense.approval_id` keeps its meaning (the vault payment the expense belongs to).
- This withdraws `GO-CHANGES.md` 2.5 and the `ExpenseConfirmation` shape.

### A3. One group budget instead of private answers
- People no longer give a private budget band. A trip has one optional **budget per person**, the same for all.
- `TripSnapshot.budget` in `read_trip`:
  - not set: `{ "answered": 0, "of": 4 }`
  - set to ₹20,000: `{ "lowest": { "min_minor": 2000000, "max_minor": 2000000, "currency": "INR" }, "answered": 4, "of": 4, "per_person_minor": 2000000 }`
  - `per_person_minor` is new and optional. The rest is the 1.0 shape, so a 1.0 Go reads it as "everyone answered
    the same band".
- `trip.updated` with `changed: ["budget"]` now comes **by the person** who set it (or by Go, see B1). It is no
  longer sent by `system` when someone joins or leaves.
- `JoinAnswers.spend_band` no longer exists; `person.joined` never carried the budget and still does not.
- `go://trips/<trip>/sheet/budget` keeps its name and now opens the group budget editor.

### A4. Money lines in the room
The Server posts a system message for every money movement, including the expenses Go adds:

```
Priya added Airport cab · ₹1,700 · split 4 ways
Go added Villa Sol · ₹54,200 · paid by Rahul · split 4 ways
Priya changed the split of Airport cab · ₹1,700 · 3 ways
Priya removed Airport cab · ₹1,700
Aarav paid Rahul ₹5,800
```

They appear in `read_messages` with `author: { "kind": "system" }` and text only. No event is sent for them.
**Please treat system messages as a record and do not reply to them** (on 8 Oct Go commented on a system pill).
Go does not need to announce the expenses it adds; if it posts an `expense` card too, the room shows both.

### A5. No push notifications
The Server sends no notifications of any kind. `mentions` on Go's messages and `for_person_ids` on Go's cards
still drive the app's "needs you" list, but nobody's phone buzzes. Nothing for Go to change; do not rely on a
push to bring someone back.

### A6. Starting city
`Person.from_city` and `earliest_leave` are now shown to the whole group in the app. Go already receives both.

---

## B. What we ask Go to add (contract 1.1)

### B1. Set the group budget from the chat
`update_trip` gains an optional field:

```json
{ "request_id": "r_1", "trip_id": "t_goa", "budget_per_person_minor": 2000000 }
```

A whole number ≥ 1 in the trip's currency. Missing or `null` means unchanged (as for every `update_trip` field),
so Go cannot clear it; a person clears it in the app. The Server answers as for any `update_trip` and sends
`trip.updated changed: ["budget"]` by Go when the value differs. The same value again changes nothing and sends no event.

### B2. Accept `expense.changed` with `change: "updated"`
A person can fix an expense's split. Go 1.0 accepts only `added | removed` there (on 8 Oct the real Go refused `approved` with
`422 Invalid option … at data.change`), so today we send no event for a fixed split and Go only sees it on its
next `read_trip`. Please accept `"updated"` (the event carries the whole `Expense`). This is `GO-CHANGES.md` B4,
now without `approved` and `disputed`.

### B3. Labelled photos
`Place`, `Option` and `DecisionOption` gain `photos`, up to 12:

```json
"photos": [ { "url": "https://…/deluxe.jpg", "label": "Deluxe room" }, { "url": "https://…/pool.jpg", "label": "Pool" } ]
```

`label` is optional, at most 40 characters. `photo_url` / `image_url` stay as the single cover. This replaces
`details.gallery_urls` from `GO-CHANGES.md` 1.1 (we still accept it; when both arrive the app shows `photos`).
Please send several photos for a destination (`update_trip.destination.photos`) and for each stay option.

### B4. A price range and room types on a stay
`Option` and `DecisionOption` gain:

```json
"price_min_minor": 900000, "price_max_minor": 1500000,
"room_types": [
  { "room_type_id": "rt_deluxe", "label": "Deluxe room", "sleeps": 2, "price_minor": 2400000, "photos": [ { "url": "https://…", "label": "Deluxe room" } ] },
  { "room_type_id": "rt_std",    "label": "Standard room", "sleeps": 2, "price_minor": 1800000 }
]
```

`price_min_minor` / `price_max_minor` are **per person for the whole stay**. `room_types[].price_minor` is **per
room for the whole stay**. Up to 10 room types, all in the option's currency.

### B5. A room arrangement card
After a stay is picked, a new card kind `rooms` showing the possible room sets and who shares with whom:

```json
{ "card_id": "c_rooms_1", "kind": "rooms", "fallback_text": "Pick how you split the rooms at Villa Sol",
  "title": "Rooms at Villa Sol", "option_id": "opt_stay_2", "for_person_ids": ["p_rahul"],
  "arrangements": [
    { "arrangement_id": "ar_1", "label": "2 Deluxe",
      "rooms": [ { "room_type_id": "rt_deluxe", "label": "Deluxe room", "person_ids": ["p_rahul","p_priya"], "price_minor": 2400000 },
                 { "room_type_id": "rt_deluxe", "label": "Deluxe room", "person_ids": ["p_aarav","p_kabir"], "price_minor": 2400000 } ],
      "total_minor": 4800000,
      "per_person": [ { "person_id": "p_rahul", "amount_minor": 1200000 }, { "person_id": "p_priya", "amount_minor": 1200000 },
                      { "person_id": "p_aarav", "amount_minor": 1200000 }, { "person_id": "p_kabir", "amount_minor": 1200000 } ] }
  ],
  "actions": [ { "action_id": "pick", "label": "Choose", "style": "primary", "per_option": true } ] }
```

1 to 10 arrangements, 1 to 15 rooms each. The buttons are Go's: a tap arrives as the usual `card_tap` with the
existing `option_id` field carrying the `arrangement_id`. `replace_card` updates it in place like any card.

### B6. One expense per room
When people take differently priced rooms, please call `add_expense` **once per room**, with
`split_person_ids` = the people in that room. The Server only knows equal splits, and this makes everyone owe
the right amount with no new rule.

### B7. Flight options per person
Flight choice is now personal. Please post flight `options` cards per person, searched from that person's
`from_city`, with `for_person_ids` and each action's `only_for_person_ids` naming them. The card is visible in
the room; only that person can act on it.

### B8. Paying for a seat or extra baggage at check-in (needs your agreement before we build)
The app wants these paid exactly like a stay: Go's `pay` card and the vault. Two things are missing.

1. **Shapes.** `CheckinState` (answer of `get_checkin`) gains
   `"extras": [ { "id": "x_15kg", "kind": "baggage" | "other", "label": "Extra 15 kg", "price_minor": 180000, "currency": "INR" } ]`
   (up to 10), and `submit_checkin` gains `"extra_ids": ["x_15kg"]`. The Server would send the chosen seat and
   extras, priced or not, when the person completes check-in; Go answers `working`, posts the `pay` card for
   anything priced, and finishes after the payment. Today a paid seat reaches Go by no request at all.
2. **The approval.** `request_spend_approval` is granted only for a closed vote whose payer confirmed the
   mandate. A personal seat or bag has neither, so the Server would deny it. We propose a personal form naming
   the flight booking and the traveller in place of `decision_id`. The Server would grant it only when that
   person is in the trip, the booking covers them, their check-in is submitted and waiting, the currency
   matches, and the amount is at most the total of the priced seat and extras they chose. The payer is always
   that traveller.

Questions for you: what should the signed approval carry in place of `decision_id`; how should `add_booking` /
the vault refer to it afterwards; and what state does the check-in return to if the payment is abandoned or fails
(we suggest `open` or `failed` with a message)?

---

## C. Please confirm

1. **Events name what changed, not the new value.** `trip.updated` and `person.updated` carry `changed: [...]`
   only. We assume Go calls `read_trip` to see the new dates, budget, title or starting city. Is that right?
2. **Unknown optional fields are tolerated.** `budget.per_person_minor`, and `photos` inside a destination or
   place that a person entered, will reach a 1.0 Go in `read_trip`, `trip.created` and `booking.changed`. The
   real Go accepted extra fields on 8 Oct; please confirm that holds.
3. **Coverage.** For everything in this release there is an event to Go:

   | What happens in the app | Event |
   |---|---|
   | dates, title, status or itinerary changed | `trip.updated` |
   | group budget set or cleared | `trip.updated` `changed: ["budget"]` |
   | starting city, leaving time, notes, name, photo, UPI flag, pause | `person.updated` |
   | expense added or removed | `expense.changed` |
   | expense split fixed | `expense.changed` `updated` (only once B2 is accepted) |
   | payback recorded | `settlement.recorded` |
   | booking added, changed, or cancelled by the group's vote | `booking.changed` |
   | vote opened, cast, closed, called off; mandate answered | `decision.*`, `mandate.*` |
   | someone joined or left | `person.joined`, `person.left` |

   The profile's default city is not a Go field and is not sent. Is anything missing that Go needs?
4. **Cancelling a booking is unchanged**: a passed group vote marks a hand-added booking cancelled and Go hears
   `booking.changed cancelled`. A booking paid through the vault still cannot be cancelled by a vote.

---

## Summary for planning

| # | Item | Go needs to | Blocks the Server? |
|---|---|---|---|
| A1-A6 | Changed sends | tolerate; stop replying to system messages | no |
| B1 | Budget in `update_trip` | add one field | no (people can set it in the app meanwhile) |
| B2 | `expense.changed` `updated` | accept one enum value | no |
| B3-B5 | Photos, price range, room types, `rooms` card | send the new shapes | no (inert until sent) |
| B6-B7 | One expense per room, per-person flights | change behaviour, no shape | no |
| B8 | Check-in payments | agree shapes and the approval | **yes: we build it only after you answer** |
