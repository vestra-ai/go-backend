# Server review against the Go docs

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
- **Still open (decisions, not bugs):**
  - app features the docs mention that have no endpoint yet (profile edits, trip edits, a later budget answer,
    settle-up, attachments, trip status);
  - a real push provider and real sign-in;
  - the first run against the real Go.

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
| Live stream | Messages, edits, deletes, reactions (Go's too), replaced cards, typing (Go's and people's), "trip changed"; works across instances; now reconnects its LISTEN connection (B12) | ✅ |
| "Needs you" strip | All 4 sources: open vote, mandate waiting for the payer, a Go card naming you, an open line asking you | ✅ |
| Pushes | Only the 4 cases; `trip_id` + `message_id` in the data; `replace_card` sends none | ✅ (vote-closing and owe pushes carry no `message_id`: see 4.8) |
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
   `GET …/messages?after_seq=` does not return the updated card. The live stream does. **Proposal:** an app-only
   "cards changed since" cursor. Needs the app team's agreement.
6. **"Give up after 24 hours":** the docs don't say from when. **We count from when the event was made.**
7. **System messages:** the contract allows `author: system`, but nothing asks the server to post one, and the
   database can't store one yet.
8. **Push data without `message_id`:** the vote-closing and owe pushes carry `trip_id` only (there is no single message
   to open). The docs say "put `trip_id` and `message_id`", which fits the Go-message pushes. Fine unless the app wants
   to open the vote card: we could add the vote card's message id.
9. **Not defined by the docs:** who may close or cancel a vote (today: any member); whether the organizer may leave
   (today: yes); whether a person may delete an expense Go recorded for a booking (today: yes). **Decide with the app team.**
10. **Converting a decided line to booked:** the event uses `change: "updated"`. The docs don't name the value.

---

## 5. Not built yet: needs a decision or an owner

The docs mention these app features. The Server has no endpoint for them yet.

| Missing | Why it matters | Suggested owner |
|---|---|---|
| Edit profile (name, photo, UPI id), sending `person.updated` | Go's "has UPI" and names go stale | Server, with the app's screens |
| Edit join answers in a trip (city, earliest leave, "know") | Only set when joining | Server |
| Answer or change the budget question after joining | Only at join | Server |
| Trip edits by people (title, dates) | Only Go can edit today | Server + app |
| Settle-up: "Pay by UPI" (needs the payee's UPI id from us) and "Nudge" | The settle-up card has no working buttons | Server + app |
| Attachment upload and storage | Only URLs pass through today | Decide: Supabase Storage? |
| Trip status (planning → booked → on trip → over) | Nothing moves it | Decide: who sets it, and when? |
| Forget me in a trip the person has already left | They can only use "everywhere" | Server (small) |
| Real push provider (FCM / APNs) | Pushes only go to the log | Decide the provider and owner |
| Real sign-in | A simple stand-in today | Decide: Supabase Auth? |
| CORS | Needed only if a web frontend calls the API | Server (small, when needed) |

## 6. What we are waiting on

- Go's URL and signing secret (shared by a one-time link).
- Giving Go's team the public half of our spend key (we generate the pair at setup).
- Keshav's fake Go or the real Go, for the first live run.
- A Supabase project (its connection string as `DATABASE_URL`).
- A push provider choice, and a sign-in choice.
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
