# Rev 5: what the Server team builds

Companion to `docs/GO-TEAM-REV5.md` (11 Oct 2026). The work is split three ways: ours, Go's, and the App team's.

## Who does what

| # | Request | Server (us) | Go | App |
|---|---|---|---|---|
| 1 | Multiple photos for stays and the trip's place | Nothing new: already stored and passed through. Check that TripView, TripSummary and vote options return `photos` | Send `photos` (R1) | Gallery |
| 2 | One card per place (Goa, Manali, Ladakh) | Nothing new (`option_kind: "place"` passes through). Document how the app draws it | Send place options (R2) | Place card |
| 3 | 10 options, "show more" | Accept 10 once Go's contract says 10 (or widen in our overlay) | Contract + send 10 (R3) | Compact + show more |
| 4 | "See more" → a new message with new cards | Nothing new: `card_tap` already forwards `more_options` | Action + new message (R4) | Button |
| 5 | Vote on the card itself, no CTA messages | **Build:** `OptionsCard.decision_id`, `add_vote_options`, `decision.options_added`, `Option.url` | Contract + behaviour (R5) | Vote buttons on options |
| 6 | Ideas with place photos | **Build:** `Idea.photos`, a daily refresh through `place_info` | `place_info` (R6) | Carousel |
| 7 | Live view of Go's computer | **Build** (small): accept and pass `live_url`. Today Go sends **no** stream | Host the stream, `live_url` (R7) | In-app panel |
| 8 | Vault in the app; Save card broken | **Build** (small): pass `display`. The Save bug is Go's | Fix Save; embedded mode (R8) | iframe + postMessage |
| 9 | Internal delete/forget for the App team | **Build:** internal admin routes (below) | Nothing new (uses `forget_person`) | Uses them in testing and support |
| 10 | Much more on "Details" | **Build:** `GET …/cards/:card/options/:option/details`, cached | `get_option_details` (R9) | Details sheet |

## Our changes

### A. Vote on the options card (item 5)
- **Overlay** (`contract/extensions-1.1.json`):
  - `OptionsCard.decision_id`
  - `Option.url`
  - method `add_vote_options` (`AddVoteOptions` → `{ seq }`)
  - event `decision.options_added`

  If Go publishes them first, we take their files instead.
- **`post_message`:** when a card has `decision_id`, check that the vote is in this trip and open (422 otherwise). Store
  it on the message.
- **`add_vote_options`** (new handler in `src/requests/votes.ts`):
  - only an open vote, at most 20 options in total;
  - append to `decisions.options`, keeping the existing indexes;
  - take a change number, emit `decision.options_added`;
  - live `trip_changed kinds:["decision"]`.

  Idempotent by `request_id`.
- **App reads:**
  - the options card's vote state comes from the `Decision` (already in TripView and GET decision);
  - needs-you "vote" items point to the newest message whose card carries the `decision_id`.
- **Taps:** a tap on `vote` on an options card is answered by the app's vote route, not Go. `cardTap` keeps rejecting
  buttons that aren't on the card.
- **Tests:** open, then post the linked card, then add options; votes before and after the add; the 20-option limit; a
  closed vote refusing adds; events in seq order.

### B. Ideas with photos (item 6)
- **Migration:** `ideas.photos jsonb`, `ideas.refreshed_at`.
- **Job** (`src/jobs/`): once a day, for each idea older than 24 h, call `place_info`. Store `photos`, `tag`, `travel`.
  A failure keeps the old values.
- **`GET /discover/ideas`:** add `photos` (up to 12); `image_url` stays as the cover (`photos[0]` when unset).
- **Until Go ships `place_info`:** seed the existing ideas with photos we're allowed to use. This needs a source: see
  open question 2.

### C. Live view and vault display (items 7, 8)
- **Overlay:**
  - `WorkingCard.live_url` (https)
  - `CreateLink.display` (`sheet` | `embedded`)
- **`POST /me/vault-link`:** accept `display` and pass it to Go.
- **Docs:**
  - an embedded vault page and `live_url` may be framed only from Go's own domain;
  - the app listens for the `go-vault` postMessage;
  - "never a WebView" becomes "sheet, or embedded when Go returns an embedded link".
- `live_url` is never logged and never stored beyond the card.

### D. Internal delete/forget routes for the App team (item 9)
These already exist for the signed-in person: `DELETE /app/v1/me` (account delete) and `DELETE /app/v1/me/go`
(forget). New routes for the App team's testing and support, to use on **any** person:

| Route | Does |
|---|---|
| `GET /internal/v1/people?email=…` | Look up `person_id` by email |
| `DELETE /internal/v1/people/:person_id` | The same account delete as `DELETE /me`: forget in Go, leave trips, "Former member", clear contact details |
| `POST /internal/v1/people/:person_id/forget` `{ trip_id? }` | The same as `DELETE /me/go` |

- **Auth:** header `x-internal-key` = `INTERNAL_API_KEY` (Railway variable). Every route answers 404 when the variable
  is unset.
- **Exposure:** no CORS, so they can't be called from a browser page and the key stays off the web app. Rate-limited.
  Each call is logged with the person id (no names or contact details).
- **Tests:** key missing or wrong → 404; right key → the same effects as the person's own routes.

### E. Stay details on demand (item 10)
- **Overlay:** method `get_option_details` (`GetOptionDetails` → `OptionDetailsFull`).
- **Route:** `GET /app/v1/trips/:trip/cards/:card_id/options/:option_id/details`.
  - Member only; the card must be visible to the caller (`visible_to_person_ids`).
  - Ask Go (3 s), cache an hour per option in a new table `option_details`.
  - Go doesn't answer → 504, or show the card's inline `details`.
- Rate limit with the card taps (10 a minute).

### F. Ten options (item 3)
- Take Go's file once it says `maxItems: 10`.
- If the App team needs it sooner: our overlay can't widen a limit (`mergeAdditive` only adds), so we'd add a one-line
  "widen" rule for this field alone.

### G. Docs and tests
- `CONTRACT-APP.md`, `API.md` (new routes in Appendix C) and `CONTRACT-GO.md` are updated for every item.
- `pnpm test` stays green. A real-Go or staging pass follows once Go ships.

## Order of work
1. **D** (internal routes): needs nothing from Go, so the App team gets it first.
2. **A** (vote on the card).
3. **E** (details).
4. **C** (pass-throughs).
5. **B** (ideas job).

A, B, C and E stay inert until Go sends the new shapes.

## Decisions (11 Oct)
1. **D:** the internal routes are for the App team's testing **and** support: delete, forget and "reset a test trip".
   They're called with a key, never from the web app.
2. **B:** Go provides idea photos (`place_info`). Until then, a static placeholder image.
3. **A:** one vote across the "see more" messages.
4. **H:** a pick stays valid 30 minutes; the fare may rise up to 5%.
5. **I:** the automatic name is on every app read (TripView, the home card, the invite preview), but not in Go's
   `read_trip`.
6. **I:** the year is the trip's start year; with no dates, the current year.
7. **L:** one home card per open item, all of them, not just 5. Tapping a card opens that same action in a popup (a
   vote opens the vote popup). Each item carries what the popup needs.
8. **C:** the vault card form may sit inside the app when Go's payment provider allows it.

## What Go shipped (go-brain `build`, contract 1.2.0; production health says 1.1.0, staging 1.2.0)
- **In the contract:**
  - `post_message.visible_to_person_ids`, the same as ours;
  - denial reasons `already_booked` and `not_in_trip`;
  - a **ticket** form of `request_spend_approval`: `{ kind: "ticket", for_person_id, amount_minor, currency,
    merchant, purpose, refundable_until? }` in place of `decision_id`. The claims carry `for_person_id` + `kind:
    "ticket"`, and the payer is always that person.
- **Behaviour from GO-TEAM-FINAL:**
  - no budget asks;
  - a declined card replaced at once;
  - no repeated money or vote lines;
  - no working text in the room;
  - a stay's `price_minor` is the whole stay everywhere;
  - Go books the group's voted stay on ixigo.
- **Not shipped yet** (0 hits in Go's code): rev 5 R3–R9 (10 options, `more_options`, `OptionsCard.decision_id` and
  `add_vote_options`, `live_url`, `display`, `get_option_details`, `place_info`). **A, B, C, E and F wait for these.**

## Build now
1. **Contract:** take Go's 1.2.0 files. Our overlay drops `visible_to_person_ids` (now official) and keeps check-in
   only. Use `already_booked` in place of the `approval_outstanding` detail.
2. **H, Go's ticket form:**
   - Record each person's pick on Go's cards (`option_picks`).
   - Grant a ticket approval when the person is in the trip (`not_in_trip` otherwise), has a pick within 30 minutes
     whose price × 1.05 ≥ the amount in the same currency (`payer_has_not_confirmed` otherwise), and no unused approval
     or confirmed booking exists for that pick.
   - Sign `for_person_id` + `kind: "ticket"`.
   - `add_booking` with that approval and no `decision_id`.
3. **D, K, I, L** as written above, with decisions 1, 5, 6 and 7.
4. Production is on `GO_CONTRACT=1.1` (set 11 Oct, owner's decision), since production Go reports 1.1.0. A fixed split is
   sent to Go as `expense.changed updated`.

## Bugs from the app (11 Oct): flight cards

**Bug 1:** of two flight cards, one ("Flights, Delhi to Srinagar") sends the person to ixigo.com, and the other
("Bengaluru to Srinagar, 3 options") opens the bottom sheet.
- The first is Go's **fallback notice card**: Go couldn't read ixigo's flights on its computer, so it posted a `notice`
  whose `source.url` is an ixigo search. The same fallback shows in our logs for stays ("Go can't read ixigo's stays
  from its computer right now").
- **Server:** nothing to fix: we pass Go's card through unchanged.
- **App:** draw a notice's `source` as a small link ("on ixigo"), not as a primary button with a lock. Only an
  `options` card opens the bottom sheet.
- **Go:** see `GO-TEAM-REV5-BUGS.md` G1.

**Bug 2:** choosing a flight in the bottom sheet posts a second card with only that one flight. Choosing it again
opens ixigo.com.
- Go answers the tap by posting a **new** `options` card with one option (its "personal confirm"), not by updating the
  card.
- The second tap probably ends at ixigo because **Go can't pay for a personal flight through the vault**:
  `request_spend_approval` needs a closed group vote with a mandate (`decision_id`), and a personal ticket has no vote
  (B7). The Server would deny it, so Go falls back to the ixigo link. *To confirm with Go (G3).*

### H. Personal spend approval (ours and Go's: fixes bug 2, also covers B8 seats and bags)
- **Contract:** `request_spend_approval` gains a personal form, used in place of `decision_id`:

  ```json
  { "request_id", "trip_id", "personal": { "person_id", "card_id", "option_id" }, "amount_minor", "currency", "merchant", "purpose", "refundable_until?" }
  ```

- **The Server records the traveller's own choice.** When a person taps a button on one of Go's `options` cards with
  an `option_id` (through `POST …/cards/:card_id/actions`), the Server keeps a row in `option_picks`: who, which card,
  which option, the option's price, and when. It does this before forwarding the tap to Go.
- **The Server grants the personal approval only when all of these hold:**
  - the person is in the trip;
  - the card is Go's and visible to them;
  - its `for_person_ids` and `only_for_person_ids` (or `visible_to_person_ids`) include them, or are absent;
  - that person picked that option within the last 30 minutes;
  - the currency matches;
  - `amount_minor` ≤ the picked option's `price_minor` (+5% for fare changes, an open question);
  - no other unused approval or confirmed booking exists for the same pick.
- The payer is always that person. The signed JWS carries `personal: { person_id, card_id, option_id }` in place of
  `decision_id`.
- `add_booking` accepts that `approval_id` with no `decision_id`, `for_person_ids: [person]`. The rest is unchanged.
- **Tests:**
  - a pick, then an approval, then a booking;
  - no pick, or someone else's pick, means denied;
  - a stale pick means denied;
  - over the price means denied;
  - a second approval for the same pick means denied;
  - a group-vote approval is unchanged.
- **Order:** right after D (internal routes), because it unblocks booking any flight in the app.

## More from the app (11 Oct): trip name, typing, pending items

### I. The trip's name follows its destination: "Hampi - 2026" (read-time only)
**Seen:** the destination is decided and saved in the trip (the room's chips show "Hampi ✓"), but the room is still
called "New trip".

**Change:** only the `title` field that `GET /app/v1/trips/:trip` (TripView) answers.
- When the stored title is still the default "New trip" and the trip has a destination, answer
  `title: "<destination.name> - <current year, IST>"`, for example "Hampi - 2026".
- When the destination changes, the next read shows the new name. The app already re-reads on `trip_changed`, which
  the destination change sends.
- Nothing is stored and no event is sent. A title a person or Go set is answered as stored.
- *To decide:* do the home card (`GET /home` `TripSummary.title`), the invite preview and Go's `read_trip` show the same
  name, or only the trip screen? See open question 5.
- **Tests:**
  - "New trip" with a destination: "Hampi - 2026".
  - No destination: "New trip".
  - A renamed trip: its own name.

### K. Log every error we answer Go with (production)
Production keeps no Go traffic log, and errors the Server answers to Go aren't printed, so a refused Go request is
invisible.
- Every JSON-RPC error the Server answers to Go is logged at `warn`, as one line: method, trip_id, request_id, code,
  message, and the field it named. No params, no names.
- The same for events Go refuses (that's already the outbox's `last_error`) and our requests Go fails.

### L. Home shows up to 5 pending items
**Seen:** the home card says "5 things pending on you" but lists none. The trip home's "Next up" is a fixed list (Pick
a place, Pick dates…), not the real items.
- **`GET /app/v1/home` gains:**

  ```json
  "needs_you": { "items": NeedsYouItem[] (≤ 5), "total": 7 }
  ```

  - These are the items from all my active trips, each also carrying `trip_id` and `trip_title`.
  - Order: a vote closing soonest; then a mandate waiting on me; then cards for me; then settle-up; then record lines
    due.
  - Each item keeps its own `target`, so a tap opens the vote, card or payment in its trip.
- The trip home keeps `GET /trips/:trip/needs-you` (all items) for "Next up". **App:** show those instead of the fixed
  list, and use the fixed hints only when there are no items.
- `home_changed` already fires when a vote, mandate or money item changes for a person. Check that it also fires when a
  card names them (`for_person_ids`) and when they vote, so the 5 stay fresh.
- **Tests:** two trips with mixed items → the top 5 in order, with `total`. A vote cast → it drops out and the next
  one appears.

### Typing when Go isn't tagged (Go's side)
The Server forwards every `typing` notification from Go to the room, with no condition (`src/requests/messages.ts`
`typing`). If no typing bubble shows when Go answers without being tagged, Go isn't sending `typing` then. See
`GO-TEAM-REV5-BUGS.md` G4. *Server: nothing to change.*

## Updated order of work
1. D: internal routes.
2. H: personal spend approval.
3. K: log Go errors.
4. I: auto title.
5. L: home pending.
6. A: votes on cards.
7. E: details.
8. C: pass-throughs.
9. B: ideas.

## 11 Oct, later: Go shipped contract 1.3, so the parked items resume
Production Go's `/v1/health` says 1.3.0. Go's 1.3 (go-brain `build`, `de37966d`) has every rev 5 shape, and Go has
built live view, the embedded vault (the vault's home only), `place_info` and `get_option_details`. Nothing in Go sends
`more_options` or calls `add_vote_options` yet.

**1.3 replaced 1.2's ticket form** (`kind: "ticket"`, `for_person_id`) with the personal form this plan first described
in H (`personal: { person_id, card_id, option_id }`), and added the denial reason `no_pick`. Go's vault refuses the old
claims, so the Server's H had to follow.

All five steps are built on branch `rev5-contract-1.3` (11 Oct), each reviewed; the record is
`docs/superpowers/build-logs/2026-10-11-rev5-contract-1.3.md`. Not merged or deployed yet.
1. Go's 1.3.0 files; H on the personal form; F (10 options).
2. C: the vault's `display` (embedded for its home only) and `live_url` kept on its card alone.
3. E: an option's Details on demand, kept an hour, never contradicting a replaced card.
4. B: idea photos from `place_info`, asked in the background once a day.
5. A: the vote on the options card; `add_vote_options` and `decision.options_added`.

Still to do once merged: a pass against the real Go, and migrations 015 and 016 on Supabase (they apply on deploy).
