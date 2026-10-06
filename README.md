# Go Server (go-demo)

The **Server** for **Go**, the AI member of every trip group chat (ixigo hackathon).

Friends chat in a trip room. Go listens, jumps in at the right moments, and helps with choices, votes, bookings and
budget. This repo is the part that **stores everything about a trip** and **talks to Go**. ("Go" is the product name,
not the programming language. The code is TypeScript.)

The full rulebook (the "contract") is here: https://vestrago.vercel.app/llms-full.txt
If a rule is unclear, the rulebook wins. Do not guess.

---

## How it works, in plain words

```
 Phone app  ──(HTTP + live stream)──▶  THIS SERVER  ◀══ one secure live connection ══▶  Go (the AI)
                                           │
                                       Database
                                      (Postgres)
```

1. **The app only talks to this server.** It never talks to Go directly.
2. **This server keeps one secure, always-open connection to Go.** Both sides send each other requests on it.
3. **Whenever anything changes in a trip** (message, reaction, vote, someone joins, booking, expense), the server saves
   the change *and* a note about it for Go, in the same database transaction. A background sender then delivers
   these notes to Go **one at a time per trip, in order**, and retries if Go is busy. Nothing is lost.
4. **Go asks the server to do things:** read the trip, post a message, show "Go is typing...", react, open a vote,
   save a booking, and so on (18 kinds of request). The server answers from its database. If the same request
   arrives twice, it is done only once.
5. **Paying is protected by two separate approvals.** The server checks its own records (vote closed, within the
   budget cap, the payer tapped "Yes, book it") and only then signs a one-time spend approval. The payer must also
   confirm with Face ID in Go's vault. Go's own word is never enough.
6. **Privacy:** Go never sees phone numbers, emails, UPI ids, or anyone's own budget answer. If someone pauses Go, Go
   gets their messages with no words in them.

---

**Frontend team:** every endpoint the app can call, with parameters and responses, is in [`docs/API.md`](docs/API.md). For Postman, import [`docs/go-server.postman_collection.json`](docs/go-server.postman_collection.json).

## Folder map

| Folder / file | What it contains |
|---|---|
| `src/main.ts` | Starts everything: database, connection to Go, sender, background jobs, app API |
| `src/contract/` | The rulebook in code: types, request signing, spend-approval signing, checking of requests |
| `src/go/go-socket.ts` | The connection to Go (signing, reconnecting, matching answers to requests) |
| `src/db/` | Database helpers: transactions, "do this only once" (`once.ts`), writing a change plus its event (`write-change.ts`) |
| `src/outbox/sender.ts` | The sender that delivers events to Go in order, with retries |
| `src/requests/` | Go's 18 requests, answered from our database (reads, messages, reactions, votes, trip record, bookings, money) |
| `src/domain/` | The business logic: trip snapshot for Go, what Go may/may not see, money maths, voting, spend check, what people do in the app, our requests to Go (`ask-go.ts`) |
| `src/api/` | The API the phone app calls (`app.ts`) and the sign-in tokens (`auth.ts`) |
| `src/jobs/` | Background jobs: close votes when time runs out, "vote closing soon" pushes |
| `src/live/`, `src/push/` | Live updates to phones, and push notifications (push is a placeholder, see below) |
| `migrations/` | The database tables (SQL) |
| `contract/` | Copies of the public rulebook files and test vectors from vestrago.vercel.app |
| `tests/` | Automated tests (see below) |
| `scripts/` | Small helpers: run migrations, test setup, and `dev-stack.ts` (the whole stack locally, with a fake Go) |
| `.env.example` | The settings the server needs |

---

## Run it

You need Node 22+, pnpm, and a Postgres database (Supabase works).

```bash
pnpm install
cp .env.example .env      # fill it in. Never commit real secrets.
set -a; . ./.env; set +a
pnpm start                # creates the tables, connects to Go, starts the app API
```

Settings (see `.env.example`): `DATABASE_URL`, `GO_URL`, `GO_SIGNING_SECRET`, `GO_SPEND_PRIVATE_KEY`,
`INSTANCE_NAME` (unique per server copy; defaults to `<hostname>-<pid>`), `PORT`, `PUBLIC_BASE_URL`,
`APP_SESSION_SECRET`, `DB_POOL_MAX` (Postgres connections per server copy, default 30; the outbox uses at most a third).

## Try it locally, with nothing to set up

```bash
pnpm dev:stack    # a temporary Postgres + a fake Go + the real server on :8080 (Ctrl-C stops all of it)
pnpm postman      # in another terminal: runs the Postman collection's "Run in order" folder against it
```

The fake Go behaves as the docs' "Work without the other side" describes: when a message names Go (`@Go ...`) it
shows "Go is typing...", reads the trip, adds a ✅ and replies with one of its cards. Port `:8090` lets you (or
Postman) act as Go for the rest: `POST http://localhost:8090/sim/<method>` with Go's params, for example
`/sim/open_vote`. `GET /sim/state` shows what the fake Go has received.

## Run it against the real Go

```bash
pnpm dev:real     # reads .env, keeps a local Postgres in .pgdata/, connects to the real Go (Ctrl-C stops)
pnpm inspect      # what happened on the socket: outbox per trip, refused events, our errors, latencies
```

`.env` needs `GO_URL`, `GO_SIGNING_SECRET`, `GO_SPEND_PRIVATE_KEY` and a unique `INSTANCE_NAME`. With
`LOG_GO_TRAFFIC=1`, every socket frame is written to `logs/go-traffic.jsonl` (no secrets). Results so far are in
[`docs/REAL-GO-TESTING.md`](docs/REAL-GO-TESTING.md).

## Test it

```bash
pnpm test         # starts a real temporary Postgres by itself, no Docker needed
pnpm typecheck
```

The tests check our signing against the official test vectors, check every message we send against the rulebook's
own schemas, and run the real connection against a **mock Go** (`tests/helpers/mock-go.ts`). The mock is only a test
tool, it is not the real Go. `tests/flows.e2e.test.ts` walks through each flow page of the docs end to end, and
`tests/fake-go.e2e.test.ts` runs the real server process against the fake Go, watched from the app's side.

The full review of this server against every page of the docs (what is covered, what was fixed, what is still open)
is in [`docs/REVIEW.md`](docs/REVIEW.md).

---

## Things to know before changing code

- Every change must go through `nextSeq` + `emit` (see `src/db/write-change.ts`) inside one transaction. That is how
  Go gets every change, in order.
- Lock rows (a vote, an approval) **before** calling `nextSeq`, which locks the trip. This avoids deadlocks.
- Go's cards are stored **exactly as Go sent them** (`raw.card`), so new card fields reach the app untouched.
- Answer Go's requests from the database, never from memory: several server copies may run at once.
- Each server copy needs its own `INSTANCE_NAME`, because Go accepts each connection signature only once.

## What is still a placeholder

- **Push notifications:** `src/push/push.ts` only writes to the log. A real provider (FCM / APNs) is not connected.
- **Sign-in:** `src/api/auth.ts` uses simple signed tokens. The rulebook leaves sign-in to us (could be Supabase Auth).
- **The contract package:** the official `@go/contract` lives in a private repo we could not reach, so `src/contract/`
  is built from the public files. Same function names, so it can be swapped later.
- **Real Go:** never tested against the real or Keshav's fake Go yet, only our mock and our own fake Go (built to the
  docs' description of Keshav's fake).
