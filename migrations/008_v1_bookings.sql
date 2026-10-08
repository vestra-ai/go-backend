-- Bookings, documents and devices (docs/ALIGNMENT-PLAN.md, phase 4): the per-person booking data Go sends with
-- add_booking (GO-CHANGES 1.7), the ticket files the server copies into Storage and serves only to the people a booking
-- covers, and the locale and time zone the app registers with a push device. Additive only. 007 (money) is written by
-- another phase at the same time: nothing here depends on it.

-- What Go sends with a booking: detail rows ("Check-in · Fri 6 Nov, 2 pm"), the return leg of a round trip, and each
-- covered person's seat and PNR. `passengers` is shown only to the people in for_person_ids (app contract §1.7).
alter table bookings add column details jsonb;
alter table bookings add column return_journey jsonb;
alter table bookings add column passengers jsonb;

-- A ticket or voucher Go obtained for a booking. The file was copied once from Go's link into Storage at `path`; the
-- app never sees a stored link, only GET …/documents/:document_id, which answers a 10-minute signed URL to the people
-- the booking covers (or to everyone when visibility is `group`).
create table booking_documents (
  document_id  text primary key,
  booking_id   text not null references bookings (booking_id),
  name         text not null,
  mime         text not null,
  size_bytes   bigint not null,
  pages        int,
  visibility   text not null check (visibility in ('covered', 'group')),
  path         text not null,
  created_at   timestamptz not null default now()
);
create index booking_documents_booking on booking_documents (booking_id);

-- A device (POST /me/devices) is still a push_subscriptions row; the app also says its locale and time zone.
alter table push_subscriptions add column if not exists locale text;
alter table push_subscriptions add column if not exists tz text;

-- As in 003: the new table is only for this server. Row-level security on, nothing for Supabase's API roles.
do $$
declare
  r text;
begin
  execute 'alter table public.booking_documents enable row level security';
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.booking_documents from %I', r);
    end if;
  end loop;
end $$;
