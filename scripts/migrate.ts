import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';

/**
 * Applies migrations/*.sql in name order, once each. Several instances may start at the same moment, so the
 * whole run holds a Postgres advisory lock: the second instance waits, then finds everything applied.
 */
export async function migrate(db: pg.Client | pg.Pool, dir = new URL('../migrations/', import.meta.url)): Promise<string[]> {
  const client = db instanceof pg.Pool ? await db.connect() : db;
  try {
    await client.query(`select pg_advisory_lock(hashtext('go_server_migrate'))`);
    try {
      await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
      const done = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name as string));
      const applied: string[] = [];
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
        if (done.has(file)) continue;
        await client.query(readFileSync(new URL(file, dir), 'utf8'));
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        applied.push(file);
      }
      return applied;
    } finally {
      await client.query(`select pg_advisory_unlock(hashtext('go_server_migrate'))`);
    }
  } finally {
    if (db instanceof pg.Pool) (client as pg.PoolClient).release();
  }
}

// `pnpm migrate`: applies the migrations to DATABASE_URL (from the environment, else .env), over TLS for Supabase with
// DATABASE_CA_CERT, exactly as the server does when it starts.
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const { loadEnv } = await import('./dev-real.js');
  const { createPool } = await import('../src/db/pool.js');
  const env = process.env.DATABASE_URL ? process.env : { ...loadEnv(), ...process.env };
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const pool = createPool(env.DATABASE_URL, 2, env.DATABASE_CA_CERT || undefined);
  const applied = await migrate(pool);
  console.log(applied.length ? `applied ${applied.join(', ')}` : 'up to date');
  await pool.end();
}
