# Build record: the demo's payment (11 Oct 2026)

**Scope.** No real payment for the demo. The payer's Approve on a waiting `pay` card is taken as paid by the Server:
the card becomes paid, the booking and its expense are written, Go hears `payment.completed`. Spec for Go:
`docs/GO-TEAM-DEMO-PAYMENT.md` (agreed by Go's team the same day). Brief for the fake booking and ticket module:
`docs/DEMO-BOOKING-MODULE.md`. Branch `demo-mock-payment`.

**Process.** Short path, chosen by Nishanth for the demo: the flow described in the session stood as the design; one
independent review, then Fable's review at his request; no push to main or deploy without his say.

**Evidence.** `npm test`: 615 passing (71 files). New: `tests/demo-payment.test.ts` (9). Rewritten for the demo flow:
`flows.e2e` F4 steps 8-10, one `app.test` tap, `contract-overlay`.

**Reviews.**
- Independent review (fresh general-purpose session): no blockers; ready after should-fixes. Fixed: a vote or pick
  could be booked twice through two waiting cards; a lost race answered 409; the demo branch skipped the button
  check; Go's `add_expense` for a paid approval was accepted; three doc mismatches; test gaps (live notices, refusals).
- Fable 5.1 (`claude-fable-5-1`, requested effort medium, session `f342f117-5881-40dc-b45a-993422375e32`): first
  pass APPROVE AFTER FIXES (the module brief only); follow-up on the delta APPROVE. It did not run the suite.

**Known and left, all minor.**
- The "already booked" check is a read, not a lock: two waiting cards for one personal pick tapped within
  milliseconds could both book.
- The button check is made before the lock: a `replace_card` that removes the buttons but keeps the card waiting,
  racing the tap, would still pay. Go does not produce such a card.
- The trip's currency is not re-checked (the demo is all INR).
- A reaction on the pay card's message at the instant of the tap can deadlock one side, as with `replace_card`.
- The approval's ten minutes are not checked: the Server relies on Go expiring the card.

**Not yet established.** How production Go handles `payment.completed` (Go's team targets 10 pm IST, 11 Oct). If the
Server ships first and Go answers 422, that event is marked failed and never resent: Go would not learn of that
payment. Nothing here was run against production Go.

**Next.** Nishanth's say for merging to main and deploying; the fake booking and ticket module replaces the body of
`demoBookingFor`.
