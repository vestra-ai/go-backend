# For Go's team: two flight-card bugs from the app (11 Oct 2026)

> **Record (11 Oct 2026).** Bugs reported to Go's team. The personal ticket approval is now part of contract 1.2 and implemented by the Server.

Separate from the rev 5 asks. Seen in the app on production, trip "New trip": Bengaluru and Delhi to Srinagar, 30 Dec.

## G1. A fallback link card instead of flight options

**Seen:**
- For the Delhi traveller, Go posted "Flights, Delhi to Srinagar: Go can't read ixigo's flights from its computer right
  now… Book them there" with a "See flights on ixigo" link.
- For the Bengaluru traveller, it posted a real options card ("3 options").

So one traveller gets options and the other gets sent to ixigo.com. Our logs show the same fallback for stays ("Go
can't read ixigo's stays from its computer right now").

**Ask:**
1. Why does reading ixigo fail on Go's computer, and how often? Please fix it so every traveller gets an options card.
2. If a fallback still happens, retry first. If it still fails, say so plainly in the text ("I couldn't load flights
   from Delhi just now; try again in a minute"). Don't present an ixigo search as the answer.
3. Per B7 and rev 5: one card per traveller, `visible_to_person_ids: [that traveller]`.

## G2. Choosing a flight posts a second card with one option, and choosing again opens ixigo

**Seen:**
1. The traveller picks a flight in the options sheet. Go posts a **new** options card, "Book IndiGo 6E2313 + 6E877
   for you, ₹19,893?", with just that one option.
2. Picking it again takes them to ixigo.com.

**Ask:**
1. **Don't post a second options card.** `replace_card` the original card to show the chosen option (and remove the
   other options' buttons).
2. Then post a **confirm** for that person only (`visible_to_person_ids: [them]`): a `pay` card in `waiting` with
   Approve and Decline.
3. On Approve, pay through the vault (G3) and `add_booking` for that person. Send them to ixigo only if the vault
   can't take it, and say why.

## G3. Paying for a personal ticket (needs both sides)

`request_spend_approval` only works for a closed group vote with a mandate. A personal ticket has no vote, so today the
Server can't approve it. We think that's why Go sends people to ixigo after they pick a flight. **Is that right?**

**Proposal** (the Server builds it; Go uses it): a personal form of `request_spend_approval`, in place of
`decision_id`:

```json
{ "request_id": "r_9", "trip_id": "t_abc", "personal": { "person_id": "p_rahul", "card_id": "c_fl_2", "option_id": "opt_3" },
  "amount_minor": 1989300, "currency": "INR", "merchant": "ixigo", "purpose": "IndiGo 6E2313 + 6E877" }
```

- **The Server grants it only when all of these hold:**
  - that person picked that option on Go's card (the Server records the tap itself) within the last 30 minutes;
  - the card is theirs;
  - the amount is at most the option's price;
  - nothing else is already approved or booked for that pick.
- **The JWS** carries `personal: { person_id, card_id, option_id }` instead of `decision_id`; the payer is always that
  person.
- **`add_booking`** takes that `approval_id` with `for_person_ids: [person]` and no `decision_id`.
- **This also covers B8** (paid seats and bags at check-in), with the check-in pick as the "option".

**Questions:**
1. Is G3 the cause of G2's ixigo redirect?
2. Does this shape work for your vault? It needs a field in place of `decision_id`, and so does the B8 answer.
3. How much can a fare move between showing it and paying? We propose allowing up to 5% over the shown price, with
   anything more asking the person again.

## G4. No typing bubble when Go answers without being tagged

**Seen:** "Go is typing…" shows when someone writes @Go, but not when Go answers a message that didn't tag it.

The Server shows every `typing` notification Go sends, with no condition. So Go isn't sending `typing` when it answers
on its own.

**Ask:** send `typing { trip_id, on: true }` whenever Go starts writing a reply, tagged or not, and `on: false` when it
stops without posting.
