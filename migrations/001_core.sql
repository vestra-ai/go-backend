-- The Server's database. One row set per trip; every change takes the trip's next change number (trips.seq).

create table people (
  person_id   text primary key,
  name        text not null,
  photo_url   text,
  -- Contact details stay here. They are never sent to Go.
  phone       text,
  email       text,
  upi_id      text,
  created_at  timestamptz not null default now()
);

create table trips (
  trip_id              text primary key,
  title                text not null,
  status               text not null default 'planning' check (status in ('planning','booked','on_trip','over')),
  organizer_person_id  text not null,
  invite_code          text not null unique,
  destination          jsonb,
  dates_start          date,
  dates_end            date,
  vibe                 jsonb not null default '[]',
  stay                 text,
  currency             text not null default 'INR',
  plan_minor           bigint,
  itinerary            jsonb not null default '[]',
  seq                  bigint not null default 0,   -- the trip's change counter; trip.created takes 1
  created_at           timestamptz not null default now()
);

create table trip_people (
  trip_id          text not null references trips (trip_id),
  person_id        text not null references people (person_id),
  role             text not null default 'member' check (role in ('organizer','member')),
  joined_at        timestamptz not null default now(),
  left_at          timestamptz,
  from_city        text,
  earliest_leave   text,
  know             jsonb not null default '[]',
  -- A person's own budget answer. Never sent to Go: only the lowest band is.
  budget_min_minor bigint,
  budget_max_minor bigint,
  go_paused        boolean not null default false,
  last_seen_at     timestamptz,
  primary key (trip_id, person_id)
);

create table messages (
  message_id        text primary key,
  trip_id           text not null references trips (trip_id),
  seq               bigint not null,
  updated_seq       bigint not null,
  author_kind       text not null check (author_kind in ('person','go')),
  author_person_id  text,
  text              text,
  attachments       jsonb not null default '[]',
  reply_to          text,
  about_message_id  text,
  mentions_go       boolean not null default false,
  mentions          jsonb not null default '[]',
  card              jsonb,                       -- exactly as Go sent it (raw.card), never rebuilt
  card_id           text,                        -- copied out of card, so a card id is used once per trip
  withheld          boolean not null default false,
  deleted           boolean not null default false,
  edited_at         timestamptz,
  sent_at           timestamptz not null default now(),
  unique (trip_id, seq)
);
create index messages_updated on messages (trip_id, updated_seq);
create unique index messages_card on messages (trip_id, card_id) where card_id is not null;

create table reactions (
  trip_id     text not null references trips (trip_id),
  message_id  text not null references messages (message_id),
  person_id   text,                              -- null: Go's reaction
  emoji       text not null,
  created_at  timestamptz not null default now()
);
create unique index reactions_once on reactions (message_id, coalesce(person_id, ''), emoji);

create table decisions (
  decision_id          text primary key,
  trip_id              text not null references trips (trip_id),
  question             text not null,
  kind                 text not null check (kind in ('choice','yesno')),
  anonymous            boolean not null default false,
  status               text not null default 'open' check (status in ('open','closed','cancelled')),
  opened_by_person_id  text,                     -- null: Go opened it
  options              jsonb not null,
  of_count             int not null,
  closes_at            timestamptz,
  closing_push_sent_at timestamptz,
  closed_at            timestamptz,
  result_index         int,
  mandate              jsonb,                    -- {choice_index, cap_minor, currency, refundable_only, payer_person_id, set_at, confirmed_at, declined_at}
  opened_at            timestamptz not null default now()
);
create index decisions_trip on decisions (trip_id);

create table votes (
  decision_id   text not null references decisions (decision_id),
  person_id     text not null,
  option_index  int not null,
  voted_at      timestamptz not null default now(),
  primary key (decision_id, person_id)
);

create table record_lines (
  line_id      text primary key,
  trip_id      text not null references trips (trip_id),
  kind         text not null check (kind in ('decided','agreed','open','doing','booked')),
  text         text not null,
  status       text not null default 'active' check (status in ('active','done','undone')),
  proof        jsonb not null default '[]',
  person_ids   jsonb not null default '[]',
  due_at       timestamptz,
  decision_id  text,
  booking_id   text,
  source       text not null check (source in ('go','person','vote','booking')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index record_lines_trip on record_lines (trip_id, created_at);

create table bookings (
  booking_id          text primary key,
  trip_id             text not null references trips (trip_id),
  kind                text not null,
  status              text not null default 'confirmed' check (status in ('confirmed','cancelled')),
  title               text not null,
  vendor              text not null,
  ref                 text not null,
  amount_minor        bigint not null,
  currency            text not null,
  payer_person_id     text not null,
  for_person_ids      jsonb not null default '[]',
  refundable_until    timestamptz,
  starts_at           timestamptz,
  ends_at             timestamptz,
  journey             jsonb,
  place               jsonb,
  image_url           text,
  decision_id         text,
  approval_id         text,
  added_by_person_id  text,
  created_at          timestamptz not null default now()
);
create index bookings_trip on bookings (trip_id, created_at);

create table expenses (
  expense_id          text primary key,
  trip_id             text not null references trips (trip_id),
  paid_by_person_id   text not null,
  amount_minor        bigint not null check (amount_minor > 0),
  currency            text not null,
  note                text not null,
  category            text not null,
  split_person_ids    jsonb not null,
  booking_id          text,
  added_by_person_id  text,
  removed_at          timestamptz,
  created_at          timestamptz not null default now()
);
create index expenses_trip on expenses (trip_id, created_at);

-- A spend approval the server signed (guides/money.md, "The approval row").
create table spend_approvals (
  approval_id      text primary key,
  trip_id          text not null references trips (trip_id),
  request_id       text not null,
  decision_id      text not null,
  payer_person_id  text not null,
  amount_minor     bigint not null,
  currency         text not null,
  merchant         text not null,
  approval         text not null,
  expires_at       timestamptz not null,
  used_at          timestamptz,
  cancelled_at     timestamptz,
  booking_id       text,
  created_at       timestamptz not null default now(),
  unique (trip_id, request_id)
);
create index spend_approvals_decision on spend_approvals (decision_id);

-- Every write Go sends is done once per (trip_id, request_id); a repeat gets the first answer back.
create table go_requests (
  trip_id     text not null,
  request_id  text not null,
  answer      jsonb not null,
  created_at  timestamptz not null default now(),
  primary key (trip_id, request_id)
);

-- Every event for Go, written in the same transaction as the change it describes.
create table outbox (
  event_id         text primary key,
  trip_id          text not null references trips (trip_id),
  seq              bigint not null,
  body             jsonb not null,
  status           text not null default 'pending' check (status in ('pending','sent','failed')),
  attempts         int not null default 0,
  next_attempt_at  timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  sent_at          timestamptz,
  unique (trip_id, seq)
);
create index outbox_pending on outbox (trip_id, seq) where status = 'pending';

-- For pushes.
create table push_devices (
  token       text primary key,
  person_id   text not null,
  platform    text not null,
  created_at  timestamptz not null default now()
);
create index push_devices_person on push_devices (person_id);
