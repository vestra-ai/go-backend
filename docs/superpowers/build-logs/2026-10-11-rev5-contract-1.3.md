# Build record: rev 5 on Go's contract 1.3

Branch `rev5-contract-1.3`, from `main` at `9264cbb`. Plan: `docs/SERVER-REV5-PLAN.md` (the section "11 Oct, later").
Asks sent to Go: `docs/GO-TEAM-REV5.md`, `docs/GO-TEAM-REV5-BUGS.md`.

## Authority
- 11 Oct 2026: Nishanth asked to reconcile and resume; after the reconciliation and the advisory review he answered
  "yes - let's go" to the proposed order (blocks B1 to B5 below). No push, merge or production change is authorized.
- Interim model lineup (Codex outage overlay): Opus 5.5 orchestrates and writes; a fresh Opus 5.5 session reviews the
  code; Fable 5.1 gives the final review. All at medium. One model family runs the whole chain: there is no
  cross-lab check.

## Reconciliation (11 Oct)
- `main` at `9264cbb` holds H, D, K, I, L and contract 1.2.0. 574 tests passed on the pulled code.
- Production Go `/v1/health`: `{"ok":true,"contract":"1.3.0"}`. Go's `build` head `de37966d`.
- Go's 1.3 removed 1.2's ticket form of `request_spend_approval` for the personal form. Verified: the Server's
  validator answered a personal-form request "kind is required".
- Not established: which Go commits after the 1.3 contract commit (`26171047`) run in production.

## Advisory review of the direction (not a build gate)
- Fable 5.1 (`claude-fable-5-1`, medium), session `e839ddc0-7a9f-4d27-a3ce-f6382433cbfc`, 248 s, read-only.
- Verdict: sound with changes. Adopted: 10 options and a test in B1; C before E and B; A last; `complete: false`
  handling in E and B; embedded vault is home-only.
- Its claims checked in the main loop against Go's `ask.ts`, `place-info.ts`, `vault-link.ts` and our `go.json`.

## Blocks
| Block | Outcome | Depends on | Status |
|---|---|---|---|
| B1 | Go's 1.3.0 contract files; personal spend approval in place of the ticket form; 10 options | none | done, committed |
| B2 | C: `live_url` passes through unlogged; `POST /me/vault-link` takes `display`, embedded for home only | B1 | done, committed |
| B3 | E: option details on demand, cached an hour when complete | B1 | done, committed |
| B4 | B: idea photos, daily refresh through `place_info`, partial answers never replace kept photos | B1 | done, committed |
| B5 | A: `OptionsCard.decision_id` checked on post, `add_vote_options`, `decision.options_added` | B1 | done, committed |

## B1 candidate
- Contract: `contract/go.json`, `socket.json`, `methods.json` are byte copies of go-brain `packages/contract` at
  `de37966d`; `src/contract/schema.d.ts` regenerated; overlay renamed `1.3.0+server-checkin`.
- Approval: `personalCheck`, `personalPickSql`, `issueApproval` (`src/domain/spend.ts`); `personalApproval`
  (`src/requests/money.ts`); claims carry `personal` (`src/contract/spend.ts`). No migration: `spend_approvals`
  keeps `for_person_id` and `pick_id`.
- Rules follow Go's guide and simulator. Differences kept on purpose: the price is the one recorded at the tap, the
  currency must match, and `already_booked` means a confirmed booking stands (a cancelled one frees the pick).
- Changed from the ticket build: a pick with no price fits no amount (was: any amount); the limit is floor, not ceil;
  the card must be the person's own.
- Known and accepted: `add_vote_options` is in the method table with no handler until B5 (answered `-32601`); Go does
  not call it yet. Go's JSON file does not restrict `Option.url` or `live_url` to https, so the Server does not either.

### Evidence
- `tsc --noEmit` clean. Full suite: 64 files, 577 tests passing (574 before; net +3 cases).
- Mutation proofs (each restored): no "their own card" condition → 1 test fails; any recent pick instead of the named
  card and option → 2 fail; no price limit → 1 fails; no "option still on the card" condition → 1 fails.
- Unit-test budget for the feature: 3 of 50 used.
- UI evidence: not applicable (no UI).

### Reviews
- **Opus 5.5 code review** (`claude-opus-5-5`, medium; effective effort not exposed), session
  `7650f98a-0bcf-4ae6-8c55-0d1f5b0fb826`, call 1 of 3, 140 s of 480. Verdict: APPROVE. Findings, all minor:
  1. Any per-option button counts as a pick. Accepted: same as Go's simulator; question for Go.
  2. A request naming both `decision_id` and `personal` passed the anyOf. Fixed: 422.
  3. `price_one_way` / `price_round_trip` are not kept with the pick. Accepted as an evidence gap; Go does not set them.
  4. Ownership is judged on the card as it stands. Tightened: message undeleted and the option still on the card.
  5. Guide says "visible only to them"; the simulator and the Server accept any private message naming them. Question for Go.
  6. Stale comments. Fixed.
  Unreviewed by it: `schema.d.ts` line by line, `socket.json` content, the two docs, 1.3's other widened shapes.
- **Fable 5.1 final QC** (`claude-fable-5-1`, medium), session `bca92339-b17f-4a43-bf24-468d5c8c97fe`, call 1 of 3,
  137 s of 480, on the candidate after the fixes above. Verdict: APPROVE. Findings, all minor:
  1. No Go-authored test vector covers `personal` claims. Evidence gap; key order cannot break Go's verification.
  2. CONTRACT-GO.md understated the "card as it stands" rule. Fixed (documentation only, after the verdict).
  3. `already_booked` sees only bookings that name an approval. Unchanged from the ticket build; same as Go's simulator.
  4. Same as Opus 5.
  Unreviewed by it: regenerating `schema.d.ts`; a Server-signed personal token against Go's production vault.

### Open with Go's team
- Which 1.3 behaviours are live in production.
- "Visible only to them" (guide) or any private message naming them (simulator)?
- A personal test vector for the signed claims.
- Round-trip and one-way prices on a pick; more than one per-option button.

### Not proven
- A real personal payment end to end against production Go and its vault.

## B2 candidate
- `POST /app/v1/me/vault-link` accepts `display` (`sheet` | `embedded`) and passes it to Go's `vault_link`. `embedded`
  with a `start` other than `home` is refused 422 `display` before Go is asked (Go would answer 409). The route now
  answers `cache-control: no-store` and is never kept for an Idempotency-Key replay.
- `live_url` reaches the app on its card (stored and served as it arrived) and is written nowhere else: dropped from
  every card that goes back to Go (`cardForGo` in `messageForGo`: the outbox's `message.created` and `message.edited`,
  and `read_messages`), and blanked in the opt-in traffic log (`LOG_GO_TRAFFIC`), an unreadable frame's text included.
- Docs: CONTRACT-APP and API (the vault row, the live view), CONTRACT-GO.

### Evidence
- `tsc --noEmit` clean. Full suite: 64 files, 580 tests passing (+3 cases; 6 of 50 used).
- Mutation proofs (each restored): no home-only check → the embedded test fails; no traffic-log blanking → its test
  fails; the card back to Go with its link → the outbox test fails; the idempotency record not cleared → the replay
  assertion fails.
- UI evidence: not applicable.

### Reviews
- **Opus 5.5 code review** (`claude-opus-5-5`, medium), session `602f3d83-3f85-49b4-a821-83c0eddd25ed`.
  - Call 1 (92 s): CHANGES REQUESTED. Major: `live_url` was kept in the outbox through `message.created`. Fixed at the
    mapper. Minor: an unreadable frame was logged unblanked. Fixed. Minor, pre-existing: the vault link was kept for an
    Idempotency-Key replay and had no `no-store`. Fixed for this route.
  - Call 2 (29 s): APPROVE. Minor: CONTRACT-GO did not say the card comes back without `live_url`: fixed. Minor: the
    text blanking stopped at an escaped quote: fixed.
  - 2 of 3 calls, 121 s of 480.
- **Fable 5.1 final QC** (`claude-fable-5-1`, medium), session `9588a247-9815-418e-8a54-a671a564e13a`, call 1 of 3,
  191 s of 480. Verdict: APPROVE. Minor: a vault-link answer stored under a key before this change is still replayed
  for up to 24 hours (transitional; recorded below). Minor: this record was behind the candidate (now updated). Minor:
  the text blanking only knows the JSON key form (accepted: test-only log, no such frame from Go).

### Follow-ups, not in this block
- The card tap route's `open` answer can carry a vault link and is still kept for replay when the app sends an
  `Idempotency-Key` (pre-existing). Owner's decision.
- Vault-link answers stored under a key before this change replay for up to 24 hours after deploy, then age out.
- Outbox rows written before this change may hold a live link Go already sent; such links expire after 15 minutes.

## B3 candidate
- `GET /app/v1/trips/:trip/cards/:card_id/options/:option_id/details` (`src/domain/option-details.ts`, route in
  `src/api/v1/cards.ts`): member only; the card must be Go's options card on an undeleted message the caller can see,
  and hold that option (404 otherwise, Go not asked). A whole answer kept in the last hour is served; otherwise Go is
  asked (`get_option_details`, with the caller's `person_id`) and a whole answer kept. `complete: false` is shown, not
  kept. Over the limit, or when Go cannot answer: the last kept answer, else the card's own details, both marked
  `complete: false`; with neither, the refusal. Go's 404 drops the kept row.
- `replace_card` deletes the card's kept rows in its transaction. An answer is kept only if the card's `updated_seq`
  is unchanged since the request began, checked with the message row locked `for share`, so a replace in flight is
  waited for.
- Migration `015_option_details.sql` (new table, RLS as 003; in the trip reset list). No change to existing rows.
- Its own limit, 10 asks of Go a minute per person per trip; a kept answer is free. The plan said "with the card
  taps": kept separate so that reading details never uses up a person's taps.
- Docs: CONTRACT-APP, API, CONTRACT-GO.

### Evidence
- `tsc --noEmit` clean. Full suite: 65 files, 585 tests passing (+5 cases; 11 of 50 used). One run showed a single
  failure in `tests/fake-go.e2e.test.ts` (an 8-second timing test, untouched here); it passed on three reruns.
- Mutation proofs (each restored): no visibility check → the 404 test fails; partial answers kept → the partial test
  fails; a kept answer never served → the caching and the limit tests fail; no delete on `replace_card` → the caching
  test fails; the `updated_seq` condition made always true → the caching test fails.
- The row lock itself is reasoned (by Fable, per interleaving), not exercised by a test.
- Migration: applies with 001 to 014 to an empty database (`tests/migration-rev4.test.ts`). Not run against Supabase.
- UI evidence: not applicable.

### Reviews
- **Opus 5.5 code review** (`claude-opus-5-5`, medium), session `dbabeaa0-4fba-43a1-921a-94708caed1bd`.
  - Call 1 (82 s): CHANGES REQUESTED. Major: kept details outlived a card replacement (fixed). Minors: Go's 404 treated
    as Go being down (fixed); 429 even with something to show (changed); room prices may lag a membership change
    (accepted, below); simultaneous first opens each ask Go (accepted).
  - Call 2 (23 s): APPROVE. New minor: an in-flight open could re-keep an old answer after a replacement (addressed
    with the `updated_seq` condition, then the row lock after Fable's finding).
  - 2 of 3 calls, 105 s of 480.
- **Fable 5.1 final QC** (`claude-fable-5-1`, medium), session `6d6708a0-8fae-40b4-a928-0aae9468565e`.
  - Call 1 (175 s): APPROVE. Minor: the `updated_seq` condition narrowed the replace race without closing it under
    read committed (fixed with `for share`). Minor: a stale route count in API.md (fixed).
  - Call 2 (28 s): APPROVE; the race confirmed closed, with its reasoning per interleaving.
  - 2 of 3 calls, 203 s of 480.

### Follow-ups, not in this block
- Rooms in a kept answer may reflect the trip's people as they were up to an hour ago.
- Several people opening the same unkept option at once each ask Go (bounded by the per-person limit).
- Kept rows for a deleted message stay until the trip is reset; they cannot be read.

## B4 candidate
- Migration `016_idea_photos.sql`: `ideas` gains `photos`, `best_months`, `refresh_tried_at`, `refreshed_at` (all
  nullable; no existing row changes).
- `src/jobs/ideas.ts` `refreshIdeas`: claims up to `max` ideas not asked about in 24 hours (marks them tried, `for
  update skip locked`), asks Go `place_info`, keeps a whole answer. Not run while the socket is down. Started from
  `startJobs` (one idea per 15-second round) with the Go socket passed from `main.ts`.
- `GET /discover/ideas` adds `photos` and `best_months`; `image_url` falls back to the first photo.
- Decision 2 of the plan (a static placeholder until Go answers): the app already keeps a fallback illustration when
  `image_url` is absent, so nothing was added.
- Docs: CONTRACT-APP, API, CONTRACT-GO.

### Evidence
- `tsc --noEmit` clean. Full suite: 66 files, 588 tests passing (+3 cases; 14 of 50 used).
- Mutation proofs (each restored): partial answers kept → the "keeps the photos it has" test fails; empty photos
  replacing kept ones → it fails; no once-a-day rule → the once-a-day test fails; asking while Go is down → it fails;
  not handing back an ask the socket dropped under → it fails; claiming one more than asked → it fails.
- Rule settled after review: a whole answer is Go's newest word and replaces what is kept field by field, even with
  fewer photos; only an answer with no photo at all leaves the kept photos.
- Migration: applies with 001 to 015 to an empty database in the suite. Not run against Supabase.
- UI evidence: not applicable.

### Reviews
- **Opus 5.5 code review** (`claude-opus-5-5`, medium), session `9e170cdf-70df-4cb2-ad6a-0e129815df9e`, call 1 of 3,
  98 s of 480. Verdict: APPROVE, six minors: (1) a whole answer with fewer photos replaces a fuller set: kept as the
  rule, wording corrected; (2) `photo_url` alone yielded nothing: now a single photo; (3) the claim might exceed
  `max` under some plans: materialized CTE and a test; (4) an oversized duration failed the update: not taken; (5) a
  socket dropping mid-ask spent the day's try: handed back when still down at the timeout; (6) a non-Go error
  abandoned the rest of a batch: the rest are still asked about.
- **Fable 5.1 final QC** (`claude-fable-5-1`, medium), session `f04573e2-a33b-4b55-8571-8a0847f84a39`, call 1 of 3,
  187 s of 480. Verdict: APPROVE, four minors: (1) a photo's `label: null` reached the app: now left out (applied
  after the verdict, as the reviewer described; covered by the first test); (2) docs said `image_url` is the first
  photo while a curated image wins: docs aligned; (3) the hand-back is narrower than its comment read: comment
  corrected; (4) a failed store after a whole answer costs the day's try: as designed.
  Unreviewed by it: `startJobs` driving the job on its timer through a real socket (type-checked only).

### Follow-ups, not in this block
- The owner may prefer "keep the larger set of photos" over "a whole answer wins".
- Go's photo links must not expire (asked in CONTRACT-GO).

## B5 candidate
- `add_vote_options` (`src/requests/votes.ts`, registered in `src/requests/index.ts`): only an open `choice` vote of
  the trip; at most 20 options in all; options kept raw and appended, so indexes continue and votes cast stay; emits
  `decision.options_added`; idempotent by `request_id`; the vote's row is locked while it grows.
- `post_message`: an `options` card carrying `decision_id` needs that vote open (422 otherwise). Other card kinds
  are unchanged.
- "Needs you": a `vote` item points at the newest message whose `vote` or `options` card carries the vote, and
  everyone's home is told when such an options card is posted or replaced.
- An added option whose `option_ref` the vote already has, or that repeats in the request, is refused 422. The
  open-vote check on a card holds the vote's row (`for share`) until the post commits.
- No change to the app's vote route: it already takes any index the vote has.
- Docs: CONTRACT-APP and API (how the app draws and casts a vote on the card, "see more"), CONTRACT-GO.

### The flaky end-to-end test, found and fixed here
- `tests/fake-go.e2e.test.ts` failed in 3 of 18 full runs on this branch and 0 of 18 at `9264cbb`; 0 of 10 alone.
- Cause: `tests/coverage.test.ts` proves the live listener reconnects by ending every backend whose query is `listen
  go_live`, in every database of the shared test Postgres, including the end-to-end server's. The tests added to that
  file in B2 moved the moment it fires onto the end-to-end test's message. Fixed by limiting it to
  `current_database()`. Test-only; no product code involved.
- After the fix: 1 failure in 47 full runs, a different cause (the end-to-end test got a 404 from `/me`: its "free
  port" was taken by another test's server between the check and the start). Older than this branch; left as is.
- Seen on the way, not changed: after the live listener reconnects, notices sent during the gap are not replayed to
  open sockets. Existing behaviour; a question for the owner.

### Evidence
- `tsc --noEmit` clean. Full suite: 67 files, 592 tests passing (+4 cases; 18 of 50 used).
- Mutation proofs (each restored): a closed vote taking options → the refusals test fails; no limit of 20 → it fails;
  options replaced instead of appended → three tests fail; a card carrying a closed vote → its test fails; needs-you
  ignoring options cards → its test fails; no home notice for a vote's options card → its test fails.
- UI evidence: not applicable.

### Reviews
- **Opus 5.5 code review** (`claude-opus-5-5`, medium), session `21274969-f846-4c13-b104-af4d17035c02`.
  - Call 1 (78 s): CHANGES REQUESTED. Major: home was not told when a vote's options card arrived (fixed). Minors:
    `replace_card` does not apply the open-vote check (kept: a card must stay replaceable after its vote closes); the
    check did not hold the vote's row (fixed); yes/no refused where Go's reference allows it (kept, stated in
    CONTRACT-GO); a repeated `option_ref` (fixed).
  - Call 2 (30 s): APPROVE. Residual, older than this block: `replace_card` checks none of the ids a card names.
  - 2 of 3 calls, 108 s of 480.
- **Fable 5.1 final QC** (`claude-fable-5-1`, medium), session `6c513f30-0d1e-4e59-8c98-74b228c1df74`, call 1 of 3,
  144 s of 480. Verdict: APPROVE. Three minors, none requiring change: the `replace_card` residual; the yes/no
  divergence from Go's simulator; the 20 limit counts the raw array while the other checks walk the checked params
  (equal today).

### Follow-ups, not in this block
- `replace_card` checks none of the ids a card names (vote, booking, expense), for any card kind.
- Go's guide and simulator allow `add_vote_options` on a yes/no vote; the Server answers 409.
- After the live listener reconnects, notices from the gap are not replayed to open sockets (existing behaviour).
- `tests/fake-go.e2e.test.ts` can still fail about once in 47 full runs on a port taken by another test.

## Where the feature stands (11 Oct 2026)
- B1 to B5 are committed on `rev5-contract-1.3`, each with an Opus code review and a Fable final review approving.
  Not pushed, not merged, not deployed: those are the owner's decisions.
- Assembled proof: the full suite on the final branch, 67 files and 592 tests, `tsc --noEmit` clean. 18 of the
  feature's 50 added test cases used.
- Not proven: anything against the real Go (a personal payment through its vault; `get_option_details`,
  `place_info`, an embedded vault link, a live view link, `add_vote_options` from Go's own code). Migrations 015 and
  016 have not been run against Supabase.
- One model family ran authoring, review and final QC (the Codex outage overlay): no cross-lab check.

## After the release: the deployment's name on the socket (branch `go-server-name`)
- What happened: the rev 5 deploy succeeded at 07:24Z on 11 Oct. The Server's socket instance (the container's
  hostname) changed and the Server sent no `server` name, so Go, which kept each trip with the instance that first
  spoke for it, could not reply in any older trip until its team patched Go (go-brain `4bb4e8fc`, prod 13:16 IST).
  Go's guide ("The socket", Good to know) asks for the name; this Server never sent it.
- Go's asks (11 Oct, 13:30 IST): add `?server=go-server-prod` to the socket URL; no Server redeploys during the demo.
- Candidate: optional `GO_SERVER_NAME`, checked (Go's characters, 64 at most), appended as `&server=`; a start-up
  line; `tests/config.test.ts`, an assertion in `tests/fake-go.e2e.test.ts`, the unset case pinned in
  `tests/main.e2e.test.ts`; DEPLOY, CONTRACT-GO, `.env.example`.
- Evidence: `tsc --noEmit` clean; 68 files, 595 tests passing (+3 cases; 21 of 50). Mutation proof (restored): the name
  not passed to the address → the end-to-end assertion fails. UI: not applicable.
- **Opus 5.5 code review**, session `abad3ab3-e9b9-41b2-8adf-978630e11c9b`, call 1 of 3, 94 s of 300: APPROVE. Four
  minors: DEPLOY should say what the first named deploy does (added); a shared default name in `.env.example`
  (per-developer placeholder); the unset end-to-end case inherited the shell's environment (pinned); only a log line
  when unset in production (kept).
- **Fable 5.1 final QC**, session `437fd97b-019e-4d52-b977-73da6f2b5fb3`, call 1 of 3, 99 s of 300: APPROVE; agrees
  with the reading of Go's side. Minors: the login prediction is unexercised on both sides; nothing but prose keeps
  staging's name different; the name is printed at start (not a secret).
- Both reviewers' reading of Go: on the first named connect, a trip follows the name from its next event; a quiet
  trip stays out of Go's reach until then (as after any deploy before); an organizer likely logs in to ixigo once
  more on their next new trip. After that, deploys change neither.
- **Not merged, not deployed.** Going live takes a merge to `main` and `GO_SERVER_NAME=go-server-prod` on Railway;
  both redeploy the Server, which Go's team asked us not to do during the demo. The owner decides when.

## Before the demo: Go's newest code against the Server's rules (branch `go-server-name`)
- Request (11 Oct): make the interactions between the Server, Go and the app seamless for the demo.
- Read in go-brain `a9a11d73`: the personal flight flow (`travel/taps.ts`, `booking/flight-booking.ts`, `money/ask.ts`),
  the vote on the card and "See more" (`travel/votes.ts`, `taps.ts`), `place-info.ts`, the live card.
- Found in step with the Server: Go redraws a person's own card with the picked option and keeps their name on it;
  a fare up more than 5% gets a new card to pick again; Go opens the vote before posting its card, gives each vote
  option the card option's id as `option_ref`, and "See more" adds only options not shown; the live link passes
  through (checked locally on the released code: room read, cards list and live frames).
- Changed:
  1. A room's card of tickets counts for a personal approval (`src/requests/money.ts`): Go books a room's flights card
     for whoever taps it, and the Server denied that `no_pick`. Only `flight`, `train`, `bus` cards with no
     `decision_id`; a card addressed to someone else is still refused.
  2. Idea photos (`src/jobs/ideas.ts`): an idea not yet answered in full is asked about again after an hour, not a
     day, and takes the photos a partial answer brings when it has none. Go was deployed after the Server on 11 Oct
     and marks a place partial while it lacks only its best months.
- Evidence: `tsc --noEmit` clean; 68 files, 596 tests passing (+1 case; 22 of 50). Mutation proofs (each restored):
  unanswered ideas waiting a day; partial photos overwriting kept ones; a card addressed to someone else accepted; the
  room's stays card accepted. Each fails a test.
- **Opus 5.5 code review**, session `7c927e08-87a3-4f58-a06b-beb5b8cd179b`, call 1 of 3, 84 s of 480: APPROVE. Minors:
  the room case not limited to ticket cards (now limited, with a test); hourly asks without end for a place Go never
  learns (accepted); a partial answer with no place (the contract check in `askGo` comes first); stale wording (fixed).
- **Fable 5.1 final QC**, session `4f713cbc-cc26-44d6-afec-ee256d3361c3`, call 1 of 3, 110 s of 480: APPROVE. Minors:
  a stale comment (fixed); no test for a literal null `for_person_ids`; Go may wait 30 minutes for an ixigo login and
  the pick also stands 30 minutes, so a slow login can end in `no_pick` and a second tap (not changed; in CONTRACT-GO).
- Not proven: any of this against the real Go.

## Storage
- Canonical: this file; the plan. Scratch (disposable, session `dcbcd553`): the session scratchpad under
  `/private/tmp/claude-501/…/scratchpad` (briefs, reviewer outputs, the read-only go-brain clone). Cleanup: pending (left in place; the
  session scratchpad is outside the repository).
