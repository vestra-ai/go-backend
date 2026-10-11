// Migration 012 (rev 4, block B6): the closing migration drops what approval, disputes, payback confirmation, private
// budgets, push and invite marks stored, and must not move anybody's balance. The expected numbers below were produced by
// the money rules as they stood before those rules were removed: commit 159e8b3's src/domain/money.ts, run on these rows
// with each expense's standing derived as the old loader derived it, from its confirmations and never from the row's own
// status column (output/contract-rev4/evidence/b6-baseline-rows.ts; recorded in the build log).
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate.js';
import { createPool } from '../src/db/pool.js';
import { tripMoney } from '../src/domain/money-view.js';
import { balances } from '../src/domain/money.js';

const pools: pg.Pool[] = [];
let dir = '';
const freshDatabase = async (): Promise<pg.Pool> => {
  const base = process.env.TEST_PG_URL!;
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: `${base}/postgres` });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const pool = createPool(`${base}/${name}`, 5);
  pools.push(pool);
  return pool;
};
let pool: pg.Pool;
let applied: string[] = [];

beforeAll(async () => {
  // A database at 011 (everything before the closing migration), with money in every standing the old rules knew.
  dir = mkdtempSync(join(tmpdir(), 'go-mig-rev4-'));
  const real = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(real).filter((f) => f.endsWith('.sql') && f < '012')) copyFileSync(new URL(f, real), join(dir, f));
  pool = await freshDatabase();
  await migrate(pool, pathToFileURL(dir + '/'));
  await pool.query(`insert into people (person_id, name) values ('p_a', 'A'), ('p_b', 'B'), ('p_c', 'C')`);
  await pool.query(`insert into trips (trip_id, title, organizer_person_id, invite_code, currency) values ('t_m', 'T', 'p_a', 'inv_m', 'INR')`);
  await pool.query(
    `insert into trip_people (trip_id, person_id, role, joined_at, budget_min_minor, budget_max_minor) values
       ('t_m', 'p_a', 'organizer', now(), 100, 200), ('t_m', 'p_b', 'member', now() + interval '1 second', null, null), ('t_m', 'p_c', 'member', now() + interval '2 seconds', null, null)`,
  );
  // Expenses: pending, approved, and disputed. The disputed one's own status column says "pending": the standing is derived from its entries.
  await pool.query(
    `insert into expenses (expense_id, trip_id, paid_by_person_id, amount_minor, currency, note, category, split_person_ids, status, created_at) values
       ('e_pending',  't_m', 'p_a', 30000, 'INR', 'Dinner', 'food',  '["p_a","p_b","p_c"]', 'pending',  now()),
       ('e_approved', 't_m', 'p_b', 12000, 'INR', 'Room',   'stay',  '["p_a","p_b"]',       'approved', now() + interval '1 second'),
       ('e_disputed', 't_m', 'p_c', 90000, 'INR', 'Boat',   'other', '["p_a","p_b","p_c"]', 'pending',  now() + interval '2 seconds'),
       ('e_column_only', 't_m', 'p_b', 6000, 'INR', 'Kayak', 'activities', '["p_b","p_c"]',  'disputed', now() + interval '3 seconds')`, // the column says disputed, no entry does: the old rules counted it
  );
  await pool.query(
    `insert into expense_confirmations (expense_id, person_id, state) values
       ('e_pending', 'p_b', 'pending'), ('e_pending', 'p_c', 'pending'), ('e_approved', 'p_a', 'approved'), ('e_disputed', 'p_a', 'approved'), ('e_disputed', 'p_b', 'disputed'), ('e_column_only', 'p_c', 'approved')`,
  );
  await pool.query(
    `insert into settlements (settlement_id, trip_id, from_person_id, to_person_id, amount_minor, currency, method, status) values
       ('st_pending', 't_m', 'p_b', 'p_a', 5000, 'INR', 'upi', 'pending_confirmation'), ('st_confirmed', 't_m', 'p_c', 'p_a', 4000, 'INR', 'cash', 'confirmed'), ('st_disputed', 't_m', 'p_a', 'p_c', 7000, 'INR', 'upi', 'disputed')`,
  );
  await pool.query(`insert into push_subscriptions (endpoint, person_id, p256dh, auth) values ('https://fcm.googleapis.com/a', 'p_a', 'k', 'a')`);
  await pool.query(`insert into nudges (trip_id, from_person_id, to_person_id, last_sent_at) values ('t_m', 'p_a', 'p_c', now())`);
  await pool.query(`insert into invite_marks (person_id, code, state) values ('p_c', 'inv_m', 'declined')`);
  applied = await migrate(pool); // the real directory: 012 and what came after it are left to apply
});
afterAll(async () => {
  for (const p of pools) await p.end();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it('012 moves nobody\'s balance: every balance, the transfers and the totals equal what the old rules gave for the same rows', async () => {
  expect(applied.filter((f) => f.endsWith('.sql'))).toEqual(['012_rev4_cleanup.sql', '013_visible_to.sql', '014_ticket_approvals.sql', '015_option_details.sql']);
  const m = await tripMoney(pool, 't_m');
  expect(Object.fromEntries(balances(m.expenses, m.order, m.settlements))).toEqual({ p_a: 5000, p_b: 4000, p_c: -9000 });
  expect([m.money.spent_minor, m.money.by_category, m.money.transfers]).toEqual([
    48000,
    [{ category: 'stay', amount_minor: 12000 }, { category: 'food', amount_minor: 30000 }, { category: 'activities', amount_minor: 6000 }],
    [{ from_person_id: 'p_c', to_person_id: 'p_a', amount_minor: 5000, currency: 'INR' }, { from_person_id: 'p_c', to_person_id: 'p_b', amount_minor: 4000, currency: 'INR' }],
  ]);
});

it('the disputed expense is marked removed and the disputed payback is gone; everything else is kept', async () => {
  const expenses = (await pool.query(`select expense_id, removed_at is not null as removed from expenses order by expense_id`)).rows;
  const settlements = (await pool.query(`select settlement_id from settlements order by settlement_id`)).rows.map((r) => r.settlement_id);
  expect(expenses).toEqual([{ expense_id: 'e_approved', removed: false }, { expense_id: 'e_column_only', removed: false }, { expense_id: 'e_disputed', removed: true }, { expense_id: 'e_pending', removed: false }]);
  expect(settlements).toEqual(['st_confirmed', 'st_pending']);
});

it('what the removed features stored is gone: four tables and seven columns on five more; what replaces them is there; a rerun applies nothing', async () => {
  const tables = (await pool.query(`select table_name from information_schema.tables where table_schema = 'public'`)).rows.map((r) => r.table_name as string);
  const columns = (await pool.query(`select table_name || '.' || column_name as c from information_schema.columns where table_schema = 'public'`)).rows.map((r) => r.c as string);
  const gone = ['expenses.status', 'settlements.status', 'settlements.responded_at', 'trip_people.budget_min_minor', 'trip_people.budget_max_minor', 'people.notifications_enabled', 'decisions.closing_push_sent_at'];
  expect(['expense_confirmations', 'push_subscriptions', 'nudges', 'invite_marks'].filter((t) => tables.includes(t))).toEqual([]);
  expect(gone.filter((c) => columns.includes(c))).toEqual([]);
  expect(['trips.budget_per_person_minor', 'messages.ledger', 'messages.visible_to_person_ids', 'expenses.removed_at', 'settlements.seq'].filter((c) => !columns.includes(c))).toEqual([]);
  expect(await migrate(pool)).toEqual([]); // nothing left to apply
});

it('every migration, 001 to 015, applies to an empty database', async () => {
  const empty = await freshDatabase();
  const applied = (await migrate(empty)).filter((f) => f.endsWith('.sql'));
  expect([applied[0], applied.at(-1), applied.length]).toEqual(['001_core.sql', '015_option_details.sql', 15]);
});
