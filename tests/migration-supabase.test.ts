// Migration 003 on a database that looks like Supabase's: the anon and authenticated roles exist and, as on Supabase,
// get privileges on every table in public by default. After 003 they can read nothing, now or in tables made later.
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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

it("closes every table to Supabase's API roles, including tables made later", async () => {
  const base = process.env.TEST_PG_URL!;
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: `${base}/postgres` });
  await admin.connect();
  await admin.query(`create database ${name}`);
  // Roles are shared by every database in the test cluster; create them once.
  for (const role of ['anon', 'authenticated']) {
    await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role} nologin; end if; end $$`);
  }
  await admin.end();
  pool = createPool(`${base}/${name}`, 3);

  // As on Supabase: the API roles may use the schema and get privileges on every new table.
  await pool.query('grant usage on schema public to anon, authenticated');
  await pool.query('alter default privileges in schema public grant all on tables to anon, authenticated');
  dir = mkdtempSync(join(tmpdir(), 'go-mig-sb-'));
  mkdirSync(join(dir, 'before'));
  for (const f of ['001_core.sql', '002_people_actions.sql']) copyFileSync(new URL(`../migrations/${f}`, import.meta.url), join(dir, 'before', f));
  await migrate(pool, pathToFileURL(join(dir, 'before') + '/'));
  const canRead = async (role: string, table: string) => (await pool!.query(`select has_table_privilege($1, $2, 'select') as ok`, [role, `public.${table}`])).rows[0].ok as boolean;
  expect(await canRead('anon', 'people')).toBe(true); // the danger 003 removes

  const applied = await migrate(pool);
  expect(applied.slice(0, 2)).toEqual(['003_supabase.sql', '004_v1_conventions.sql']);
  expect(applied).toContain('006_v1_room.sql');
  for (const role of ['anon', 'authenticated']) {
    for (const table of ['people', 'trips', 'messages', 'outbox', 'spend_approvals', 'push_subscriptions', 'schema_migrations', 'idempotency_keys', 'invite_marks', 'live_tickets', 'uploads']) {
      expect(await canRead(role, table), `${role} on ${table}`).toBe(false);
    }
  }
  // A table made later by the server (the owner) is not opened to them either.
  await pool.query('create table later_table (x int)');
  expect(await canRead('anon', 'later_table')).toBe(false);
  // Our server is the owner: row-level security does not get in its way.
  expect((await pool.query('select count(*)::int as n from people')).rows[0].n).toBe(0);
});
