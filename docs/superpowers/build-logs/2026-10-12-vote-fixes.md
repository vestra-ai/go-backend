# Two vote fixes: options 11 to 20 can be voted for; "chosen" in a trip of one

12 Oct 2026. Branch `fix/vote-index-20` (PR #1, opened by Keshav), target `main`.

**What was asked.** (A) Ankur, #go 23:45: Vote on an option that "See more" brought shows "option_index must be <= 9".
(B) Nishanth: in a trip of one, the closing line should not say "won · 1 vote"; "<option> chosen" instead.
Nishanth asked for both to be fixed and merged to main in this session.

**Process.** Small fixes, no separate spec or plan. Claude-led lineup (Opus 5.5 main session), as on 11 Oct; no Astra
orchestrator and no cross-lab reviewer took part.

**Candidate.**
- A: `castVote.option_index` maximum 9 → 19 (`src/api/bodies.ts`, Keshav's commit 3eba0cc); a test that the 20th option
  of a 20-option vote can be voted for and is counted, and that index 20 is refused (`tests/vote-on-card.test.ts`);
  the app docs say 0-19.
- B: `decidedText` reads "<label> chosen" when the decision's `of_count` is 1 at close (`src/domain/system-messages.ts`,
  `src/domain/voting.ts`); a test in `tests/system-messages.test.ts`; the app and Go docs name the new line.

**Evidence.** Full suite 71 files / 616 tests passed, typecheck clean (before the last docs-only edits; rerun after
taking main in, see the commit). Mutation proofs: cap back to 9 → the amended test fails "expected 422 to be 200";
`of === 1` disabled → the new test fails "Denpasar won · 1 vote". UI evidence: not applicable.

**Reviews.**
- Opus 5.5 code review of A (`claude-opus-5-5`, requested effort medium, session `d1810787-82e2-459e-89de-66a13cd1edfa`,
  1 call, 64 s): APPROVE. Acted on: docs still said 0-9; tally slot unchecked. Left: the literal 19 beside
  `MAX_VOTE_OPTIONS`.
- Opus 5.5 code review of B (session `39effada-917b-463a-b2f3-4a406d672d74`, 1 call, 62 s): APPROVE. Acted on: the Go
  contract and the close-endpoint rows named only "won".
- Fable 5.1 final review of both (`claude-fable-5-1`, requested effort medium, session
  `6e8104b6-1034-4bb0-a672-3c6653c0f9ae`, 1 call, 77 s): APPROVE, notes only.
Effective effort was not exposed by the CLI; recorded as requested.

**Known and left.**
- `of_count` can sit above the real head count when a sole member leaves and rejoins mid-vote (clamp in
  `src/domain/actions.ts`); the line then reads "won · 1 vote" as before. Older than this change.
- In a trip of one a cancellation vote reads "Cancel: Villa Sol chosen" and a yes/no vote "Scuba on day 2? Yes chosen".
- Whether Go or the app read the word "won" cannot be told from this repository.
- Closing a one-person vote by the close endpoint (rather than by the last vote) is not tested; it reaches the same line.
