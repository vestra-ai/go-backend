-- App contract rev 4 (block B6): the closing migration. The Server no longer has expense approval or disputes, payback
-- confirmation, private budgets, push notifications, Nudge or invite marks; this removes what they stored.
-- NOT REVERSIBLE: the data dropped here is gone. (Owner decision C4, 10 Oct 2026.)
--
-- Nobody's balance moves. Until now a disputed expense and a disputed payback counted in nothing; from now on every
-- expense and every payback that exists counts. So the disputed ones are taken out first, and everything else stays.
-- An expense is disputed when any of its confirmations is (the row's own status column was a copy, never trusted).
update expenses e
   set removed_at = now()
 where e.removed_at is null
   and exists (select 1 from expense_confirmations c where c.expense_id = e.expense_id and c.state = 'disputed');

delete from settlements where status = 'disputed';

-- Expense approval and payback confirmation.
drop table expense_confirmations;
alter table expenses drop column status;                 -- its index expenses_status goes with it
alter table settlements drop column status, drop column responded_at;

-- Private budgets (the group's one budget is trips.budget_per_person_minor, migration 011).
alter table trip_people drop column budget_min_minor, drop column budget_max_minor;

-- Push notifications, Nudge, and the "closing soon" reminder's marker.
drop table push_subscriptions;
drop table nudges;
alter table people drop column notifications_enabled;
alter table decisions drop column closing_push_sent_at;

-- "Not now" and "Decline" on an invite link.
drop table invite_marks;
