-- Phase 3 of docs/ALIGNMENT-PLAN.md: money. Payments people make to each other outside Go (settlements), and the
-- approval of an expense by the people in its split (docs/APP-CONTRACT-CHANGES.md §4.9, docs/GO-CHANGES.md 2.5).
-- Additive only. As in 004 and 005, there are no "if exists" guards on purpose.

-- "Record a payment": money one person sent another outside Go. It counts provisionally while the payee has not
-- answered; a dispute puts the amount back. `seq` is the change number the last change to the row took. Go is told
-- (settlement.recorded) only when the payee confirms.
create table settlements (
  settlement_id   text primary key,
  trip_id         text not null references trips (trip_id),
  from_person_id  text not null,
  to_person_id    text not null,
  amount_minor    bigint not null check (amount_minor > 0),
  currency        text not null,
  method          text not null check (method in ('upi', 'cash', 'bank_transfer', 'other')),
  note            text,
  status          text not null default 'pending_confirmation' check (status in ('pending_confirmation', 'confirmed', 'disputed')),
  created_at      timestamptz not null default now(),
  responded_at    timestamptz,
  seq             bigint
);
create index settlements_trip on settlements (trip_id, created_at);

-- An expense's standing with the people in its split: `approved` when every entry is approved, `disputed` when any is,
-- else `pending`. Kept on the row (recomputed on every answer) so lists can filter by it. Every expense that exists
-- today was added before approval existed: approved.
alter table expenses add column status text not null default 'approved' check (status in ('pending', 'approved', 'disputed'));
create index expenses_status on expenses (trip_id, status) where removed_at is null;

-- One row per person in the split other than the payer (the payer is implicitly approved). `at` is when the row was
-- made or last answered; `reason` is a disputer's words, if any.
create table expense_confirmations (
  expense_id  text not null references expenses (expense_id),
  person_id   text not null,
  state       text not null default 'pending' check (state in ('pending', 'approved', 'disputed')),
  at          timestamptz not null default now(),
  reason      text,
  primary key (expense_id, person_id)
);
create index expense_confirmations_person on expense_confirmations (person_id, state);

-- As in 003 to 005: the new tables are only for this server. Row-level security on, nothing for Supabase's API roles.
do $$
declare
  t text;
  r text;
begin
  foreach t in array array['settlements', 'expense_confirmations'] loop
    execute format('alter table public.%I enable row level security', t);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on public.%I from %I', t, r);
      end if;
    end loop;
  end loop;
end $$;
