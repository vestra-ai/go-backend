// Is this server ready to run on a Supabase project? Run it after filling .env (or pass --env <file>):
//   pnpm check:supabase
// Read-only: it never writes to the database or changes anything in Supabase. Each line is ✅, ⚠️ or ❌.
import pg from 'pg';
import { createPool } from '../src/db/pool.js';
import { loadEnv } from './dev-real.js';

const envFile = process.argv.includes('--env') ? process.argv[process.argv.indexOf('--env') + 1]! : '.env';
const env = { ...loadEnv(envFile), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(SUPABASE_|DATABASE_|AUTH_MODE)/.test(k))) } as Record<string, string | undefined>;
let failed = 0;
const ok = (m: string) => console.log(`  ✅ ${m}`);
const warn = (m: string) => console.log(`  ⚠️  ${m}`);
const bad = (m: string) => (failed++, console.log(`  ❌ ${m}`));

console.log(`\nSupabase readiness check (${envFile})\n\n1. Sign-in`);
const url = env.SUPABASE_URL?.replace(/\/+$/, '');
const mode = env.AUTH_MODE || (url ? 'supabase' : 'dev');
if (mode !== 'supabase') bad(`AUTH_MODE is ${mode}: set SUPABASE_URL (and leave AUTH_MODE empty or set it to supabase)`);
else if (!url) bad('SUPABASE_URL is not set');
else {
  ok(`AUTH_MODE=supabase, project ${url}`);
  try {
    const r = await fetch(`${url}/auth/v1/.well-known/jwks.json`);
    const keys = ((await r.json()) as { keys?: Array<{ alg?: string; kid?: string }> }).keys ?? [];
    if (keys.length) ok(`signing keys published: ${keys.map((k) => k.alg).join(', ')} (tokens are checked locally against them)`);
    else if (env.SUPABASE_JWT_SECRET) warn('no published signing keys: the project uses the legacy shared secret (SUPABASE_JWT_SECRET is set, so HS256 tokens will work). Consider switching to signing keys in Supabase.');
    else bad('no published signing keys and no SUPABASE_JWT_SECRET: no token could be checked. Turn on signing keys in Supabase, or set the legacy JWT secret.');
  } catch (err) {
    bad(`cannot reach ${url}/auth/v1/.well-known/jwks.json: ${(err as Error).message}`);
  }
  const key = env.SUPABASE_PUBLISHABLE_KEY;
  if (!key) warn('SUPABASE_PUBLISHABLE_KEY not set: skipping the provider check (the server itself does not need it; the app does)');
  else {
    try {
      const s = (await (await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } })).json()) as { external?: Record<string, boolean> };
      if (s.external?.google) ok('Google sign-in is turned on');
      else bad('Google sign-in is off: Supabase → Authentication → Providers → Google');
    } catch (err) {
      warn(`could not read the auth settings: ${(err as Error).message}`);
    }
  }
}

console.log('\n2. Database');
if (!env.DATABASE_URL) bad('DATABASE_URL is not set');
else {
  const u = new URL(env.DATABASE_URL);
  if (u.port === '6543') bad('port 6543 is the transaction pooler: live updates (LISTEN) and the outbox locks need the session pooler (port 5432) or the direct connection');
  if (/supabase/.test(u.hostname) && !env.DATABASE_CA_CERT) warn('DATABASE_CA_CERT not set: TLS is on, but the certificate is not checked. Download it from Database settings → SSL.');
  const pool: pg.Pool = createPool(env.DATABASE_URL, 2, env.DATABASE_CA_CERT);
  try {
    const v = (await pool.query('select version() as v, current_user as u')).rows[0];
    ok(`connected as ${v.u}: ${String(v.v).split(' on ')[0]}`);
    const c = await pool.connect();
    try {
      await c.query('listen go_check');
      const heard = new Promise<boolean>((r) => {
        c.once('notification', () => r(true));
        setTimeout(() => r(false), 3000);
      });
      await pool.query(`select pg_notify('go_check', 'x')`);
      if (await heard) ok('LISTEN/NOTIFY works (live updates across instances)');
      else bad('LISTEN/NOTIFY did not deliver: use the session pooler or the direct connection');
      const got = (await c.query(`select pg_try_advisory_lock(hashtext('go_check')) as ok`)).rows[0].ok;
      await c.query(`select pg_advisory_unlock(hashtext('go_check'))`);
      if (got) ok('session advisory locks work (one sender per trip, migration lock)');
      else bad('could not take an advisory lock');
    } finally {
      c.release();
    }
    const migrated = await pool.query(`select name from schema_migrations order by name`).catch(() => null);
    if (!migrated) warn('no tables yet: the server creates them (migrations 001-003) the first time it starts');
    else {
      ok(`migrations applied: ${migrated.rows.map((r) => r.name).join(', ')}`);
      const open = await pool.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
      if (open.rowCount) bad(`row-level security is off on: ${open.rows.map((r) => r.relname).join(', ')}`);
      else ok('row-level security is on for every table');
      const roles = (await pool.query(`select rolname from pg_roles where rolname in ('anon', 'authenticated')`)).rows.map((r) => r.rolname);
      for (const role of roles) {
        const exposed = await pool.query(
          `select c.relname as table_name from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm') and has_table_privilege($1, c.oid, 'select')`,
          [role],
        );
        if (exposed.rowCount) bad(`Supabase's ${role} role can still read: ${exposed.rows.map((r) => r.table_name).join(', ')}`);
        else ok(`the public Data API (${role}) cannot read any of our tables`);
      }
      if (!roles.length) warn('no anon/authenticated roles: this is not a Supabase database (fine for a local check)');
    }
  } catch (err) {
    bad(`cannot connect: ${(err as Error).message}`);
  } finally {
    await pool.end();
  }
}

console.log(failed ? `\n${failed} problem(s) to fix.\n` : '\nReady.\n');
process.exit(failed ? 1 : 0);
