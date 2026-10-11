# Deploying the Go Server (Railway)

| | |
|---|---|
| Railway project | `go-server-backend` (workspace "vestra-verse's Projects"), environment `production` |
| Service | `server`, built by Railpack from GitHub `vestra-ai/go-backend`, branch `main`. Every push to `main` redeploys |
| Region | US East Metal, Virginia (`us-east4-eqdc4a`), next to the Supabase database (us-east-1) |
| Start | `pnpm start` (runs `src/main.ts` with tsx). The tables are migrated at start, under a lock; the city dataset is loaded once per version of its file |
| Health check | `GET /health` → `{"ok":true,"go":true}` once the socket to Go is open (also at `GET /app/v1/health`) |
| Database | Supabase Postgres, through the session pooler, with TLS checked against `certs/prod-ca-2021.crt` |
| Files | Supabase Storage, one **private** bucket (`go-files`), signed upload and download links from the server |
| Go | Keshav's `brain` (Railway project `go`). That project is the Go team's, not ours: don't change it |

## Before the first deploy with files: the Storage bucket

In the Supabase project: **Storage → New bucket**, name `go-files` (or whatever `SUPABASE_STORAGE_BUCKET` says),
**private** (public off), no file-size or MIME limit needed (the server enforces 25 MB and its own allow-list). Nothing
else: the server signs upload and download links with the project's secret key; the app never holds a Storage key.

## Variables

Not secret (set on the service):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production`: Supabase sign-in is required, and dev tokens are refused |
| `GO_URL` | `https://brain-production-6b68.up.railway.app` |
| `GO_SERVER_NAME` | `go-server-prod`: this deployment's one name to Go, sent as `&server=` on the socket. The same on every instance and across deploys; never the same as staging's. Without it Go keeps a trip with one instance, and a redeploy strands every trip made before it (seen on 11 Oct 2026, 07:24Z) and people's ixigo logins. **On the first deploy that sets it:** a trip follows this name from its next message or other event (a quiet trip stays out of Go's reach until someone acts in it, as after any deploy before), and an organizer logs in to ixigo once more on their next new trip; after that, deploys change neither |
| `SUPABASE_URL` | `https://rbltcfpcqkefazsonzbb.supabase.co` |
| `DATABASE_CA_CERT` | `certs/prod-ca-2021.crt` |
| `DB_POOL_MAX` | `10` |
| `PUBLIC_BASE_URL` | the web app's public address: invite links are `<it>/invite/<code>` (production: `https://go-frontend-three.vercel.app`) |
| `APP_ORIGINS` | the web app's exact address(es), comma-separated, no wildcard |
| `SUPABASE_STORAGE_BUCKET` | `go-files`: the private Storage bucket (above). Default `go-files` when unset |
| `GO_CONTRACT` | Go's contract version as its `/v1/health` says it (production: `1.3.0`); any 1.x from 1.1 up sends a re-split expense as `expense.changed updated`. `1.0` (the default, and what Go spoke on 8 Oct 2026): a re-split expense takes its change number but sends no event, because Go 1.0's `expense.changed` knows only `added` and `removed`; Go reads the expense's state on its next `read_trip`. Set `1.1` the day Keshav's team ships `docs/GO-CHANGES.md` |
| `FEATURE_*` | the feature flags (below), only the ones to change from their defaults |

Secret (pasted by a person in Railway → service → Variables → Raw Editor; never in git or chat):

| Variable | What |
|---|---|
| `DATABASE_URL` | Supabase session pooler string with the database password |
| `GO_SIGNING_SECRET` | the socket signing secret shared with the Go team |
| `GO_SPEND_PRIVATE_KEY` | our Ed25519 spend key (one line with `\n`); the Go team holds its public half |
| `INTERNAL_API_KEY` | optional: the App team's key for the internal routes (`/internal/v1`: look a person up, delete or forget any person, reset a test trip; `docs/API.md` §10), sent as `x-internal-key`. Generate with `openssl rand -hex 32` and share it with the App team by one-time link. **Unset: every internal route answers `404`.** Rotate it by changing the variable (a redeploy) |
| `SUPABASE_SECRET_KEY` | the project's secret key (`sb_secret_…`, Project Settings → API Keys): it signs Storage upload and download links. **With it set, `STORAGE` defaults to `supabase`**; without it the server keeps files in memory, warns at start, and loses them on every redeploy |

Feature flags (`1` or `0`; unset = the default from `src/config.ts`). Each is served to the app by `GET /app/v1/config`
and `docs/API.md` §9 says what it hides. Flip one on the day Go's side of that item is live:

| Variable | Default | On |
|---|---|---|
| `FEATURE_CHECKIN` | off | the three web check-in routes exist (`get_checkin` / `submit_checkin` on Go's side) |
| `FEATURE_VISA` | off | `POST /app/v1/me/vault-link { start: "add_documents" }` is allowed; checklist rows drive the home card |
| `FEATURE_CALLS` | off | `POST …/cards/:id/share` (call recordings into the room) |
| `FEATURE_VOTE_RETRACT` | off | `DELETE …/decisions/:id/vote` |
| `FEATURE_VOTE_FLEXIBLE` | off | `PUT …/vote { flexible: true }` |
| `FEATURE_CLAIM` | off | tells the app Go handles the `claim` card action (nothing changes on the server) |

Left out on purpose:
- `STORAGE`: `supabase` follows from `SUPABASE_SECRET_KEY`; `memory` is for laptops and tests.
- `AUTH_MODE`: `supabase` follows from `SUPABASE_URL`.
- `INSTANCE_NAME`: the default, `<hostname>-<pid>`, is unique per container, so two copies during a redeploy never clash.
  It changes on every deploy, which is why `GO_SERVER_NAME` above must be set.
- `LOG_GO_TRAFFIC`: it writes to a local file, and the container's disk is not kept.
- `APP_SESSION_SECRET`: only used by dev sign-in, which does not exist in production.

## Testing the deployed server before Google sign-in is on

1. Create test users in Supabase: **Authentication → Users → Add user → Create new user**, with Auto Confirm.
2. Put their logins in your local `.env` as `SUPABASE_TEST_EMAIL` and `SUPABASE_TEST_PASSWORD` (and
   `SUPABASE_TEST_EMAIL_2` and `SUPABASE_TEST_PASSWORD_2`, and so on).
3. Get a token: `pnpm supabase:token --me https://<server address>` prints a real Supabase access token, valid for
   about an hour, and calls `GET /app/v1/me` with it. Use it as `Authorization: Bearer …`.

These are real Supabase tokens, the same kind Google sign-in gives, so this tests the production path. There's no
bypass in the code and nothing to remove later.

## Checks after a deploy

- Build log: Node 22 and pnpm detected; the install succeeded.
- Deploy log: `sign-in: supabase (…)`, `storage: supabase bucket go-files` (not the `STORAGE=memory` warning),
  `go socket open`, `listening`, and `internal routes (/internal/v1): on` or `off` as intended.
- Every error the server answers Go with is a `warn` line: `[go] <method> answered <code> trip=… request=… field=…: <message>`.
  Search the deploy log for `[go] ` and `answered` when Go reports a refusal. Internal calls are `[internal] …` lines.
- `GET /health` and `GET /app/v1/health` return `{"ok":true,"go":true}`.
- `GET /app/v1/config` returns the contract version and the `features` you expect.
- `GET /app/v1/me` with no token returns `401` with the one error shape and an `X-Request-Id` header.
  `POST /app/v1/dev/sign-in` returns `404` (dev sign-in is off).
- With a test-user token: `POST /app/v1/uploads` answers a `upload_url` on `<SUPABASE_URL>/storage/v1/...`; a `PUT`
  of a small JPEG to it succeeds; a message naming the `upload_id` comes back with a signed `url` that loads.
- From the web app's origin, a preflight (`OPTIONS` with `Access-Control-Request-Method`) answers `204` with
  `access-control-allow-headers: authorization, content-type, idempotency-key`.
- `GET /internal/v1/people?email=x` with no `x-internal-key` answers `404`; with the key (when set), `404` for an unknown email.
- Locally, `pnpm check:supabase` is still green.
