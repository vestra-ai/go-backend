import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../scripts/migrate.js';
import { createPool } from '../../src/db/pool.js';

/** A fresh, migrated database for one test file. */
export async function freshDb(): Promise<{ pool: pg.Pool; close: () => Promise<void> }> {
  const base = process.env.TEST_PG_URL!;
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: `${base}/postgres` });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const pool = createPool(`${base}/${name}`, 20);
  await migrate(pool);
  return { pool, close: () => pool.end() };
}
