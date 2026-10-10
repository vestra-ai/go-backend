-- App contract rev 4 (block B3): money lines in the room. The Server posts a system message for every money movement;
-- `ledger` says which movement and which row, for the app only (Go's reads of the message never carry it).
alter table messages add column ledger jsonb;
