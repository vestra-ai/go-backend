-- People can do more in the app: the link from a cancellation vote to its booking, Web Push subscriptions
-- and the nudge rate limit. This file runs as one statement batch, so it applies whole or not at all.
-- There are no "if exists" guards on purpose: if the process dies after this batch and before the tracking
-- row is written, a second run fails loudly instead of hiding the state. (Recovery: insert the tracking row by hand.)

-- A vote that asks "cancel this booking?" points at the booking it would cancel. Only the Server uses this;
-- it is never sent to Go. There is deliberately no foreign key: a key-share lock on the booking row would
-- make opening a vote wait for the row locks the booking paths take.
alter table decisions add column cancels_booking_id text;
create unique index decisions_one_open_cancel on decisions (cancels_booking_id)
  where cancels_booking_id is not null and status = 'open';

-- Browsers' push subscriptions (Web Push). Replaces push_devices. An endpoint belongs to one person at a time.
create table push_subscriptions (
  endpoint    text primary key,
  person_id   text not null references people (person_id),
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);
create index push_subscriptions_person on push_subscriptions (person_id);

-- When one person last reminded another about money in a trip: one reminder per pair per trip per 24 hours.
create table nudges (
  trip_id         text not null references trips (trip_id),
  from_person_id  text not null,
  to_person_id    text not null,
  last_sent_at    timestamptz not null,
  primary key (trip_id, from_person_id, to_person_id)
);

drop table push_devices;
