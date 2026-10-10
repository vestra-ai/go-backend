-- App contract rev 4 (block B4): one budget for the whole group. A trip has an optional amount per person, the same for
-- everyone, in the trip's currency. It replaces the private per-person answers (trip_people.budget_min_minor and
-- budget_max_minor), which nothing reads any more and which the closing migration drops.
alter table trips add column budget_per_person_minor bigint check (budget_per_person_minor > 0);
