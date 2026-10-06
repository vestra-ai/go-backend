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
and example responses (success and error cases). The collection covers all 33 endpoints plus `/health`.

## Basics

- **Base URL:** the server's address (default port `8080`). All bodies are JSON (`content-type: application/json`).
- **Sign-in:** `POST /app/people` returns a `token`. Send it on every other call as `Authorization: Bearer <token>`
  (valid 90 days). *This is a simple stand-in and may be replaced by a real sign-in (e.g. Supabase Auth).*
- **Ids** are opaque strings (don't parse them). **Money** is a whole number in paise (₹54,200 = `5420000`),
  never a decimal. **Times** are ISO 8601 (`2026-11-06T18:10:00Z`); dates are `YYYY-MM-DD`.
- **Trip membership:** every `/app/trips/:id/...` call needs the person to be in that trip, otherwise `403`.
- **Change numbers (`seq`):** every change to a trip gets the trip's next number. Most write calls return the
  `seq` of the change they made.

### Errors

Every error looks like this:

```json
{ "error": { "code": "conflict", "message": "decision d_1 is already closed" } }
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `invalid` | Body failed basic validation (only on `POST /app/people`, `POST /app/trips`) |
| 401 | `unauthorized` | Missing, forged or expired token |
| 403 | `forbidden` | Not in this trip, not the author of the message, not the payer |
| 404 | `not_found` | Trip, message, vote, line, card... not found |
| 409 | `conflict` | Clashes with current state (vote already closed, message deleted...) |
| 422 | `invalid` | Rule broken (not an option of the vote, amount ≤ 0, someone not in the trip...) |
| 429 | `rate_limited` | Go is busy. Wait the `Retry-After` header (seconds). Only on calls that ask Go |
| 502/503/504 | `go_unavailable` | Go did not answer in time or could not do it. Show "try again" and let the person retry. **Do not auto-retry** |
| 500 | `internal` | Server bug |

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
The currency is the trip's. The people who now owe money get a push.

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
| `POST /app/devices` | `{ "token", "platform" }` | `204`. Register the device for pushes. |

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
`EventSource` in browsers cannot send an `Authorization` header: use a streaming HTTP client (in Flutter, the `http` package with a streamed request).

## 7. Pushes

The server sends a push only when someone needs to look now: **Go names you**, **a new Go card needs you**, **a vote you haven't voted in is about to close**, **you owe money**. Push data always has `trip_id` (and `message_id` when there is one) so a tap opens the room at that message. Never put Go links in pushes.

---

## Known gaps (not available yet)

- No endpoints to **edit your profile** (name, photo, city, UPI id), **edit trip details** (title, dates, itinerary, status), or **answer/change the budget question after joining**.
- No **settle-up** endpoints (the "Pay by UPI" button needs the payee's UPI id from the server; "Nudge").
- No **attachment upload**: only URLs are accepted.
- **CORS is not enabled.** A browser-based frontend would be blocked until it is. Mobile apps are not affected.
- Sign-in is a stand-in, and push delivery only writes to a log until a provider (FCM/APNs) is connected.
- Most routes do light input checks. Send values within the limits above.
