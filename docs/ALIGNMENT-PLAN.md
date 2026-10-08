# Server plan: align with the app contract (rev 3) and the Go changes (1.1)

## Status (8 Oct 2026)

| Phase | State | Commits |
|---|---|---|
| 0 Foundations | done | `c46d21f` |
| 1 Sign-in, Me, home, invites, trips, places | done | `728bdfe` |
| 2 The room, live WebSocket, uploads, cards, decisions | done | `02aa167`, merged `90f9f45` |
| 3 Money, settlements, expense approval | done | `bc8c87e`, merged `98c1b38` |
| 4 Bookings, documents, itinerary, needs-you v2, cards query, pushes | done | `c3fceba`, merged `9088a74` |
| 5 Web check-in, visa, task attention | done | `69ef776` |
| 6 Documents, Postman, deploy, real-Go pass | **in progress**: 6.1 (documents) done; 6.2 (Postman generation with the journey) in progress; 6.3 Railway variables and bucket, 6.4 the real-Go pass remain | — |

`pnpm test`: 470 tests in 52 files, green. The app-facing contract is now [`API.md`](API.md) (81 routes); the known
gaps are listed in [`REVIEW.md`](REVIEW.md).

---

**Written 8 Oct 2026, after the decisions in [`ALIGNMENT-REVIEW.md`](ALIGNMENT-REVIEW.md).** The two outward
documents, [`APP-CONTRACT-CHANGES.md`](APP-CONTRACT-CHANGES.md) and [`GO-CHANGES.md`](GO-CHANGES.md), are the
specification; this page is the order of work.

## Ground rules

1. **Break freely.** Nobody consumes the API yet. Every app route moves to `/app/v1/...` with the app team's names;
   the old `/app/...` routes are deleted, not kept.
2. **One source of truth for the app team.** `docs/API.md` is rewritten to follow the app contract's section numbers
   (§1 conventions … §4.14 places, §8 pushes) and lists **only the endpoints the app consumes**. Dev-only routes
   (dev sign-in) and operator tools live in the README, not in API.md and not in the app folders of Postman.
3. **Postman is generated, not hand-edited.** Every v1 route is registered with metadata (section, title, example
   body, example answers); `scripts/postman-build.ts` writes the collection from it, so Postman, API.md's index and the
   code cannot drift. The collection is pushed to the Postman "go-backend" workspace through the MCP at the end of
   each phase.
4. **Tests stay offline and green at the end of every phase** (embedded Postgres, mock Go, fake Supabase Auth). The
   dev stack runs with the fake Supabase Auth by default; the Postman journeys sign in through it locally and through
   Supabase test users against the deployed server.
5. **Go-dependent features are built now behind `features` flags** in `GET /config`; the mock Go gets the 1.1
   behaviour so our tests cover it; a flag flips to on when Go ships that item.
6. **Supabase Storage** for files; the service key exists only on Railway (`SUPABASE_SECRET_KEY`), never in `.env`
   on a laptop (local tests use an in-process fake storage).
7. **Never commit `.env`, keys or logs. Commit at the end of each phase; push when told.**

## Data model changes (one migration per phase, additive)

| Migration | Tables and columns |
|---|---|
| `004_v1_conventions.sql` | `idempotency_keys (person_id, method, path, key, body_hash, status, response, created_at)`; `people` + `email`, `auth_provider`, `from_city_default`, `notifications_enabled`, `deleted_at`; `trip_people` + `last_read_seq`; `invites (code, trip_id, created_by, created_at, revoked_at)` (the current `trips.invite_code` moves here); `invite_marks (person_id, code, state, at)`; `live_tickets (ticket, person_id, device_id, expires_at, used_at)`; `devices (device_id, person_id, platform, endpoint, keys, locale, tz, created_at)` replacing `push_subscriptions` |
| `005_v1_room.sql` | `uploads (upload_id, person_id, purpose, kind, mime, name, size_bytes, width, height, duration_s, path, used_at, expires_at)`; `messages` + `quick_replies`, `attachments` now may reference `upload_id` |
| `006_v1_money.sql` | `settlements (settlement_id, trip_id, from_person_id, to_person_id, amount_minor, currency, method, note, status, created_at, responded_at, seq)`; `expenses` + `status`; `expense_confirmations (expense_id, person_id, state, at, reason)` |
| `007_v1_bookings.sql` | `bookings` + `details`, `return_journey`, `passengers` (jsonb); `booking_documents (document_id, booking_id, name, mime, size_bytes, pages, visibility, path)`; `checkins (booking_id, person_id, state jsonb, status, updated_at)` |
| `008_v1_places.sql` | `places_cities (id, name, ascii_name, region, country, lat, lng, population)` loaded from a bundled GeoNames extract (India, population ≥ 15k); `ideas (idea_id, from_city, name, tag, travel_mode, duration_minutes, image_url, destination_hint, rank)` with a seed |

## Phase 0: foundations (everything else sits on this)

| Step | Work | Files |
|---|---|---|
| 0.1 | Router split: one file per contract section under `src/api/v1/` (`me.ts`, `home.ts`, `invites.ts`, `trips.ts`, `uploads.ts`, `messages.ts`, `cards.ts`, `decisions.ts`, `money.ts`, `bookings.ts`, `itinerary.ts`, `needs-you.ts`, `checkin.ts`, `you.ts`, `places.ts`, `config.ts`), each exporting `register(app, ctx)` plus the route metadata for Postman. `src/api/app.ts` becomes the shell: auth, CORS, error handler, request id, idempotency, then the section registrations | `src/api/app.ts`, `src/api/v1/*` |
| 0.2 | Error shape: `{ error: { code, message, field, retry_after_seconds, request_id } }`; 400 `bad_request` only for unreadable JSON; every body rule 422 `invalid` with `field`; `X-Request-Id` on every response (also in logs) | `src/api/errors.ts`, `src/domain/errors.ts`, `src/api/bodies.ts` |
| 0.3 | `Idempotency-Key` for every write: a preHandler that hashes the body, looks up `(person, method, path, key)`, replays the stored answer, refuses a different body with 422 `idempotency_key_reused`; stores the answer after the handler; 24 h sweep in `src/jobs`. Replaces the app-side `once()` calls (`client_id` keys go; `client_message_id` and `press_id` stay as domain keys) | `src/api/idempotency.ts`, `src/db/once.ts` (kept for Go requests) |
| 0.4 | Auth: `Me` needs `email`, `auth_provider`, `from_city_default`, `notifications_enabled` (first sign-in fills them from the Supabase claims); dev sign-in moves to `POST /app/v1/dev/sign-in` (AUTH_MODE=dev only) | `src/api/auth.ts` |
| 0.5 | `GET /app/v1/config` (`contract`, `min_client_version`, `currency_default`, `features`, `vapid_public_key`) and `GET /app/v1/health`; `FEATURES` from config/env with the defaults in the app document | `src/api/v1/config.ts`, `src/config.ts` |
| 0.6 | Test harness: `v1()` path helper, Supabase-token sign-in by default (fake auth), old path constants removed; the Postman generator skeleton | `tests/helpers/harness.ts`, `scripts/postman-build.ts` |
| 0.7 | Contract extension overlay for Go 1.1: `contract/extensions-1.1.json` adds the enum values and optional fields from `GO-CHANGES.md` (option_kind `cab`, card kind `checklist`, attachment `location`, vault start `add_documents`, event `settlement.recorded`, `expense.changed` change values, `card_tap.payload`, `get_checkin`/`submit_checkin`, `quick_replies`, …); `src/contract/validate.ts` merges it (additive only); the mock Go learns the new requests. The official 1.1 `go.json` replaces the overlay when Keshav publishes it | `contract/`, `src/contract/validate.ts`, `tests/helpers/mock-go.ts` |

Exit: `pnpm test` green with every existing test on v1 paths; `GET /config` and `/health` live; the Postman generator
emits an empty-but-valid collection.

## Phase 1: sign-in, Me, home, invites, trips (§4.1–4.4, §4.13, §4.14)

| Step | Endpoints | Domain work |
|---|---|---|
| 1.1 | `GET/PATCH /me`, `PUT/DELETE /me/upi`, `POST/DELETE /me/devices`, `DELETE /me` | `Me` with `counts`, masked UPI, `notifications_enabled` honoured by the push sender; account deletion sequence (`forget_person` everywhere → clear answers → leave trips → anonymise messages → wipe email/UPI) in `src/domain/account.ts` |
| 1.2 | `GET /home`, `GET /discover/ideas` | `TripSummary` with `stage`, `attention`, `photo_url`, `people_preview`; `InviteSummary` from `invite_marks`; `PastTripSummary.all_settled`; `home_changed` hook on every change that moves the home screen; ideas from the seeded table |
| 1.3 | `GET /invites/:code` (public, inviter, faces, `state`, 30/min/IP), `POST …/accept` (`landing`), `…/later`, `…/decline`, `POST /trips/:trip/invite/rotate` | `invites` table, `src/domain/invites.ts`; system message "Rahul joined" (D8) |
| 1.4 | `POST /trips` (all optional), `GET /trips/:trip` (`TripView`, `include`, ETag), `GET …/invite`, `POST …/leave`, `PUT …/me/join-answers` (vibe → `know`, spend_band → budget), `PUT/DELETE …/me/budget`, `PATCH …/me {go_paused}`, `POST …/read`, kept `PATCH /trips/:trip`, `cancel-vote` | `stage` rule in `src/domain/stage.ts`; `TripView.me/chat/needs_you_count/can`; `from_city`/`earliest_leave` hidden from other members (D5) in `readSnapshotForApp`; `last_read_seq` → `unread_count` |
| 1.5 | `GET /me/go`, `PATCH /me/go`, `DELETE /me/go/facts/:id`, `DELETE /me/go?trip_id=`, `POST /me/vault-link` | renames only |
| 1.6 | `GET /places/cities`, `GET /places/cities/top` | migration `008` seed, accent-insensitive match, 5/s/person |

Tests: `people-*.test.ts` moved and extended (home states, invite later/decline/rotate, `stage` transitions, private
`from_city`, account deletion). Postman: sections 4.1–4.4, 4.13, 4.14 generated.

## Phase 2: the room, live, uploads, cards, decisions (§3, §4.5–4.8)

| Step | Endpoints | Domain work |
|---|---|---|
| 2.1 | `POST /live/ticket`, `GET /live` WebSocket: `hello`, `subscribe`/`unsubscribe` with replay (messages after `since_seq` + one `trip_changed`, `resync` above 200), `message`, `card`, `typing` both ways, `trip_changed` with `kinds`, `home_changed`, `ping`/`pong`, 4401; one socket per (person, device), 50 trips | `src/live/ws.ts` on `@fastify/websocket`; the existing LISTEN/NOTIFY fan-out feeds it; SSE removed |
| 2.2 | `GET /trips/:trip/messages` history mode (`before_seq`) + changes mode; `POST …/messages` (`client_message_id`, `upload_id` attachments, `201 Message`); `PUT …/reaction` (one per person); `PATCH`/`DELETE` returning `Message`; `GET …/catch-up` → 200/204 | `src/requests/messages.ts`, `src/domain/actions.ts`; signed attachment URLs minted on read |
| 2.3 | `POST /uploads` (Supabase Storage signed upload URL; size/MIME checks; 24 h expiry sweep) | `src/storage/supabase-storage.ts` + an in-memory fake for tests |
| 2.4 | System messages (D8): trip created, joined, left, decided, booked, person-opened vote anchor; a change number, no event | `src/domain/system-messages.ts` |
| 2.5 | `replace_card` moves `updated_seq` with no event (D9) | `src/requests/messages.ts` |
| 2.6 | `POST /trips/:trip/cards/:card_id/actions` (`press_id`, `payload` pass-through, timeout → `refused` toast); `go://` untouched | `src/domain/ask-go.ts` |
| 2.7 | `GET …/decisions/:id` (+`my_vote`), `POST …/decisions` → `{decision, message}`, `PUT …/vote` (+`flexible` behind `features.vote_flexible`), `DELETE …/vote` (behind `features.vote_retract`), close (organizer/opener + auto), cancel, mandate confirm/decline; `GET …/record` (+`include_undone`), undo, redo | `src/domain/voting.ts`, `votes-bookings.ts` |
| 2.8 | `quick_replies` stored and returned; `location` attachments and `duration_s` accepted from Go | pass-through via the overlay |

Tests: `room.test.ts`, a new `live-ws.test.ts` (replay, resync, two devices, ticket reuse), `uploads.test.ts`,
`system-messages.test.ts`, decisions extended. Postman: 4.5–4.8 (the WebSocket is documented in API.md §3 with a
`wscat` example; Postman cannot drive it).

## Phase 3: money, including expense approval (§4.9)

| Step | Endpoints | Domain work |
|---|---|---|
| 3.1 | `GET /trips/:trip/money` (`MoneyView` with `me.budget` range, `by_category`, `owed_to_me`, `i_owe`) | `src/domain/money.ts`, `settle-up.ts` |
| 3.2 | `GET …/transactions` (`filter`, cursor, `total_count`, `expense_status`) | `src/domain/transactions.ts` |
| 3.3 | `POST …/settlements`, `…/confirm`, `…/dispute`; provisional counting; push `settlement`; `settlement.recorded` to Go on confirm (behind the overlay) | `src/domain/settlements.ts` |
| 3.4 | `POST …/transfers/pay-link`, `POST …/transfers/nudge` | rename of settle-up/nudges; `upi://` builder |
| 3.5 | Expense approval (D6): `Expense.status` + `confirmations`; `POST …/expenses` (payer defaults to me), `…/approve`, `…/dispute`, `DELETE`, `PATCH` (fix split resets changed shares); disputed expenses left out of transfers; `needs-you` `expense` items; push `expense`; `add_expense` from Go → pending unless `approval_id`; `expense.changed` approved/disputed | `src/domain/expenses.ts`, `src/requests/money.ts`, `needs-you` |

Tests: `money.test.ts`, `settle-up.test.ts` extended; new `settlements.test.ts`, `expense-approval.test.ts`
(acceptance scenario 21). Postman: 4.9.

## Phase 4: bookings, documents, itinerary, trip home, calls (§4.10, §4.11)

| Step | Endpoints | Domain work |
|---|---|---|
| 4.1 | `GET /trips/:trip/bookings`, `GET …/bookings/:id` with the covered-people rule for `passengers`/`documents`; `POST …/bookings`, `PATCH …/bookings/:id` kept | `src/domain/bookings.ts` |
| 4.2 | `GET …/bookings/:id/documents/:doc` → 302 signed URL (10 min); on `add_booking` the server copies each `documents[].url` into Storage | `src/storage`, `src/requests/trip.ts` |
| 4.3 | `GET …/itinerary?scope=everyone\|me` (`me` filters by `person_ids`/`audience` and adds my bookings' wording once Go sends them; until then everyone's) | `src/domain/itinerary.ts` |
| 4.4 | `GET …/needs-you` v2 (`NeedsYouItem` with `settle_up`, `expense`, `checkin`, `title/subtitle/cta_label/since/target`) | `src/domain/actions.ts` |
| 4.5 | `GET …/cards?kind=&state=` (latest version per card) | `src/domain/cards.ts` |
| 4.6 | Calls behind `features.calls`: `listen` action pass-through, `recording_url`/`duration_s` on the card, `POST …/cards/:card_id/share` (server copies the recording into Storage and posts the message) | `src/domain/cards.ts` |
| 4.7 | Pushes: payload `{type, trip_id, message_id, title, body, deep_link, tag}`; new types `settlement`, `nudge`, `joined`, `expense`, `checkin`; `notifications_enabled` and the device table | `src/push/*` |

Tests: `people-bookings.test.ts` extended (privacy rule, documents), new `itinerary.test.ts`, `cards.test.ts`,
`web-push.test.ts` extended. Postman: 4.10, 4.11, 8.

## Phase 5: web check-in and visa (§4.12, §9.8, §9.12)

| Step | Endpoints | Domain work |
|---|---|---|
| 5.1 | `GET …/bookings/:id/checkin`, `PATCH …/checkin`, `POST …/checkin/complete`, behind `features.checkin`; Server → Go `get_checkin` / `submit_checkin` (2 s, `working` allowed, finished by event or `replace_card`); paid seat → `payment_required` and the vault flow; `needs-you` `checkin`, `attention.task`, push `checkin` | `src/domain/checkin.ts`, `src/domain/ask-go.ts`, mock Go handlers |
| 5.2 | Visa: `vault_link.start: "add_documents"` (+`context`), `checklist` cards pass-through, `attention.task` for a pending row of mine | `src/api/v1/you.ts`, `needs-you` |
| 5.3 | `claim`: nothing to build; a test proving two simultaneous `claim` taps reach Go with distinct `tap_id`s | tests only |

Tests: new `checkin.test.ts`, `visa.test.ts`. Postman: 4.12.

## Phase 6: documents, Postman, deploy

| Step | Work |
|---|---|
| 6.1 | `docs/API.md` rewritten in the app contract's structure, app-consumed endpoints only, every `ℹ️`/`🔁`/`➕` from `APP-CONTRACT-CHANGES.md` folded in; `docs/REVIEW.md`, `README.md`, `DEPLOY.md` updated (Storage variables, flags) |
| 6.2 | Postman: generated collection with folders per contract section plus **Journeys** (sign in → create trip → invite → chat → vote → book → money → check-in) using fake-Supabase tokens locally and test users remotely; environment updated; pushed to the Postman "go-backend" workspace through the MCP; `pnpm postman` runs the journeys with newman |
| 6.3 | Railway: `SUPABASE_SECRET_KEY` (Storage) and `FEATURES_*` variables (set by a person in the Raw Editor); a private Storage bucket `go-files` created in the Supabase project; deploy; the checks in `DEPLOY.md` |
| 6.4 | A real-Go pass with `pnpm dev:real` on the flows that touch Go (taps with `payload`, person-opened votes, settlements once Go accepts the event) and `REAL-GO-TESTING.md` updated |

## Order and parallelism

Phase 0 first, alone (everything depends on it). Phases 1, 3 and 4 touch different modules and can run in parallel
in worktrees once Phase 0 is in; Phase 2 touches `messages`/`live` which Phase 4's cards query reads, so it goes with
or before Phase 4. Phase 5 last, then 6. Suggested: 0 → (1 ‖ 2) → (3 ‖ 4) → 5 → 6, with one agent per parallel phase
and the fixes merged by me, as in the real-Go round.

## Sizes

| Phase | Size | Why |
|---|---|---|
| 0 | M | mostly mechanical, but it touches every test |
| 1 | M | home and invites are new; the rest are renames and small additions |
| 2 | L | the WebSocket and uploads are new subsystems; history mode and system messages are careful work |
| 3 | M | settlements and expense approval change the money maths |
| 4 | M | documents and the privacy rule; the rest is queries |
| 5 | M | check-in is new state with a two-step Go request |
| 6 | S–M | generation and docs |

## What is **not** in this plan

- iOS/Android push tokens (the product is a PWA).
- Virus scanning of uploads; EXIF stripping (later).
- A per-trip mute for pushes (later).
- Go's own work (groups A–C in `GO-CHANGES.md`); ours is the pass-through and the flags.
