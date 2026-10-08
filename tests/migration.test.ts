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

it('migrations 002 onwards apply on top of a database at 001 with data in it, and keep one open cancellation vote per booking', async () => {
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
  const applied = await migrate(pool);
  expect(applied.slice(0, 3)).toEqual(['002_people_actions.sql', '003_supabase.sql', '004_v1_conventions.sql']);
  expect(applied).toContain('006_v1_room.sql'); // later phases add their own files after 004; each is listed by its own test
  expect(applied).toEqual([...applied].sort());
  const tables = (await pool.query(`select table_name from information_schema.tables where table_schema = 'public'`)).rows.map((r) => r.table_name);
  expect(tables).toEqual(expect.arrayContaining(['push_subscriptions', 'nudges', 'idempotency_keys', 'invite_marks', 'live_tickets', 'uploads']));
  expect(tables).not.toContain('push_devices');
  expect((await pool.query(`select booking_id from bookings`)).rows).toEqual([{ booking_id: 'b_1' }]);
  // 004: the Me columns with their defaults, the read marker, and a device id for each existing push registration.
  expect((await pool.query(`select auth_provider, from_city_default, notifications_enabled, deleted_at from people where person_id = 'p_a'`)).rows[0]).toEqual({ auth_provider: null, from_city_default: null, notifications_enabled: true, deleted_at: null });
  await pool.query(`insert into trip_people (trip_id, person_id) values ('t_1', 'p_a')`);
  expect((await pool.query(`select last_read_seq from trip_people`)).rows[0]).toEqual({ last_read_seq: 0 });
  await pool.query(`insert into push_subscriptions (endpoint, person_id, p256dh, auth) values ('https://fcm.googleapis.com/a', 'p_a', 'k', 'a'), ('https://fcm.googleapis.com/b', 'p_a', 'k', 'a')`);
  const devices = (await pool.query(`select device_id from push_subscriptions`)).rows.map((r) => r.device_id as string);
  expect([devices.every((d) => /^dev_[0-9a-f]{32}$/.test(d)), new Set(devices).size]).toEqual([true, 2]);
  // The old votes and their vote survive, with the new column empty (so they are outside the one-open-vote rule).
  expect((await pool.query(`select decision_id, status, cancels_booking_id from decisions order by decision_id`)).rows).toEqual([
    { decision_id: 'd_old_closed', status: 'closed', cancels_booking_id: null },
    { decision_id: 'd_old_open', status: 'open', cancels_booking_id: null },
  ]);
  expect((await pool.query(`select count(*)::int as n from votes`)).rows[0].n).toBe(1);
  // 006: a flexible vote names no option; a vote for an option is not flexible; system messages and quick replies are allowed.
  await expect(pool.query(`insert into votes (decision_id, person_id, option_index, flexible) values ('d_old_open', 'p_b', 0, true)`)).rejects.toMatchObject({ code: '23514' });
  await pool.query(`insert into votes (decision_id, person_id, option_index, flexible) values ('d_old_open', 'p_b', null, true)`);
  await pool.query(`insert into messages (message_id, trip_id, seq, updated_seq, author_kind, text, quick_replies) values ('m_sys', 't_1', 1, 1, 'system', 'Trip created · A joined', null)`);

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
