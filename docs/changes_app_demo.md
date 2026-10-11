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
   seat and PNR for each traveller in `passengers[]` (covered people only), and detail rows such as Cabin, Fare,
   Baggage, Terminal, Stops and Duration. A stay has `starts_at`/`ends_at` (check-in 14:00, check-out 11:00 local time,
   on the trip's dates), and rows for Check-in, Check-out, Nights, Room, Guests and Cancellation. Every demo booking has
   the row **"Booking · Demo, no real ticket"** and a `DEMO-…` reference. Nothing to change if you already draw
   `details[]` and `passengers[]`.
2. **A PDF a moment after Approve.** The booking is answered at once without a file. A few seconds later the Server adds
   a **PDF e-ticket** per leg (`E-ticket DEL-GOI.pdf`) or a **PDF hotel voucher** (`Hotel voucher <name>.pdf`) to
   `documents[]`, and sends **`trip_changed kinds:["booking"]`** with a new `seq` (and `home_changed` to the covered
   people). **Do:** on that frame, re-read the bookings (or the one booking) to show the file.
3. **`documents[].url` (§2, §4.10).** Every document in the bookings list, one booking and `TripView.bookings` now carries
   `url`: a **signed link valid 1 hour**, minted on each read. Open, download or share it directly. **Do:** don't store it;
   read the booking again for a fresh one when it has run out. `GET …/bookings/:id/documents/:document_id` (302) still
   works as the stable link, and is the fallback when a document comes without `url`. Only covered people get
   `documents[]`, as before.

## A booking fills the trip's empty place, stay and dates (12 Oct)

A person can go straight to booking a Goa flight or a stay without the group ever setting the trip's place or dates.
After any booking (Approve on the pay card, Go's own booking, or one added by hand), the trip now takes whatever it
**doesn't have yet** from its confirmed bookings. A value a person or Go set is never overwritten.
- **Destination:** a place, never the hotel's name: the city the outbound flight lands in ("Goa", not the airport town
  "Mopa"), else the town or state from the stay's address ("Anjuna, Goa" gives "Goa").
- **Stay:** the stay's name.
- **Dates:** the stay's check-in to check-out. From flights, only when both a going and a return flight are booked
  (going departure date to return arrival date). A one-way flight leaves the dates empty.

**Do:** nothing new beyond the usual. It arrives as `trip_changed kinds:["trip"]` (plus `home_changed` when the place
or dates changed): re-read the trip. The header and home card then show the place, the dates and the automatic name
("Goa 2026"), and the trip can move to stage `planned`.

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
new, higher `seq`, plus `home_changed` for the people the booking covers. On that frame, re-read the booking you're
showing, or the bookings list.
- If the app wasn't connected when it happened, the next normal read (opening the trip or the booking) has the file
  anyway.
- If you show the ticket card before the file is there, draw it from the booking's fields (route, times, seat and PNR,
  or hotel, dates and room) with a "Ticket PDF on its way…" placeholder. Swap in the file when `documents[]` fills.

### Flight vs stay: what differs

| | Flight (also train and bus) | Stay |
|---|---|---|
| **When** | after the traveller's own flight is paid (Approve on their pay card) | after the group's stay is paid (the payer's Approve) |
| **Who gets the file** | only the traveller: the booking covers just them, and the card and booking are theirs (`visible_to_person_ids`) | everyone in the trip: a group stay covers all members |
| **How many files** | one e-ticket per leg: `E-ticket BLR-GOX.pdf`, and for a return trip also `E-ticket GOX-BLR.pdf` | one voucher: `Hotel voucher <hotel>.pdf` |
| **What's in the PDF** | booking id, carrier and flight number, cabin and fare, from/to with airports, terminals, dates and times, duration, stops, baggage, and each traveller's name, PNR, e-ticket number and seat | ixigo booking id, hotel booking number, hotel name, address and map link, check-in and check-out, primary guest, number of adults, room type and inclusions, total price, cancellation policy, terms |
| **Booking fields to draw the card** | `journey` (and `return_journey`), `passengers[]` (seat, PNR), `details[]` | `place`, `starts_at` (check-in 14:00) and `ends_at` (check-out 11:00), `details[]` (Room, Guests, Nights, Cancellation) |

**Who sees what:** people the booking doesn't cover still see the booking itself, but with no `passengers` and no
`documents`, so they never get someone else's ticket or PNR.

---

**Questions or anything unclear:** reply to the Server team. When this file and `CONTRACT-APP.md` differ,
`CONTRACT-APP.md` is what the Server does.
