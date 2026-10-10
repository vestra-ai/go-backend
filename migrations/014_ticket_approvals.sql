-- Go's 1.2 ticket approval (rev 5 H): a traveller's own ticket, paid by them, with no group vote behind it.
--
-- Each time a person taps an option on one of Go's options cards, the Server keeps the pick: who, which card and option,
-- the option's price as the card showed it, and when. Go's ticket request names only the person, so the Server grants it
-- against that person's most recent pick from the last 30 minutes at that price (and currency).
create table option_picks (
  pick_id      text primary key,
  trip_id      text not null references trips (trip_id),
  person_id    text not null,
  card_id      text not null,
  message_id   text not null,
  option_id    text not null,
  price_minor  bigint,
  currency     text,
  picked_at    timestamptz not null default now()
);
create index option_picks_person on option_picks (trip_id, person_id, picked_at desc);

-- As in 003: the new table is only for this server. Row-level security on, nothing for Supabase's API roles.
do $$
declare
  r text;
begin
  execute 'alter table public.option_picks enable row level security';
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.option_picks from %I', r);
    end if;
  end loop;
end $$;

-- A ticket approval has no vote: decision_id is null, for_person_id names the traveller (always the payer), and pick_id
-- the pick it was granted against. A group approval is unchanged (decision_id set, the other two null).
alter table spend_approvals alter column decision_id drop not null;
alter table spend_approvals add column for_person_id text;
alter table spend_approvals add column pick_id text references option_picks (pick_id);
create index spend_approvals_pick on spend_approvals (pick_id) where pick_id is not null;
