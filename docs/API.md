# App API (for the frontend team)

Everything the app can call on the Server. The app talks **only** to this API. It never talks to Go, and never
sees Go's address or secrets. Source of truth for the code: `src/api/app.ts`. Details of the shared object shapes
(`Message`, `TripSnapshot`, `Card`, ...) are in the contract: https://vestrago.vercel.app/llms-full.txt
(machine-readable: `contract/go.json` in this repo).

> The paths below are **our own design**: the Go contract leaves the app API open. If you want a path or shape
> changed, tell the backend team.

## Try it in Postman

Import `docs/go-server.postman_collection.json` (and optionally `docs/go-server.postman_environment.json`) into Postman.
Set `baseUrl` (default `http://localhost:8080`). Then run **1. People, trips, joining > Create person**: it saves `token`
and `personId`, and every other request uses the token automatically. **Create trip** saves `tripId` and `inviteCode`;
**Post message** saves `messageId`; **Add expense** saves `expenseId`. Each request has a description, an example body
and example responses (success and error cases). The collection covers all 36 endpoints plus `/health`. **Open a vote** and **Propose cancelling a booking** save `decisionId`; **Add booking** saves `bookingId`.

## Basics

- **Base URL:** the server's address (default port `8080`). All bodies are JSON (`content-type: application/json`).
- **Sign-in:** `POST /app/people` returns a `token`. Send it on every other call as `Authorization: Bearer <token>`
  (valid 90 days). *This is a simple stand-in and may be replaced by a real sign-in (e.g. Supabase Auth).*
- **Ids** are opaque strings (don't parse them). **Money** is a whole number in paise (₹54,200 = `5420000`),
  never a decimal. **Times** are ISO 8601 (`2026-11-06T18:10:00Z`; on the strict routes a time must end in `Z` or an offset, otherwise `422`); dates are `YYYY-MM-DD`.
- **Trip membership:** every `/app/trips/:id/...` call needs the person to be in that trip, otherwise `403`.
- **Change numbers (`seq`):** every change to a trip gets the trip's next number. Most write calls return the
  `seq` of the change they made.
- **Strict bodies on the newer routes** (open a vote, add and update a booking, propose cancelling): a field that is not listed is refused, a value of the wrong type is refused (`"5"` is not `5`), `null` is accepted only where the route says it clears a field, and every refusal is `422`. Nothing is converted or dropped silently.
- **One `client_id` per press** on the three *create* calls (open a vote, add a booking, propose cancelling): make a new one (e.g. a UUID) for each press, and send the same one when you retry. A repeat returns the first answer and creates nothing more.
- **`{ "seq": null }`** means "nothing changed" (an update that sets what is already there).

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
| 400 | `invalid` | Body failed basic validation (`POST /app/people`, `POST /app/trips`); also, on **every** route, a request that cannot be read: malformed JSON, an empty body sent as JSON, a broken web address (e.g. a stray `%`) are `400`, and an oversized body `413`, all with code `invalid` |
| 401 | `unauthorized` | Missing, forged or expired token |
| 403 | `forbidden` | Not in this trip, not the author of the message, not the payer |
| 404 | `not_found` | Trip, message, vote, line, card... not found |
| 409 | `conflict` | Clashes with current state (vote already closed, message deleted...) |
| 422 | `invalid` | Rule broken (not an option of the vote, amount ≤ 0, someone not in the trip, an unknown field or wrong type on a strict body, a time that cannot be stored...) |
| 429 | `rate_limited` | Go is busy. Wait the `Retry-After` header (seconds). Only on calls that ask Go |
| 502/503/504 | `go_unavailable` | Go did not answer in time or could not do it. Show "try again" and let the person retry. **Do not auto-retry** |
| 500 | `internal` | Server bug |

A path that does not exist (for example the removed `POST /app/devices`) answers a plain `404` in the web framework's own shape (`{ "message", "error", "statusCode" }`), not the one above.

---

## 1. People, trips, joining

### `POST /app/people` (no sign-in)
Creates a person and signs them in.
Body: `name` (required, ≤80), `photo_url`, `phone`, `email`, `upi_id` (all optional).
`201` → `{ "person_id": "p_...", "token": "s1...." }`
Phone, email and UPI id stay on the server. Go never sees them (it only learns "has a UPI id").

### `POST /app/trips`
Creates a trip. The caller becomes the organizer. Go is told and greets the room.
Body: `title` (required, ≤80), `destination` (`{ name, lat?, lng?, address?, place_id?, photo_url? }`),
`dates` (`{ start, end }`), `vibe` (string[] ≤12), `stay`, `plan_minor` (planned total, paise), `currency` (default `INR`).
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
| `vote` | `decision_id` | the vote card (open vote you haven't voted in) |
| `mandate` | `decision_id` | the mandate card (you are the payer and haven't answered) |
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
Body: `{ "emoji" }` (1-16 chars). → `{ "seq" }` (or `{ "seq": null }` if you already had that reaction).

### `DELETE /app/trips/:id/messages/:mid/reactions/:emoji`
Takes your reaction back. `:emoji` must be URL-encoded. → `{ "seq" }` (or `null` if you had none).

### `POST /app/trips/:id/typing`
Body: `{ "on": true|false }`. Shows "<you> is typing..." to the room (runs out after 5 s). Not sent to Go. → `{ "ok": true }`

---

## 3. Votes, mandate, trip record, expenses

These buttons belong to the **Server** (record cards). They never go to Go.

| Call | Body | Result | Notes |
|---|---|---|---|
| `POST /app/trips/:id/decisions/:did/vote` | `{ "option_index": 0 }` | `{ seq }` | You can change your vote until it closes. `422` bad index, `409` not open. The vote closes by itself when everyone has voted. |
| `POST .../decisions/:did/close` | none | `{ decision, seq }` | Anyone can close early. `409` already closed. |
| `POST .../decisions/:did/cancel` | none | `{ seq }` | Calls the vote off. |
| `POST .../decisions/:did/mandate/confirm` | none | `{ seq }` | **"Yes, book it".** Payer only (`403` otherwise). |
| `POST .../decisions/:did/mandate/decline` | none | `{ seq }` | **"Not now".** Payer only. |
| `POST /app/trips/:id/record/:lid/undo` | none | `{ seq }` (or `null` if already undone) | Undo a trip-record line. Go never undoes one. |
| `POST /app/trips/:id/expenses` | see below | `{ expense_id, seq }` | Add an expense. |
| `DELETE /app/trips/:id/expenses/:eid` | none | `{ seq }` | Remove an expense (to "fix split": remove, then add again). |

`POST .../expenses` body: `paid_by_person_id`, `amount_minor` (> 0, paise), `note` (≤120), `category`
(`stay` | `food` | `getting_around` | `activities` | `other`), `split_person_ids` (shared equally), `booking_id?`.
The currency is the trip's. The people who now owe money are due a push (see section 7: not delivered yet).

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
**Limit to know about:** the trip data does not say that a vote is about a booking, or which one. `decisions[]` shows it as an ordinary yes/no vote; the only marks are its question, which starts "Cancel this booking?", and the `decision_id` returned to the person who proposed it. So the app cannot reliably show "needs more than half of everyone" or hide *Propose cancelling* on a booking that already has an open vote: rely on the `409`, and do not build logic on matching the question text. (This is a known gap, not final behaviour.)
The repeat key is the person and `client_id` only, not the booking: never reuse a `client_id` for a different booking.

The vote/mandate/record/expense **cards** in the room are drawn from the trip data (`GET /app/trips/:id`), so they always agree with the Trip screens.

---

## 4. Asking Go (through the Server)

### `POST /app/trips/:id/card-taps`
A tap on a button of a **Go card** (`options`, `working`, `call`, `pay`, `notice`). Not for record cards (`422`).
Body: `card_id`, `action_id`, `option_id?` (when the button was on one option), `tap_id?` (your own id for this press, e.g. a UUID: a double tap with the same id counts once; if omitted, the server makes one).
Disable the button while the tap is on its way. **Do not retry a tap yourself.** A new press = a new `tap_id`.
`200` → one of:
- `{ "result": "done", "toast?" }` show the toast.
- `{ "result": "open", "url", "expires_at" }` open the URL in the **system browser sheet** (Flutter `url_launcher`, `LaunchMode.inAppBrowserView`). **Never a WebView** (passkeys/Face ID would not work). The link expires in 5 minutes: open it straight away, never store it.
- `{ "result": "refused", "toast?" }` show the toast.

Errors: `404` card not found, `422` not a Go card, `504/503/502` Go problem, `429` Go busy (`Retry-After`).

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
| `DELETE /app/me/facts/:fact` | none | `{ ok: true }`. Delete one fact. |
| `POST /app/me/forget` | `{ "trip_id?" }` | `{ deleted_facts, remaining_facts: 0 }`. With `trip_id`: forget in that trip; without: everywhere. Show how many were forgotten. |
| `POST /app/me/vault-link` | `{ "start?": "home" \| "add_card" \| "add_login" }` | `{ url, expires_at }`. Open in the system browser sheet, only when the person taps. |

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

## 7. Pushes

**Not delivered yet.** Pushes are only written to the server log for now, and there is no call to register a device or a browser (`POST /app/devices` was removed). Real delivery is planned.

The server sends a push only when someone needs to look now: **Go names you**, **a new Go card needs you**, **a vote you haven't voted in is about to close**, **you owe money**. Push data always has `trip_id` (and `message_id` when there is one) so a tap opens the room at that message. Never put Go links in pushes.

---

## Known gaps (not available yet)

- No endpoints to **edit your profile** (name, photo, city, UPI id), **edit trip details** (title, dates, itinerary, status), or **answer/change the budget question after joining**.
- No **settle-up** endpoints (the "Pay by UPI" button needs the payee's UPI id from the server; "Nudge").
- No **attachment upload**: only URLs are accepted.
- Sign-in is a stand-in, and push delivery only writes to a log until real delivery is connected (see section 7).
- The older routes do light input checks only. Send values within the limits above. (The newer routes are strict; see Basics.)
