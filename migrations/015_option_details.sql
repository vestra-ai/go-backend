-- Rev 5 E (Go's contract 1.3, get_option_details): everything about one option on one of Go's options cards, for the
-- app's Details page. Asked of Go when a person opens Details, and kept here for an hour so the next person to open
-- the same option does not wait on Go. Only a whole answer is kept: one Go marks `complete: false` is shown and
-- asked again. Nothing here is about a person.
create table option_details (
  trip_id     text not null references trips (trip_id),
  card_id     text not null,
  option_id   text not null,
  details     jsonb not null,
  fetched_at  timestamptz not null default now(),
  primary key (trip_id, card_id, option_id)
);

-- As in 003: the new table is only for this server. Row-level security on, nothing for Supabase's API roles.
do $$
declare
  r text;
begin
  execute 'alter table public.option_details enable row level security';
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.option_details from %I', r);
    end if;
  end loop;
end $$;
