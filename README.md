# Go Server

**Go is an AI travel planner that lives inside your group chat.** Friends plan a trip together in one room, and Go
joins the conversation: it suggests places and stays with photos, runs votes, keeps the plan, splits the money, and
books. Built for the ixigo hackathon.

This repository is the **Server**: the backend that stores every trip, enforces every rule, keeps the AI and everyone's
phones in sync, and produces the bookings and tickets. ("Go" is the product's name, not the programming language; this
is TypeScript.)

[![Node 22](https://img.shields.io/badge/node-22%2B-339933)](#run-it) [![Tests](https://img.shields.io/badge/tests-660%2B%20passing-brightgreen)](#test-it) [![Contract](https://img.shields.io/badge/Go%20contract-1.3.0-blue)](docs/CONTRACT-GO.md)

---

## The problem

Planning a group trip happens in a chat, but the chat can't *do* anything. Someone has to collect everyone's dates and
budgets, compare stays on another site, run a poll, chase people to pay, book, and keep track of who owes whom. The
decisions get lost in the scroll.

## What Go does

| In the trip room | How the Server makes it work |
|---|---|
| **Ask Go anything:** "@Go stays in Goa for 6–9 Nov under ₹20k each?" | Every message reaches Go as an ordered event; Go answers with rich cards (10 options with photos, prices and details) |
| **Decide together:** vote right on Go's options card; "See more" adds options to the same vote | Votes, tallies and results are stored by the Server; the result lands in the trip's record |
| **Plan in one place:** destination, dates, stay, itinerary, group budget | A single trip record, shared by the app and Go, with an automatic name ("Goa 2026") |
| **Book safely:** the payer confirms, then pays | Two keys: the Server signs a one-time **Ed25519 spend approval** from its own records, and the payer confirms |
| **Get real-looking tickets:** an ixigo-style e-ticket or hotel voucher PDF after booking | Rendered server-side from HTML templates with headless Chromium, stored in a private bucket, opened through signed links |
| **Split money fairly:** expenses, re-splits, paybacks, a UPI pay link | Exact integer money maths, the fewest payments to settle up, money lines posted in the room |
| **Stay in sync:** everything appears live on every phone, in order | A per-trip change log (`seq`), a transactional outbox to Go, and `LISTEN/NOTIFY` fan-out to WebSockets |
| **Privacy:** each traveller's own flights and tickets are theirs | Per-person visibility for messages, bookings and files; Go never receives anyone's contact details |
| **"Pending on you":** every open vote, payment and to-do in one list | Computed per person, with exactly what each popup needs |

---

## How it fits together

```text
   App (web / PWA)                        THIS SERVER                           Go brain (the AI)
 ┌─────────────────┐  HTTPS /app/v1   ┌──────────────────────────┐  one signed   ┌─────────────────┐
 │ trip room, votes│ ───────────────▶ │  Fastify API (71 routes) │  JSON-RPC 2.0 │ understands the │
 │ bookings, money │ ◀── WebSocket ── │  Live hub                │ ◀═══════════▶ │ chat, searches  │
 └─────────────────┘                  │  Go socket + outbox      │   WebSocket   │ ixigo, writes   │
                                      │  Ticket PDFs (Chromium)  │               │ messages & cards│
                                      └──────┬──────────┬────────┘               └─────────────────┘
                                             │          │
                                     PostgreSQL       Storage        (Supabase: database, files, Google sign-in)
```

1. **The app talks only to this Server.** Sign-in is Supabase Auth (Google); the Server verifies tokens itself.
2. **Every change to a trip** (a message, a vote, a booking, an expense) is saved **together with an event for Go, in
   one transaction**, and takes the trip's next change number. A background sender delivers the events to Go one at a
   time, in order, with retries. Nothing is lost and nothing arrives out of order.
3. **Go acts through requests to the Server** (post a message, open a vote, add a booking…), and every request is
   validated against Go's published contract and done exactly once.
4. **Phones get live frames** over one WebSocket, delivered at commit and in commit order.

**Full design: [`ARCHITECTURE.md`](ARCHITECTURE.md)** covers the components, the three interfaces, the data model, the
key flows (with diagrams), security, reliability, testing and deployment.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22, TypeScript (strict), ES modules | One language across the team; strict types catch contract drift |
| HTTP | Fastify 5 | Fast, schema-friendly, hooks for auth, idempotency and errors |
| Database | PostgreSQL (Supabase), `pg` | Transactions, row locks, advisory locks and `LISTEN/NOTIFY` power ordering and fan-out |
| Realtime | `ws` WebSockets | The app's live updates, and the long-lived connection to Go |
| Validation | Ajv (JSON Schema 2020-12) | Every frame to and from Go is checked against Go's official schema |
| Crypto | Node `crypto`, `jose` | HMAC-signed socket handshake, Ed25519 spend approvals, Supabase JWT verification |
| PDFs | `puppeteer-core` + system Chromium | Pixel-faithful e-tickets and vouchers from HTML templates |
| Files and auth | Supabase Storage and Auth | A private bucket with signed links; Google sign-in |
| Tests | Vitest, `embedded-postgres` | A real Postgres per test file, with no Docker or network needed |
| Hosting | Railway (Railpack) | Push to `main`, deployed in about a minute |

---

## Run it

You need **Node 22+**, **pnpm**, and a PostgreSQL database (Supabase works).

```bash
pnpm install
cp .env.example .env        # fill it in; never commit real secrets
set -a; . ./.env; set +a
pnpm start                  # applies migrations, connects to Go, serves the API on :8080
```

### Try it locally with nothing to set up

```bash
pnpm dev:stack              # a temporary Postgres + a fake Go + a fake Supabase Auth + the real server on :8080
```

- **Sign in like production:** `curl 'http://127.0.0.1:54331/mint?name=Priya&email=priya@gmail.com'` gives a
  Supabase-style token; send it as `Authorization: Bearer …`.
- **Act as Go** on `:8090`: `POST http://localhost:8090/sim/<method>` with Go's params (for example `/sim/open_vote`).
  The fake Go also replies to any message that mentions `@Go`.
- **Dev tokens instead:** `pnpm dev:stack:dev`, then `POST /app/v1/dev/sign-in {"name":"Priya"}` (local only; refused
  in production).
- **Ticket PDFs locally:** set `PUPPETEER_EXECUTABLE_PATH` to your Chrome (for example
  `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`).

<details>
<summary><b>All settings</b> (each is documented in <code>.env.example</code>)</summary>

| Group | Variables |
|---|---|
| Go | `GO_URL`, `GO_SIGNING_SECRET`, `GO_SPEND_PRIVATE_KEY`, `GO_SERVER_NAME` (the deployment's name to Go), `INSTANCE_NAME`, `GO_CONTRACT` (Go's contract version, e.g. `1.3.0`) |
| Database | `DATABASE_URL`, `DATABASE_CA_CERT` (Supabase TLS), `DB_POOL_MAX` |
| Server | `PORT`, `PUBLIC_BASE_URL` (invite links are `<it>/invite/<code>`), `APP_ORIGINS` (exact CORS origins) |
| Sign-in | `SUPABASE_URL`, `SUPABASE_JWT_SECRET` (legacy only), `AUTH_MODE`, `APP_SESSION_SECRET` (dev tokens) |
| Files | `SUPABASE_SECRET_KEY`, `SUPABASE_STORAGE_BUCKET`, `STORAGE` |
| PDFs | `PUPPETEER_EXECUTABLE_PATH` (on Railway `/usr/bin/chromium`, installed via `RAILPACK_DEPLOY_APT_PACKAGES`) |
| Support | `INTERNAL_API_KEY` (enables `/internal/v1`; unset = off) |
| Feature flags | `FEATURE_CHECKIN`, `FEATURE_VISA`, `FEATURE_CALLS`, `FEATURE_VOTE_RETRACT`, `FEATURE_VOTE_FLEXIBLE`, `FEATURE_CLAIM` |
| Debug | `LOG_GO_TRAFFIC=1` writes every socket frame to `logs/go-traffic.jsonl` (no secrets) |

</details>

---

## Test it

```bash
pnpm test          # 660+ tests in 75 files: a real Postgres starts in-process, no Docker needed (about a minute)
pnpm typecheck
```

What the suite covers:
- **Contracts:** every event and answer is validated against **Go's official 1.3.0 schemas**; signing and spend
  approvals are checked against Go's official test vectors.
- **Every app route:** happy paths, documented errors, CORS, idempotency and rate limits. One test walks *every* trip
  route to prove a stranger always gets 403.
- **Money and rules:** fewest-payments transfers, spend checks, and vote results, including concurrent votes and taps.
- **Live updates:** replay, resync, multiple devices, frames in commit order, leavers stop receiving.
- **End to end:** each documented flow (`tests/flows.e2e.test.ts`); the real server process against a fake Go
  (`tests/fake-go.e2e.test.ts`, `tests/main.e2e.test.ts`).
- **Real PDFs** with Chromium (`tests/demo-tickets.test.ts`, when `PUPPETEER_EXECUTABLE_PATH` is set).

Beyond the suite, the Server has been run against the **real production Go** through full multi-person trips. See
[`docs/REAL-GO-TESTING.md`](docs/REAL-GO-TESTING.md).

---

## Repository map

| Path | What it contains |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The design: components, interfaces, data model, flows, security, reliability |
| `src/main.ts` | Start-up and wiring |
| `src/api/` | The app's HTTP API: the Fastify shell (`app.ts`), sign-in (`auth.ts`), one file per contract section (`v1/`) |
| `src/domain/` | Business rules: trips, votes, bookings, money, spend checks, needs-you, home, visibility |
| `src/requests/` | Go's 20 requests to the Server |
| `src/go/`, `src/outbox/` | The signed socket to Go, and the ordered event sender |
| `src/live/` | Live updates to phones (WebSocket hub over Postgres `LISTEN/NOTIFY`) |
| `src/demo/` | Demo bookings and the ticket PDF templates and renderer |
| `src/db/`, `src/storage/`, `src/contract/`, `src/jobs/` | Transactions and the change log, files, Go's contract in code, background jobs |
| `migrations/` | The database schema (16 SQL migrations, applied at start) |
| `contract/` | Go's official contract 1.3.0 (`go.json`, `methods.json`, `socket.json`), test vectors, our additive overlay |
| `tests/` | The test suite and its helpers (mock Go, fake Supabase Auth, embedded Postgres) |
| `scripts/` | Operator and developer tools (below) |
| [`docs/`](docs/README.md) | The contracts, guides and records (see [`docs/README.md`](docs/README.md)) |

## Operator and developer tools

| Command | What it does |
|---|---|
| `pnpm dev:stack` / `dev:stack:dev` | The whole stack locally (above) |
| `pnpm dev:real` | The server against the **real Go**, with a persistent local Postgres |
| `pnpm inspect [--trip t_x]` | What happened on the socket to Go: outbox per trip, refused events, our errors, latencies |
| `pnpm check:supabase` | Is a Supabase project ready (keys, Google, TLS, LISTEN, RLS, roles)? Read-only |
| `pnpm supabase:rehearse` | The server against a local official Supabase (Docker), with only Go faked |
| `pnpm migrate` | Apply the migrations by hand (`pnpm start` does it too) |
| `pnpm gen:types` | Regenerate TypeScript types from Go's contract |

---

## Documentation

| Read | For |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How the Server is built and why |
| [`docs/CONTRACT-APP.md`](docs/CONTRACT-APP.md) | The App ↔ Server contract (what the app sends and receives) |
| [`docs/API.md`](docs/API.md) | The same contract, plus try-it examples and the full route index |
| [`docs/CONTRACT-GO.md`](docs/CONTRACT-GO.md) | The Server ↔ Go contract (events, requests, rules) |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) and [`docs/SUPABASE-SETUP.md`](docs/SUPABASE-SETUP.md) | Deploying to Railway and setting up Supabase |
| [`docs/README.md`](docs/README.md) | Every document, and which are current contracts versus historical records |

## Team

Built for the ixigo hackathon by three teams: **Server** (this repo: Nishanth Gunupudi, Rahul Manglani), **Go brain**
(the AI: Keshav Musunuri) and **App** (the web app: Saket).
