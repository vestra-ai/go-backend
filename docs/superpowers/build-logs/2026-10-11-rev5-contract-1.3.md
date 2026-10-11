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
| B2 | C: `live_url` passes through unlogged; `POST /me/vault-link` takes `display`, embedded for home only | B1 | not started |
| B3 | E: option details on demand, cached an hour when complete | B1 | not started |
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

## Storage
- Canonical: this file; the plan. Scratch (disposable, session `dcbcd553`): the session scratchpad under
  `/private/tmp/claude-501/…/scratchpad` (briefs, reviewer outputs, the read-only go-brain clone). Cleanup: pending, the
  clone is needed for B2 to B5.
