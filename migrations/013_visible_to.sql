-- A message only some people can see (Go's post_message `visible_to_person_ids`, our 1.1 overlay): each traveller's own
-- flight options and booking flow, a note for the organizer only. The ids as Go sent them, a JSON array of person ids;
-- null means everyone, as every message before this one. Go reads every message; each app read leaves out the messages
-- whose list does not name the reader. The message still takes a change number, so people outside the list see a gap in seq.
alter table messages add column visible_to_person_ids jsonb;
