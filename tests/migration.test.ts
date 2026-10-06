import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate.js';
import { createPool } from '../src/db/pool.js';

let pool: pg.Pool | undefined;
let dir = '';
afterAll(async () => {
  await pool?.end();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it('migration 002 applies on top of a database at 001 with data in it, and keeps one open cancellation vote per booking', async () => {
  const base = process.env.TEST_PG_URL!;
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: `${base}/postgres` });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  pool = createPool(`${base}/${name}`, 5);

  // [1] A database that is at 001 only, with a booking, votes and a device registration in it.
  dir = mkdtempSync(join(tmpdir(), 'go-mig-'));
  mkdirSync(join(dir, 'only-001'));
  copyFileSync(new URL('../migrations/001_core.sql', import.meta.url), join(dir, 'only-001', '001_core.sql'));
  expect(await migrate(pool, pathToFileURL(join(dir, 'only-001') + '/'))).toEqual(['001_core.sql']);
  await pool.query(`insert into people (person_id, name) values ('p_a', 'A')`);
  await pool.query(`insert into trips (trip_id, title, organizer_person_id, invite_code) values ('t_1', 'T', 'p_a', 'inv_1')`);
  await pool.query(
    `insert into bookings (booking_id, trip_id, kind, title, vendor, ref, amount_minor, currency, payer_person_id)
     values ('b_1', 't_1', 'stay', 'Villa', 'V', 'R', 100, 'INR', 'p_a')`,
  );
  await pool.query(`insert into push_devices (token, person_id, platform) values ('tok', 'p_a', 'ios')`);
  for (const [id, status] of [['d_old_open', 'open'], ['d_old_closed', 'closed']]) {
    await pool.query(`insert into decisions (decision_id, trip_id, question, kind, options, of_count, status) values ($1, 't_1', 'Where?', 'choice', '[]', 1, $2)`, [id, status]);
  }
  await pool.query(`insert into votes (decision_id, person_id, option_index) values ('d_old_open', 'p_a', 0)`);

  // [2] The real directory applies only 002, the new shape is there, the old table is gone, and old data stayed.
  expect(await migrate(pool)).toEqual(['002_people_actions.sql']);
  const tables = (await pool.query(`select table_name from information_schema.tables where table_schema = 'public'`)).rows.map((r) => r.table_name);
  expect(tables).toEqual(expect.arrayContaining(['push_subscriptions', 'nudges']));
  expect(tables).not.toContain('push_devices');
  expect((await pool.query(`select booking_id from bookings`)).rows).toEqual([{ booking_id: 'b_1' }]);
  // The old votes and their vote survive, with the new column empty (so they are outside the one-open-vote rule).
  expect((await pool.query(`select decision_id, status, cancels_booking_id from decisions order by decision_id`)).rows).toEqual([
    { decision_id: 'd_old_closed', status: 'closed', cancels_booking_id: null },
    { decision_id: 'd_old_open', status: 'open', cancels_booking_id: null },
  ]);
  expect((await pool.query(`select count(*)::int as n from votes`)).rows[0].n).toBe(1);

  // [3] A second open cancellation vote for the same booking is refused; once the first has closed, another is allowed.
  const vote = (id: string, status: string) =>
    pool!.query(
      `insert into decisions (decision_id, trip_id, question, kind, options, of_count, status, cancels_booking_id)
       values ($1, 't_1', 'Cancel?', 'yesno', '[]', 1, $2, 'b_1')`,
      [id, status],
    );
  await vote('d_1', 'open');
  await expect(vote('d_2', 'open')).rejects.toMatchObject({ code: '23505' });
  await pool.query(`update decisions set status = 'closed' where decision_id = 'd_1'`);
  await expect(vote('d_3', 'open')).resolves.toBeTruthy();

  // [4] Running the migrations again applies nothing.
  expect(await migrate(pool)).toEqual([]);
});
