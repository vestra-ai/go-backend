# For Go's team: final contract check before launch

**From:** the Server team. **Date:** 10 Oct 2026. **Please reply by:** filling in the reply table at the end.

This is the last round. We connected our Server to **production Go** (`brain-production-6b68`) and ran full 4-person
trips through every feature: chat, @Go, votes, mandate, spend approval, bookings, expenses, paybacks, catch-up,
"What Go knows", forget, leave, account delete. The socket held up well:
- every event was accepted (0 failed, in seq order);
- every request Go sent us was answered within 60 ms;
- spend approvals verified in your vault;
- money matched to the paisa.

What follows is what we saw from Go that doesn't match the rev 4 contract (`CONTRACT-GO.md`) or your "Connecting your
Server to Go" page.

**For each item, please tell us one of two things:**
- **Done:** where it is live (production or staging, and since when), plus the exact method, event or field the Server
  should expect, so we can test it.
- **Not done:** please implement it as written, or propose a change. Everything the Server needs is already built on
  our side and switches on when Go sends it.

---

## 1. Production Go still speaks contract 1.0 (the main blocker)

On 10 Oct, `GET /v1/health` answers:
- production `{"ok":true,"contract":"1.0.0"}`
- staging `{"ok":true,"contract":"1.1.0"}`

Your page lists A1–B7 as "Live", but production behaves as 1.0 for every one of them:

| Rev 4 item | What production Go did in our tests |
|---|---|
| **B1** Group budget via `update_trip.budget_per_person_minor` | Never sent. Go reads `per_person_minor` when a person sets it, but doesn't set it from the chat. |
| **B2** `expense.changed` with `change: "updated"` | **Refused with 422** (`Invalid option … at data.change`). We hold these events back on production (`GO_CONTRACT=1.0`), so Go only sees a fixed split on its next `read_trip`. |
| **B3** Labelled `photos` on places, options, vote options and destination | Never sent. |
| **B4** `price_min_minor`, `price_max_minor`, `room_types[]` on stays | Never sent. |
| **B5** The `rooms` card | Never sent. |
| 1.1 `checklist` card, `quick_replies` | Never sent. |
| `vault_link` with `start: "add_documents"` and `context` (the visa form) | **Refused with 422.** |

**Questions:**
1. When does 1.1.0 reach production? Is there anything on our side you're waiting for?
2. Until then, should we test against staging? We can point a test Server at it with the same settings.
3. Once production says 1.1.0, we switch to `GO_CONTRACT=1.1` and send `expense.changed updated`. Please confirm that's
   the right signal.

## 2. Go still asks people for private budgets (rev 4 removed them)

Production Go asks each person for their own budget band, and adds an open record line about collecting them. Rev 4 has
**one group budget per person** (`TripSnapshot.budget.per_person_minor`, `trip.updated changed:["budget"]`).

**Need:** no private budget questions and no record lines about them. When the group agrees a figure in chat, send
`update_trip { budget_per_person_minor }` (B1).

## 3. Flight options per person (B7), and seeing only your own

Seen on production: "@Go find flights for each of us from our cities" in a trip with 4 starting cities (Delhi, Mumbai,
Bengaluru, Pune) gave **2 cards** (Delhi and Bengaluru). Mumbai and Pune got nothing. Neither card had `for_person_ids`
or `only_for_person_ids`, and one still had a vote button.

**Need:**
- One flight `options` card per traveller, searched from their `from_city` and `earliest_leave`.
- Each card has `for_person_ids: [that person]`, and each action has `only_for_person_ids: [that person]`.
- No vote button on travel options.

**New: a message only some people can see (your ask, now built on the Server).** `post_message` accepts an optional
field:

```json
{ "request_id": "r_9", "trip_id": "t_goa", "text": "Your flights from Pune", "card": { "kind": "options", "...": "..." },
  "visible_to_person_ids": ["p_priya"] }
```

- 1 to 30 person ids, all in the trip. Absent or `null` means everyone, as today.
- The app shows the message **only** to those people: in the room, live, in their "needs you" list and on the cards
  screen. To everyone else it doesn't exist (no taps, replies or reactions from them).
- `read_messages` returns these messages to Go with the field set. The message still takes a change number and gets
  its `message.created` event.
- Use it for each traveller's flight options and booking flow, and for owner-only notes ("your ixigo money applies
  here").
- `replace_card` keeps the message's visibility. Visibility is fixed when the message is posted.

**Questions:**
4. Is `visible_to_person_ids` a good name, or do you want another? We'll rename on our side before launch.
5. Will Go set it on every per-person flight card and booking step? If a card should stay visible to the room and be
   actionable only by one person, keep using only `for_person_ids` and `only_for_person_ids`.

## 4. "Already booked" needs its own denial reason

When a vote is already booked (a confirmed booking exists), the Server denies a second `request_spend_approval` so
nobody pays twice. Contract 1.1 has no reason for that. We send:

```json
{ "status": "denied", "reason": "approval_outstanding", "detail": "this vote is already booked: a second payment would charge twice (cancel the booking first)" }
```

Go read this as "an earlier approval is still waiting" and told the room to wait.

**Proposal:** add `already_booked` to `SpendDenialReason`. Go tells the person it's booked already, and to cancel first
if they want to rebook.

**Question:**
6. Agree? Once you accept the value, we'll send `already_booked` (until then we keep `approval_outstanding` with this
   detail).

## 5. Catch-up mislabels a person's own asks

`catch_up` for a person returned items that listed **their own** questions under "Go is asking you".

**Need:** in `catch_up { trip_id, person_id, since }`, only list as asking-you the things Go or others asked **that
person**. Their own messages are "you asked …" or are left out.

## 6. Speed and data

| What | Seen | Need |
|---|---|---|
| `send_event` answer time | `mandate.set` took **2,142 ms** (the promise is 2 s; everything else had a p50 of about 350–480 ms) | answer within 2 s; do the work after answering |
| A declined pay card | after **Decline**, the card stayed `waiting` with live Approve/Decline buttons for **46 s** before `replace_card` made it `declined` (Go cancelled the approval at 16 s) | send `replace_card` with `state:"declined"` and no actions as soon as the decline is handled |
| Stay prices | the options card's `price_minor` was **per night** (₹11,800, subtitle "₹35,400 for 3 nights") while the vote options built from it carried the **3-night total** (₹35,400) | one meaning everywhere: `price_minor` is the total for the whole stay (per night can go in the subtitle or details) |

**Question:**
7. Please confirm `price_minor` on a stay option is the whole-stay total, for both cards and `open_vote` options.

## 7. Check-in (`get_checkin`, `submit_checkin`, B8)

These two methods are in our extension only (`contract/extensions-1.1.json`), not in your `methods.json`. B8 (paid seats
and baggage at check-in) still waits on your answers from the rev 4 asks.

**Questions:**
8. Will Go implement `get_checkin` and `submit_checkin` as in our extension? If yes, please add them to `methods.json`.
   If not, we turn web check-in off for launch.
9. B8: what does the signed approval carry in place of `decision_id` for a personal seat or bag? How do `add_booking`
   and the vault refer to it? What state does a check-in go back to when the payment is abandoned or fails? If B8 isn't
   coming before launch, say so and we hide paid extras.

## 8. Also seen in the room (behaviour, no contract change)

- **Go announces its own expenses** ("I've added Villa Sol…") although the Server already posts the money line for
  every `add_expense` (rev 4 A4). The room shows both.
- **Go repeats vote results** after the Server's "Villa Sol won · 3 votes" line.
- **Go's reasoning text sometimes shows in the room** (planning notes in `post_message.text`).

Go replying to chatter that didn't mention it is fine: that's Go's call.

## 8b. Seen in the final run (10 Oct, after 19:50 IST)

- **Stay search was down.** Twice, "@Go find stays for 6–9 Nov" got "ixigo wouldn't load its stays" and a notice card
  linking to ixigo, with no options card. Each attempt also posted **two identical** "Searching hotels on ixigo" working
  cards.
- **No mandate for a vote a person opened.** After the group's own vote closed ("Villa Sol, Anjuna won"), "@Go Asha
  pays, cap ₹55,000" got "isn't something I can book here", and Go never called `set_mandate`. So "Yes, book it", the
  spend approval and the pay card can't be reached for any stay Go didn't find itself.
- **A forget notice goes to the whole room.** After `forget_person`, Go posts "Go forgot you in this trip" to everyone.
  It should be an owner-only note (`visible_to_person_ids: [that person]`, item 3).
- **`forget_person` took longer than 2 s once** (2,096 ms, so our Server answered the person 503). Go still forgot.
  Please answer within 2 s.

**Questions:**
10. Is the stay search back? Is a single working card per search intended?
11. Should Go set a mandate on a closed vote a person opened (when the winning option is bookable on ixigo)? If not,
    what should the app tell the group?

## 9. For your information (no change for Go)

- **A leaver's and a deleted account's messages** stay in the room. The app shows their author as "Former member".
  `read_messages` is unchanged for Go: the `person_id` is kept, and a deleted account's `Person.name` is already
  "Former member".
- **System messages** (joins, leaves, money lines, vote results, bookings) now reach Go as `message.created` with
  `author.kind: "system"`, as you asked. Per your A4: never reply to or react to them.
- The `person.updated` events carry the whole `Person`, as you asked.

---

## Reply table (please fill in and send back)

| # | Item | Done or not done | If done: production or staging, since when, and the method, event or field we test | If not done: date, or a counter-proposal |
|---|---|---|---|---|
| 1 | Contract 1.1.0 on production (B1–B5, checklist, quick_replies, `add_documents`) | | | |
| 2 | No private budgets; budget via `update_trip` | | | |
| 3a | One flight card per traveller with `for_person_ids` and `only_for_person_ids`, no vote button | | | |
| 3b | `visible_to_person_ids` on per-person cards and owner-only notes (name OK?) | | | |
| 4 | `already_booked` denial reason | | | |
| 5 | Catch-up doesn't list a person's own asks as asking them | | | |
| 6a | `send_event` within 2 s | | | |
| 6b | Declined pay card replaced at once | | | |
| 6c | `price_minor` is the whole-stay total everywhere | | | |
| 7 | `get_checkin` / `submit_checkin` in `methods.json`; B8 answers | | | |
| 8 | No self-announced expenses, no repeated vote results, no reasoning text in the room | | | |
| 8b | Stay search back, one working card; mandate for person-opened votes; forget notice owner-only; `forget_person` within 2 s | | | |

Anything else Go needs from the Server that isn't covered here? Please list it in your reply. After this round we freeze
the contract for launch.
