# Supabase: sign-in with Google and the database

Everything on our side is built and tested locally, against a fake Supabase Auth that issues the same kind of
tokens as Supabase. When the Supabase project is ready, setup is: fill in `.env`, turn on Google in Supabase, run
`pnpm check:supabase`. No code changes.

## How the tokens travel

Think of a hotel:
- **Google** is the passport office. It confirms who you are.
- **Supabase Auth** is the reception. It hands you a key card.
- **Our server** is the door lock. It checks the key card itself, without phoning reception each time.

```
 ① Sign in        ② Who is this?        ③ Key card              ④ Every request
 App ──────▶ Google ──────▶ Supabase Auth ──────▶ App ──────────────────▶ Our server
     "Sign in        Google says:         access token (1 h)       Authorization: Bearer <access token>
      with Google"   "this is Priya"      + refresh token          checked locally, Priya found, request done
```

1. **App to Google.** Priya taps "Sign in with Google" and picks her account. Google gives the app proof of who she is.
2. **Google to Supabase.** The app passes that proof to Supabase. Supabase checks it with Google and finds or creates
   Priya's Supabase user.
3. **Supabase to app.** Supabase gives the app two tokens:
   - an **access token** (the key card): a note signed by Supabase saying "this is user 7f3a…, valid until 15:30",
     lasting about an hour;
   - a **refresh token**, used to get a new key card before the old one runs out. `supabase_flutter` does this by
     itself.
4. **App to our server, on every call.** The app sends `Authorization: Bearer <access token>`. The server:
   - checks Supabase's signature using the project's public keys (fetched once and kept, so there is no call to
     Supabase per request);
   - checks the token was issued by our project, for a signed-in user (audience `authenticated`), and hasn't expired;
   - reads the user id (`sub`) and finds Priya's person record. The first time, it creates one from her Google name
     and photo.
5. **When the key card runs out**, the server answers 401. The app refreshes the session once and retries.

**Our server never issues tokens and never sees Google's token.** Supabase is the only one that issues tokens; our
server only checks them, so no passwords or Google secrets are kept here. Our own "dev" tokens (`POST /app/people`)
exist only for local testing and are refused when `NODE_ENV=production`.

## What the server does (`src/api/auth.ts`)

| | |
|---|---|
| Mode | `AUTH_MODE=supabase` (the default when `SUPABASE_URL` is set), or `dev` for local testing |
| Checked | Signature against `SUPABASE_URL/auth/v1/.well-known/jwks.json` (ES256/RS256/EdDSA); issuer `SUPABASE_URL/auth/v1`; audience `authenticated`; role `authenticated`; not anonymous; expiry, with 30 s of clock leeway |
| Older projects | With `SUPABASE_JWT_SECRET` set, tokens signed with the legacy shared secret (HS256) are accepted too |
| Refused (401) | No token, expired (the message says to refresh), another project, another audience, the anon/publishable key, anonymous users, a key the project never published, changed claims, `alg: none`, our dev tokens |
| First sign-in | Creates the person: name from Google (else the start of the email address), photo if it is an https link, email kept on our side only. Two first calls at the same moment make one person. A later Google name never overwrites what the person set in `PATCH /app/me` |
| Link | `people.auth_user_id` (migration 003) = the Supabase user id |

## The database on Supabase

- **Use the session pooler** connection string, on port **5432**:
  - The direct address is IPv6-only.
  - The transaction pooler (port 6543) breaks two things we need: live updates (LISTEN/NOTIFY) and the outbox's
    locks.
- **Pool size:** set `DB_POOL_MAX=10`. The session pooler allows about 15 clients on small plans.
- **TLS:** this is turned on automatically for Supabase addresses. Download the CA certificate (Database settings →
  SSL) and set `DATABASE_CA_CERT` to its path, so the server checks it is really talking to Supabase.
- **Migration 003** keeps our tables private:
  - It turns on row-level security on every table, with no policies.
  - It removes every privilege from Supabase's public API roles (`anon`, `authenticated`), including on tables made
    later.

  Without it, anyone with the app's publishable key could read our tables through Supabase's Data API. Our server
  connects as the tables' owner, so none of this affects it. Tested in `tests/migration-supabase.test.ts`.
- **Table creation:** the server creates the tables itself the first time it starts (migrations 001–003, under a
  lock, so several instances can start together).

## Try it now, locally (no account needed)

```bash
pnpm dev:stack:supabase    # temporary Postgres + fake Go + the server in AUTH_MODE=supabase + a fake Supabase Auth on :54331
curl 'http://127.0.0.1:54331/mint?name=Priya&email=priya@gmail.com'              # a Supabase-style access token
curl localhost:8080/app/me -H "authorization: Bearer <access_token>"              # Priya, created on first sign-in
```

`pnpm dev:auth` runs the fake Supabase Auth on its own, for any server started with
`AUTH_MODE=supabase SUPABASE_URL=http://127.0.0.1:54331`. The tests are in `tests/supabase-auth.test.ts` and
`tests/migration-supabase.test.ts`.

## Rehearse on a local Supabase (Docker)

The official local Supabase runs the real Supabase Auth, Postgres and Data API on your Mac. The rehearsal runs our
server against it with nothing faked on the Supabase side (only Go is the fake Go):

```bash
npx supabase start -x studio,storage-api,imgproxy,realtime,edge-runtime,logflare,vector,supavisor,postgres-meta
pnpm supabase:rehearse        # add --fresh to wipe the local database first
npx supabase stop             # when done (the data is kept for next time)
```

It checks, against the real local Supabase:
- a real Supabase sign-up signs a person in, and the same person comes back after a token refresh;
- a trip, a join and a message all work, and the fake Go gets the events, with no email address in them;
- the anon key and changed tokens are refused;
- Supabase's own Data API gives the publishable key 401 and a signed-in token 403 (`permission denied`) on our
  tables.

`pnpm check:supabase` against it comes back all green except "Google sign-in is off", which is expected locally.
The settings are in `supabase/config.toml`, with Google ready but off. Generated signing keys
(`supabase/signing_keys.json`) are gitignored.

**Result (7 Oct): ✅ everything passed**, using Supabase's published ES256 keys (the default for new projects), with
no shared secret set.

## When the Supabase project is ready

1. **Copy these values from Supabase into `.env`:**

   | `.env` | Where in Supabase |
   |---|---|
   | `SUPABASE_URL` | Project Settings → API → Project URL (`https://<ref>.supabase.co`) |
   | `SUPABASE_PUBLISHABLE_KEY` | Project Settings → API Keys → publishable key (`sb_publishable_…`). Not used by the server; for `pnpm check:supabase` and `pnpm dev:login`, and it goes in the app |
   | `DATABASE_URL` | Connect → **Session pooler** URI, with the database password filled in |
   | `DATABASE_CA_CERT` | Database settings → SSL → download the certificate; put the file path here |
   | `DB_POOL_MAX` | `10` |
   | `SUPABASE_JWT_SECRET` | Only if the project has **no** signing keys (JWT Keys page shows only the legacy secret). Better: turn on signing keys there |

   Leave `AUTH_MODE` empty, or set it to `supabase`.
2. **Set up Google sign-in.**
   1. In Google Cloud, create an OAuth consent screen and a **Web** OAuth client.
   2. Add `https://<ref>.supabase.co/auth/v1/callback` to that client's authorised redirect URIs.
   3. In Supabase → Authentication → Providers → Google, turn it on and paste the Web client ID and secret.
   4. Then, depending on how the app signs in:
      - **Native sign-in** (`google_sign_in` + `signInWithIdToken`): also create Android and iOS OAuth clients, and
        list all their client IDs in the Google provider's "Client IDs" field.
      - **Browser sign-in** (`signInWithOAuth`): add the app's deep link (for example `com.vestra.go://login-callback`)
        to Authentication → URL Configuration → Redirect URLs.
3. **Check.** Run `pnpm check:supabase`. It checks, read-only:
   - the signing keys are published;
   - Google is on;
   - the database connects over TLS;
   - LISTEN and the locks work;
   - the migrations are applied;
   - row-level security is on everywhere;
   - the API roles can read nothing.
4. **Sign in once for real.**
   1. Add `http://localhost:3000` to Supabase's Redirect URLs.
   2. Start the server with `APP_ORIGINS=http://localhost:3000`.
   3. Run `pnpm dev:login`, open http://localhost:3000, click "Sign in with Google", then "Call GET /app/me".
5. **Postman:** paste the access token from step 4 into the `token` variable. Everything works the same way.

## Testing before Google is on: email test users

The server only ever sees Supabase's token, never how the person signed in, and Supabase's email sign-in gives the
same kind of token as Google. To test now:
1. In Supabase, go to **Authentication → Users → Add user**, enter an email and password, and tick Auto Confirm.
2. Put the login in your local `.env` as `SUPABASE_TEST_EMAIL` and `SUPABASE_TEST_PASSWORD` (add `_2` for a
   second user).
3. Run `pnpm supabase:token`. It prints a real access token; add `--me <server>` to call `GET /app/me` with it.
   The `pnpm dev:login` page also has an email sign-in box.

This tests exactly the production path, with no bypass in the code.

## For the app team (Flutter)

```dart
// After sign-in, on every call to our server:
final token = Supabase.instance.client.auth.currentSession?.accessToken;
headers['Authorization'] = 'Bearer $token';
// On a 401: await Supabase.instance.client.auth.refreshSession(); then retry once.
```

The first call after sign-in creates the person. Call `GET /app/me` to show their profile, and `PATCH /app/me` to set
a UPI id or change the name or photo.
