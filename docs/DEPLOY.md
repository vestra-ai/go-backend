# Deploying the Go Server (Railway)

| | |
|---|---|
| Railway project | `go-server-backend` (workspace "vestra-verse's Projects"), environment `production` |
| Service | `server`, built by Railpack from GitHub `vestra-ai/go-backend`, branch `main`. Every push to `main` redeploys |
| Region | US East Metal, Virginia (`us-east4-eqdc4a`), next to the Supabase database (us-east-1) |
| Start | `pnpm start` (runs `src/main.ts` with tsx). The tables are migrated at start, under a lock |
| Health check | `GET /health` → `{"ok":true,"go":true}` once the socket to Go is open |
| Database | Supabase Postgres, through the session pooler, with TLS checked against `certs/prod-ca-2021.crt` |
| Go | Keshav's `brain` (Railway project `go`). That project is the Go team's, not ours: don't change it |

## Variables

Not secret (set on the service):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production`: Supabase sign-in is required, and dev tokens are refused |
| `GO_URL` | `https://brain-production-6b68.up.railway.app` |
| `SUPABASE_URL` | `https://rbltcfpcqkefazsonzbb.supabase.co` |
| `DATABASE_CA_CERT` | `certs/prod-ca-2021.crt` |
| `DB_POOL_MAX` | `10` |
| `PUBLIC_BASE_URL` | the service's public address (invite links are `<it>/j/<code>`) |
| `APP_ORIGINS` | the web app's exact address(es), if there is a browser app |

Secret (pasted by a person in Railway → service → Variables → Raw Editor; never in git or chat):

| Variable | What |
|---|---|
| `DATABASE_URL` | Supabase session pooler string with the database password |
| `GO_SIGNING_SECRET` | the socket signing secret shared with the Go team |
| `GO_SPEND_PRIVATE_KEY` | our Ed25519 spend key (one line with `\n`); the Go team holds its public half |

Left out on purpose:
- `INSTANCE_NAME`: the default, `<hostname>-<pid>`, is unique per container, so two copies during a redeploy never
  clash.
- `LOG_GO_TRAFFIC`: it writes to a local file, and the container's disk is not kept.
- `APP_SESSION_SECRET`: only used by dev sign-in.
- `VAPID_*`: push notifications are only logged until these are set.

## Testing the deployed server before Google sign-in is on

1. Create test users in Supabase: **Authentication → Users → Add user → Create new user**, with Auto Confirm.
2. Put their logins in your local `.env` as `SUPABASE_TEST_EMAIL` and `SUPABASE_TEST_PASSWORD` (and
   `SUPABASE_TEST_EMAIL_2` and `SUPABASE_TEST_PASSWORD_2`, and so on).
3. Get a token: `pnpm supabase:token --me https://<server address>` prints a real Supabase access token, valid for
   about an hour. Use it as `Authorization: Bearer …` in curl or Postman.

These are real Supabase tokens, the same kind Google sign-in gives, so this tests the production path. There's no
bypass in the code and nothing to remove later.

## Checks after a deploy

- Build log: Node 22 and pnpm detected; the install succeeded.
- Deploy log: `sign-in: supabase (…)`, `go socket open`, `listening`.
- `GET /health` returns `{"ok":true,"go":true}`.
- `GET /app/me` with no token returns 401. `POST /app/people` returns 404 (dev sign-in is off).
- Locally, `pnpm check:supabase` is still green.
