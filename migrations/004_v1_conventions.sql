-- The app contract's conventions (docs/ALIGNMENT-PLAN.md, phase 0): the Idempotency-Key store, the Me fields the app
-- shows, a read marker per membership, the invite marks and live tickets that later phases fill, and a device id for
-- push registrations. Additive only: nothing here changes what the earlier migrations store.
-- `invites` (the move of trips.invite_code) is left to the phase that rewrites invites; moving the column now would
-- touch every trip read for no behaviour change.

-- One answer per (person, method, path, key) for 24 hours: a repeat with the same body gets the stored answer back.
create table idempotency_keys (
  person_id   text not null,
  method      text not null,
  path        text not null,
  key         text not null,
  body_hash   text not null,
  status      int not null,
  response    jsonb,
  created_at  timestamptz not null default now(),
  primary key (person_id, method, path, key)
);
create index idempotency_keys_created on idempotency_keys (created_at);

-- What the app's Me shows: the sign-in email and provider (filled on the first Supabase sign-in), the default
-- "travelling from", the notifications switch, and when the account was deleted (phase 1 fills it).
alter table people add column auth_provider text;
alter table people add column from_city_default text;
alter table people add column notifications_enabled boolean not null default true;
alter table people add column deleted_at timestamptz;

-- The last change number the person has read in a trip (POST /trips/:trip/read): unread counts and catch-up.
alter table trip_people add column last_read_seq bigint not null default 0;

-- "Not now" and "Decline" on an invite preview, per person and code. Decline tells nobody.
create table invite_marks (
  person_id  text not null references people (person_id),
  code       text not null,
  state      text not null check (state in ('later', 'declined')),
  at         timestamptz not null default now(),
  primary key (person_id, code)
);

-- Single-use tickets for the live connection (POST /live/ticket): 30 seconds, one socket per (person, device).
create table live_tickets (
  ticket      text primary key,
  person_id   text not null references people (person_id),
  device_id   text,
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index live_tickets_expires on live_tickets (expires_at);

-- A push registration is a device to the app (POST /me/devices → device_id, DELETE /me/devices/:device_id).
-- Existing rows each get their own id (a volatile default is evaluated once per row).
alter table push_subscriptions add column device_id text not null default ('dev_' || replace(gen_random_uuid()::text, '-', ''));
create unique index push_subscriptions_device on push_subscriptions (device_id);

-- As in 003: the new tables are only for this server. Row-level security on, nothing for Supabase's API roles.
do $$
declare
  t text;
  r text;
begin
  foreach t in array array['idempotency_keys', 'invite_marks', 'live_tickets'] loop
    execute format('alter table public.%I enable row level security', t);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on public.%I from %I', t, r);
      end if;
    end loop;
  end loop;
end $$;
