# App API (for the frontend team)

Everything the app can call on the Server. The app talks **only** to this API. It never talks to Go, and never
sees Go's address or secrets. Source of truth for the code: `src/api/app.ts`. Details of the shared object shapes
(`Message`, `TripSnapshot`, `Card`, ...) are in the contract: https://vestrago.vercel.app/llms-full.txt
(machine-readable: `contract/go.json` in this repo).

> The paths below are **our own design**: the Go contract leaves the app API open. If you want a path or shape
> changed, tell the backend team.

## Try it in Postman

Import `docs/go-server.postman_collection.json` and `docs/go-server.postman_environment.json` into Postman.

- **Run in order:** start the local stack with `pnpm dev:stack` (a temporary Postgres, a fake Go and the real server
  on `:8080`, plus an "act as Go" port on `:8090`). Then run the folder **Run in order** with the Collection Runner, or
  `pnpm postman` from a terminal. It signs up two people, makes a trip, goes through every endpoint (and the errors the
  app must handle), and checks every answer. Requests marked **[Go]** act as Go for what only Go can do (open a vote,
  set a mandate, post a card, write a record line, ask for a spend approval).
- **Reference folders:** one request per endpoint, with a description, an example body and example responses
  (success and error cases). Run **Create person** (saves `token`), then **Create trip** (saves `tripId`); every other
  request uses them automatically. The collection covers all 47 endpoints plus `/health`. **Open a vote** and **Propose cancelling a booking** save `decisionId`; **Add booking** saves `bookingId`.

## Basics

- **Base URL:** the server's address (default port `8080`). All bodies are JSON (`content-type: application/json`).
- **Sign-in (production):** the app signs in with **Supabase Auth (Google)** and sends Supabase's access token on every
  call as `Authorization: Bearer <session.accessToken>`. The server checks it locally (signature, project, expiry)
  and never issues tokens itself. The first call after a person's first sign-in creates them from their Google name and
  photo; `GET /app/me` shows the profile. Tokens last about an hour and `supabase_flutter` refreshes them: **on any
  `401`, refresh the session once and retry.** Details and the token flow: [`SUPABASE-SETUP.md`](SUPABASE-SETUP.md).
- **Sign-in (local testing only):** with `AUTH_MODE=dev`, `POST /app/people` returns a dev `token` (90 days), used the
  same way. That route does not exist when the server runs with Supabase sign-in.
- **Ids** are opaque strings (don't parse them). **Money** is a whole number in the currency's minor unit (rupees: paise, so ₹54,200 = `5420000`; a currency with no minor unit, such as yen, uses whole units),
  never a decimal. **Times** are ISO 8601 (`2026-11-06T18:10:00Z`; on the strict routes a time must end in `Z` or an offset, otherwise `422`); dates are `YYYY-MM-DD`.
- **Trip membership:** every `/app/trips/:id/...` call needs the person to be in that trip, otherwise `403`. A trip
  id that does not exist is also `403` (so ids cannot be probed).
- **Bodies are checked** against the limits on this page (the contract's own limits). A body that breaks them is `400`
  before anything happens. A POST that needs no body can be sent with none.
- **Change numbers (`seq`):** every change to a trip gets the trip's next number. Most write calls return the
  `seq` of the change they made.
- **Strict bodies on the newer routes** (open a vote, bookings, propose cancelling, your profile, your answers and budget, trip details, remind, push subscriptions): a field that is not listed is refused, a value of the wrong type is refused (`"5"` is not `5`), `null` is accepted only where the route says it clears a field, and every refusal is `422` (except JSON that cannot be read at all, which is `400`). Nothing is converted or dropped silently.
- **One `client_id` per press** on the three *create* calls (open a vote, add a booking, propose cancelling): make a new one (e.g. a UUID) for each press, and send the same one when you retry. A repeat returns the first answer and creates nothing more.
- **`{ "seq": null }`** means "nothing changed" (an update that sets what is already there). (On `PATCH /app/me` it means no change number was written: see section 5.)

### Calling from a browser

The server answers browsers from the web app's own address. The backend team lists the exact addresses allowed in `APP_ORIGINS` (comma-separated, no wildcard; with none listed, no browser origin is allowed). From a listed address every response carries the cross-origin headers, including errors and the live stream; a preflight needs no sign-in; `Retry-After` can be read; cookies are not used. The sign-in token is sent in the `Authorization` header as everywhere else, never in the address.
Beyond the headers a browser always allows (such as `Accept`), a browser may send only the headers `authorization` and `content-type`, and the methods GET, POST, PUT, PATCH and DELETE: any other *custom* request header (for example `Last-Event-ID` on a stream reconnect, or your own request id) is blocked by the browser. The answer to a preflight may be remembered by the browser for ten minutes.

### Errors

Every error looks like this:

```json
{ "error": { "code": "conflict", "message": "decision d_1 is already closed" } }
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `invalid` | The body or query breaks the limits on this page: a field missing (such as `client_id`), too long, the wrong type, or unreadable JSON; also, on every route, a broken web address (e.g. a stray `%`). An oversized body is `413` (code `invalid`) |
| 401 | `unauthorized` | Missing, forged or expired token. The message says when it expired: refresh the Supabase session once and retry |
| 403 | `forbidden` | Not in this trip (or no such trip), not the author of the message, not the payer |
| 404 | `not_found` | Invite link, message, vote, line, expense, card, fact... not found, or no such route |
| 409 | `conflict` | Clashes with current state (vote already closed or cancelled, message deleted, no mandate yet...) |
| 422 | `invalid` | A rule about the trip is broken (not an option of the vote, someone not in the trip, unknown category, a bad attachment, a record card's button...); on the newer routes (open a vote, bookings, propose cancelling, your profile, answers and budget, trip details, remind, push subscriptions) **every** bad body is `422`, except JSON that cannot be read at all (`400`): an unknown field, a wrong type, a missing field, a time that cannot be stored |
| 429 | `rate_limited` | Go is busy (calls that ask Go), or you already reminded this person in the last 24 hours (`POST .../settle-up/nudges`). Wait the `Retry-After` header (seconds) |
| 503 | `unavailable` | Push notifications are not set up on this server (`GET /app/push/key` only) |
| 502/503/504 | `go_unavailable` | Go did not answer in time or could not do it. Show "try again" and let the person retry. **Do not auto-retry** |
| 500 | `internal` | Server bug (please report it) |

A path that does not exist (for example the removed `POST /app/devices`) answers `404 not_found` in this same shape.

---

## 1. People, trips, joining

### `POST /app/people` (no sign-in; dev sign-in only, `404` with Supabase sign-in)
Creates a person and signs them in.
Body: `name` (required, ≤80), `photo_url`, `phone`, `email`, `upi_id` (all optional).
`201` → `{ "person_id": "p_...", "token": "s1...." }`
Phone, email and UPI id stay on the server. Go never sees them (it only learns "has a UPI id").

### `POST /app/trips`
Creates a trip. The caller becomes the organizer. Go is told and greets the room.
Body: `title` (required, ≤80), `destination` (`{ name, lat?, lng?, address?, place_id?, photo_url? }`),
`dates` (`{ start, end }`, `YYYY-MM-DD`, a real date from year 1, start on or before end, else `422`), `vibe` (string[] ≤12), `stay`, `plan_minor` (planned total, in the currency's minor unit), `currency` (default `INR`).
`201` → `{ "trip_id", "invite_url" }` (`invite_url` is `<PUBLIC_BASE_URL>/j/<code>`; the code is the last part).

### `GET /app/join/:code` (no sign-in)
Preview of a trip from an invite link, for the join screen.
`200` → `{ "trip_id", "title", "destination", "dates_start", "dates_end", "people": <count> }` · `404` bad link.

### `POST /app/join/:code`
Joins the trip with the join answers. Safe to repeat.
Body (all optional): `from_city`, `earliest_leave` (free text, e.g. "Fri after 6 pm"), `know` (string[], "anything Go should know"),
`budget` (`{ min_minor, max_minor? }`, the person's own answer).
`200` → `{ "trip_id", "already": false }` (`already: true` if they were already in).
The budget answer is **private**: Go only ever learns the lowest band of everyone's answers.

### `GET /app/trips/:id`
The whole trip for the Trip screens (home/record, itinerary, bookings, budget, money). Returns a contract `TripSnapshot`:
`trip_id, seq, title, status, organizer_person_id, invite_url, destination, dates, vibe, stay, budget, people[], decisions[], bookings[], expenses[], money, itinerary[], record[]`.
`money` has the totals, per-category spend and the fewest-payments `transfers` (who pays whom). The server does all money maths.
Note: `budget` is only the lowest band and counts, not the caller's own answer.
One app-only addition to the contract's `Decision`: a vote that asks "cancel this booking?" carries **`cancels_booking_id`** (the booking it is about). Every other vote has no such key. Go never receives it.

### Your answers in this trip

`GET /app/trips/:id/me` → `{ "from_city", "earliest_leave", "know", "budget", "role", "go_paused" }`: your join answers, your own budget answer (`{ "min_minor", "max_minor?" }`, or `null` if you have not answered), your role and whether Go is paused for you.

`PATCH /app/trips/:id/me` · body (strict, at least one field): `from_city` and `earliest_leave` (≤60 characters; `null` clears), `know` (≤20 items of 1-80 characters; `[]` clears). Go is told in this trip only, and only what differs. → `{ "seq" }`, or `{ "seq": null }` if nothing changed. `403` not in the trip.

`PUT /app/trips/:id/me/budget` · body `{ "min_minor" (whole paise ≥ 0), "max_minor?" (≥ min_minor) }`. It replaces your whole answer (leave out `max_minor` for "no upper limit") and **cannot be withdrawn** (`null` is `422`). → `{ "seq" }`, or `{ "seq": null }` when it is the same answer. Your answer is **private**: Go only learns that the budget moved (naming nobody, with no amount) and the lowest band of everyone's answers. Leaving the trip also moves the band.

### Trip details and status

`PATCH /app/trips/:id` · **any member**, not only the organizer. Body (strict, at least one field): `title` (1-80), `dates` (`{ "start", "end" }`, `YYYY-MM-DD`, start on or before end, from year 1), `itinerary`, `status` (`planning` | `booked` | `on_trip` | `over`, in any direction). Nothing can be cleared. `itinerary` replaces the **whole** itinerary: at most 30 days, each a contract `Day` (`{ date, title?, items[] }`, items up to 20 with `title`, `category`, `status`, and optionally `time` (`HH:MM`), `place`, `note`, `booking_id`, `item_id`); a `booking_id` must be a booking of this trip (`422` otherwise). The itinerary is stored exactly as sent, so fields you add are kept; sending the same itinerary back (even with keys in another order) changes nothing. The itinerary may be at most **262144 bytes** as JSON (`422` with "itinerary is too large" above that: show a message and have the person trim it) and free-form fields may not nest deeper than 32 levels. If two people save at once, the later save wins. Go hears one change, by the person, naming only the fields that differed. → `{ "seq" }`, or `{ "seq": null }` if nothing changed. `403` not in the trip · `422` a rule or a field.

### `POST /app/trips/:id/leave`
Leaves the trip. → `{ "seq" }`

### `POST /app/trips/:id/go-paused`
Body: `{ "paused": true|false }`. While paused, the person's messages reach Go with no words. The room still sees them fully. → `{ "seq" }`

### `POST /app/trips/:id/seen`
Call when the person opens/leaves the room. Used to decide when catch-up is needed. → `{ "ok": true }`

### `GET /app/trips/:id/needs-you`
The "needs you" strip for this person. → array of items, each with `kind` and `text`:

| `kind` | extra fields | Tap opens |
|---|---|---|
| `vote` | `decision_id`, and `cancels_booking_id` for a "cancel this booking" vote | the vote card (open vote you haven't voted in) |
| `mandate` | `decision_id`, `question` | the mandate card (you are the payer and haven't answered). `text` is what to confirm, e.g. "Yes, book it? Villa Sol, up to ₹55,000"; `question` is the vote it came from |
| `card` | `card_id`, `message_id` | a Go card that names you |
| `record` | `line_id` | an open trip-record line that asks you |

---

## 2. Messages

### `GET /app/trips/:id/messages?after_seq=0&limit=100`
Messages posted **or changed** (edit, delete, reaction, replaced card) after a change number, oldest change first.
`limit` default 100, max 200. → `{ "messages": [Message...], "has_more": bool }`.
To continue: call again with `after_seq` = the last message's `updated_seq`. Each `Message` has `message_id, seq, updated_seq,
author ({kind:"person",person_id} or {kind:"go"}), text, attachments[], reply_to, about_message_id, mentions_go, mentions[],
reactions[], card, deleted, edited_at, sent_at`. `text` is always present (`withheld` is always `false` for the app).
A reaction **without** `person_id` is Go's. A message whose `author.kind` is `go` must look like Go, never like a person.

### `POST /app/trips/:id/messages`
Body:
- `client_id` (**required**): your own unique id for this press (e.g. a UUID). Sending the same `client_id` again does **not** post twice and returns the first answer. Use it for retries.
- `text` (≤4000) and/or `attachments` (≤10). One of them is required.
- `reply_to`: message id this replies to. `about_message_id`: set for **"Ask Go about this"** (long-press); Go will answer it even if the text doesn't name Go.
- `mentions`: person ids @mentioned (≤30, must be in the trip).

Attachments are objects: `{ "kind":"photo","url","width?","height?","caption?" }` or `{ "kind":"file","url","name","mime","size_bytes" }`. (There is no upload endpoint yet, only URLs.)
→ `{ "message_id", "seq" }`. Show the message instantly as "sending", then replace it with this.
The server marks a message as "for Go" when it contains `@Go`, starts with "Go," / "Go:", replies to a Go message, or has `about_message_id`.

### `PATCH /app/trips/:id/messages/:mid`
Edit your own message. Body: `{ "text" }`. → `{ "seq" }` · `403` not yours · `409` deleted.

### `DELETE /app/trips/:id/messages/:mid`
Delete your own message. → `{ "seq" }`

### `POST /app/trips/:id/messages/:mid/reactions`
Body: `{ "emoji" }` (1-16 characters). → `{ "seq" }` (or `{ "seq": null }` if you already had that reaction) · `404` no such message · `409` deleted.

### `DELETE /app/trips/:id/messages/:mid/reactions/:emoji`
Takes your reaction back. `:emoji` must be URL-encoded. → `{ "seq" }` (or `null` if you had none) · `404` no such message · `409` deleted.

### `POST /app/trips/:id/typing`
Body: `{ "on": true|false }`. Shows "<you> is typing..." to the room (runs out after 5 s). Not sent to Go. → `{ "ok": true }`

---

## 3. Votes, mandate, trip record, expenses

These buttons belong to the **Server** (record cards). They never go to Go.

| Call | Body | Result | Notes |
|---|---|---|---|
| `POST /app/trips/:id/decisions/:did/vote` | `{ "option_index": 0 }` | `{ seq }` | You can change your vote until it closes. `422` bad index, `409` not open. The vote closes by itself when everyone has voted. |
| `POST .../decisions/:did/close` | none | `{ decision, seq }` | Anyone can close early. `409` already closed. |
| `POST .../decisions/:did/cancel` | none | `{ seq }` | Calls the vote off. `409` already closed or cancelled. |
| `POST .../decisions/:did/mandate/confirm` | none | `{ seq }` | **"Yes, book it".** Payer only (`403` otherwise). `409` no mandate yet. |
| `POST .../decisions/:did/mandate/decline` | none | `{ seq }` | **"Not now".** Payer only. `409` no mandate yet. |
| `POST /app/trips/:id/record/:lid/undo` | none | `{ seq }` (or `null` if already undone) | Undo a trip-record line. Go never undoes one. `404` no such line. |
| `POST /app/trips/:id/expenses` | see below | `{ expense_id, seq }` | Add an expense. |
| `DELETE /app/trips/:id/expenses/:eid` | none | `{ seq }` | Remove an expense (to "fix split": remove, then add again). `404` no such expense (or already removed). |

`POST .../expenses` body: `paid_by_person_id`, `amount_minor` (whole number > 0, paise), `note` (1-120), `category`
(`stay` | `food` | `getting_around` | `activities` | `other`, else `422`), `split_person_ids` (1-30, shared equally),
`booking_id?` (a booking in this trip, else `422`). The currency is the trip's.
The people in the split who **owe money overall** afterwards get a push, worked out from the trip's `money.transfers`
(for example "You owe Kabir ₹1,133.34 for Airport cab"). Someone who is still owed money overall gets none.

### Open a vote

`POST /app/trips/:id/decisions` · any member. Body (all strict):
- `client_id` (**required**, 1-64), `question` (1-200), `kind` (`choice` | `yesno`), `anonymous` (true/false): all required.
- `options` (**required**, 2-10): each `{ label (1-120, required), image_url?, price_minor? (whole paise ≥ 0), note? (≤120) }`. A priced option is shown in the trip's currency. `image_url` must be a URL; **render it only when it is an `http` or `https` link.**
- `closes_at?`: an ISO time in the future; the vote closes by itself then.

`201` → `{ "decision_id", "seq" }`. The vote counts everyone in the trip now (the count `of` then follows people joining and leaving: a joiner adds one, a leaver who had not voted removes one), shows in everyone's "needs you" strip (the person who opened it too, until they vote), and closes when all have voted, when time runs out, or when someone closes it. Go is told it was opened by this person.
**The server does not post a vote card into the room**: Go posts vote cards. Until Go does it for votes people open, a vote opened here appears in the "needs you" strip and on the Trip screen, not as a card in the chat. It sends no push when it opens. `401` · `403` not in the trip · `422` a rule or a field.

### Bookings

`POST /app/trips/:id/bookings` · any member adds a booking they made. Body (strict): `client_id`, `kind` (`stay` | `flight` | `train` | `bus` | `cab` | `table` | `activity` | `other`), `title` (1-120), `vendor` (1-80), `ref` (1-80), `amount_minor` (≥ 0, paise), `payer_person_id`, `for_person_ids` (1-30): all required; optional `refundable_until`, `starts_at`, `ends_at` (ISO times), `journey`, `place`, `image_url`, `decision_id`. `journey` is `{ mode (`flight|train|bus|cab`), origin, destination (each `{ name 1-80, code? ≤8 }`), depart_at, arrive_at, carrier_name? ≤60, carrier_code? ≤8, number? ≤20, logo_url?, stops? ≥0 }` (the first five are required). `place` is `{ name 1-120, place_id? ≤256, address? ≤200, lat? -90 to 90, lng? -180 to 180, photo_url? }`. URLs must be URLs (render only `http`/`https`).
`201` → `{ "booking_id", "seq" }`. It is stored as confirmed, in the trip's currency, with you as the person who added it. **It creates no expense**: add one separately if people owe money. Rules (`422`): `ends_at` may not be before `starts_at`; payer and `for_person_ids` must be in the trip; `decision_id`, if given, must be a **closed** vote of this trip that is not a vote about cancelling a booking (if that vote ended with a result, its decided line in the trip record then becomes the booked line; otherwise a new booked line is added; a decided line that a person had undone stays undone).

`PATCH /app/trips/:id/bookings/:bid` · any member, any booking. Body: any of `ref`, `refundable_until`, `starts_at`, `ends_at` (`null` clears the three times; `ref` cannot be cleared); at least one field. → `{ "seq" }`, or `{ "seq": null }` if nothing changed. `404` the booking is not in this trip · `409` it is cancelled · `422` an empty body, or the result would end before it starts.

### Propose cancelling a booking (the group decides)

`POST /app/trips/:id/bookings/:bid/cancel-vote` · any member. Body: `{ "client_id" }`. `201` → `{ "decision_id", "seq" }`.
The server opens a yes/no vote that is **not anonymous** and closes **24 hours** after it opens: question "Cancel this booking? <title>", options "Cancel: <title>" (index 0) and "Keep: <title>" (index 1) (the title is cut to 112 characters in the option labels). Voting, changing a vote, closing early and calling it off work as for any vote.
**The booking is cancelled only if "Cancel" gets more than half of everyone in the trip at the moment the vote closes.** People who do not vote count against cancelling; a tie does not cancel; someone who voted and then left still counts. If "Keep" has more votes than "Cancel" the result is "Keep"; otherwise the vote ends **with no result**, even if "Cancel" had the most votes, and the booking stays. When it passes the booking becomes `cancelled` at once, in the same moment the vote closes, and the vote's result is added to the trip record as a decided line ("Cancel: <title>" or "Keep: <title>"), as for any vote. The app learns of it from the usual `trip` notice on the live stream (re-read the trip). **Cancelling records the group's decision only: nothing is cancelled with the vendor.**
`404` the booking is not in this trip · `409` already cancelled, **paid through Go's vault** (cannot be cancelled by a vote), or a cancellation vote on it is already open (the message names it). As with any vote opened by a person, the server posts no card for it in the chat.
**Telling it apart.** A vote to cancel a booking carries `cancels_booking_id` in `GET /app/trips/:id` (in `decisions[]`) and in its `needs-you` entry; ordinary votes have no such key. Use it to pick the cancellation component, and to hide *Propose cancelling* on a booking that already has an **open** vote with this marker (a closed one keeps its marker, so check `status`; the `409` still backs this up).
The repeat key is the person and `client_id` only, not the booking: never reuse a `client_id` for a different booking.

The vote/mandate/record/expense **cards** in the room are drawn from the trip data (`GET /app/trips/:id`), so they always agree with the Trip screens.

### Settle up

`GET /app/trips/:id/settle-up` (`cache-control: no-store`) → `{ "seq", "you_pay": [{ "to_person_id", "amount_minor", "currency", "upi_id" }], "owed_to_you": [{ "from_person_id", "amount_minor", "currency", "nudge_allowed_at" }] }`. Both lists are **your** entries from the trip's fewest-payments list (`money.transfers`), never a share of one expense. `upi_id` is the payee's id for the *Pay by UPI* button and is `null` if they saved none or have left the trip; **it is shown only to people who owe that payee**, and never in `owed_to_you`. `nudge_allowed_at` is when you may remind that person again, or `null` if you may now. Everything is read at one change number (`seq`).

### Remind someone who owes you

`POST /app/trips/:id/settle-up/nudges` · body `{ "person_id" }`. Allowed only while that person owes you in the trip's list and is in the trip (`409` otherwise; `403` if you are not in the trip). → `200 { "reminded": true, "nudge_allowed_at" }`, meaning the reminder was *accepted*, not that it arrived: the person gets one notification, "<your name> reminded you: you owe <amount>", if they have notifications on; if delivery fails you are not told. **One reminder per person per trip every 24 hours**: inside the window the answer is `429 rate_limited` with `Retry-After` (also for a retry after a lost answer: show "already reminded"). Go is not told (no change number).



---

## 4. Asking Go (through the Server)

### `POST /app/trips/:id/card-taps`
A tap on a button of a **Go card** (`options`, `working`, `call`, `pay`, `notice`). Not for record cards (`422`).
Body: `card_id`, `action_id` (lowercase letters and `_`, as on the button), `option_id?` (when the button was on one option), `tap_id?` (your own id for this press, e.g. a UUID: a double tap with the same id counts once; if omitted, the server makes one). The server ties the tap id to the signed-in person, so nobody can replay someone else's press.
Disable the button while the tap is on its way. **Do not retry a tap yourself.** A new press = a new `tap_id`.
`200` → one of:
- `{ "result": "done", "toast?" }` show the toast.
- `{ "result": "open", "url", "expires_at" }` open the URL in the **system browser sheet** (Flutter `url_launcher`, `LaunchMode.inAppBrowserView`). **Never a WebView** (passkeys/Face ID would not work). The link expires in 5 minutes: open it straight away, never store it.
- `{ "result": "refused", "toast?" }` show the toast.

Errors: `400` bad body, `404` (`not_found`) card not found, `422` not a Go card, `504/503/502` Go problem, `429` Go busy (`Retry-After`). For any of these, show a short toast such as "Go didn't answer. Try again." and enable the button again.

### `POST /app/trips/:id/catch-up`
For a person returning to the room. Body: `{ "force?": true }`.
`{ "needed": false }` → show nothing. Otherwise `{ "needed": true, "summary?", "items": [{ kind, text, image_url?, message_id? }] }`
(`kind`: `decided | booked | needs_you | open | news`). Show the room immediately, slide the catch-up in above it for this person only, max 5 items, dismissible. A tap on an item with `message_id` scrolls to that message.
It is needed when the person was away 3 hours or more, or has 15+ unread. If this call fails, just show the room without it.

---

## 5. The You screen

| Call | Body | Result |
|---|---|---|
| `GET /app/me/go-knows` | none | `{ person_id, carry_over, facts: [{ fact_id, topic, text, trip_id, message_id?, said_at }] }` (what Go knows about you, and where each fact came from). A fact with `message_id` opens that message; one without came from the join answers. |
| `PUT /app/me/carry-over` | `{ "carry_over": true|false }` | `{ ok: true }`. Remember me in future trips (off by default). |
| `DELETE /app/me/facts/:fact` | none | `{ ok: true }`. Delete one fact. `404` (`not_found`) if Go has no such fact. |
| `POST /app/me/forget` | `{ "trip_id?" }` | `{ deleted_facts, remaining_facts: 0 }`. With `trip_id`: forget in that trip; without: everywhere. Show how many were forgotten. |
| `GET /app/me` | none | `{ person_id, name, photo_url, upi_id }`: your own values (`no-store`). |
| `PATCH /app/me` | `{ name?, photo_url?, upi_id? }` | your own values plus `seq` (see below). |
| `POST /app/me/vault-link` | `{ "start?": "home" \| "add_card" \| "add_login" }` | `{ url, expires_at }`. Open in the system browser sheet, only when the person taps. |

`PATCH /app/me` body (strict, at least one field): `name` (1-80, cannot be cleared), `photo_url` (a lowercase `http://` or `https://` link; `null` clears), `upi_id` (1-100 characters, no format rule; `null` clears). The answer is your own values plus `seq`: the last change number written, or `null` when nothing was sent (the same values again, a UPI id replaced by another, which Go cannot see, or a change made by someone who is in no trip, which has nobody to tell): so `null` means "no change number", and your own values in the answer are always the saved ones. Go is told once in every trip you are in: a new name or photo, and only whether you *have* a UPI id, never the id. Phone and email cannot be edited. A stored photo link that is not a valid URL (older sign-ups were not checked) is left out of the trip data until a valid one is saved; `GET /app/me` still shows it.

Pause Go is `POST /app/trips/:id/go-paused` (section 1). All of these act for the **signed-in person only**.

---

## 6. Live connection (server-sent events)

`GET /app/trips/:id/live` (with the `Authorization` header). Open it when the person opens a trip, close it when they leave.
Content type `text/event-stream`. A `: ping` comment is sent every 20 s. Events:

| `event:` | `data:` | What to do |
|---|---|---|
| `hello` | `{ trip_id }` | connected |
| `message` | a full `Message` | add/replace the message with the same `message_id`. Also used for edits, deletes, reactions and **replaced cards** (the card is inside the message): swap the card in place. |
| `trip` | `{ seq }` | something that isn't a message changed (vote, mandate, record, booking, expense, people). If `seq` is higher than what you hold, re-read `GET /app/trips/:id` and `GET .../needs-you`. |
| `typing` | `{ who: {kind:"go"} or {kind:"person",person_id}, on, until? }` | show "Go is typing..." until `until` passes or Go's next message lands. `on:false` hides it. |

Rules of thumb: remember the highest `seq` / `updated_seq` you have seen. After a reconnect (phones sleep), or if a number jumps by more than one, re-read the messages (`after_seq`) and the trip before trusting the stream.
`EventSource` in browsers cannot send an `Authorization` header, and the token must never go in the address. From a browser, read the stream with `fetch` and the `Authorization` header (a streamed response body), parse the events yourself, and **reconnect yourself** when it drops. A listed origin gets the cross-origin headers on the stream and on its `401` and `403` refusals. In Flutter, use the `http` package with a streamed request.

## 7. Pushes (Web Push)

The server sends a push only when someone needs to look now: **Go names you**, **a new Go card needs you**, **a vote you haven't voted in is about to close**, **you owe money** (an expense, or a reminder from someone you owe). Nothing for votes, bookings, edits or a cancellation. Each push is `{ "body" (≤300 characters), "data": { "trip_id", "message_id?" } }`: a tap should open the trip (at that message). There are no links in a push.

How a browser gets them:
1. `GET /app/push/key` (no sign-in) → `{ "public_key" }`, the key to subscribe with. `503 unavailable` means the server has no push keys: do not offer notifications.
2. Ask permission **from a tap**, subscribe with that key, and send the subscription: `PUT /app/push/subscription` with `{ "endpoint", "keys": { "p256dh", "auth" } }` → `204`. Take those two fields from `subscription.toJSON()` and **leave out its `expirationTime`**: the body is strict and refuses any other field. The endpoint must be an `https` address on a known push service (Google FCM, Mozilla, Apple `*.push.apple.com`, Windows `*.notify.windows.com`; at most 2048 characters) and the keys must have a browser's shape, else `422`. An address someone else registered moves to you. You keep at most **10** subscriptions: a newer one silently replaces your oldest (you are never refused), and saving an address again makes it the newest.
3. `POST /app/push/unsubscribe` with `{ "endpoint" }` → `204`: removes only your own, safe to repeat. Call it at sign-out.

Rules for the client: show a **visible notification for every push** and open the trip from `data`; re-register when the browser replaces the subscription or the key from step 1 changes (changing the server's keys invalidates every subscription); everything must be served over HTTPS; on iPhone and iPad notifications work only after the app is added to the Home Screen, on iOS 16.4 or later. Delivery is best-effort: a push the service refuses is not retried, and an address the service says is gone is deleted. **Real delivery has not yet been tried against a real browser or push service** (only against a test stand-in): check it end to end on staging before you rely on it. (The older `POST /app/devices` is removed.)

---

## Known gaps (not available yet)

- No **attachment upload**: only URLs are accepted.
- Supabase sign-in is built and tested locally against a fake Supabase Auth; it has not yet run against a real Supabase project (see [`SUPABASE-SETUP.md`](SUPABASE-SETUP.md)).
- **A card Go updated while the phone was offline** (for example a pay card that became "paid") is sent on the live
  connection, but `GET .../messages?after_seq=` does not return it again, because the contract gives a card update no
  change number. Until we agree a fix, re-read the messages from `after_seq=0` after a long time offline.
- Go posts no chat card for a vote a person opens until that is changed on Go's side (until then it appears in the "needs you" strip and the trip screen).
- The full review against the docs, with every known gap and open question, is in [`docs/REVIEW.md`](REVIEW.md).
