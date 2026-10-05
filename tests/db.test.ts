import { afterAll, beforeAll, expect, it } from 'vitest';
import type pg from 'pg';
import { freshDb } from './helpers/db.js';

let pool: pg.Pool;
let close: () => Promise<void>;
beforeAll(async () => ({ pool, close } = await freshDb()));
afterAll(() => close());

it('applies the migration to a real Postgres', async () => {
  const { rows } = await pool.query("select count(*)::int as n from information_schema.tables where table_schema = 'public'");
  expect(rows[0].n).toBeGreaterThanOrEqual(15);
});
