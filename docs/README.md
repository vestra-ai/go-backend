# Documentation

Start with **[`../ARCHITECTURE.md`](../ARCHITECTURE.md)** (how the Server is built) and the two contracts below. Every
document here is labelled:
- **Current:** describes the system as it runs.
- **Guide:** how to run or deploy.
- **Record:** the history of decisions made with the other teams. Kept for the trail, not as the current design.

## Contracts (current)

| Document | What it is |
|---|---|
| [`CONTRACT-APP.md`](CONTRACT-APP.md) | **The App ↔ Server contract**: every route, request and response shape, live frame, error and rule the app relies on |
| [`API.md`](API.md) | The same app contract, plus "try it" curl examples, how to run locally, and **Appendix C: the index of all 71 routes** (checked against the code by a test) |
| [`CONTRACT-GO.md`](CONTRACT-GO.md) | **The Server ↔ Go contract**: the socket, the events, Go's requests and the Server's, the rules (ordering, exactly-once, privacy, money), built on Go's official contract 1.3.0 in [`../contract/`](../contract/) |
| [`GO-TEAM-DEMO-PAYMENT.md`](GO-TEAM-DEMO-PAYMENT.md) | The demo payment agreed with Go's team: Approve is taken as paid, and `payment.completed` is sent |
| [`DEMO-BOOKING-MODULE.md`](DEMO-BOOKING-MODULE.md) | How a demo booking and its ticket PDF are built from the option that was paid for |

## Changes for the App team (current)

| Document | What it is |
|---|---|
| [`changes_app.md`](changes_app.md) | What changed for the app since the rev 4 contract of 10 Oct |
| [`changes_app_demo.md`](changes_app_demo.md) | The newest changes: the demo payment, ticket PDFs and how to fetch them, booking privacy, and pending items |

## Guides

| Document | What it is |
|---|---|
| [`DEPLOY.md`](DEPLOY.md) | Deploying to Railway: every variable, Chromium for PDFs, and the post-deploy checks |
| [`SUPABASE-SETUP.md`](SUPABASE-SETUP.md) | Google sign-in, tokens, the database connection and the Storage bucket |
| [`REAL-GO-TESTING.md`](REAL-GO-TESTING.md) | How we test against the real Go (traffic log, `pnpm inspect`), and the early results |

## Records (history of decisions with Go's team)

These are the asks and answers, in order, that shaped the current contracts. Where a record and a contract disagree,
**the contract wins**.

| Document | Date | What it records |
|---|---|---|
| [`GO-CHANGES.md`](GO-CHANGES.md) | 8 Oct 2026 | The first proposal for contract 1.1 (most of it later shipped by Go as 1.1–1.3) |
| [`GO-TEAM-ASKS-REV4.md`](GO-TEAM-ASKS-REV4.md) | 10 Oct 2026 | The rev 4 simplification (one group budget, no approval steps, money in the room) |
| [`GO-TEAM-FINAL.md`](GO-TEAM-FINAL.md) | 10 Oct 2026 | The pre-launch check against production Go, and what Go then fixed |
| [`GO-TEAM-REV5.md`](GO-TEAM-REV5.md) | 11 Oct 2026 | Rev 5 asks: photo-led cards, 10 options, voting on the card, live view, embedded vault, stay details (shipped by Go as contract 1.3.0) |
| [`GO-TEAM-REV5-BUGS.md`](GO-TEAM-REV5-BUGS.md) | 11 Oct 2026 | Flight-card bugs, and the personal ticket approval |
| [`SERVER-REV5-PLAN.md`](SERVER-REV5-PLAN.md) | 11 Oct 2026 | How rev 5 was split between the Server, Go and the App, and the decisions taken |
| [`superpowers/build-logs/`](superpowers/build-logs/) | 11–12 Oct 2026 | Build logs for the demo payment, contract 1.3 and vote fixes |
