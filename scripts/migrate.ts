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

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const applied = await migrate(client);
  console.log(applied.length ? `applied ${applied.join(', ')}` : 'up to date');
  await client.end();
}
