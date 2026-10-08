-- Phase 1 of docs/ALIGNMENT-PLAN.md: invites as rows of their own (so a link can be rotated and an old one answers
-- "revoked"), the bundled places dataset the city search reads, and the curated ideas the first-run home shows.
-- Additive only. As in 004, there are no "if exists" guards on purpose.

-- One row per invite link. The active link is the one with no revoked_at; `trips.invite_code` keeps mirroring it, so
-- Go's `read_trip` (which builds invite_url from that column) needs no change. Existing trips get their current code.
create table invites (
  code        text primary key,
  trip_id     text not null references trips (trip_id),
  created_by  text,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);
create index invites_trip on invites (trip_id);
insert into invites (code, trip_id, created_by, created_at)
  select invite_code, trip_id, organizer_person_id, created_at from trips;

-- Populated places for the "Travelling from" search (GET /places/cities). The rows are loaded from data/cities-in.json
-- by scripts/migrate.ts right after this file (once per version of that file), so the dataset can be replaced without
-- a new migration. `ascii_name` is the name with accents stripped, lower-cased: what a typed prefix is matched against.
create table places_cities (
  id          text primary key,
  name        text not null,
  ascii_name  text not null,
  region      text not null,
  country     text not null default 'IN',
  lat         double precision not null,
  lng         double precision not null,
  population  int not null default 0
);
create index places_cities_search on places_cities (country, ascii_name text_pattern_ops, population desc);

-- "Ideas for your crew · From Bengaluru": a curated list per origin city (GET /discover/ideas). `from_city` is the
-- origin's name as in places_cities (compared case-insensitively); null rows are the set shown when the origin is
-- unknown. `image_url` may be null (the app keeps a fallback illustration). `destination_hint` is what the app sends
-- to POST /trips when an idea is tapped.
create table ideas (
  idea_id           text primary key,
  from_city         text,
  name              text not null,
  tag               text not null,
  travel_mode       text not null check (travel_mode in ('flight', 'car', 'train', 'bus')),
  duration_minutes  int not null,
  image_url         text,
  destination_hint  text not null,
  rank              int not null default 0
);
create index ideas_from_city on ideas (lower(from_city), rank);

insert into ideas (idea_id, from_city, name, tag, travel_mode, duration_minutes, destination_hint, rank) values
  -- anywhere (the origin is unknown or not in the list)
  ('idea_any_goa',          null, 'Goa',          'Beach weekend',       'flight', 90,  'Goa',          1),
  ('idea_any_manali',       null, 'Manali',       'Snow and cafés',      'flight', 120, 'Manali',       2),
  ('idea_any_coorg',        null, 'Coorg',        'Coffee hills',        'flight', 120, 'Coorg',        3),
  ('idea_any_udaipur',      null, 'Udaipur',      'Lakes and palaces',   'flight', 90,  'Udaipur',      4),
  ('idea_any_rishikesh',    null, 'Rishikesh',    'River and yoga',      'flight', 90,  'Rishikesh',    5),
  ('idea_any_pondicherry',  null, 'Pondicherry',  'French quarter',      'flight', 120, 'Pondicherry',  6),
  ('idea_any_kochi',        null, 'Kochi',        'Backwaters',          'flight', 100, 'Kochi',        7),
  ('idea_any_jaipur',       null, 'Jaipur',       'The pink city',       'flight', 90,  'Jaipur',       8),
  -- from Bengaluru
  ('idea_blr_coorg',        'Bengaluru', 'Coorg',        'Coffee hills',        'car',    330, 'Coorg',        1),
  ('idea_blr_gokarna',      'Bengaluru', 'Gokarna',      'Quiet beaches',       'car',    480, 'Gokarna',      2),
  ('idea_blr_pondicherry',  'Bengaluru', 'Pondicherry',  'French quarter',      'car',    420, 'Pondicherry',  3),
  ('idea_blr_hampi',        'Bengaluru', 'Hampi',        'Ruins and boulders',  'car',    390, 'Hampi',        4),
  ('idea_blr_wayanad',      'Bengaluru', 'Wayanad',      'Rainforest stays',    'car',    420, 'Wayanad',      5),
  ('idea_blr_chikmagalur',  'Bengaluru', 'Chikmagalur',  'Coffee estates',      'car',    300, 'Chikmagalur',  6),
  ('idea_blr_goa',          'Bengaluru', 'Goa',          'Beach weekend',       'flight', 75,  'Goa',          7),
  ('idea_blr_ooty',         'Bengaluru', 'Ooty',         'Hill station',        'car',    330, 'Ooty',         8),
  -- from Mumbai
  ('idea_bom_goa',          'Mumbai', 'Goa',            'Beach weekend',       'flight', 70,  'Goa',            1),
  ('idea_bom_lonavala',     'Mumbai', 'Lonavala',       'Monsoon hills',       'car',    120, 'Lonavala',       2),
  ('idea_bom_alibaug',      'Mumbai', 'Alibaug',        'Beach by the ferry',  'car',    150, 'Alibaug',        3),
  ('idea_bom_mahabaleshwar','Mumbai', 'Mahabaleshwar',  'Strawberry hills',    'car',    300, 'Mahabaleshwar',  4),
  ('idea_bom_nashik',       'Mumbai', 'Nashik',         'Vineyards',           'car',    210, 'Nashik',         5),
  ('idea_bom_udaipur',      'Mumbai', 'Udaipur',        'Lakes and palaces',   'flight', 90,  'Udaipur',        6),
  ('idea_bom_matheran',     'Mumbai', 'Matheran',       'A car-free hill',     'train',  150, 'Matheran',       7),
  -- from Delhi
  ('idea_del_rishikesh',    'Delhi', 'Rishikesh',   'River and yoga',      'car',    360, 'Rishikesh',   1),
  ('idea_del_jaipur',       'Delhi', 'Jaipur',      'The pink city',       'train',  270, 'Jaipur',      2),
  ('idea_del_manali',       'Delhi', 'Manali',      'Snow and cafés',      'bus',    780, 'Manali',      3),
  ('idea_del_corbett',      'Delhi', 'Jim Corbett', 'Tiger safari',        'car',    360, 'Jim Corbett', 4),
  ('idea_del_agra',         'Delhi', 'Agra',        'The Taj at dawn',     'train',  120, 'Agra',        5),
  ('idea_del_mussoorie',    'Delhi', 'Mussoorie',   'Queen of the hills',  'car',    420, 'Mussoorie',   6),
  ('idea_del_udaipur',      'Delhi', 'Udaipur',     'Lakes and palaces',   'flight', 80,  'Udaipur',     7),
  ('idea_del_shimla',       'Delhi', 'Shimla',      'Colonial hills',      'car',    450, 'Shimla',      8),
  -- from Hyderabad
  ('idea_hyd_hampi',        'Hyderabad', 'Hampi',           'Ruins and boulders',  'car',    420, 'Hampi',           1),
  ('idea_hyd_goa',          'Hyderabad', 'Goa',             'Beach weekend',       'flight', 75,  'Goa',             2),
  ('idea_hyd_araku',        'Hyderabad', 'Araku Valley',    'Coffee valley',       'train',  720, 'Araku Valley',    3),
  ('idea_hyd_warangal',     'Hyderabad', 'Warangal',        'Temples and forts',   'car',    180, 'Warangal',        4),
  ('idea_hyd_srisailam',    'Hyderabad', 'Srisailam',       'Forest and temple',   'car',    240, 'Srisailam',       5),
  ('idea_hyd_nagarjuna',    'Hyderabad', 'Nagarjuna Sagar', 'Dam and lake',        'car',    180, 'Nagarjuna Sagar', 6),
  ('idea_hyd_pondicherry',  'Hyderabad', 'Pondicherry',     'French quarter',      'flight', 110, 'Pondicherry',     7),
  -- from Chennai
  ('idea_maa_pondicherry',  'Chennai', 'Pondicherry',    'French quarter',   'car',    180, 'Pondicherry',    1),
  ('idea_maa_mahabalipuram','Chennai', 'Mahabalipuram',  'Shore temples',    'car',    90,  'Mahabalipuram',  2),
  ('idea_maa_yelagiri',     'Chennai', 'Yelagiri',       'Quiet hills',      'car',    240, 'Yelagiri',       3),
  ('idea_maa_kodaikanal',   'Chennai', 'Kodaikanal',     'Misty lakes',      'car',    480, 'Kodaikanal',     4),
  ('idea_maa_ooty',         'Chennai', 'Ooty',           'Hill station',     'car',    540, 'Ooty',           5),
  ('idea_maa_goa',          'Chennai', 'Goa',            'Beach weekend',    'flight', 90,  'Goa',            6),
  ('idea_maa_kochi',        'Chennai', 'Kochi',          'Backwaters',       'flight', 80,  'Kochi',          7),
  ('idea_maa_tranquebar',   'Chennai', 'Tranquebar',     'The Danish coast', 'car',    300, 'Tranquebar',     8),
  -- from Kolkata
  ('idea_ccu_darjeeling',   'Kolkata', 'Darjeeling',    'Tea and the toy train', 'flight', 60,  'Darjeeling',    1),
  ('idea_ccu_puri',         'Kolkata', 'Puri',          'Beach and temple',      'train',  480, 'Puri',          2),
  ('idea_ccu_shantiniketan','Kolkata', 'Shantiniketan', 'Tagore''s town',        'train',  150, 'Shantiniketan', 3),
  ('idea_ccu_sundarbans',   'Kolkata', 'Sundarbans',    'Mangrove safari',       'car',    180, 'Sundarbans',    4),
  ('idea_ccu_digha',        'Kolkata', 'Digha',         'Beach drive',           'car',    240, 'Digha',         5),
  ('idea_ccu_gangtok',      'Kolkata', 'Gangtok',       'Himalayan city',        'flight', 70,  'Gangtok',       6),
  ('idea_ccu_bishnupur',    'Kolkata', 'Bishnupur',     'Terracotta temples',    'train',  240, 'Bishnupur',     7),
  -- from Pune
  ('idea_pnq_lonavala',     'Pune', 'Lonavala',       'Monsoon hills',     'car',    90,  'Lonavala',       1),
  ('idea_pnq_mahabaleshwar','Pune', 'Mahabaleshwar',  'Strawberry hills',  'car',    180, 'Mahabaleshwar',  2),
  ('idea_pnq_goa',          'Pune', 'Goa',            'Beach weekend',     'flight', 60,  'Goa',            3),
  ('idea_pnq_alibaug',      'Pune', 'Alibaug',        'Beach weekend',     'car',    180, 'Alibaug',        4),
  ('idea_pnq_lavasa',       'Pune', 'Lavasa',         'Lakeside town',     'car',    90,  'Lavasa',         5),
  ('idea_pnq_tapola',       'Pune', 'Tapola',         'Mini Kashmir',      'car',    240, 'Tapola',         6),
  ('idea_pnq_kaas',         'Pune', 'Kaas Plateau',   'Valley of flowers', 'car',    180, 'Kaas Plateau',   7),
  ('idea_pnq_bhimashankar', 'Pune', 'Bhimashankar',   'Forest trek',       'car',    150, 'Bhimashankar',   8);

-- As in 003 and 004: only for this server. Row-level security on, nothing for Supabase's API roles.
do $$
declare
  t text;
  r text;
begin
  foreach t in array array['invites', 'places_cities', 'ideas'] loop
    execute format('alter table public.%I enable row level security', t);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on public.%I from %I', t, r);
      end if;
    end loop;
  end loop;
end $$;
