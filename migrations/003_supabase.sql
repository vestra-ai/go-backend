-- Ready for Supabase: sign-in through Supabase Auth, and our tables closed to Supabase's public Data API.
-- Written so it also applies on a plain Postgres (tests, the dev stack), where Supabase's roles do not exist.

-- The Supabase Auth user a person signs in as (the access token's `sub`). Null for people made with dev tokens.
alter table people add column auth_user_id uuid unique;

-- Supabase serves every table in `public` through its Data API to anyone holding the project's publishable key.
-- Our tables are only for this server, which connects as their owner (owners skip row-level security). So:
-- turn row-level security on everywhere with no policies (nobody else may read or write a row), take away every
-- privilege from Supabase's API roles, and stop them getting privileges on tables made later.
do $$
declare
  t record;
  r text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);
    end if;
  end loop;
end $$;
