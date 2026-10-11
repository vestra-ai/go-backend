-- Rev 5 B (Go's contract 1.3, place_info): photos for the ideas on the home screen. Go knows what a place looks like;
-- the Server asks it about each idea at most once a day, in a background job, and keeps the answer here. `photos` is
-- up to 12 of { url, label? } as Go sent them; `best_months` is 1 to 12. `refresh_tried_at` is the last time Go was
-- asked (answered or not), `refreshed_at` the last time a whole answer was kept. All null until Go first answers:
-- the idea then shows as it always did.
alter table ideas add column photos jsonb;
alter table ideas add column best_months jsonb;
alter table ideas add column refresh_tried_at timestamptz;
alter table ideas add column refreshed_at timestamptz;
