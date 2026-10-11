# App changes: demo payment and demo tickets (12 Oct 2026)

**For:** the App team. **Covers only what changed after the last `changes_app.md` you integrated.** Everything here is
live on production (`https://server-production-2202go.up.railway.app`). The full contract is `docs/CONTRACT-APP.md`
(§4.7 for the pay card, §4.10 for bookings and documents).

## Demo payment: Approve on the pay card is the payment (11 Oct)

For the demo no money moves and there is no vault step (CONTRACT-APP §4.7, "For the demo").

1. **Approve answers `done` at once.** When the payer taps `approve` on a `pay` card in `state: "waiting"`, the tap
   (`POST …/cards/:card_id/actions`) answers `{ "result": "done" }`. There is no `open` and no vault link.
   **Do:** don't wait for or open a vault page on the payer's Approve. Show a short "Paid" state and let the frames
   below redraw the card.
2. **Key on `action_id`, not the label.** Go now labels the button **"Pay with ixigo money"**. The button is still
   `action_id: "approve"`.
3. **Drop the old helper line.** "Approve opens Go's vault page. You confirm there, never in the app." (`copy.ts`
   `pay.helper`) is now wrong. Remove it, or change it to something like "Paid with ixigo money. This is a demo, no
   money moves."
4. **What arrives after the tap:**
   - a `card` frame, then a `message` frame: the pay card is now `state: "paid"` with `actions: null` (no buttons);
   - `trip_changed` with `kinds` `booking`, `record` and `expense`: a confirmed booking (with a `DEMO-…` reference)
     and its expense now exist, so re-read bookings and money;
   - two room lines: "`<title>` booked" and the money line ("… added `<title>` …");
   - then Go posts a **`ticket` card**, `{ kind: "ticket", card_id, booking_id }`.
     - **Do:** draw it from `GET /trips/:trip/bookings/:booking_id` (a record card; the Server's row is the truth).
     - A person's own ticket comes only to them (`visible_to_person_ids`).
5. **A repeated tap** answers `done` again and changes nothing.
6. **When the payment can no longer be taken** (Go expired the card at that moment, or it is already booked):
   `{ "result": "refused", "toast": "This payment is no longer waiting." }`. **Do:** show the toast.
7. **Unchanged:** Decline / "Not now", an expired card's "Start again", and anyone else's tap still go to Go as before.

## Demo booking tickets (12 Oct)

For the demo, a booking made by **Approve** on Go's pay card now looks like a real one and comes with a ticket file.

1. **Richer demo bookings (§4.10).** A flight, train or bus booking has the carrier, flight number, route and times, a
   seat and PNR for each traveller in `passengers[]`, and detail rows such as Cabin, Fare,
   Baggage, Terminal, Stops and Duration. A stay has `starts_at`/`ends_at` (check-in 14:00, check-out 11:00 local time,
   on the trip's dates), and rows for Check-in, Check-out, Nights, Room, Guests and Cancellation. Every demo booking has
   the row **"Booking · Demo, no real ticket"** and a `DEMO-…` reference. Nothing to change if you already draw
   `details[]` and `passengers[]`.
2. **A PDF a moment after Approve.** The booking is answered at once without a file. A few seconds later the Server adds
   a **PDF e-ticket** per leg (`E-ticket DEL-GOI.pdf`) or a **PDF hotel voucher** (`Hotel voucher <name>.pdf`) to
   `documents[]`, and sends **`trip_changed kinds:["booking"]`** with a new `seq` (and `home_changed` to the covered
   people and the payer). **Do:** on that frame, re-read the bookings (or the one booking) to show the file.
3. **`documents[].url` (§2, §4.10).** Every document in the bookings list, one booking and `TripView.bookings` now carries
   `url`: a **signed link valid 1 hour**, minted on each read. Open, download or share it directly. **Do:** don't store it;
   read the booking again for a fresh one when it has run out. `GET …/bookings/:id/documents/:document_id` (302) still
   works as the stable link, and is the fallback when a document comes without `url`. Only the people a booking covers
   and its payer get the booking at all (see "Three fixes" below).

## A booking fills the trip's empty place and stay (12 Oct)

A person can go straight to booking a Goa flight or a stay without the group ever setting the trip's place. After any
booking (Approve on the pay card, Go's own booking, or one added by hand), the trip now takes whatever it **doesn't have
yet** from its confirmed bookings. A value a person or Go set is never overwritten.
- **Destination:** a place, never the hotel's name: the city the outbound flight lands in ("Goa", not the airport town
  "Mopa"), else the town or state from the stay's address ("Anjuna, Goa" gives "Goa").
- **Stay:** the stay's name.
- **Dates: never.** Go and the people set the trip's dates. A booking does not.

**Do:** nothing new beyond the usual. It arrives as `trip_changed kinds:["trip"]` (plus `home_changed` when the place
changed): re-read the trip.

**A demo stay with no trip dates** takes the dates of the stay that was paid for (from its ixigo link). With neither, it has no check-in or check-out: `starts_at`/`ends_at` are absent, the voucher PDF reads
"To be confirmed", and the booking has a "Dates · To be confirmed" row (plus "Nights" when known). **Do:** draw a stay
booking without dates as "Dates to be confirmed", not as an error.

## Three fixes: bookings are private, re-splits stay one expense, a friend added to a split gets the voucher (12 Oct)

1. **A friend's flight is no longer on your Bookings tab (§1.7, §4.10).** A booking now reaches only the people in its
   `for_person_ids` and its payer (`payer_person_id`), and to them whole (`passengers[]`, `documents[]` with `url`).
   Everyone else in the trip does not get it at all: it is missing from `GET …/bookings` and from `TripView.bookings`,
   and `GET …/bookings/:id` and `GET …/bookings/:id/documents/:document_id` answer **`404`**, as for an unknown booking
   (the documents route used to answer `403`, or `302` for a `group` document). Unchanged: the trip's `stage` still
   counts every booking, the room's "`<title>` booked" line and the trip record still name it, the expense that pays for
   it is still in everyone's money, and `POST …/bookings` still answers the booking to the person who added it.
   **Do:** stop drawing a "booked for others" state from a booking without `passengers`; there is none now. Treat a
   `404` on a booking or its file as "not yours to see" (drop it from the screen), not as an error.
2. **"Split evenly" no longer makes a second expense.** Go used to re-split by adding a new expense, so the totals
   counted the cost twice. Go now re-splits the same expense in place (its new `update_expense` request). What the app
   sees is what a person's "Fix split" already sends: `trip_changed kinds: ["settlement","expense"]`, the expense with
   its new `split_person_ids`, and the room line **"Go changed the split of `<note>` · `<amount>` · N ways"**
   (`ledger: { kind: "expense_changed", expense_id }`). **Do:** nothing new if you already draw the `expense_changed`
   line; it can now come from Go.
3. **A friend added to a stay's split can open the voucher (§4.10).** When an expense that pays for a booking
   (`Expense.booking_id`; every demo payment's expense does) is re-split, by its person with `PATCH …/expenses/:id` or
   by Go, the people new to the split are added to the booking's `for_person_ids`, in the same change. Nobody is taken
   off, `passengers` stay as they are, and never past 30 people. You get **`trip_changed kinds: ["booking"]`** with its
   own `seq`, and `home_changed` for the people added. **Do:** on that frame, re-read the bookings: the friend now has
   the stay and its voucher in `documents[]`. The same happens when the expense is first added for a booking (a
   `booking_id` on `POST …/expenses`, or Go's) split with people the booking does not cover.

## Pending items: only what you can act on (12 Oct)

A Go card is a "Pending on you" item only when it has a button **you** can press. A button kept for someone else
(`only_for_person_ids`) doesn't count, and a `rooms` card stops counting once the trip's stay is booked. So a home card
never opens a popup that says "no longer waiting on you". **Do:** nothing; the list is simply shorter.

## How to get the ticket PDF, step by step

The PDF is a **document on the booking**. There's no separate "ticket" endpoint: you read the booking, and its
`documents[]` holds the file with a ready link. The same three steps work for a flight and for a stay; only what's in
the file differs.

### 1. Know which booking

You learn the `booking_id` from one of these:
- **Go's `ticket` card**, posted right after the payment: `{ "kind": "ticket", "card_id": "c_ticket_…", "booking_id":
  "b_7f3a…" }`. This is the usual way.
- **The bookings list:** `GET /app/v1/trips/:trip/bookings` (or `TripView.bookings`). A demo booking has
  `ref: "DEMO-…"` and the detail row "Booking · Demo, no real ticket".

### 2. Read the booking

`GET /app/v1/trips/:trip/bookings/:booking_id` with the person's bearer token.

**Right after Approve** the booking exists but has no file yet:
```jsonc
{ "booking_id": "b_7f3a…", "kind": "flight", "status": "confirmed", "title": "IndiGo 6E 5313 · BLR → GOX",
  "ref": "DEMO-4K7Q2M", "starts_at": "2026-11-06T14:10:00Z", "ends_at": "2026-11-06T15:35:00Z",
  "journey": { "mode": "flight", "origin": { "name": "Bengaluru", "code": "BLR" }, "destination": { "name": "Mopa", "code": "GOX" }, … },
  "passengers": [{ "person_id": "p_rahul", "seat": "4C", "pnr": "B69S47" }],
  "details": [{ "label": "Cabin", "value": "Economy" }, …, { "label": "Booking", "value": "Demo, no real ticket" }],
  "documents": [] }                                  // the PDF is being made
```

**A few seconds later** (usually under 2 s; the Server renders it right after the payment is saved), `documents[]` has
the file:
```jsonc
"documents": [{
  "document_id": "doc_91c2…",
  "name": "E-ticket BLR-GOX.pdf",                    // a stay: "Hotel voucher Villa Sol, Anjuna.pdf"
  "mime": "application/pdf",
  "size_bytes": 93859,
  "pages": 1,
  "visibility": "covered",
  "url": "https://rbltcfpcqkefazsonzbb.supabase.co/storage/v1/object/sign/go-files/bookings/t_…/b_…/doc_….pdf?token=…"
}]
```

### 3. Show or download the file

Open `url` directly: in an in-app PDF viewer, a new tab, a download, or a share sheet. It's a signed Supabase link to
our private bucket, and **it works for 1 hour**.
- Don't store it. Each time you read the booking you get a fresh `url`, so re-read the booking when you need the file
  again.
- **Stable fallback:** `GET /app/v1/trips/:trip/bookings/:booking_id/documents/:document_id` with the bearer token
  answers `302` to a fresh link. Use it when a document comes without `url`, or as a "Download" link you build
  yourself.

### When to re-read (don't poll)

The Server tells you the moment the file lands: a live **`trip_changed`** frame with **`kinds: ["booking"]`** and a
new, higher `seq`, plus `home_changed` for the people the booking covers and its payer. On that frame, re-read the booking you're
showing, or the bookings list.
- If the app wasn't connected when it happened, the next normal read (opening the trip or the booking) has the file
  anyway.
- If you show the ticket card before the file is there, draw it from the booking's fields (route, times, seat and PNR,
  or hotel, dates and room) with a "Ticket PDF on its way…" placeholder. Swap in the file when `documents[]` fills.

### Flight vs stay: what differs

| | Flight (also train and bus) | Stay |
|---|---|---|
| **When** | after the traveller's own flight is paid (Approve on their pay card) | after the group's stay is paid (the payer's Approve) |
| **Who gets the file** | only the traveller: the booking covers just them (they are also its payer), and the card and booking are theirs (`visible_to_person_ids`) | everyone in the trip when it was paid (a group stay covers all members then), and anyone later added to the stay's split |
| **How many files** | one e-ticket per leg: `E-ticket BLR-GOX.pdf`, and for a return trip also `E-ticket GOX-BLR.pdf` | one voucher: `Hotel voucher <hotel>.pdf` |
| **What's in the PDF** | booking id, carrier and flight number, cabin and fare, from/to with airports, terminals, dates and times, duration, stops, baggage, and each traveller's name, PNR, e-ticket number and seat | ixigo booking id, hotel booking number, hotel name, address and map link, check-in and check-out, primary guest, number of adults, room type and inclusions, total price, cancellation policy, terms |
| **Booking fields to draw the card** | `journey` (and `return_journey`), `passengers[]` (seat, PNR), `details[]` | `place`, `starts_at` (check-in 14:00) and `ends_at` (check-out 11:00), `details[]` (Room, Guests, Nights, Cancellation) |

**Who sees what:** a booking reaches only the people it covers and its payer, whole. Anyone else in the trip doesn't get
the booking at all (`404` on it and its file), so they never see someone else's ticket, seat or PNR.

---

**Questions or anything unclear:** reply to the Server team. When this file and `CONTRACT-APP.md` differ,
`CONTRACT-APP.md` is what the Server does.
