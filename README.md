# Go Server (go-demo)

The **Server** for **Go**, the AI member of every trip group chat (ixigo hackathon).

Friends chat in a trip room. Go listens, jumps in at the right moments, and helps with choices, votes, bookings and
budget. This repo is the part that **stores everything about a trip**, **talks to Go**, and **serves the app**. ("Go" is
the product name, not the programming language. The code is TypeScript.)

Two contracts rule the code:
- **Server ↔ Go:** https://vestrago.vercel.app/llms-full.txt (1.0.0), plus the additive 1.1 proposal in
  [`docs/GO-CHANGES.md`](docs/GO-CHANGES.md) (`contract/extensions-1.1.json`). If a rule is unclear, the rulebook wins.
- **App ↔ Server:** [`docs/API.md`](docs/API.md), the app team's contract (rev 4) as this server runs it. **Frontend
  team: start there**, or with [`docs/CONTRACT-APP.md`](docs/CONTRACT-APP.md), the same contract on its own. For Go's
  team: [`docs/CONTRACT-GO.md`](docs/CONTRACT-GO.md).

---

## How it works, in plain words

```
 Web app (PWA)  ──(HTTP + one WebSocket)──▶  THIS SERVER  ◀══ one secure live connection ══▶  Go (the AI)
                                              │        │
                                          Postgres   Supabase Storage (files)
```

1. **The app only talks to this server**, under `/app/v1`. It never talks to Go directly; the only exception is opening a
   Go page (the vault) from a short link the server hands over.
2. **Sign-in is Supabase Auth (Google).** The app sends Supabase's access token on every call; this server checks it
   locally and creates the person on their first call. It issues no tokens of its own (outside local dev).
3. **This server keeps one secure, always-open connection to Go.** Both sides send each other requests on it.
4. **Whenever anything changes in a trip** (message, reaction, vote, someone joins, booking, expense, settlement), the
   server saves the change *and* a note about it for Go, in the same database transaction, then tells the phones over
   the WebSocket. A background sender delivers the notes to Go **one at a time per trip, in order**, and retries if Go
   is busy. Nothing is lost.
5. **Go asks the server to do things:** read the trip, post a message, show "Go is typing...", react, open a vote,
   save a booking, and so on (18 kinds of request). The server answers from its database. If the same request
   arrives twice, it is done only once.
6. **Paying is protected by two separate approvals.** The server checks its own records (vote closed, within the
   budget cap, the payer tapped "Yes, book it") and only then signs a one-time spend approval. The payer must also
   confirm with Face ID in Go's vault. Go's own word is never enough.
7. **Privacy:** Go never sees phone numbers, emails, UPI ids, or anyone's own budget answer. In the app, "travelling
   from" is shown only to the person themselves, and a booking's passengers and ticket files only to the people it
   covers. If someone pauses Go, Go gets their messages with no words in them.

---

## Folder map

| Folder / file | What it contains |
|---|---|
| `src/main.ts` | Starts everything: database and migrations, storage, connection to Go, sender, background jobs, app API |
| `src/config.ts` | The settings and the feature flags (`FEATURE_*`, served by `GET /app/v1/config`) |
| `src/contract/` | The rulebook in code: types, request signing, spend-approval signing, checking of requests; the 1.1 overlay |
| `src/go/go-socket.ts` | The connection to Go (signing, reconnecting, matching answers to requests) |
| `src/db/` | Database helpers: transactions, "do this only once" (`once.ts`), writing a change plus its event (`write-change.ts`) |
| `src/outbox/sender.ts` | The sender that delivers events to Go in order, with retries |
| `src/requests/` | Go's 18 requests, answered from our database |
| `src/domain/` | The business logic: snapshots, what Go and the app may see, money maths, voting, spend check, bookings and documents, itinerary scopes, check-in, invites, home, system messages, our requests to Go (`ask-go.ts`) |
| `src/api/` | The app's API: `app.ts` is the shell (request id, CORS, one error shape, sign-in, `Idempotency-Key`); `v1/` has one file per section of `docs/API.md`, each with its routes' metadata; `bodies.ts` the strict body definitions; `auth.ts` Supabase and dev tokens |
| `src/live/` | Live updates to phones: the WebSocket hub (`ws.ts`) fed by Postgres LISTEN/NOTIFY (`live.ts`) |
| `src/storage/` | Files: Supabase Storage (private bucket, signed links) and an in-memory stand-in for tests and laptops |
| `src/jobs/` | Background jobs: close votes when time runs out, sweeps (idempotency keys, uploads, tickets) |
| `migrations/` | The database tables (SQL, `001`–`009`, applied at start under a lock) |
| `data/cities-in.json` | The bundled city dataset for "travelling from" (loaded by the migration) |
| `contract/` | Copies of the public rulebook files and test vectors, and `extensions-1.1.json` |
| `tests/` | Automated tests (see below); `tests/helpers/mock-go.ts` is the mock Go, `fake-supabase-auth.ts` the fake Supabase Auth |
| `scripts/` | Operator and dev tools (table below) |
| `docs/` | `API.md` (the app contract), `CONTRACT-APP.md` and `CONTRACT-GO.md` (each contract on its own), `GO-CHANGES.md`, `DEPLOY.md`, `SUPABASE-SETUP.md`, `REAL-GO-TESTING.md` |
| `.env.example` | The settings the server needs |

---

## Run it

You need Node 22+, pnpm, and a Postgres database (Supabase works).

```bash
pnpm install
cp .env.example .env      # fill it in. Never commit real secrets.
set -a; . ./.env; set +a
pnpm start                # creates the tables, connects to Go, starts the app API on :8080
```

Settings (all in `.env.example`, each with a comment):

| Group | Variables |
|---|---|
| Go | `GO_URL`, `GO_SIGNING_SECRET`, `GO_SPEND_PRIVATE_KEY`, `INSTANCE_NAME` (unique per server copy; default `<hostname>-<pid>`) |
| Database | `DATABASE_URL`, `DATABASE_CA_CERT` (Supabase TLS), `DB_POOL_MAX` (default 30; the outbox uses at most a third) |
| Server | `PORT` (8080), `PUBLIC_BASE_URL` (invite links are `<it>/j/<code>`), `APP_ORIGINS` (the web app's exact addresses, comma-separated, no wildcard; none by default) |
| Sign-in | `SUPABASE_URL` (sets `AUTH_MODE=supabase`), `SUPABASE_JWT_SECRET` (legacy projects only), `AUTH_MODE` (`supabase` \| `dev`; `dev` is refused in production), `APP_SESSION_SECRET` (dev tokens only) |
| Files | `SUPABASE_SECRET_KEY` (Storage; sets `STORAGE=supabase`), `SUPABASE_STORAGE_BUCKET` (default `go-files`), `STORAGE` (`supabase` \| `memory`) |
| Feature flags | `FEATURE_CHECKIN`, `FEATURE_VISA`, `FEATURE_CALLS`, `FEATURE_VOTE_RETRACT`, `FEATURE_VOTE_FLEXIBLE`, `FEATURE_CLAIM` (`1` or `0`; unset = the default: off). `docs/API.md` §9 says what each hides |
| Debug | `LOG_GO_TRAFFIC=1` writes every socket frame to `logs/go-traffic.jsonl` (no secrets) |

## Try it locally, with nothing to set up

```bash
pnpm dev:stack    # a temporary Postgres + a fake Go + a fake Supabase Auth on :54331 + the real server on :8080 (Ctrl-C stops all of it)
```

Then use curl as in `docs/API.md` "Try it".

- **Sign in like production:** `curl 'http://127.0.0.1:54331/mint?name=Priya&email=priya@gmail.com'` gives a
  Supabase-style access token; send it as `Authorization: Bearer …`. The person is created on the first call.
- **Act as Go** on `:8090`: `POST http://localhost:8090/sim/<method>` with Go's params (for example `/sim/open_vote`);
  `GET /sim/state` shows what the fake Go has received. The fake Go also answers every message that names it
  (`@Go …`): "Go is typing...", a ✅, then a reply with one of its cards.
- **Files** live in memory (`STORAGE=memory`): the server itself serves the signed upload and download links at
  `/_dev/storage/...`. They are lost on restart.

### Dev sign-in (local only)

`pnpm dev:stack:dev` runs the stack with the server's own dev tokens instead of the fake Supabase Auth (`AUTH_MODE=dev`,
the default when `SUPABASE_URL` is not set). Then **`POST /app/v1/dev/sign-in`** with `{ "name": "Priya" }` (and
optionally `photo_url`, `phone`, `email`, `upi_id`) answers `201 { "person_id", "token" }`; the token (90 days, signed
with `APP_SESSION_SECRET`) is sent as `Authorization: Bearer …` like a Supabase one. The route does not exist in
`AUTH_MODE=supabase`, is refused in production, and is kept out of `docs/API.md` on purpose.

## Operator and dev scripts

| Command | What it does |
|---|---|
| `pnpm dev:stack` / `pnpm dev:stack:dev` | The whole stack locally (above), with the fake Supabase Auth or with dev tokens |
| `pnpm dev:auth` | The fake Supabase Auth on its own (`:54331`), for any server run with `AUTH_MODE=supabase SUPABASE_URL=http://127.0.0.1:54331` |
| `pnpm dev:real` | The server against the **real Go**: reads `.env`, keeps a persistent local Postgres in `.pgdata/`, mirrors output to `logs/server.log` |
| `pnpm inspect` | What happened on the socket to Go: outbox per trip, refused events, our errors, latencies (`--trip t_xxx`, `--since 10m`) |
| `pnpm check:supabase` | Is the server ready for a Supabase project? Keys published, Google on, database over TLS, LISTEN and locks, migrations, RLS, API roles. Read-only |
| `pnpm dev:login` | A "Sign in with Google" page on `:3000` that shows the real Supabase token and calls `GET /app/v1/me` (needs `APP_ORIGINS=http://localhost:3000`) |
| `pnpm supabase:token` | A real Supabase access token for a test user (`SUPABASE_TEST_EMAIL`/`_PASSWORD` in `.env`; `--user 2` for the second); `--me <server>` also calls `GET /app/v1/me` |
| `pnpm supabase:rehearse` | The server against the official local Supabase (Docker): real Auth, Postgres and Data API, only Go faked |
| `pnpm migrate` | Applies `migrations/*.sql` and loads the city dataset by hand (`pnpm start` does it too) |
| `pnpm test` / `pnpm typecheck` | The tests (below) and the type check |

Deployment (Railway): [`docs/DEPLOY.md`](docs/DEPLOY.md). Supabase setup, the token flow and the storage bucket:
[`docs/SUPABASE-SETUP.md`](docs/SUPABASE-SETUP.md). Results against the real Go so far:
[`docs/REAL-GO-TESTING.md`](docs/REAL-GO-TESTING.md).

## Test it

```bash
pnpm test         # 489 tests in 56 files; starts a real temporary Postgres by itself, no Docker needed (about 40 s)
pnpm typecheck
```

The tests check our signing against the official test vectors, check every message we send against the rulebook's
own schemas (1.0 plus the 1.1 overlay), and run the real connection against the **mock Go** (`tests/helpers/mock-go.ts`),
the fake Supabase Auth and the in-memory storage, all offline. `tests/flows.e2e.test.ts` walks through each flow page
of the docs end to end, `tests/fake-go.e2e.test.ts` runs the real server process against the fake Go, and
`tests/live-ws.test.ts` drives the WebSocket (replay, resync, two devices, ticket reuse). The mock is only a test tool,
it is not the real Go.

---

## Things to know before changing code

- Every change must go through `nextSeq` + `emit` (see `src/db/write-change.ts`) inside one transaction, and publish its
  live notice after the commit. That is how Go and the phones get every change, in order.
- Lock rows (a vote, an approval, a booking) **before** calling `nextSeq`, which locks the trip. The full order is: the
  person's row, then the person's membership row in a trip, then vote rows, then booking rows, then the trip's change
  number. A path that closes a vote about a booking holds the booking before it takes a change number (`lockBooking` in
  `src/domain/voting.ts`). A profile edit holds the person's row while it tells every trip they are in, in ascending trip id.
- Go's cards are stored **exactly as Go sent them** (`raw.card`), so new card fields reach the app untouched.
- Answer Go's requests from the database, never from memory: several server copies may run at once. (The two in-memory
  rate limiters, invite preview and city search, are per instance on purpose.)
- Each server copy needs its own `INSTANCE_NAME`, because Go accepts each connection signature only once.
- **Every app route declares its metadata** (`routes[]` in `src/api/v1/*.ts`: method, path, section, title, summary,
  example). A test counts the routes (70); `docs/API.md` Appendix C is kept in step by hand. A new route goes in the section file with
  its metadata and a strict body definition in `src/api/bodies.ts` (`tests/bodies.test.ts` checks the rules).
- Go-dependent features live behind a flag in `src/config.ts` (`FEATURE_DEFAULTS`). The mock Go implements the 1.1
  behaviour so the tests cover a feature with its flag on.
- System messages (`author.kind = "system"`) take a change number but **no event** to Go; `replace_card` moves the
  message's `updated_seq` but sends no event. Both are agreed with Go's team in `docs/GO-CHANGES.md` part 4.

## What is still a placeholder or waiting on someone

- **Supabase Storage** is tested against an in-process fake and the local Supabase rehearsal, not yet against the
  production bucket (`docs/DEPLOY.md` has the checks).
- **Contract 1.1:** check-in, visa documents, calls, flexible votes, taking a vote back and `claim` are built behind
  flags and wait for Go's side (`docs/GO-CHANGES.md`); `docs/REAL-GO-TESTING.md` records no real-Go pass on them.
- **The contract package:** the official `@go/contract` lives in a private repo we could not reach, so `src/contract/`
  is built from the public files. Same function names, so it can be swapped later.
