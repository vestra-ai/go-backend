# For Go's team: the demo payment (`payment.completed`)

**From:** the Server team. **Date:** 11 Oct 2026. **Status:** agreed by Go's team on 11 Oct 2026 (their answers are in section 5); built on the Server. Names are proposals: tell us if you'd
rather call them something else and we'll follow.

For the demo, no real payment is taken. When the payer taps **Approve** on your `pay` card, the Server treats the
payment as done, writes the booking and the expense itself, and tells you with one new event. Everything before that
tap is unchanged: the pick, `request_spend_approval`, and your `pay` card.

---

## 1. What changes for Go

| Step | Today | In the demo |
|---|---|---|
| Person picks; you ask `request_spend_approval`; you post the `pay` card | as now | **unchanged** |
| Payer taps **Approve** on the `pay` card | `card_tap` reaches you; you answer `open` with the vault page | **The tap never reaches you.** No `card_tap`, no vault page |
| The payment | your vault | none: the Server assumes it is paid |
| The card becomes paid | you `replace_card` with `state: "paid"` | the Server sets `state: "paid"` and `actions: null` on your card itself |
| The booking and the expense | you call `add_booking` and `add_expense` | the Server writes both |
| You learn it is paid | you did it | **`payment.completed`** (below) |

Only a tap on `action_id: "approve"` of a `pay` card in `state: "waiting"`, by the card's `payer_person_id`, is taken
this way. `decline` and every other card's buttons still reach you as now. **Please confirm `approve` is the
`action_id` of that button on every `pay` card you post.**

## 2. The new event

Sent like every other event (`send_event`, the trip's next `seq`, same retries): `{ event_id, trip_id, seq,
occurred_at, type, data }` with `type: "payment.completed"`.

```json
{
  "event_id": "ev_01JC…",
  "trip_id": "t_goa",
  "seq": 214,
  "occurred_at": "2026-10-12T09:06:30.000Z",
  "type": "payment.completed",
  "data": {
    "approval_id": "ap_3f9c1e0b7a2d4c55",
    "card_id": "c_pay_7",
    "payer_person_id": "p_rahul",
    "amount_minor": 1184000,
    "currency": "INR",
    "merchant": "ixigo",
    "purpose": "BLR → GOX · 6E 5313",
    "personal": { "person_id": "p_rahul", "card_id": "c_flights_2", "option_id": "opt_flight_1" },
    "booking_id": "b_01JC…",
    "expense_id": "e_01JC…",
    "method": "demo",
    "paid_at": "2026-10-12T09:06:30.000Z",
    "by": { "kind": "person", "person_id": "p_rahul" }
  }
}
```

| Field | Meaning |
|---|---|
| `approval_id` | the approval you were granted and put on the `pay` card. **Your key for this payment** |
| `card_id` | your `pay` card, now `state: "paid"` with no buttons |
| `payer_person_id`, `amount_minor`, `currency`, `merchant`, `purpose` | exactly as on the approval and the card |
| `decision_id` / `personal` | exactly one is sent, as in the approval's claims: the vote of a group payment, or the person's pick. The other is left out |
| `booking_id` | the confirmed booking the Server wrote for this payment (it carries the same `approval_id`) |
| `expense_id` | the expense the Server wrote for it (its `booking_id` is that booking) |
| `method` | always `"demo"` for now |
| `paid_at` | when the payer tapped Approve |
| `by` | the person who tapped: always the payer |

**Order within the trip.** One tap writes these, in `seq` order, in one transaction:

1. `booking.changed` · `change: "added"`, `by: { kind: "system" }`, the booking with `approval_id`
2. `record.changed` · the **booked** line
3. `expense.changed` · `change: "added"`, `by: { kind: "system" }`
4. **`payment.completed`**: the ids it names have already reached you
5. `message.created` · the room's lines ("… booked", the expense line)

The card's change to `paid` takes a `seq` with no event, like any `replace_card`.

## 3. What we ask Go to do

1. **Accept the event** (`EventAccepted`), and add `payment.completed` to your contract files. A `422` would mark it
   failed and we would not retry.
2. **Treat that approval as paid and finished.** Stop any timer or flow waiting on it: no vault page, no charge.
3. **Do not expire, fail or decline the card.** From this point the Server refuses a `replace_card` of that card unless
   it keeps `state: "paid"` (`409`). You may still replace it to add to a paid card.
4. **Do not call `add_booking` or `add_expense` for that approval.** The Server has written both; the approval is
   marked used, so `add_booking` with it answers `409` "the approval is already used", and `add_expense` naming it
   answers `409` too.
5. **Carry on as you do after a real payment**: confirm in the room, update the itinerary and the trip status, offer
   what comes next. Use `booking_id` from the event; do not post a second "booked" line.
6. **Keep what you learned**: who paid, how much, for what, so later answers ("is the villa paid?") are right.
   `read_trip` shows the same booking and expense.

`cancel_spend_approval` for it still answers `ok` and changes nothing.

**The Server does not check the approval's ten minutes on the tap.** It relies on you to expire the card: a card still
`waiting` after its `expires_at` can be paid. Two things are refused with the toast "This payment is no longer
waiting.": a card whose approval you cancelled, and a card for a vote or a pick that is already booked (you were
granted a second approval after the first ran out, and that one was paid).

## 4. What the Server writes

- **Booking:** `confirmed`, `approval_id` set. Title, kind, journey, place and picture come from the option the
  approval was granted for (the picked option, or the vote's winning option); the amount and vendor from the approval.
  `starts_at` and `ends_at` are set only when the option has a journey, so a stay may carry no dates. `ref` is a demo
  reference (`DEMO-…`).
- **Expense:** the approval's amount, paid by the payer. A personal payment is split to that person alone; a group
  payment is split equally across everyone in the trip.
- **The `pay` card:** `state: "paid"`, `actions: null`, nothing else changed.

## 5. Questions for Go

| # | Question | Go's answer (11 Oct 2026) |
|---|---|---|
| Q1 | Is `approve` the `action_id` of the Approve button on every `pay` card? | Yes, on every waiting card, for the payer only. An expired card's "Start again" is also `approve`, but its state is not `waiting`, so it stays Go's. The label will read "Pay with ixigo money": key on `action_id` |
| Q2 | Will you accept `payment.completed` as specified? | Yes, same names and fields. A repeat is a no-op; an unknown `approval_id` is accepted and logged, never `422` |
| Q3 | What will you post after it? | No second "booked" line and no expense line. The `ticket` card for our `booking_id` (a personal one with `visible_to_person_ids`), then the next step. Go marks the approval used, stops its timers, and does not touch the card's paid state |
| Q4 | Does anything need the vault to have run? | No: Go stops at ixigo's pay step, so no PNR or stored ticket waits on the vault |
| Q5 | When on production Go? | Target 10 pm IST on 11 Oct; until the Server ships, Go's vault flow keeps working |

**For the App:** the pay card's helper line "Approve opens Go's vault page. You confirm there, never in the app."
(`copy.ts` `pay.helper`) is wrong once the Server takes the tap. Change or drop it.
