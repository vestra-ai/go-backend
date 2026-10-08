# Server review against the Go docs

## October 2026: the `/app/v1` rebuild

**Date:** 8 Oct 2026. After the review below (6 Oct), the app team's contract (rev 2) and the design PDF were reviewed
against the server ([`ALIGNMENT-REVIEW.md`](ALIGNMENT-REVIEW.md)), the decisions were written up for the app team
([`APP-CONTRACT-CHANGES.md`](APP-CONTRACT-CHANGES.md)) and for Go's team ([`GO-CHANGES.md`](GO-CHANGES.md)), and the
app API was rebuilt in six phases ([`ALIGNMENT-PLAN.md`](ALIGNMENT-PLAN.md)). The result is the one contract the app
builds against, [`API.md`](API.md): 81 routes under `/app/v1`, one WebSocket, and 470 tests in 52 files, all offline
(embedded Postgres, mock Go, fake Supabase Auth, in-memory storage).

**Phase 0, foundations (`c46d21f`).** Every app route moved to `/app/v1` with the app team's names; the old `/app/...`
routes were deleted. The API became a shell (`src/api/app.ts`: request id on every answer, CORS with the exact origins
and the `Idempotency-Key` header, one error shape `{ error: { code, message, field, retry_after_seconds, request_id } }`
with 400 only for unreadable JSON and 422 for every rule, sign-in before the body) plus one file per contract section in
`src/api/v1/`, each declaring its routes' metadata for the Postman generator. `Idempotency-Key` became the one repeat
mechanism for every write (24 h, scoped to person, method, path and key, replay marked `Idempotent-Replayed`), `GET
/config` (feature flags, push key) and `GET /health` landed, and the 1.1 overlay (`contract/extensions-1.1.json`)
extended the contract check additively so Go's new fields pass through.

**Phase 1, sign-in, Me, home, invites, trips, places (`728bdfe`).** `Me` with email, provider, masked UPI id, default
city, the notifications switch and the counts; `PUT/DELETE /me/upi`; `POST/DELETE /me/devices`; account deletion in the
contract's order (`DELETE /me`). `GET /home` with the server-computed `stage` and `attention`, the invites kept for
later, past trips with `all_settled`, and `home_changed` on every change that moves the home screen; the curated ideas
table. Invites as rows: the public, read-only, rate-limited preview with inviter, faces and a personal `state`,
accept (with `landing`), later, decline, and the organizer's rotation (old codes answer `revoked`). `POST /trips` with
everything optional, `GET /trips/:trip` as a `TripView` (`stage`, `me`, `chat`, `needs_you_count`, `can`, `?include`,
ETag), join answers with the Quick start mapping (`vibe` → a `know` entry, `spend_band` → the private budget),
`DELETE …/me/budget`, `POST …/read` with `last_read_seq`, and the privacy rule that hides other members' `from_city` and
`earliest_leave`. The city search from a bundled GeoNames extract, no third-party call.

**Phase 2, the room, live, uploads, cards, decisions (`02aa167`, merge `90f9f45`).** The SSE stream was replaced by one
WebSocket per app instance (`POST /live/ticket`, `GET /live?ticket=`): `hello`, `message`, `card`, `typing` both ways,
`trip_changed` with `kinds`, `home_changed`, `resync`, `ping`/`pong`, subscribe with replay (the changed messages, then one
`trip_changed`; `resync` above 200), one socket per person and device, close code 4401. Messages gained history mode
(`before_seq`) beside changes mode, `client_message_id`, `201 Message` answers, one reaction per person (`PUT
…/reaction`), and `GET …/catch-up` with 204. `POST /uploads` signs a one-off upload URL into Supabase Storage (size and
MIME checks, 24 h expiry sweep; an in-memory fake for tests and laptops); attachment links are signed again on every
read, valid one hour. The server now posts system messages (trip created, joined, left, decided, booked, and the anchor
carrying the vote card of a person-opened poll), each a change number with no event to Go. `replace_card` moves the
message's `updated_seq` (no event), closing the old "card updated while offline" gap. Card taps moved to
`POST …/cards/:card_id/actions` with `press_id` and `payload`, answering `refused` with a toast when Go does not answer.
Decisions gained `GET …/decisions/:id` with `my_vote`, `POST …/decisions` answering the decision and its message,
`PUT …/vote` (with `flexible` behind a flag), `DELETE …/vote` behind a flag, close by the organizer or opener, cancel,
`GET …/record` with `include_undone`, and redo.

**Phase 3, money (`bc8c87e`, merge `98c1b38`).** `GET …/money` (`MoneyView`: the contract's `Money` plus the caller's
private budget range, their share spent by equal split and by category, `owed_to_me`, `i_owe`), `GET …/transactions`
(filters, opaque cursor, `total_count`, the approval badge per row), settlements (`POST …/settlements`, confirm,
dispute) counted provisionally from the moment they are recorded and told to Go only on confirmation
(`settlement.recorded`), `POST …/transfers/pay-link` (`upi://pay`) and `…/transfers/nudge` (24 h). Expense approval
(decision D6): `Expense.status` and `confirmations` (one per split member other than the payer), `POST …/expenses` by
hand, approve, dispute, fix split (resets the changed shares), remove; disputed expenses leave the totals and the
transfers; `expense` items in the strip and `expense` pushes; Go's `add_expense` starts pending unless it carries an
`approval_id`.

**Phase 4, bookings, documents, itinerary, trip home, pushes (`c3fceba`, merge `9088a74`).** `GET …/bookings` and
`…/bookings/:id` with the covered-people rule (`passengers` and `documents` only for the people in `for_person_ids`);
booking documents copied from Go's `add_booking` links into Storage and opened through a 302 to a 10-minute signed link;
the 1.1 fields `details`, `return_journey`, `passengers` on `POST …/bookings`. `GET …/itinerary?scope=everyone|me`
(private items filtered; "Just me" reworded from the person's bookings). The needs-you strip in its v2 shape
(`NeedsYouItem` with `title`, `subtitle`, `cta_label`, `since`, `target`, and the `settle_up` kind). `GET …/cards?kind=
&state=` for the Trip home's calls, and `POST …/cards/:id/share` (behind `features.calls`) copying an ended call's
recording into the room. Pushes in the contract's payload (`type`, `trip_id`, `message_id`, `title`, `body`, `deep_link`,
`tag`) with the new types `settlement`, `nudge`, `joined`, `expense`, honouring `notifications_enabled`, and the device
table behind `POST /me/devices`.

**Phase 5, web check-in and visa (`69ef776`).** The three check-in routes behind `features.checkin` (`GET`, `PATCH`,
`POST …/complete`): the server asks Go `get_checkin` and `submit_checkin` (2 s, `working` allowed, finished by
`replace_card` or a later read), caches each covered person's state, fills the companion from the booking's passengers,
refuses a paid seat with `payment_required` (the vault pays first), and raises the `checkin` strip item, the home card's
`attention.task` and the `checkin` push when a flight's check-in first opens (also when Go posts a notice card with a
`go://…/checkin/<booking>` link). Visa: `POST /me/vault-link { start: "add_documents", context }` behind `features.visa`,
`checklist` cards passed through, a pending row of mine as `attention.task`. A test proves two simultaneous `claim` taps
reach Go with distinct `tap_id`s.

**Known gaps now (October 2026).** From the code, in no particular order:

- The in-memory rate limiters (invite preview 30/min/IP, city search 5/s/person, and rev 2 Appendix A's reactions 20,
  card taps 10, votes 20, vault links 6 and uploads 20 a minute per person) are **per instance**; with several
  instances the real limit is that many times higher.
- Uploads: **no EXIF stripping and no virus scanning** (files are only shared inside a trip). Upload URLs are valid two
  hours (Supabase's own limit).
- `claim`, the flexible vote, taking a vote back, web check-in, visa documents and call recordings **wait on Go's side**
  (`GO-CHANGES.md`); each is behind a flag that is off by default (expense approval is on). Go must also confirm it
  tolerates `author.kind = "system"` in `read_messages` and a `replace_card` that moves `updated_seq`.
- The city dataset is a **starter set** (311 Indian cities from GeoNames); other countries answer 422.
- `home_changed` is sent for a trip created, joined or left and for invite marks, **not** when a trip's `attention`
  alone changes (that is a `trip_changed` to the trip); the app should re-read home on resume.
- The `Idempotency-Key` store is written after the handler: two copies of a request that race past the lookup both
  run (the domain keys still keep a double press to one write where it matters).
- Real Web Push delivery and the production Storage bucket have not been exercised against a real browser or the
  real bucket yet (phase 6.3); the 1.1 flows have not run against the real Go yet (phase 6.4).
- Transactions rows have no merchant `logo_url`/`emoji`; `Idea.image_url` is empty in the seed.

The sections below are the 6 October review, kept as written; the items it left open are marked where they were
resolved.

---

## The 6 October 2026 review

**Date:** 6 Oct 2026. **What was checked:** every page of the docs at https://vestrago.vercel.app/llms-full.txt
(11,705 lines, including the agents guide at `/docs#/guides/agents`), against the code in this repo, the app API
(`docs/API.md`) and the Postman collection.

## Summary

- **The docs have not changed since the build.** `llms-full.txt` (sha256 `1788035c…42241a1`), `go.json`, `socket.json`,
  `methods.json` and both test vectors are byte for byte the same as the copies in `contract/`.
- **Everything the docs ask of the Server towards Go is built and works:**
  - the signed socket, with reconnects and resends;
  - the outbox and all 20 events;
  - all 18 of Go's requests;
  - the 7 requests we send to Go;
  - money and the spend approval;
  - privacy and the app-facing rules.
- **16 bugs were found and fixed.** Most were at the app's edge: bad input caused a 500 instead of a 400 or 422, and a
  message without `client_id` was silently dropped. There were also correctness bugs (the "you owe" push amounts, a
  booking on an undone line, the budget band when someone leaves) and robustness bugs for several instances.
  Each one now has a test that fails without the fix: 37 of 41 failed on the old code; the other 4 are guards.
- **Every flow page in the docs is now an end-to-end test**, and the real server process has been run against a fake Go
  built to the docs' own description of Keshav's fake Go.
- **The Postman collection now runs end to end:** 79 requests and 148 checks, 0 failures, and it can be run again.
- **Still open on 6 Oct (decisions, not bugs)**, all since resolved (see the October 2026 section above):
  - app features the docs mention that had no endpoint yet (profile edits, trip edits, a later budget answer,
    settle-up, attachments, trip status): built in phases 1–4;
  - a real push provider (Web Push, 6 Oct) and real sign-in (Supabase Auth, 7 Oct);
  - the first run against the real Go (6 Oct, `REAL-GO-TESTING.md`).

| | Before this review | After |
|---|---|---|
| Automated tests | 123 | **224** (all passing) |
| Postman | could not run in order, no checks | **79 requests, 148 checks, 0 failed** (`pnpm postman`) |
| Doc flow pages tested end to end | 0 of 8 | **8 of 8**, plus the real server against the fake Go |

How to run it all yourself:

```bash
pnpm test           # 224 tests, temporary Postgres, about 15 seconds
pnpm dev:stack      # temporary Postgres + fake Go + the real server on :8080
pnpm postman        # in a second terminal, while dev:stack runs
```

---

## 1. The docs' own "What done means" for the Server

Each item is quoted from the docs' "What each team builds" page, with the proof.

| # | The docs say the Server… | Status | Where, and the test that proves it |
|---|---|---|---|
| 1 | Opens one socket with a fresh signature on every connect, its own `?instance=`, and reconnects after 1, 2, 5, 10, then every 30 s | ✅ | `src/go/go-socket.ts`, `src/config.ts`. Tests: `socket` "opens with a signature Go accepts…", `reconnect` "after Go refuses the upgrade with 401…", `coverage` "waits 1, 2, 5, 10, then 30 seconds…" and "after a good connect the next wait starts again at 1 second" |
| 2 | Sends an event for every change from an outbox, in change-number order per trip, waiting for each answer, with the retry schedule | ✅ | `src/db/write-change.ts`, `src/outbox/sender.ts`. Tests: all of `outbox`, `concurrency` "many writes to one trip take consecutive change numbers", `coverage` "a 429 without retry_after_seconds…", `fake-go.e2e` "every event reached Go once, in change-number order, with no gaps" |
| 3 | Answers all of Go's requests within 2 s, checks params, does each write once per `request_id`, answers -32601 for an unknown method, shows/hides typing, keeps `read_messages` pages under 1 MB with `has_more` | ✅ | `src/requests/*`, `src/db/once.ts`. Tests: `room`, `money`, `socket` "answers 503… in time", "-32601", `concurrency` "the same request_id arriving twice at once" |
| 4 | Sends an unanswered request again after reconnecting, with the same JSON-RPC id | ✅ | `go-socket.ts` (pending requests survive a drop). Tests: `resend` (both) |
| 5 | Lets any instance answer any request from the shared database | ✅ | Every handler reads Postgres. Tests: `outbox` "two server instances never send the same trip at once…", `coverage` "live updates reach a second instance…". Fixed: migration race, live LISTEN reconnect, pool sizing (bugs B10–B12) |
| 6 | Runs the spend check and signs approvals that verify against Go's public key, reproducing the test-vector token | ✅ | `src/domain/spend.ts`, `src/contract/spend.ts`. Tests: `contract` "reproduces the token character for character", `money` spend tests, `flows` F4 |
| 7 | Sends card taps (each with its own `tap_id`), catch-up, people pages, forget me and vault links on the socket; the app never talks to Go except to open Go's pages | ✅ | `src/domain/ask-go.ts`. Tests: `app` "asking Go", "the You screen"; `flows` F1, F4, F5, F6, F7 |
| 8 | Sends pushes only in the 4 documented cases | ✅ (push provider is a placeholder) | Go names you, a new card needs you (`src/requests/messages.ts`), a vote closing (`src/jobs/votes.ts`), you owe money (`pushOwed`, fixed to use `money.transfers`). Tests: `room` pushes, `app` jobs, `fixes` A4, `flows` F1/F4/F5 |

---

## 2. Requirement matrix

✅ means it matches the docs and is tested. ⚠️ means it works, but there is an open question (see section 4).
"Test" names the test file in `tests/`.

### 2.1 Socket, frames, keepalive

| Requirement (doc page) | Status | Test |
|---|---|---|
| `x-go-signature: t=…,v1=…` over `t\nGET\ntarget\nbody`, matches the 3 signing vectors (The socket) | ✅ | contract |
| A fresh signature every connect; a 401 means try again with a new one | ✅ | socket, reconnect |
| `?instance=<name>`, unique per instance (default `<hostname>-<pid>`, fixed from `server-<pid>`) | ✅ | socket, main.e2e |
| Reconnect 1, 2, 5, 10, then 30 s; back to 1 s after a good connect | ✅ | coverage |
| Close after 40 s of silence | ✅ by reading `go-socket.ts`; not timed in a test (it would take 40 s) | — |
| Answer Go's pings | ✅ (the `ws` library does it) | — |
| Unreadable frame, or a frame that is not JSON-RPC 2.0, gets `-32700` with `id: null` | ✅ (non-JSON-RPC case fixed, B13) | socket, fixes B13 |
| Unknown method `-32601` before params; bad params `422` naming the field; null equals missing | ✅ | socket, contract |
| A notification is never answered, even with bad params | ✅ | room |
| An answer with an id we no longer wait for is ignored | ✅ | fixes B13 |
| Frames at most 1 MB: inbound limit set; `read_messages` pages under it | ✅ | room |
| Frames at most 1 MB outbound for `read_trip` / `trip.created` | ⚠️ not guarded (a trip would need to be very large) | — |
| Unanswered requests resent after reconnect with the same id; the outbox resends with the same `event_id` after a restart | ✅ | resend |

### 2.2 Outbox and `send_event`

| Requirement | Status | Test |
|---|---|---|
| Change and its event in one transaction; change number from the trip row | ✅ | room, concurrency |
| `trip.created` is change 1 | ✅ | app, flows F2 |
| One event at a time per trip, waiting for each answer; trips don't block each other | ✅ | outbox |
| Retry timeout/429/500/503 after 1, 5, 30, 120, 600 s, then every 600 s; 429 waits `retry_after_seconds`, or the schedule without it | ✅ | outbox, coverage |
| Any other error: mark failed, send the next event | ✅ | outbox, flows F8 |
| Give up after 24 hours | ✅ (counted from when the event was made; see 4.6) | outbox |
| `accepted` and `duplicate: true` both count as sent | ✅ | outbox, flows F8 |
| Nothing is sent while the socket is down, and no retry is used up | ✅ | outbox |
| Every event checked against the contract before it is stored (stricter than the docs) | ✅ | every flow test checks `check('Event')` |
| `replace_card` and typing take no change number | ✅ | room, flows F4/F5 |

### 2.3 Go's 18 requests

| Request | What was verified | Status |
|---|---|---|
| `read_trip` | Snapshot at the current change number, read consistently; no contact details; lowest budget band only; anonymous votes show totals only; people who left are not included; 404 | ✅ |
| `read_messages` | Changed after `after_seq`, ordered; Go's reactions have no person; withheld and deleted have no words; `has_more`; under 1 MB | ✅ |
| `post_message` | Card stored exactly as sent; `message.created`; live update; typing hidden; pushes once; 422 for a mention or `reply_to` outside the trip, or an unknown record id; 409 for a mandate card without a mandate, or a repeated `card_id` (also when two arrive at once: fixed, B6) | ✅ |
| `replace_card` | Swapped in place; no change number, event or push; the strip follows `for_person_ids`; 404 when not on a Go message | ✅ (see 4.5) |
| `typing` | Live for 10 s, hidden by Go's next message; never answered | ✅ |
| `add_reaction` / `remove_reaction` | No person; moves `updated_seq`; events; 404 then 409; two at once is a 409, not a 500 (fixed, B6) | ✅ |
| `update_trip` | Only the fields sent change; `trip.updated` by Go; 422 with no known field (was a 500: fixed, A3); date order; itinerary bookings checked | ✅ |
| `open_vote` | `of` = people now in the trip; options kept as sent; 2–10 options; `closes_at` in the future; currency | ✅ |
| `close_vote` | Result is the option with most votes; a tie or no votes gives no line; `decision.closed`, then the decided line as its own change | ✅ |
| `set_mandate` | A new mandate clears yes/no; `mandate.set`; in the payer's strip; 404/409/422 | ✅ (rule order: see 4.1) |
| `add_record_line` / `update_record_line` | Go writes only agreed/open/doing; agreed needs proof; Go cannot change server lines or undone lines; 422 with no known field (fixed, A3) | ✅ |
| `add_booking` | Approval checked and marked used in the same transaction; booked line (now a new line when the decided line was undone: fixed, A5); a repeat returns the first answer; 409 rules | ✅ |
| `update_booking` | Only the fields sent change; `updated` or `cancelled`; 409 when cancelled; 422 with no known field (fixed, A3) | ✅ |
| `add_expense` | Server does the money maths; 422 rules; owe pushes from transfers (fixed, A4) | ✅ |
| `request_spend_approval` | The 9 rules in the documented order; denial is a result; Ed25519 token, payer from the mandate, `exp−iat = 600`; the same `request_id` gives the same token; only one outstanding (race-safe); not a trip change | ✅ |
| `cancel_spend_approval` | `ok` and safe to repeat; used, cancelled or expired approvals are left unchanged (expired fixed, B16); 404 when unknown | ✅ |
| Rules for every request | Answer within 2 s or 503 (the write still completes and stores its answer); a person who left is not in the trip; `request_id` checked before any rule; two copies at once get the first answer | ✅ |

### 2.4 Requests the Server sends to Go

| Request | Status | Test |
|---|---|---|
| `card_tap`: only for Go's card kinds (options, working, call, pay, notice); each press has its own `tap_id`, now tied to the person (fixed, B15); 3 s limit | ✅ | app, flows F1/F4/F5 |
| `catch_up`: away 3 h or more, or 15+ unread; `since` = last seen; nothing posted to the room | ✅ (15-unread branch now tested) | flows F6 |
| `get_person`, `update_person`, `delete_fact`, `vault_link`: always for the signed-in person | ✅ | app, flows F7 |
| `forget_person`: Go first; then that trip's (or every trip's) join answers are cleared and `person.updated` is sent; 502 if facts remain | ✅ (two trips now tested) | flows F7 |
| Not resent on their own; Go's 429 passed on with `Retry-After`; Go's answer checked against the contract (502 when wrong) | ✅ | app |

### 2.5 The 20 events

All 20 are sent, and every one is checked against the contract in the tests. Fixed: `trip.updated ["budget"]` now
also goes out when someone with a budget answer leaves (A7). Not reachable yet: `person.updated` for name, photo or
UPI changes, and `trip.updated` for `status`, because those app features don't exist (section 5).

### 2.6 Cards, trip record, money, privacy, app

| Area | What was verified | Status |
|---|---|---|
| Cards | Stored raw (new fields survive); record cards checked against our rows; buttons on record cards never reach Go (422); unknown kinds left to the app's `fallback_text` | ✅ (new kinds: see 4.3) |
| Trip record | Decided line from votes, booked line from bookings; anyone can undo; undo is idempotent; Go can never undo or write an undo back | ✅ |
| Money | Spend rule order; token; approval marked used inside the booking; release; vault link; mandate buttons belong to the server, payer only | ✅ |
| Privacy | No phone, email or UPI id to Go (`has_upi` only); budget as the lowest band only; anonymous votes totals only; paused people `withheld` (edits too); forget me | ✅ |
| Live stream | Messages, edits, deletes, reactions (Go's too), replaced cards, typing (Go's and people's), "trip changed"; works across instances; now reconnects its LISTEN connection (B12). (October: the SSE stream became the WebSocket of `API.md` §3, fed by the same LISTEN/NOTIFY) | ✅ |
| "Needs you" strip | All 4 sources: open vote, mandate waiting for the payer, a Go card naming you, an open line asking you. (October: plus `settle_up`, `expense`, `checkin`) | ✅ |
| Pushes | Only the 4 cases; `trip_id` + `message_id` in the data; `replace_card` sends none. (October: plus `settlement`, `nudge`, `joined`, `expense`, `checkin`, and the `deep_link`/`tag` payload) | ✅ (vote-closing and owe pushes carry no `message_id`: see 4.8) |
| "Ask Go about this" | `about_message_id` makes it for Go even without Go's name | ✅ |

---

## 3. Bugs found and fixed

Each has a test in `tests/fixes.test.ts` (or the named file) that fails without the fix.

### Wrong answers or lost data

| # | Bug | Impact | Fix |
|---|---|---|---|
| A1 | A message without `client_id` used the duplicate key `…:undefined`, so every later message without one was **silently dropped** | Lost messages | `client_id` is required (400), as API.md already said |
| A2 | Almost no app route checked its body. Too-long text, a bad emoji, an unknown category, an empty split, a bad attachment, a bad `action_id`, a bad vault page, a missing token, `after_seq=abc`, broken JSON… all gave **500** | The app can't tell its mistake from a server bug | JSON schemas with the contract's limits on every route; standard 400 for parse errors; standard 404 for unknown routes; `PATCH {}` no longer erases a message |
| A3 | `update_trip` with only a field the contract doesn't know gave **500** (empty SQL `update`); `update_booking` / `update_record_line` sent an event that changed nothing | Go gets 500 instead of 422 | Only known fields count as "something to change" |
| A4 | The "you owe" push used one expense's share, rounded down, with ₹ hard-coded. Someone **owed** money overall could be told "You owe…" | Wrong amounts in pushes | Pushes come from the trip's `money.transfers`, as the docs say, formatted in the trip's currency |
| A5 | A booking turned a decided line that a person had **undone** into "booked" but left it undone, so the booking was hidden from the record | Booking missing from the Trip screen | The undone line stays undone; the booking gets a new booked line |
| A6 | Two different requests for the same thing at the same moment (the same ✅, the same `card_id`) gave **500** | Go gets 500 instead of 409 | A unique-index clash is a 409 conflict |
| A7 | When someone with a budget answer left, the band moved silently | Go's view of the budget goes stale | `trip.updated ["budget"]` by the system, as the docs require |
| A8 | A tap on a missing card, and Go's own 404/409, came back as `go_unavailable` | Wrong error code for the app | `not_found` / `conflict`, as API.md says |
| A9 | An expense could point at a booking in another trip | Bad data | 422 |

### Robustness and several instances

| # | Bug | Fix |
|---|---|---|
| B10 | The outbox could hold up to 16 of the pool's 20 connections while it waited for Go, leaving Go's 2-second requests short of connections | Pool configurable (`DB_POOL_MAX`, default 30); the outbox uses at most a third |
| B11 | Two instances starting at once could both run the migration | The migration holds a Postgres advisory lock |
| B12 | If the live stream's LISTEN connection dropped, live updates stopped silently for good | It listens again after 1, 2, 5, 10, then 30 s |
| B13 | A frame that was not JSON-RPC (no `jsonrpc: "2.0"`, or neither a request nor an answer) was ignored | `-32700` with `id: null`, as the docs say |
| B14 | The default instance name `server-<pid>` repeats in containers (pid 1), and Go refuses a reused name's signature | `<hostname>-<pid>` |
| B15 | Someone could replay another person's tap id and get Go's cached answer (for example their vault link) | The tap id sent to Go is tied to the person |
| B16 | Cancelling an approval that had already expired still stamped it cancelled | Left unchanged, `ok` |

---

## 4. Where the docs are unclear, and what we chose

These are not bugs. Each is a choice we made where the docs disagree with themselves or say nothing. Worth confirming
with Keshav's team.

1. **Which error wins when a request breaks several rules.** The general table (404, then 422 ids, then 422
   currency, then 409) disagrees with the `set_mandate`, `update_record_line` and `update_booking` pages (409 before
   422). **We follow the general table.** If Go's tests expect the per-method order, it is a small reorder.
2. **A spend request in the wrong currency:** the general page says 422; the `request_spend_approval` page says a
   `currency_mismatch` denial. **We return the denial.**
3. **New card kinds:** the docs say kinds may be added within version 1, but the contract's `Card` schema refuses an
   unknown kind. So `post_message` with a new kind gets 422 (the docs' own reference client does the same). **Ask
   Keshav's team:** should the server store unknown kinds as raw?
4. **A failed card tap or catch-up:** the docs' sample shows a quiet toast or nothing. **We return HTTP 504/503/429/502**
   with the standard error, and API.md tells the app to show a toast and re-enable the button.
5. **A card updated while a phone was offline:** `replace_card` takes no change number (by contract), so
   `GET …/messages?after_seq=` does not return the updated card. The live stream does. **Resolved (October, D9):**
   a `replace_card` now moves the message's `updated_seq` with no event; Go's team is asked to confirm it is harmless.
6. **"Give up after 24 hours":** the docs don't say from when. **We count from when the event was made.**
7. **System messages:** the contract allows `author: system`, but nothing asks the server to post one, and the
   database can't store one yet. **Resolved (October, D8):** the server posts them for joins, leaves, decided and
   booked lines and person-opened polls, with a change number and no event.
8. **Push data without `message_id`:** the vote-closing and owe pushes carry `trip_id` only (there is no single message
   to open). The docs say "put `trip_id` and `message_id`", which fits the Go-message pushes. Fine unless the app wants
   to open the vote card: we could add the vote card's message id.
9. **Not defined by the docs:** who may close or cancel a vote; whether the organizer may leave; whether a person may
   delete an expense Go recorded for a booking. **Decided with the app team (October):** close and cancel are for the
   organizer or the person who opened the vote; the organizer may leave; an expense may be removed by its payer or the
   organizer.
10. **Converting a decided line to booked:** the event uses `change: "updated"`. The docs don't name the value.

---

## 5. Not built yet on 6 October: all built since

The docs mentioned these app features; on 6 October the Server had no endpoint for them. Every row is done now
(`API.md` has the routes); the current gaps are in the October 2026 section at the top.

| Was missing | Built as |
|---|---|
| Edit profile (name, photo, UPI id), sending `person.updated` | `PATCH /me`, `PUT`/`DELETE /me/upi` (§4.1) |
| Edit join answers in a trip | `PUT /trips/:trip/me/join-answers` (§4.4) |
| Answer or change the budget question after joining | `PUT`/`DELETE /trips/:trip/me/budget` (§4.4) |
| Trip edits by people (title, dates) and trip status | `PATCH /trips/:trip` by any member (§4.4) |
| Settle-up: "Pay by UPI" and "Nudge" | `POST …/transfers/pay-link`, `…/transfers/nudge`, plus settlements (§4.9) |
| Attachment upload and storage | `POST /uploads` into Supabase Storage (§4.5) |
| Forget me in a trip the person has already left | `DELETE /me/go?trip_id=` works for a left trip (§4.13) |
| Real push provider | Web Push with VAPID (§8); a real browser still to be tried |
| Real sign-in | Supabase Auth (§1.2) |
| CORS | exact origins, `Idempotency-Key` allowed, no credentials (§1.1) |

## 6. What we were waiting on

Received since: Go's URL and signing secret, the real Go for the first run (6 Oct), the Supabase project, the push and
sign-in choices. Still outstanding:

- Our spend public key installed in Go's vault (`go-spend-public.pem`).
- Go's team's answers to `GO-CHANGES.md` (contract 1.1), which flip the feature flags.
- Optional: access to the private contract repo (`vestra-ai/go-brain`). We rebuilt the contract package from the
  public files, with the same names.

---

## 7. End-to-end tests and the Postman run

### The docs' flow pages (`tests/flows.e2e.test.ts`, 47 tests)

Each flow runs the real server code, a real Postgres and a mock Go over the real signed socket. It checks every HTTP
answer, every event Go receives (each checked against the contract), every request Go makes back, every live update
and push, and the "needs you" strip.

| Flow (doc page) | What it proves |
|---|---|
| F1 Go answers a question | @Go message → `message.created` with `mentions_go` → typing for 10 s → `read_trip` → reply with a flights card: one push to the named person, typing hidden, card stored as sent. A repeat changes nothing; a card tap reaches Go and its toast comes back; Go silent gives 504 |
| F2 A trip starts | `trip.created` is change 1 with no contact details → Go's vote and card are changes 2 and 3 → join preview → joining sends `person.joined` (no budget), then `trip.updated` budget; the vote waits for 2 → both vote → closes itself → decided line |
| F3 Agreeing without a vote | 👍 by a person; Go's agreed line with proof; Go's quiet ✅ (a repeat is 409); an undo by a person (idempotent); Go cannot write it back |
| F4 From a vote to a booking | The whole money path: 5 people vote; mandate (a card before it is 409); "not confirmed" → only the payer → "Not now" → "Yes, book it"; over the cap; a new mandate clears the yes; a signed 10-minute token (the same for a repeat, one at a time); pay card push; tap → vault link passed on and not stored; booking marks the approval used and turns the line booked; owe pushes of ₹10,840 each; ticket card; pay card marked paid with no change number, event or push. Branches: decline and cancel, expiry |
| F5 A phone call | A reply to Go is for Go; call card dialing → talking → ended, all in place; stop tap reaches Go; outcome push to Rahul; open line in his strip |
| F6 Opening the room after a while | Away 6 h with 23 unread → catch-up with the right `since`, nothing posted; 15 unread is enough even when just seen; after "seen" Go is not asked; Go silent gives 504 |
| F7 Forget me | `get_person` for the signed-in person; forget in one trip clears only that trip; everywhere clears both trips (one `person.updated` each); facts left gives 502, silence gives 504; carry-over; pausing withholds words from Go only |
| F8 Go misses an event | Go refuses one event → marked failed, the next is sent → Go sees the gap and catches up with `read_trip` and `read_messages`; `duplicate: true` counts as sent |

### The real server against a fake Go (`tests/fake-go.e2e.test.ts`)

This runs `src/main.ts` as its own process, connected to a fake Go that behaves as the docs describe Keshav's fake
Go. It is watched only through HTTP and the live stream, exactly as the app sees it. An @Go message shows "Go is
typing...", Go's ✅ on the message, then Go's reply with a card. Five questions produce the five Go card kinds in
turn (options, working, call, pay, notice). The pay card shows in the payer's strip, a tap reaches Go, and every
event reached Go once, in order, with no gaps.

### Postman (`pnpm postman`, against `pnpm dev:stack`)

The old collection could not run in order:

- it had no checks at all;
- "Leave trip" came 7th, so every later request got 403;
- the vote, line and fact ids were never set;
- several requests ran in an order that could only fail.

It now has a **Run in order** folder:

- two people, a stranger and a trip;
- every endpoint, with checks on each answer;
- Go's part played through the stack's control port (`[Go]` requests);
- an errors section (401, 403, 400, 404, 409, 422).

Result: **79 requests, 148 checks, 0 failed**, and it passes again on a second run against the same stack. The
reference folders keep one request per endpoint with example answers. Their wrong examples were fixed: the 429 now
has `Retry-After`, the 204 has no body, the 400 has no `name`, and a missing card is `not_found`.

A manual check with `curl -N` on the live stream showed the same thing for an @Go message: typing, ✅, then Go's reply.
