-- Web check-in (docs/ALIGNMENT-PLAN.md, phase 5; app contract §4.12): the server's copy of what Go found on the
-- airline site for one person on one flight booking, so the Trip home, the strip and the check-in sheets read it
-- without asking Go every time, and still show it when Go is away. Additive only.

-- One row per (flight booking, covered person). `state` is the app contract's CheckinState as Go last answered it,
-- with the person's own answers (DigiYatra, declaration, seat) laid over it until they complete the check-in. `status`
-- is what the strip and the home card need from state.status: `open` while the person can act (Go's open, or a failed
-- attempt they may retry), `done` once checked in, `not_open` otherwise (not yet open, Go still working, or closed).
create table checkins (
  booking_id  text not null references bookings (booking_id),
  person_id   text not null references people (person_id),
  status      text not null check (status in ('not_open', 'open', 'done')),
  state       jsonb not null,
  updated_at  timestamptz not null default now(),
  primary key (booking_id, person_id)
);

-- As in 003: the new table is only for this server. Row-level security on, nothing for Supabase's API roles.
do $$
declare
  r text;
begin
  execute 'alter table public.checkins enable row level security';
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.checkins from %I', r);
    end if;
  end loop;
end $$;
