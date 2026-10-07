// A real Supabase access token for a test user, without Google: signs in with email + password (Supabase's email
// provider issues the same kind of token as Google sign-in; our server cannot tell them apart).
//   pnpm supabase:token                  user 1: SUPABASE_TEST_EMAIL / SUPABASE_TEST_PASSWORD from .env
//   pnpm supabase:token --user 2         user 2: SUPABASE_TEST_EMAIL_2 / SUPABASE_TEST_PASSWORD_2
//   pnpm supabase:token --me <server>    also calls GET <server>/app/me with it
// Create the test users in Supabase: Authentication → Users → Add user → Create new user, with Auto Confirm.
// The token lasts about an hour. Never commit it; never use test users in the real app.
import { loadEnv } from './dev-real.js';

const arg = (name: string) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined);
const env = loadEnv(arg('env') ?? '.env');
const n = arg('user') ?? '1';
const suffix = n === '1' ? '' : `_${n}`;
const email = env[`SUPABASE_TEST_EMAIL${suffix}`];
const password = env[`SUPABASE_TEST_PASSWORD${suffix}`];
const url = env.SUPABASE_URL?.replace(/\/+$/, '');
const key = env.SUPABASE_PUBLISHABLE_KEY;
if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be in .env');
if (!email || !password) throw new Error(`SUPABASE_TEST_EMAIL${suffix} and SUPABASE_TEST_PASSWORD${suffix} must be in .env`);

const r = await fetch(`${url}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: key, 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const j = (await r.json()) as { access_token?: string; expires_in?: number; user?: { id: string }; error_description?: string; msg?: string };
if (!j.access_token) {
  console.error(`Supabase refused the sign-in (${r.status}): ${j.error_description ?? j.msg ?? JSON.stringify(j)}`);
  console.error('Check the email/password, that the user exists and is confirmed, and that the Email provider is on.');
  process.exit(1);
}
console.error(`Signed in as ${email} (Supabase user ${j.user?.id}); the token expires in ${Math.round((j.expires_in ?? 3600) / 60)} min.`);
console.log(j.access_token);

const server = arg('me');
if (server) {
  const me = await fetch(`${server.replace(/\/+$/, '')}/app/me`, { headers: { authorization: `Bearer ${j.access_token}` } });
  console.error(`GET ${server}/app/me → ${me.status} ${await me.text()}`);
}
