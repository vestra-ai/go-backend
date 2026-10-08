# Alignment review: the app's designs, the app team's contract, and what Go must change

**Status: reviewed with Rahul on 8 Oct 2026; decisions in part 1 are final.** The outward documents are
[`APP-CONTRACT-CHANGES.md`](APP-CONTRACT-CHANGES.md) (to the app team) and [`GO-CHANGES.md`](GO-CHANGES.md) (to Go's
team); the build plan is [`ALIGNMENT-PLAN.md`](ALIGNMENT-PLAN.md). Nothing here is built yet. Sources: the "Frontend alignment with server"
PDF (21 pages, 27 screens), the design canvas "Go — Group Trip Agent" (prototype page, 13 journeys), the app team's
"App ↔ Server API contract v1 draft rev 2" (1,288 lines), `llms-full.txt` (Server ↔ Go, 1.0.0, unchanged) and our
server as deployed (`docs/API.md`, 47 endpoints).

Marks used below:

| Mark | Meaning |
|---|---|
| ✅ accept | Take the app team's endpoint or rule as written |
| 🔧 accept with changes | Take it, with the change and the reason given |
| ⛔ push back | We don't do it this way; the reason and our alternative are given |
| 🔶 needs Go | Can't be finished without a change on Keshav's side (see part 5) |
| 🟢 have | Already in our server today, possibly under another path |

Numbers: the app contract has **73 endpoints plus one WebSocket**. We have **36** of them today in some form,
**27** are new server-only work, **10** can't be completed without Go, and we push back on **5** (three of which are the
`/auth/*` routes, replaced by Supabase).

---

## 1. Decisions (final)

Decided on 8 Oct: D1, D3, D5, D8, D9 as recommended; **D2** Supabase, with the pushback written into the app-team
document; **D4** Supabase Storage (not a Railway bucket); **D6** expense approval is **built now** and its endpoints
are sent to the app team; **D7** check-in, calls and visa are **built now** on the server (behind flags), sent to
Keshav's team, and the missing app endpoints sent to the app team. Several stays per trip and per-person tickets are
also in scope and in the app-team document. The table keeps the reasoning.

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | **Paths and names.** Adopt the app team's paths under `/app/v1/...` and rename ours, or keep ours and let the app adapt? | **Adopt theirs.** | Nobody consumes our API yet. Their naming is REST-clean and their document is already the one the app is built from; one document for both teams beats two with a mapping table. Cost: a mechanical rename across routes, tests and the Postman collection, done once, in the same pass that rewrites home/money/invites/live anyway. |
| D2 | **Sign-in.** Their `/auth/google`, `/auth/refresh`, `/auth/logout` with our own refresh tokens and an httpOnly cookie, or Supabase Auth as built? | **Supabase Auth, push back on `/auth/*`.** | Built, tested against the real project, deployed, and the admin team is enabling Google in it now. It removes a whole security surface from our server (refresh-token rotation, cookie CSRF routes). `supabase-js` does Google sign-in, refresh and sign-out in the PWA. What stays identical for the app: `Authorization: Bearer <access token>`, and "401 → refresh once". Where the refresh token lives in the browser becomes the app's choice (`@supabase/ssr` keeps it in cookies for Next.js if they want that). |
| D3 | **Live connection.** Their one WebSocket per app (ticket, `subscribe`, replay) or our SSE stream per trip? | **Switch to their WebSocket, simplified.** | One socket serves the home screen and every open trip, and carries typing upstream. We already run `ws` for Go. Simplification: on `subscribe` we replay changed messages and send **one** `trip_changed` with the current `seq`, instead of replaying every change; the app re-reads what moved. SSE goes away. |
| D4 | **File storage** for photos, voice notes and ticket PDFs: a Railway bucket (S3 API) or Supabase Storage? | **Decided: Supabase Storage** (one vendor; private bucket, signed upload and download URLs; the server holds the service key on Railway only). | — |
| D5 | **"Travelling from" privacy.** The design says "Only you and Go see this"; the contract (and `llms-full.txt`) make `from_city` group-visible on `Person`. | **Hide it from other members in the app; Go keeps it.** | Server-side filter, five lines. Go needs it to plan routes and will say "everyone lands between…" anyway, which is the group-level summary the design wants. The app team must drop it from the member list. |
| D6 | **Expense approval.** PDF page Z asks for an approval by the people in a split when an expense is added by hand or by Go ("on the home page and beside each expense"). It's **not in the app contract**. | **Decided: build it now.** `Expense.status` + `confirmations`, approve/dispute endpoints, "needs you" and push, disputed expenses left out of transfers; Go's `add_expense` creates pending expenses. Specified in `APP-CONTRACT-CHANGES.md` §4.9 and `GO-CHANGES.md` 2.5. | — |
| D7 | **Go-heavy features**: web check-in (seat map, boarding pass), listening in on calls and call recordings, visa documents. | **Decided: build the server side now, behind `features` flags**, and send the Go side to Keshav's team (groups B and C). | The flags flip on the day Go's side ships; the app builds against the final shapes from day one. |
| D8 | **Server-authored messages** (`author: {kind: "system"}`): join/leave pills, "Diwali won" pills, and the anchor message that carries the vote card for a **person-opened** poll. | **Yes, with Keshav's confirmation.** | Deterministic (today Go posts no card for person-opened votes). They take a change number but **no event to Go** (Go already got `person.joined` / `decision.opened`). Go must tolerate `author.kind = "system"` in `read_messages`. |
| D9 | **Replaced cards and offline phones.** A `replace_card` takes no change number, so a phone that was offline can't fetch it with `after_seq`. | **Give it a change number on our side, no event.** | Fixes our known gap for good. Needs a one-line nod from Go: its own `read_messages` may then return a card it replaced itself. |

Everything else below is settled by the documents and I've marked it accordingly.

---

## 2. Feature map: the designs, screen by screen

From the PDF (letters A–Z) and the prototype page. "Server" = our work only. "Go" = can't ship without Keshav's team.

| PDF | Screen | What it needs from the server | Status |
|---|---|---|---|
| A | Welcome, Continue with Google | Supabase Google sign-in; token check | 🟢 have (D2) |
| B | App home, first run: hero, "Ideas for your crew · From Bengaluru", "Not sure where? Ask Go" | `GET /home` (empty), `GET /discover/ideas` (curated list by origin city), `POST /trips` | new, server |
| B | App home, returning: invites (Accept/Decline), trip cards with photo, dates, "in 34 days", faces, status line, past trips | `GET /home` with computed `attention` and `stage`; `home_changed` frame | new, server |
| C | Who's coming: invite link, Copy, Share in WhatsApp, crew list updating live | 🟢 invite link; live `trip_changed kinds:["people"]` | 🟢 + live (D3) |
| C | Friend taps the link: preview behind a sheet, "Rahul invited you · Rahul, Priya and 1 more are in", Accept & join, Not now | `GET /invites/:code` (public, with inviter + faces), `accept`, `later` | 🟢 preview/accept; new later/decline |
| D | Profile: name, email, Travelling from (default), "1 active · 2 past · 1 invite", Payment methods (UPI, cards via vault), Trip notifications switch, Sign out | `GET/PATCH /me` with `counts`, `has_upi`, `upi_id_masked`, `notifications_enabled`; vault link `add_card` | 🟢 partly; extend |
| E, F | Trip chat landing (creator vs joiner), fact chips Where/When/Stay/Budget/From, Quick start sheet (vibe, spend band, from city), city search | `TripView` (chips are client-derived), `PUT …/me/join-answers`, `GET /places/cities` | 🟢 answers; new places |
| G | Long-press: reactions, Reply, Ask Go, Copy | 🟢 reactions/reply/about_message_id; one reaction per person (🔧) | 🟢 |
| H | Chat with Go replying when it wants, quick-reply chips, "next step" pills | messages + live; `quick_replies` on Go's messages | 🔶 9.3 (pass-through on our side) |
| I | Place details sheet (hero, why Go picked it, rough cost, things to do, Vote) | option `details` on `DecisionOption`/`Option` | 🔶 9.1 (pass-through) |
| J | Budget ask card → Budget sheet (₹5k–60k slider, private) | 🟢 `PUT …/me/budget`, summary band, `by: system`; `go://` button link | 🟢 + 🔶 9.4 |
| K | Dates poll (fit tags, countdown, "I'm flexible") | 🟢 votes; flexible vote | 🟢 + 🔶 9.6 |
| L | Stay suggestions + stay details (rating, amenities, total for 4, your share, cancellation) | options card + `details` | 🔶 9.1 |
| M | One person books for all: "I'll book it" (first tap wins), others see "Rahul is booking"; Watch; booked card; "Added to trip money · split 4 ways · Fix split" | `claim` card action; mandate; pay card → vault; expense card; `PATCH expenses/:id` | 🟢 mandate/pay/expense; 🔶 9.14 claim; new fix-split |
| M | Several stays in one trip (2 + 2 + 3 nights) | nothing new: bookings are rows; the itinerary places them | 🟢 |
| N | Travel ask → Route sheet (one way / round trip, flight/train/bus, filters, time slots) → Book → "Who lands when" | options cards with `only_for_person_ids` (🟢); `return_journey`, prices, `pick` payload; `checklist` card for who-lands | 🔶 9.2, 9.8 |
| O | Cab from airport to stay (one way / both, Sedan/SUV) | `option_kind: cab` | 🔶 9.2 |
| P | Just-for-me: my flight, seat, PNR, Open ticket PDF; nobody else sees my ticket | per-person fields on `Booking` and signed document links; **server rule: `passengers[]`/`documents` only to the people covered** | 🔶 9.9 + server privacy rule |
| Q | "Can you sort the whole plan?" → plan card → itinerary | 🟢 itinerary from `update_trip`; `plan`/`day` cards; `Day.image_url` | 🟢 + 🔶 9.10 |
| R | Header widgets (destination, dates, stay, budget, my flight) updating as the trip is decided | client-derived from `TripView` + record + my bookings | 🟢 |
| S | International trips: passport details, e-visa, status card ("Sent / Started / Not yet") | vault `add_documents` page; `checklist` card. **Passport data never touches our server** | 🔶 9.8 |
| T | Trip board: Where/When/Stay/Budget/Travel rows with Change/Vote/Ask Go, spend vs budget bar | `TripView` + `GET …/record` + `GET …/money`; row buttons deep-link into chat | 🟢 data; new `GET /record`, `GET /money` |
| U | Trip home zero state: "0 of 5 decided", Next up rows | `stage = new`; static copy on the client | new `stage` |
| V | Go calls the villa/airline: live call cards, Ask Go to call form, listen in, recording with transcript | `call` cards (🟢), `GET …/cards?kind=call`; recording/listen-in | 🟢 + new query + 🔶 9.5 |
| W | Web check-in: details, DigiYatra, seat next to a friend (paid seat via vault), boarding pass | whole domain | 🔶 9.12 (phase 3) |
| X | Itinerary: map + list, Everyone / Just me, route lines, face stacks, MINE/SHARED/GROUP badges | `GET …/itinerary?scope=`; `person_ids`/`audience` on items | new + 🔶 9.10 |
| Y | Bookings tab: ticket cards, counts, Ticket PDF viewer (Save, Share to group) | `GET …/bookings`, signed document links, share = message with file | new + 🔶 9.9 |
| Z | Expenses: Everyone / Just me, stay/travel tiles, settle up (Record, Nudge), transactions with filters, Record a payment (payee confirms), categories, **approval of added expenses** | `GET /money`, `GET /transactions`, settlements with confirm/dispute, nudge (🟢), `POST /expenses` (🟢) | new; approval = D6 |

Things the designs show that the app contract **doesn't** say, and that I've folded in above: the PWA (not Flutter);
"Travelling from" shown as private (D5); several stays per trip; per-person tickets; expense approval (D6); the trip
board; call recordings; check-in. Nothing in the designs contradicts `llms-full.txt`.

---

## 3. The app contract, endpoint by endpoint

Paths are the app team's (under `/app/v1`, per D1). "Ours today" names the current route when one exists.

### 3.1 Conventions (§1)

| Rule | Verdict | Notes |
|---|---|---|
| Base `/app/v1`, JSON, additive versioning | 🔧 | Adopt the prefix (D1). Base host is our Railway address, not `api.<env>.go.example`. |
| CORS: exact origins, `Authorization`, `Idempotency-Key`, `X-Go-Client`, credentials | 🔧 | We already allow-list exact origins (`APP_ORIGINS`). Add `Idempotency-Key`. **No credentials and no `X-Go-Client`**: there is no cookie (D2). |
| §1.2 Authentication: `/auth/google`, refresh rotation, httpOnly cookie, CSRF rules | ⛔ | Supabase Auth (D2). Person keyed by the Supabase user id (their `sub` principle, kept). `is_new` → `Me.created_at` (or compare with the first `GET /me`). |
| Every trip route: member now, else 403; unknown trip 404 | 🔧 | Both are **403**, as today. Their own goal ("never reveal that a trip exists") is only met when the two cases answer the same; 403 also tells a person who left why. |
| Ids, money (`_minor`), times, `snake_case`, null = missing | ✅ | Identical to ours. |
| `Idempotency-Key` header on every write, 24 h, scoped `(person, method, path)`, repeat → first response, different body → 422 `idempotency_key_reused` | 🔧 | Accept as **the** mechanism, replacing our per-route `client_id` (same table, generic). Keep `client_message_id` on messages (the "sending" bubble needs it) and `press_id` on card taps (it becomes Go's `tap_id`). |
| Error body `{error:{code,message,field,retry_after_seconds,request_id}}`; 400 `bad_request` only for unparseable JSON, 422 `invalid` for every rule; `X-Request-Id` on every response | 🔧 | Adopt. Our older routes answer 400 `invalid` for limit breaks; they move to 422. `go_unavailable` stays 502/504. `503 unavailable` stays for push-not-configured. |
| Pagination: cursors for transactions, `before_seq`/`after_seq` for messages; `seq` consistent per read; ETag on `GET /trips/:id`; `Cache-Control: private, no-store` on lists | ✅ | `before_seq` (history mode) is new on our side; the rest we do or is cheap. |
| §1.7 privacy rules | ✅ | All already enforced. Two additions from the designs: `from_city` hidden from other members (D5); `Booking.passengers`/`documents` only to the people a booking covers. |

### 3.2 Object shapes (§2)

| Shape | Verdict | Notes |
|---|---|---|
| `Me` | 🔧 | `auth_provider` is `"google" \| "email"` (email = Supabase test users; the app shows "Signed in with Google" only for google). `from_city` default, `has_upi`, `upi_id_masked`, `notifications_enabled`, `counts`: accept. |
| `TripSummary` | 🔧 | One `photo_url` (the destination photo Go sets in `update_trip`), not `cover_url` + `hero_url` + `illustration_url`: we have one image. The illustration/avatar is the client's (by destination or vibe). `attention` and `stage`: accept, server-computed. |
| `InviteSummary`, `PastTripSummary`, `Idea` | ✅ | |
| `TripView` | ✅ | = our `TripSnapshot` + `stage`, `me`, `chat`, `needs_you_count`, `can`. We keep our app-only `Decision.cancels_booking_id`. |
| `NeedsYouItem` | ✅ | Replaces our `{kind, text, …}` items; adds `settle_up`. |
| `Transaction`, `Settlement` | ✅ | |
| `MoneyView` | 🔧 | `me.budget_minor` becomes `me.budget: {min_minor, max_minor}` (the budget is a range everywhere else in their own doc; the bar uses `max_minor`, or `min_minor` when there is no max). |

### 3.3 The live connection (§3)

| Item | Verdict | Notes |
|---|---|---|
| `POST /live/ticket` (30 s, single use), `GET /live?ticket=`, close `4401` | ✅ | D3 |
| Frames `hello`, `message`, `card`, `typing`, `trip_changed` (+`kinds`), `home_changed`, `resync`, `ping`/`pong` | ✅ | `card` frame: see D9 (we also give it a change number so it is fetchable later). |
| `subscribe` with `since_seq`, replay up to 500 frames else `resync` | 🔧 | On `subscribe` we send the messages changed after `since_seq` (same query as `after_seq`, up to 200, else `resync`) and **one** `trip_changed` with the current `seq`. Same effect, less state. |
| `unsubscribe`, `typing` (1 per 2 s, never to Go), `pong` | ✅ | |
| Writes over HTTP only | ✅ | |
| Limits: one socket per (person, device), 50 trips, 1 MB | ✅ | |
| Our SSE `GET /trips/:id/live` | — | Removed. |

### 3.4 Sign-in, session, Me (§4.1)

| Endpoint | Verdict | Ours today | Notes |
|---|---|---|---|
| `POST /auth/google` · `/auth/refresh` · `/auth/logout` | ⛔ | Supabase | D2. Sign-out = `supabase.auth.signOut()` on the client plus `DELETE /me/devices/:id` for the push registration. |
| `GET /me` | 🔧 | `GET /app/me` | Extend to the `Me` shape. |
| `PATCH /me` (`name`, `photo_upload_id`, `from_city`, `notifications_enabled`) | 🔧 | `PATCH /app/me` | Accept. `photo_upload_id` once uploads exist; `photo_url` stays accepted meanwhile. Emits `person.updated` per active trip (🟢). |
| `PUT /me/upi` · `DELETE /me/upi` | ✅ | `PATCH /app/me {upi_id}` | Validated format, masked in responses, emits `has_upi`. |
| `POST /me/devices` · `DELETE /me/devices/:id` | 🔧 | `PUT /app/push/subscription`, `POST /app/push/unsubscribe` | Adopt their path and `{platform:"web_push", web_push:{endpoint, keys}}`; returns `device_id`. `ios`/`android` tokens are not accepted in v1 (PWA only). Our 10-per-person cap and `410` clean-up stay. |
| `DELETE /me` (`confirm: true`) | 🔧 | — | Accept their sequence exactly (`forget_person` everywhere first, then clear answers, leave every trip, anonymise messages, delete email/UPI). Lower priority than the rest; store requirement, not a hackathon flow. |

### 3.5 Home (§4.2)

| Endpoint | Verdict | Notes |
|---|---|---|
| `GET /home` | ✅ | New. `attention`: `needs_you` → `all_set` (planned) → `collecting`; `task` only once we have a rule (phase 3, visa). `past_trips.all_settled` = no transfers. |
| `GET /discover/ideas?from_city=` | 🔧 | New. v1 source: a curated table on the server (6–10 ideas per big origin city, `travel` by mode/duration). `image_url` optional; the app keeps a fallback illustration. Go as a source later. |

### 3.6 Invites (§4.3)

| Endpoint | Verdict | Ours today | Notes |
|---|---|---|---|
| `GET /invites/:code` public, read-only, `state`, inviter, `people_preview`, 30/min/IP | 🔧 | `GET /app/join/:code` | Accept; add inviter, faces, `state`, rate limit. |
| `POST /invites/:code/accept` (`join_answers?`) → `{trip_id, seq, landing}` | 🔧 | `POST /app/join/:code` | Accept. `landing: "chat"` when the room has any Go or person message, else `trip_home`. |
| `POST /invites/:code/later` · `POST /invites/:code/decline` | ✅ | — | New small table `invite_marks (person_id, code, state)`. Decline tells nobody. |
| Rotation (`POST /trips/:trip/invite/rotate`) | ✅ | — | Old codes answer `state: "revoked"`. |

### 3.7 Trips (§4.4)

| Endpoint | Verdict | Ours today | Notes |
|---|---|---|---|
| `POST /trips` all-optional body (`title?`, `destination_hint?`, `dates?`, `from_city?`) → `201 TripView` | 🔧 | `POST /app/trips` (title required) | Accept. `destination_hint` becomes the title when no title is given (Go reads it from the trip); `from_city` is saved as my join answer. We keep accepting our richer `destination`/`vibe`/`plan_minor` fields. |
| `GET /trips/:trip` (+`include`, ETag) | 🔧 | `GET /app/trips/:id` | Returns `TripView`. |
| `GET /trips/:trip/invite` | ✅ | in the snapshot | |
| `POST /trips/:trip/leave` | ✅ | 🟢 | |
| `PUT /trips/:trip/me/join-answers` (`from_city`, `earliest_leave`, `know`, `vibe`, `spend_band`) | 🔧 | `PATCH /app/trips/:id/me` | Accept, including their mapping: `vibe` → a `know` entry `"Vibe: beach"` (group- and Go-visible, not the trip-level `vibe`), `spend_band` → my private budget answer. |
| `PUT /trips/:trip/me/budget` · `DELETE` | 🔧 | `PUT` only | Accept `DELETE` (we currently refuse withdrawing; no reason to). Response `{budget, summary, seq}`. |
| `PATCH /trips/:trip/me {go_paused}` | ✅ | `POST …/go-paused` | |
| `POST /trips/:trip/read {up_to_seq}` | 🔧 | `POST …/seen` | Accept; it also feeds `me.unread_count`, `chat.unread_count` and catch-up. |
| `stage` rule | 🔧 | — | Computed from the snapshot, not from record lines (more robust): `new` = no destination and no dates; `planned` = destination **and** dates **and** (a confirmed `stay` booking, or any confirmed booking); else `deciding`. |
| Ours, not in their doc: `PATCH /trips/:trip` (title, dates, itinerary, status), `POST …/bookings/:bid/cancel-vote`, `PATCH …/bookings/:bid` | — | 🟢 | Kept (the Board's "Change" buttons and group cancellation need them). |

### 3.8 Uploads (§4.5)

| Item | Verdict | Notes |
|---|---|---|
| `POST /uploads` → presigned PUT, then `upload_id` in a message or `PATCH /me` | ✅ | New. Storage per D4. |
| Permanent, access-controlled URLs | 🔧 | Attachment URLs are **signed links valid 1 hour, minted when the message is read** (an `<img>` can't send `Authorization`). The app re-reads a message if a link has gone stale. |
| Size, MIME allow-list, EXIF location stripped, 24 h expiry of unused uploads | 🔧 | Size and MIME in v1; EXIF strip and expiry sweep in v2. |
| Virus scan | ⛔ | Not in scope. Files are only ever shared inside a trip. |
| Voice note = `kind: "audio"` file attachment; `duration_s` | ✅ / 🔶 9.7 | |

### 3.9 The room (§4.6)

| Endpoint | Verdict | Ours today | Notes |
|---|---|---|---|
| `GET /trips/:trip/messages` history mode (`before_seq`, newest 50, `seq` asc) and changes mode (`after_seq`, `updated_seq` asc) | 🔧 | changes mode only | Add history mode exactly as specified; `422` when both cursors are sent. |
| `POST /trips/:trip/messages` (`client_message_id`, `text`, `attachments[{upload_id}]`, `reply_to`, `about_message_id`, `mentions`) → `201 Message` | 🔧 | 🟢 (`client_id`, URL attachments) | Rename the key, accept `upload_id`, return the stored `Message`. `mentions_go` rules: identical. 30/min: identical. |
| `PUT …/messages/:id/reaction {emoji \| null}` (one per person per message) | 🔧 | `POST …/reactions`, `DELETE …/reactions/:emoji` | Accept the one-per-person rule; switching emoji emits `reaction.removed` then `reaction.added` to Go. |
| `PATCH` / `DELETE …/messages/:id` → `Message` | ✅ | 🟢 | |
| `GET /trips/:trip/catch-up` → `200 CatchUp` or `204` | 🔧 | `POST …/catch-up` | Accept GET and the 204. No `since` parameter: the server knows `last_read` (from `/read`). Keep `?force=1` for testing. |
| System messages posted by the server (joins, "Trip created") | 🔧 | — | D8: yes, `author: {kind:"system"}`, a change number, **no event to Go**. Also used as the anchor for a person-opened vote's card. |
| Composer: Poll → `POST /decisions`; Location 🔶; voice ✅ | ✅ | | |

### 3.10 Go's cards (§4.7)

| Endpoint | Verdict | Ours today | Notes |
|---|---|---|---|
| `POST /trips/:trip/cards/:card_id/actions {action_id, option_id?, press_id}` | 🔧 | `POST …/card-taps` (`tap_id`) | Adopt their path and `press_id`. |
| Timeout → `200 {result:"refused", toast:"Go didn't answer. Try again."}` | 🔧 | `504 go_unavailable` | Accept their answer (it is the guide's own example). |
| `POST /me/vault-link {start}` | ✅ | 🟢 | `add_documents` 🔶 9.8. |
| `go://` links from card buttons | ✅ | pass-through | Needs Go to send them (🔶 9.4); nothing on our side. |

### 3.11 Votes, mandate, record (§4.8)

| Endpoint | Verdict | Ours today | Notes |
|---|---|---|---|
| `GET /trips/:trip/decisions/:id` (+`my_vote`) | ✅ | in the snapshot | New route, cheap. |
| `POST /trips/:trip/decisions` → `{decision, message}` | 🔧 | 🟢 (no card message) | The server posts the anchor message with the `vote` card (D8). |
| `PUT …/vote {option_index}` | ✅ | `POST …/vote` | |
| `DELETE …/vote` (take it back) | 🔶 | — | 9.13. Off behind `features.vote_retract` until Go lands it. |
| `POST …/close` (organizer or opener) | 🔧 | anyone | Accept their tighter rule. We also close a vote automatically when everyone has voted (keep; tell the app team). |
| `POST …/cancel` | ✅ | 🟢 | |
| `POST …/mandate/confirm` · `decline` (payer only) | ✅ | 🟢 | |
| `GET /trips/:trip/record` (+`include_undone`) | ✅ | in the snapshot | |
| `POST …/record/:line/undo` · `redo` | 🔧 | undo only | Add redo (`record.changed change:"updated"`). |
| "I'm flexible" | 🔶 | — | 9.6. Until then the app sends it as a message (their fallback). |
| "I'll book it" (`claim`) | 🔶 | — | 9.14. No server change. |

### 3.12 Money (§4.9)

| Endpoint | Verdict | Ours today | Notes |
|---|---|---|---|
| `GET /trips/:trip/money` → `MoneyView` | 🔧 | `money` in the snapshot + `GET …/settle-up` | New view; `me.budget` as a range (3.2). |
| `GET /trips/:trip/transactions` (`filter`, cursor, `total_count`) | ✅ | — | New. |
| `POST /trips/:trip/settlements`, `…/confirm`, `…/dispute` | ✅ / 🔶 9.11 | — | New. Provisional until confirmed, as they describe. Go sees **confirmed** settlements only (our answer to their open question 3). |
| `POST /trips/:trip/transfers/pay-link` | 🔧 | `upi_id` in `settle-up` | Accept as a convenience, but **it hides nothing**: a `upi://pay?pa=…` link carries the id. We drop the "the UPI id never leaves the Server" claim from the doc. `409` when the payee has none. |
| `POST /trips/:trip/transfers/nudge {from_person_id}` | ✅ | `POST …/settle-up/nudges` | Rename. 24 h rule identical. |
| `PATCH /trips/:trip/expenses/:id {split_person_ids, note}` | ✅ | delete + add | New; emits `expense.changed`. |
| Ours, not in their doc: `POST /trips/:trip/expenses`, `DELETE …/expenses/:id` | — | 🟢 | Kept: PDF page Z wants people to add expenses by hand. |
| Expense approval (PDF Z): `Expense.status/confirmations`, `POST …/expenses/:id/approve` · `dispute` | ➕ | — | D6: built now; sent to the app team (`APP-CONTRACT-CHANGES.md` §4.9). |

### 3.13 Bookings, documents, itinerary (§4.10)

| Endpoint | Verdict | Ours today | Notes |
|---|---|---|---|
| `GET /trips/:trip/bookings` · `GET …/bookings/:id` | ✅ | in the snapshot | New routes. **Server rule (new):** `passengers[]` and `documents[]` are returned only to the people in `for_person_ids`; everyone else sees the booking without them. |
| `GET …/bookings/:id/documents/:doc` → `302` signed URL | 🔶 9.9 | — | Needs Go to give us the files (part 5). |
| `POST /trips/:trip/bookings` | ✅ | 🟢 | |
| `GET /trips/:trip/itinerary?scope=everyone\|me` | 🔧 / 🔶 9.10 | in the snapshot | New route now; `scope=me` returns everything until `person_ids`/`audience` exist, then filters and rewords from my bookings. |

### 3.14 Trip home (§4.11)

| Endpoint | Verdict | Ours today | Notes |
|---|---|---|---|
| `GET /trips/:trip/needs-you` → `NeedsYouItem[]` | 🔧 | 🟢 (4 kinds) | Add `settle_up`, `title`/`subtitle`/`cta_label`/`since`/`target`. |
| `GET /trips/:trip/cards?kind=&state=` | ✅ | — | New; latest version of each card. |
| "Ask Go to call" = a message mentioning Go | ✅ | 🟢 | `request_task` later (🔶 9.5a). |
| Listen in, take over, recording | 🔶 9.5 | — | Built now behind `features.calls` (D7): `listen` action pass-through, `recording_url`/`duration_s`, `POST …/cards/:id/share`. |

### 3.15 Web check-in (§4.12)

| Endpoint | Verdict | Notes |
|---|---|---|
| `GET/PATCH …/bookings/:id/checkin`, `POST …/checkin/complete` | 🔶 9.12 | Built now behind `features.checkin` (D7), with `get_checkin`/`submit_checkin` in the mock Go. Paid seat through the vault: agreed. |

### 3.16 You screen (§4.13)

| Endpoint | Verdict | Ours today |
|---|---|---|
| `GET /me/go` | ✅ | `GET /app/me/go-knows` |
| `PATCH /me/go {carry_over}` | ✅ | `PUT /app/me/carry-over` |
| `DELETE /me/go/facts/:id` | ✅ | `DELETE /app/me/facts/:fact` |
| `DELETE /me/go?trip_id=` | ✅ | `POST /app/me/forget` (same semantics: clears answers, `person.updated`, never claims success on failure) |

### 3.17 Places, config, health (§4.14)

| Endpoint | Verdict | Notes |
|---|---|---|
| `GET /places/cities?q=&country=IN`, `GET /places/cities/top` | 🔧 | New. **Bundled dataset** (GeoNames, India, population ≥ 15k, about 1,800 rows) loaded into Postgres by a migration; no third-party call at request time, so no outage or rate-limit risk. Other countries later. |
| `GET /config` (`features`, `vapid_public_key`, `min_client_version`) | ✅ | New. Replaces `GET /app/push/key`. |
| `GET /health` | ✅ | 🟢 |

### 3.18 Pushes (§8)

| Item | Verdict | Notes |
|---|---|---|
| When: mention, new card for me, vote closing, owe, settlement, nudge, friend joined | ✅ | First four 🟢; the three new ones are small. |
| Payload `{type, trip_id, message_id, title, body, deep_link, tag, badge_count}` | 🔧 | Adopt, **without `badge_count`** in v1 (we don't track per-device badges). |
| Web Push with VAPID; drop when the room is focused; `410` cleanup | ✅ | 🟢 |

### 3.19 Their open questions (§11), our answers

1. `stage`: our rule in 3.7. 2. Quick start mapping: yes. 3. Settlements: Go sees them when `confirmed`, via `settlement.recorded`. 4. Person-opened votes: yes, `opened_by_person_id` is for them; the server posts the card's anchor message (D8). 5. People editing the itinerary: `PATCH /trips/:trip` allows it; the UI need not expose it. 6. The budget `trip_changed` names nobody: yes. 7. One commit hook feeds Go's outbox and the app frames: yes, that's how it works today. 8. Account deletion order: yes. 9. Rotated codes answer `revoked`. 10. VAPID keys are the server's; the public key is in `GET /config`. 11. Time zone: ask Go for an optional `Place.timezone` (part 5). 12. Retract: `decision.voted` with `retracted: true` (our preference). 13. `claim` on a `notice` card: yes.

---

## 4. What we keep that the app team didn't ask for

- Strict bodies (`422` on unknown fields and wrong types) on every route: it has caught real bugs.
- Group cancellation of a booking by vote (`cancel-vote`), `PATCH /trips/:trip`, person-added expenses.
- Automatic vote close when everyone has voted; the 24 h cancellation vote rule.
- The traffic log, `pnpm inspect`, the fake Go and the dev stack: all tests stay offline.

---

## 5. Draft: changes we need from Go's team

The separate document `docs/GO-CHANGES.md` is written in the style of `llms-full.txt`, lists only what changes, and
states what we have already implemented so Keshav's team can see where we stand. Summary of its contents:

**Already live on our side (no action for Go):** the signed socket with reconnect, all 18 Go requests, the 7 Server →
Go requests, 20 events through the outbox, signed spend approvals, vault links, cards stored raw, `replace_card`,
privacy rules. Tested against the real Go on 6 Oct (19 of 20 events accepted; the 20th waits on our public key being
installed in Go's vault).

**Group A, small and additive (unblocks most screens):** 9.1 option `details`; 9.2 `return_journey`, one-way/round
prices, `option_kind: cab`, `CardTap.payload`; 9.3 `quick_replies`; 9.4 the `go://` scheme; 9.6 flexible vote;
9.7 `location` attachment and `duration_s`; 9.9 `Booking.details/documents/passengers/return_journey`; 9.10
`ItineraryItem.person_ids/audience`, `Day.image_url`; 9.13 `retracted`; 9.14 `claim`; `Place.timezone`.

**Group B, new events and requests:** 9.11 `settlement.recorded`; 9.8 `checklist` card and `vault_link.start:
"add_documents"`; 9.5 `CallCard.recording_url/duration_s`, `listen` action, `request_task`; how booking PDFs reach the
server (Go uploads to a URL we give it in `AddBooking`, or hands us a fetchable link).

**Group C, large:** 9.12 web check-in (`get_checkin`, `submit_checkin`, allowed to answer `working`).

**Clarifications we need (no schema change):** D8 server-authored messages with `author.kind = "system"` and no
event; D9 a change number on `replace_card`; Go posting nothing for person-opened votes (the server does); the seven
behaviour issues already logged in `REAL-GO-TESTING.md` (stale `open` lines, missing `mentions`, reasoning in room
text, mandates for things Go can't book, the spend-approval refusal).

---

## 6. The plan

Superseded by [`ALIGNMENT-PLAN.md`](ALIGNMENT-PLAN.md).
