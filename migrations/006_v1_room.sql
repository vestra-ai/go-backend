-- The room, live and uploads (docs/ALIGNMENT-PLAN.md, phase 2): the uploads the app makes before it references them in a
-- message, Go's quick replies on a message, the server's own system messages, one reaction per person per message, and
-- "I'm flexible" votes. Additive only: nothing here changes what the earlier migrations store.

-- An upload the app signed for (POST /uploads): the file lands in Storage at `path`; a message (or the profile photo)
-- then references it by `upload_id`, which marks it used. Unused uploads are swept after `expires_at` (24 hours).
create table uploads (
  upload_id   text primary key,
  person_id   text not null references people (person_id),
  purpose     text not null check (purpose in ('chat_attachment', 'profile_photo')),
  kind        text not null check (kind in ('photo', 'file', 'audio')),
  mime        text not null,
  name        text,
  size_bytes  bigint not null,
  width       int,
  height      int,
  duration_s  real,
  path        text not null unique,
  created_at  timestamptz not null default now(),
  used_at     timestamptz,
  expires_at  timestamptz not null
);
create index uploads_unused on uploads (expires_at) where used_at is null;

-- Go's quick replies under a message (GO-CHANGES 1.3): stored as sent, null when there are none.
alter table messages add column quick_replies jsonb;

-- The server itself posts messages (joins, "X won", the card of a person-opened vote): author kind `system`.
alter table messages drop constraint messages_author_kind_check;
alter table messages add constraint messages_author_kind_check check (author_kind in ('person', 'go', 'system'));

-- One reaction per person per message (app contract §4.6): a new emoji replaces the old one. Older rows that break the
-- rule keep only the latest reaction. Go's reactions (no person) are not limited.
delete from reactions r using reactions newer
  where r.person_id is not null and newer.person_id = r.person_id and newer.message_id = r.message_id and newer.created_at > r.created_at;
create unique index reactions_one_per_person on reactions (message_id, person_id) where person_id is not null;

-- "I'm flexible, any of these work" (GO-CHANGES 1.5): a vote that counts toward `voted` and names no option.
alter table votes alter column option_index drop not null;
alter table votes add column flexible boolean not null default false;
alter table votes add constraint votes_option_or_flexible check ((flexible and option_index is null) or (not flexible and option_index is not null));

-- As in 003: the new table is only for this server. Row-level security on, nothing for Supabase's API roles.
do $$
declare
  r text;
begin
  execute 'alter table public.uploads enable row level security';
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.uploads from %I', r);
    end if;
  end loop;
end $$;
