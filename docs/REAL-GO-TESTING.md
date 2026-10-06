# Testing against the real Go

The real Go: `https://brain-production-6b68.up.railway.app` (socket `wss://…/v1/socket`). Contract unchanged
(`llms-full.txt` sha256 `1788035c…`, `go.json`, `socket.json`, `methods.json` identical to `contract/`).

How to run it yourself:

```bash
pnpm dev:real     # .env → local Postgres in .pgdata/ + the server connected to the real Go (Ctrl-C stops)
pnpm inspect      # outbox per trip, refused events, our errors, latencies, what Go asked (from logs/go-traffic.jsonl)
```

`.env` holds `GO_URL`, `GO_SIGNING_SECRET`, `GO_SPEND_PRIVATE_KEY` and `INSTANCE_NAME=rahul-mac-1`. It is never
committed. With `LOG_GO_TRAFFIC=1`, every socket frame goes to `logs/go-traffic.jsonl` (no signature header,
no secrets).

## Waiting on Go's team

- **Our spend-approval public key.** Send them `go-spend-public.pem`:

  ```
  -----BEGIN PUBLIC KEY-----
  MCowBQYDK2VwAyEAKp6wiF858+DwVczc/1FkbUss8AQNcpIuuNIsZl7xoJg=
  -----END PUBLIC KEY-----
  ```

  Until they have it, Go cannot verify the spend approvals we sign.

## 1. Connection (6 Oct, 13:33 UTC)

| Check | Result |
|---|---|
| Signed upgrade accepted (no 401) | ✅ first try |
| `?instance=rahul-mac-1` in the target | ✅ |
| `/health` shows `go: true` | ✅ |
| Socket stays up past 40 s of quiet (Go's pings) | ✅ no close or reconnect |

## 2. Smoke test

Trip "TEST smoke: Goa weekend", Rahul and Priya. Priya asked "@Go … suggest a nice area to stay in Goa for 4 friends?".

- Go showed typing, put ✅ on her message, and replied in the room (North Goa vs South Goa) about 20 s later.
  It also wrote a trip-record line.
- All 6 events were delivered and accepted, in about 360 ms each.
- Go's 5 requests to us: typing ×2, `add_reaction`, `post_message` and `add_record_line`. We answered each in under
  10 ms, with no errors.

## 3. Parallel testing by area

### A. Socket and the 20 events: ✅ 19 of 20 accepted, 1 not reached

Trip `t_b7f427a8fea39c16` ("TEST A events"): 52 events, all `sent`. None failed, got stuck or was sent twice. Go
answered every one `{accepted: true, duplicate: false}`. Across all trips on the server, 124 `send_event` answers
were all accepted, every trip's events arrived in order with no gaps, and Go's answers took p50 393 ms, p95 683 ms,
max 1162 ms (limit 2 s). The socket stayed open the whole time, through a 60 s silent stretch (kept alive by Go's
pings).

| Event | Result |
|---|---|
| trip.created, person.joined, person.left | ✅ |
| person.updated (pause, unpause, forget me) | ✅ |
| trip.updated (budget on join and on leave, by the system; stay, by Go) | ✅ |
| message.created, message.edited, message.deleted | ✅ |
| reaction.added, reaction.removed (by people and by Go) | ✅ |
| decision.opened, decision.voted, decision.closed (closed by a person; everyone voted), decision.cancelled | ✅ Go opened all 3 votes when asked |
| mandate.set, mandate.declined, mandate.confirmed | ✅ |
| record.changed (undo by a person; lines from Go and the server) | ✅ |
| expense.changed (added, removed) | ✅ |
| booking.changed | not reached: Go's payment page refused the spend approval (see "Issues for Go's team" 1) |

### D. Our requests to Go: ✅ all 29 answered in time and matching the contract

Trip `t_61b36c5c704512f4` ("TEST D Goa stays"). Times are measured at the app; Go's own time was about 0.4 s.

| Request | Result |
|---|---|
| card_tap (8 sent to Go) | Go's options card with `pick` (per option) and `vote` buttons. Results came back as `done`/`refused` with toasts. The same `tap_id` three times got the same answer and one follow-up in the room. Another person reusing that press id got a separate tap. Taps on vote and mandate cards (422), unknown cards (404) and a bad `action_id` (400) never reached Go. 0.4–1.2 s |
| catch_up (3 reached Go) | `needed:false` when it isn't due (Go not asked). Away 4 h, 15 unread, and forced all came back `needed:true` with 3 items and message ids. The right `since` was sent each time and nothing was posted to the room. About 0.4 s |
| get_person, update_person, delete_fact | Facts from the join answers and from messages, with the right ids; carry-over on and off. Go's 404 for a fact it doesn't have reached the app as 404 `not_found`. 0.4–1.3 s |
| forget_person | Trip and everywhere both returned `remaining_facts: 0`. Join answers were cleared, `person.updated` was accepted, and Go did not learn them again. About 0.5 s |
| vault_link | home, add_card and add_login all returned an https link that expires in 5 minutes. **The link is stored nowhere** (we searched every table and log). About 0.4 s |

Not covered: a card tap answered `open` (the pay card never appeared, see "Issues for Go's team" 1), Go's 429 or
504, and the working, call, pay and notice cards (only options cards appeared).

### B. Go in the room: ✅ every Go request accepted and answered quickly

Trip `t_be4afbd1d543d532` ("TEST B Goa weekend"), 10 messages to Go.

| Go's request | Count | Errors | Slowest answer |
|---|---|---|---|
| read_trip | 22 | 0 | 79 ms |
| read_messages | 13 | 0 | 67 ms |
| post_message | 15 | 0 | 51 ms |
| typing (notification) | 21 | – | not answered, by design |
| add_record_line / update_record_line | 7 / 1 | 0 | 12 ms |
| add_reaction | 4 | 0 | 49 ms |
| update_trip, open_vote, set_mandate | 1 each | 0 | 5 ms |

- Across every trip on the server: 0 params refused, 0 errors, slowest answer 92 ms.
- Seen only in the other agents' trips: `request_spend_approval`, `cancel_spend_approval`, `add_expense`.
- Never seen from the real Go: `replace_card`, `remove_reaction`, `close_vote`, `add_booking`, `update_booking`.
- **Cards:** options (stay ×2, flight ×3), vote and mandate. All 7 were stored exactly as Go sent them and reached the
  live stream as authored by Go.
- **Scenarios that worked:**
  - an @Go question (answered in about 7 s);
  - a reply to Go without @Go;
  - a burst of 3 messages, handled as one turn, with the open line turned into an agreed line backed by all 3 messages;
  - a paused person's message, which reached Go withheld; Go stayed silent;
  - "Ask Go about this";
  - a dates change through `update_trip`;
  - a vote leading to a mandate, then "Yes, book it";
  - typing shown and hidden on the live stream;
  - Go's reactions, shown with no person.

### C. Votes and money: ✅ every step Go took worked; payment waits on our public key

Trips `t_3808865fe94f174c` ("TEST C Goa villa vote", 5 people) and `t_07a90b63100d3054` ("TEST C Goa hotel
booking", 4 people). 0 errors; every Go request answered in under 100 ms.

| Step | Result |
|---|---|
| Join answers and the budget band | ✅ Go sees only the lowest band (3 of 5 answered) |
| Go opens a vote and posts the vote card | ✅ |
| Voting through the app | ✅ Bad option 422, changing a vote, closed vote 409. Closing early works (`closed_by_person`); cancelling works and a second cancel is 409 |
| Vote closes, decided line | ✅ `decision.closed`, then the decided line as its own change |
| `set_mandate` and the mandate card | ✅ Go first asks who pays and the cap. Only the payer sees it in "needs you" |
| "Not now" / "Yes, book it" | ✅ A non-payer gets 403 |
| `request_spend_approval` | ✅ Approved twice. The claims are right (payer from the mandate, amount within the cap, `exp − iat = 600`) and the signature verifies against our public key. Cancelled approvals don't count as outstanding |
| Go's payment page | ⏳ **Refused every time, about 1 s after our approval, with no pay card.** Waiting on Go's team to install our public key (above) |
| `cancel_spend_approval` | ✅ |
| Pay card, card tap → open, `add_booking`, booked line | not reached (blocked by the payment page) |
| Spend denials | not reached: Go checks prices itself. The rule order was checked in code and matches the contract |
| `add_expense` | ✅ Pushes for people who owe, with the right amounts (for example "You owe Kabir ₹640 for Airport cab for all five"); none for the payer |
| "Needs you" strip at each stage | ✅ |
| Anonymous vote | not reached: Go always sends `anonymous: false`, even when asked for a secret ballot |

To retest once Go has our key: the pay card and its push, card tap → `open`, `add_booking` with the approval (marked
used; decided line becomes booked), `replace_card` to paid, a second booking with a used approval (409).

## 4. Retest after the fixes, and a final pass (14:00 UTC)

The server was restarted with fixes 1–4. Trip `t_35e02e110dfa4980` ("TEST final: Goa long weekend"):

| Check | Result |
|---|---|
| Socket reconnects after the restart; `/health` shows `go: true` | ✅ |
| Fix 3: empty JSON body on `POST …/seen` | ✅ 200 |
| Fix 2: forget for a person with no answers | ✅ `deleted_facts: 0`, no event (seq stayed 2) |
| Fix 2: forget for a person with answers | ✅ `deleted_facts: 5`, one `person.updated` |
| Fix 1: `pnpm inspect --trip` shows Go's answer times for that trip only | ✅ |
| @Go asks for a vote → Go opens it → both vote → closes → decided line "Anjuna" | ✅ |
| Forced catch-up | ✅ "While you were away, the plan moved on. 1 thing needs you." |
| 17 of 17 events accepted, 0 errors; Go's requests answered in at most 47 ms | ✅ |

**Watch item:** Go's answers to `send_event` were slower in this run: p50 559 ms, p95 and max 1530 ms (earlier
runs: max 1162 ms). The contract limit is 2 s and our timeout is 2.5 s. A slower answer would be retried, not lost.

## Fixes made during real testing

1. **`pnpm inspect --trip` mixed in other trips' figures.** Go's answers to our requests had no trip on them. They
   now carry the trip of the request they answer, so the filter is exact. Tooling only:
   `src/go/go-socket.ts` and `scripts/inspect.ts`.
2. **"Forget me" sent `person.updated` when nothing had changed.** A person with no join answers still produced an
   event saying `from_city`, `earliest_leave` and `know` changed. Two related gaps:
   - "forget everywhere" skipped trips the person had left, so their answers stayed in our database;
   - "forget me in this trip" refused (403) a trip they had left.

   Now the answers are cleared in every trip the person was ever in, and `person.updated` is sent only where they are
   still in the trip and something was actually cleared (`src/domain/ask-go.ts`; tests in `tests/fixes.test.ts`
   "R1"). Found by agent D.
3. **An empty POST with `content-type: application/json` was refused (400).** Many HTTP clients, Flutter's
   included, set that header on every request. An empty body now counts as no body, and each route's schema still
   decides what is required; unreadable JSON is still a 400. `src/api/app.ts`, test "R2". Found by agent B.
4. **The payer's "needs you" item showed the vote's question.** It showed "Which villa for 6 to 9 Nov?" instead of
   what to confirm. It now reads "Yes, book it? Villa Sol, up to ₹55,000", with the question in a separate
   `question` field (`src/domain/actions.ts`, API.md). Found by agent C.

## Issues for Go's team

1. **Spend approval refused straight away.** Trip `t_b7f427a8fea39c16`, decision `d_80f224a4536191de`:
   - At 13:39:14.567Z Go asked for a spend approval (₹38,400, merchant "ixigo (simulated)") and we approved it
     (`ap_3abb4830c6a6715e`).
   - 0.65 s later Go posted "The payment page refused this one. Nothing was charged." No pay card was posted and no
     page was opened.
   - Go then sent `cancel_spend_approval` with reason `other`.

   Our token checks out on our side:
   - the header is `{"alg":"EdDSA","typ":"go-spend+jws"}`;
   - the claims are in the contract's order;
   - it expires after 10 minutes;
   - its signature verifies against our public key.

   Most likely Go's vault doesn't have our public key yet (above). **Please confirm the refusal reason.** The room
   message is also misleading: no payment page was ever opened.
2. **Go's reasoning shows in its chat messages:**
   - "Asha asked directly, so I'll open a plain two-option vote."
   - "Bina asked directly, so a yes/no vote it is."

   Room text should be for people only.
3. **Wrong place saved.** `update_trip` set the stay to "Villa Sol, Assagao", but Go's own search option and the vote
   say Villa Sol is in Anjuna.
4. **Go names people but never sends `mentions`, so nobody gets a push.** For example, "Asha, you're the payer, so tap
   'Yes, book it'…" (13:46:20) and "Bilal, I can't say for sure yet…" (13:43:29), in trip `t_be4afbd1d543d532`. The
   contract says people Go names go in `mentions`, and the server pushes them.
5. **A mandate for something Go can't book.** Go ran a vote and set a mandate for a flight, then said "I can't book
   flights for the whole group yet". The mandate stays confirmed with nothing booked. Go should check it can book
   before asking who pays.
6. **Content slips:**
   - Go said "the three flight lists that came back", but one was missing.
   - Its "doing" lines were added after the results, and they name the wrong person.
   - It said it found nothing at ₹8–10k, then showed a ₹9,800 villa.
7. **Stale open lines.** For every vote it opens, Go writes an `open` record line naming everyone, and it never
   closes it with `update_record_line` when the vote closes or is cancelled. The same goes for its "who pays" lines.
   They stay in everyone's "needs you" strip (for example `r_901c032ad09c0cc6`, `r_729441e01697f4c1`).
8. **`anonymous` is ignored.** Go opened votes with `anonymous: false` even when asked for a secret ballot.
9. **Web results it can't book.** On `t_3808865fe94f174c`, Go set a mandate and asked Rahul to confirm, then said
    "I found this one on the web, so I can't book it here". It should say so before the mandate.
10. **A request lost behind the welcome.** On `t_35e02e110dfa4980`, Priya's "@Go can you show us 2 or 3 stay
    options…" arrived while Go was posting its welcome. Go never answered it; only after a later vote did it say it
    would look "if you'd like me to start".
11. **Wording:**
    - "won, 5 of 5 votes" when the tally was 4 to 1;
    - "Calangute" for a villa in Vagator;
    - room messages that describe its own steps ("The two results come from separate searches, so I'll open the
      vote directly…").
12. **Question:** should a paused person's message keep `reply_to` when it reaches Go withheld? The contract's
    list of fields to hide doesn't include it, so we keep it. But the contract's own example has `reply_to: null`, and
    keeping it shows Go that the person replied to it. We'll follow their answer.
