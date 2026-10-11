# The fake booking and ticket module: what to build and how it plugs in

**For:** whoever builds the fake booking and fake ticket for the demo. **Date:** 11 Oct 2026.
**Read with:** `docs/GO-TEAM-DEMO-PAYMENT.md` (what happens around your module).

## 1. The one-paragraph picture

For the demo no real payment is taken. When the payer taps **Approve** on Go's payment card, the Server marks the card
paid and writes a booking and an expense by itself. **Your module decides what that booking looks like**: its title,
reference, times, journey, seats, PNRs, the detail rows, and the ticket file. You write one function. The Server calls
it, stores what you return, tells Go, and pushes it to the phones. You do not touch the database, the events, the card,
or the app.

## 2. Where you plug in

One file, one function: **`src/domain/demo-booking.ts` → `demoBookingFor`**.

```ts
export function demoBookingFor(s: DemoBookingSource, now?: Date): DemoBookingFields | Promise<DemoBookingFields>
```

- Replace the **body** of `demoBookingFor`. Put your own code in new files (for example `src/demo/…`) and call it from
  there.
- Keep the two type names and the function name. You may **add optional fields** to `DemoBookingSource` or
  `DemoBookingFields`; tell the Server owner first, because each new output field needs a line in
  `src/domain/demo-payment.ts` to store it.
- Do not edit `src/domain/demo-payment.ts`, `src/domain/ask-go.ts` or `src/requests/*`.

It is called from `demoPay` in `src/domain/demo-payment.ts`, once per paid card, **inside the database transaction**,
while the payment card and its approval are locked. Until you return, Go cannot update that card or book with that
approval, and a second tap on the card waits.

## 3. What you are given (`DemoBookingSource`)

| Field | What it is |
|---|---|
| `trip_id` | the trip |
| `approval_id` | the payment's id. Unique per payment: a good seed if you want the same fake data on a re-run |
| `merchant` | who is paid, as on the payment card (for example `ixigo`, or `ixigo: Villa Sol, Anjuna`). Up to 120 chars |
| `purpose` | what it is for, as on the payment card (for example `Villa Sol, 3 nights`) |
| `amount_minor`, `currency` | the amount paid, in paise, and `INR`. **Not yours to change**: the Server stores these itself |
| `payer_person_id` | who paid |
| `for_person_ids` | who the booking covers. One person for their own ticket; everyone in the trip for a group stay |
| `option_kind` | the kind of the card the option came from: `stay`, `flight`, `train`, `bus`, `cab`, `place`, `food`, `activity`. May be missing. For a group vote whose winning option is not tied to one of Go's options cards it is always `stay` |
| `option` | the option that was paid for, exactly as Go's card showed it (for a group vote: the vote's winning option, with the card option it came from laid over it): `title` (or `label` for a vote's option), `image_url`, `refundable_until`, `place`, `journey`, `return_journey`, `room_types`, `highlights`, and any other field Go put on it. **May be missing**, and any field inside it may be missing |
| `people` | the covered people **and the payer**: `[{ person_id, name, email? }]`, read by `demoPay` in the same transaction. Names go on the ticket. An email is private (app contract §1.7): show it only on a file nobody but its owner sees |
| `trip` | `{ title, destination?, dates?: { start, end } }` (dates as `YYYY-MM-DD`): a stay's check-in and check-out are the trip's dates, else the option's own (its ixigo `url`, `checkinDate`/`checkoutDate`) |

Do not query the database from your module: if you need more, ask for it to be added to the source.

## 4. What you return (`DemoBookingFields`)

Everything is stored as you return it and reaches the app as an ordinary booking. **The limits are hard**: every
booking is checked against the contract before it is saved, and a value over a limit makes the payer's tap fail.

| Field | Required | Limits | Where the app shows it |
|---|---|---|---|
| `kind` | yes | one of `stay`, `flight`, `train`, `bus`, `cab`, `table`, `activity`, `other` | picks the ticket's look (boarding pass, stay pass); also sets the expense's category |
| `title` | yes | 1–120 chars | the ticket's heading, the room line "`<title>` booked", the trip record, and the expense's name |
| `vendor` | yes | 1–80 chars | "booked with" |
| `ref` | yes | 1–80 chars | the booking reference. Use the `DEMO-` prefix (`demoRef()` gives `DEMO-4K7Q2M`) so nobody mistakes it for a real one |
| `starts_at`, `ends_at` | no | ISO date-time with a zone (`2026-11-06T14:10:00Z`) | check-in / check-out, or departure / arrival; the itinerary |
| `refundable_until` | no | ISO date-time | "free cancellation until" |
| `journey` | no | `{ mode: flight\|train\|bus\|cab, origin: { name ≤ 80, code? ≤ 8 }, destination: { name, code? }, depart_at, arrive_at, carrier_name? ≤ 60, carrier_code? ≤ 8, number? ≤ 20 }` | the boarding pass: route, times, carrier, flight number |
| `return_journey` | no | same shape | the return leg |
| `place` | no | `{ name 1–120, address? ≤ 200, lat?, lng?, photo_url?, photos? ≤ 12 }` | the stay pass: where, and the map |
| `image_url` | no | an `https://` URL | the ticket's picture |
| `details` | no | at most 20 rows of `{ label 1–40, value 1–200 }` | the ticket's detail rows ("Baggage · 15 kg", "Room · Deluxe, 2 guests") |
| `passengers` | no | at most 30 of `{ person_id, seat? ≤ 20, pnr? ≤ 40 }`; every `person_id` **must be one of `for_person_ids`**, each at most once | each traveller's seat and PNR |
| `documents` | no | at most 10 of `{ name 1–200, mime, url, pages?, visibility: "covered" \| "group" }` | the ticket file the app opens (see section 5) |
| `tickets` | no | at most 10 of `{ kind: "flight", name, data: TicketData }` or `{ kind: "stay", name, data: HotelBookingData }` (`src/demo/tickets/`) | ticket files the Server renders to PDF itself after the payment (see section 5) |

`null` and "left out" mean the same thing. Return only what you have.

**Who sees what.** `passengers` and `documents` are shown only to the people in `for_person_ids`. Everyone else in the
trip sees the booking without them. `details`, `journey`, `place` and the rest are shown to everyone.

## 5. The ticket file

- A ticket file is a **PDF or an image** (`application/pdf`, JPEG, PNG, WebP), at most 25 MB.
- You return a **link** (`url`), not bytes. After the payment is saved, the Server downloads the file from your link
  into its own storage; the app then opens it through the Server, never through your link. So the link must be
  reachable from the Server (use `https`) at that moment and for a minute after. A static, pre-made file is fine.
- The copy happens in the background. If the link is dead, the wrong type or too large, that file is skipped and the
  booking stands without it. Nothing tells the payer.
- `visibility: "covered"` shows the file only to the people the booking covers; `"group"` shows it to the whole trip.
- If you do not have a file, return no `documents`. The app still draws the ticket from the booking's fields.
- **Or let the Server render it:** return `tickets` (the generator inputs, not a link). After the payment is saved,
  `src/demo/attach.ts` renders each one to HTML (`src/demo/tickets/`), then to an A4 PDF with the machine's Chromium
  (`src/demo/pdf.ts`, `PUPPETEER_EXECUTABLE_PATH`), stores it at `bookings/<trip>/<booking>/<document_id>.pdf`, lists it
  for the covered people, and sends `trip_changed kinds:["booking"]`. In the background: a slow or failed render never
  holds up the tap, and with no Chromium the booking simply has no file.

## 6. Rules the function must keep

1. **Be fast and local.** It runs while the payment card and its approval are locked. No network calls, no database, no waiting on Go: aim for
   well under 100 ms. Never render a file here: return `tickets` and the Server renders them after the payment (section 5).
2. **Never throw for missing input.** `option`, `option_kind` and every field inside `option` can be absent. Fall back
   to `purpose` and `merchant`. If your function throws, the payer's tap fails and nothing is booked.
3. **Stay inside the limits in section 4.** Trim strings (`.slice(0, 120)`) rather than trusting Go's text to fit.
4. **Do not invent people.** `passengers` only from `for_person_ids`.
5. **Do not set money.** The amount, currency, payer and covered people are fixed by the payment.
6. **Mark it as a demo** somewhere a person will see it: the `DEMO-` reference, or a detail row.

## 7. What happens around you (so you can picture the result)

1. The payer taps Approve. The Server checks the payment is theirs and still waiting.
2. The Server calls `demoBookingFor` with what was paid for.
3. In the same step it saves the booking (confirmed), the "booked" line of the trip record, and the expense (the
   person alone for a ticket, split equally for a group stay), and marks the payment card paid.
4. The room shows "`<title>` booked" and the money line. Phones are told to refresh.
5. Go hears about the booking and the payment, and posts a **ticket card** that points at this booking. The app draws
   that card from the booking you described: this is where your work shows up on screen.
6. The ticket file, if you gave one, appears on the booking a moment later.

## 8. What it does now (`src/demo/`)

`demoBookingFor` builds the booking in `src/demo/booking.ts`, synchronously, from the option and the source:

- **A flight, train or bus** (an option with a readable `journey`): `kind` from the card's kind (else the journey's mode),
  `title` "IndiGo 6E 2134 · DEL → GOI", `starts_at`/`ends_at` from the legs, the journey and return leg as Go sent them,
  one passenger per covered person with a seat on each leg ("14A / 9C") and the shared 6-character PNR, and detail rows
  (Cabin, Fare, Baggage, Terminal, Stops, Duration, Return, Booking ID, "Booking · Demo, no real ticket"). `tickets`: one
  ixigo-style e-ticket per leg, with the travellers' names, PNR, e-ticket numbers and seats. Times print at the offset Go
  sent them with (else India time). A cab gets the same booking with no ticket.
- **A stay** (the card's kind is `stay`): `title` from the option (else its place, else `purpose`), check-in 14:00 and
  check-out 11:00 in the place's time zone (else India) on the trip's dates, else the stay's own from the option's
  ixigo link (`checkinDate=01112026&checkoutDate=05112026`). Never made up: with neither, the booking has no
  `starts_at`/`ends_at`, no Check-in, Check-out or Nights rows, and the voucher says "Not set" (so it never gives the
  trip dates either). Detail rows (Check-in, Check-out, Nights, Room from the first `room_types`, Guests, Cancellation
  from `refundable_until`, the booking numbers, the demo row). `tickets`: one hotel voucher; its primary guest is the payer, with their email only
  when the stay covers the payer alone.
- **Anything else, or no option at all:** the thin booking as before: `title` from the option (else `purpose`), the
  journey, place and image as they are, one row ("Paid · Demo payment"), no ticket.

Made-up parts come from `src/demo/fake.ts`, seeded with `approval_id`, so the same payment always gets the same PNR,
seats, numbers and `DEMO-…` reference. The PNR and e-ticket numbers are only in `passengers` and the files (covered
people), never in `details`. If building the rich booking fails on odd input, the thin one is answered instead: the
function never throws.

## 9. How to check your work

- `npx vitest run tests/demo-payment.test.ts` runs the whole flow, personal ticket and group stay, against your
  function. Its tests assert what the module returns: the booking's `title` (`IndiGo 6E 2134 · BLR → GOX`, `Villa
  Sol`), `kind`, `vendor`, `ref` matching `DEMO-`, the journey passed through, the times, seat, PNR and demo row, the
  expense's note and category, the room lines "`<title>` booked" and "… added `<title>` …", and (with a fake renderer)
  the e-ticket PDF stored and listed with a signed `url` for the covered person only. When your module changes any of
  these, update those assertions in the same change.
- `tests/demo-booking.test.ts` calls `demoBookingFor` directly: a flight with a return leg, a stay with and without the
  trip's dates, and a source with **no `option` at all**. `tests/demo-tickets.test.ts` checks the templates, and renders
  both PDFs with a real Chromium when `PUPPETEER_EXECUTABLE_PATH` is set.
- Check your output against the contract in a test, so a limit never surprises you in the demo:
  ```ts
  import { check } from '../src/contract/index.js';
  expect(check('Booking', { booking_id: 'b_x', status: 'confirmed', amount_minor: 1, currency: 'INR',
    payer_person_id: 'p_a', for_person_ids: ['p_a'], created_at: new Date().toISOString(), ...fields, documents: undefined })).toMatchObject({ ok: true });
  ```
- `npm test` must stay green before you hand it over.

## 10. Done when

- A paid flight shows a boarding pass with route, times, carrier, flight number, a seat and a PNR for each traveller.
- A paid stay shows a stay pass with the place, check-in and check-out, and useful detail rows.
- A payment whose option could not be found still books, with the title from `purpose`.
- Every value is inside the limits of section 4, and the tests in section 9 pass.
