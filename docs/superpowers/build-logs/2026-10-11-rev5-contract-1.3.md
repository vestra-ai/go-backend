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
| B4 | B: idea photos, daily refresh through `place_info`, partial answers never replace kept photos | B1 | not started |
| B5 | A: `OptionsCard.decision_id` checked on post, `add_vote_options`, `decision.options_added` | B1 | not started |

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

## Storage
- Canonical: this file; the plan. Scratch (disposable, session `dcbcd553`): the session scratchpad under
  `/private/tmp/claude-501/…/scratchpad` (briefs, reviewer outputs, the read-only go-brain clone). Cleanup: pending, the
  clone is needed for B2 to B5.
