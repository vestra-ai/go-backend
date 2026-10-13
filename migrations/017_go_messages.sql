-- Slack alerts (13 Oct 2026): how many messages Go has posted in each trip, counted as they go in (post_message), so
-- "this trip reached another 50 of Go's messages" is one exact step, alerted once. Go's replies cost model tokens.
-- The trips that exist start from what they already hold.
alter table trips add column go_messages integer not null default 0;
update trips t set go_messages = (select count(*) from messages m where m.trip_id = t.trip_id and m.author_kind = 'go');
