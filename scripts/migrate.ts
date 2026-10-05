import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';

/** Applies migrations/*.sql in name order, once each. */
export async function migrate(db: pg.Client | pg.Pool, dir = new URL('../migrations/', import.meta.url)): Promise<string[]> {
  await db.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const done = new Set((await db.query('select name from schema_migrations')).rows.map((r) => r.name as string));
  const applied: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    await db.query(readFileSync(new URL(file, dir), 'utf8'));
    await db.query('insert into schema_migrations (name) values ($1)', [file]);
    applied.push(file);
  }
  return applied;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const applied = await migrate(client);
  console.log(applied.length ? `applied ${applied.join(', ')}` : 'up to date');
  await client.end();
}
