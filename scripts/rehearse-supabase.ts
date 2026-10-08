// A rehearsal of production sign-in and database on the official LOCAL Supabase (Docker), with nothing faked on the
// Supabase side: real Supabase Auth issues the tokens, real Supabase Postgres holds our tables, and Supabase's real
// Data API is asked whether our tables are visible. Only Go is the fake Go.
//
//   npx supabase start -x studio,storage-api,imgproxy,realtime,edge-runtime,logflare,vector,supavisor,postgres-meta
//   pnpm supabase:rehearse            (add --fresh to wipe the local database first)
//
// Test users are made with random emails and passwords that are never printed. Everything runs on 127.0.0.1.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { MockGo } from '../tests/helpers/mock-go.js';

const sh = (args: string[]) => execFileSync('npx', ['supabase', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
if (process.argv.includes('--fresh')) {
  console.log('Wiping the local Supabase database (supabase db reset)…');
  sh(['db', 'reset']);
}
const status = JSON.parse(sh(['status', '-o', 'json'])) as Record<string, string>;
const SB = status.API_URL!;
const KEY = status.PUBLISHABLE_KEY ?? status.ANON_KEY!;
const PORT = Number(process.env.PORT ?? 8090);
const B = `http://127.0.0.1:${PORT}`;
const jwks = (await (await fetch(`${SB}/auth/v1/.well-known/jwks.json`)).json()) as { keys: Array<{ alg: string }> };
const asymmetric = jwks.keys.some((k) => k.alg !== 'HS256');

let failed = 0;
const pass = (m: string) => console.log(`  ✅ ${m}`);
const fail = (m: string) => (failed++, console.log(`  ❌ ${m}`));
const expect = (ok: boolean, m: string, detail = '') => (ok ? pass(m) : fail(`${m}${detail ? `: ${detail}` : ''}`));

console.log(`\nRehearsal on the local Supabase ${SB}`);
console.log(`  signing: ${asymmetric ? `published keys (${jwks.keys.map((k) => k.alg).join(', ')})` : 'legacy shared secret (HS256)'}\n`);

// The fake Go, and our server pointed at the local Supabase for both sign-in and the database.
const go = new MockGo();
go.fakeGo = true;
const goBase = await go.listen();
const spend = (await import('../contract/test-vectors/spend-approval.json', { with: { type: 'json' } })).default as { private_key_pem: string };
const server = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
  env: {
    ...process.env,
    DATABASE_URL: status.DB_URL!,
    SUPABASE_URL: SB,
    AUTH_MODE: 'supabase',
    // Only on the legacy secret do we hand the server the secret. With published keys it must work without it.
    ...(asymmetric ? { SUPABASE_JWT_SECRET: '' } : { SUPABASE_JWT_SECRET: status.JWT_SECRET! }),
    GO_URL: goBase.replace('ws://', 'http://'),
    GO_SIGNING_SECRET: go.secret,
    GO_SPEND_PRIVATE_KEY: spend.private_key_pem.replace(/\n/g, '\\n'),
    INSTANCE_NAME: 'rehearsal-1',
    PORT: String(PORT),
    PUBLIC_BASE_URL: B,
    DB_POOL_MAX: '10',
    LOG_GO_TRAFFIC: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
server.stdout!.on('data', (d) => (out += d));
server.stderr!.on('data', (d) => (out += d));
const end = Date.now() + 30_000;
while (!out.includes('listening')) {
  if (server.exitCode !== null || Date.now() > end) {
    console.log(out);
    throw new Error('the server did not start');
  }
  await new Promise((r) => setTimeout(r, 100));
}
await go.untilConnected(10_000);
console.log('1. The server starts on Supabase Postgres');
expect(out.includes('sign-in: supabase'), 'sign-in mode is supabase');

const call = async (token: string | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(B + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
};
// A real Supabase sign-up (email + password; Google cannot run locally without Google Cloud credentials, but the
// access token Supabase issues has the same shape whichever way the person signed in).
const signUp = async (fullName: string) => {
  const email = `rehearsal-${randomBytes(4).toString('hex')}@example.test`;
  const password = randomBytes(18).toString('base64url');
  const r = await fetch(`${SB}/auth/v1/signup`, { method: 'POST', headers: { apikey: KEY, 'content-type': 'application/json' }, body: JSON.stringify({ email, password, data: { full_name: fullName } }) });
  const j = (await r.json()) as { access_token?: string; refresh_token?: string; user?: { id: string } };
  if (!j.access_token) throw new Error(`sign-up gave no session: ${JSON.stringify(j).slice(0, 300)}`);
  return { email, access: j.access_token, refresh: j.refresh_token!, userId: j.user!.id };
};

try {
  console.log('\n2. Real Supabase tokens reach our server');
  const priya = await signUp('Priya Rehearsal');
  const me = await call(priya.access, 'GET', '/app/v1/me');
  expect(me.status === 200 && me.body.name === 'Priya Rehearsal', 'a fresh Supabase session signs Priya in; her person is created from the profile', JSON.stringify(me));
  const again = await call(priya.access, 'GET', '/app/v1/me');
  expect(again.body?.person_id === me.body?.person_id, 'the same token again is the same person');

  const refreshed = (await (await fetch(`${SB}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { apikey: KEY, 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: priya.refresh }) })).json()) as { access_token?: string };
  const afterRefresh = await call(refreshed.access_token ?? '', 'GET', '/app/v1/me');
  expect(afterRefresh.body?.person_id === me.body?.person_id, 'after a refresh (a new access token) she is still the same person');

  console.log('\n3. The app works end to end with Supabase sign-in');
  const kabir = await signUp('Kabir Rehearsal');
  const trip = await call(priya.access, 'POST', '/app/v1/trips', { title: 'Rehearsal trip' });
  expect(trip.status === 201, 'Priya creates a trip', JSON.stringify(trip.body));
  const joined = await call(kabir.access, 'POST', `/app/v1/invites/${trip.body.invite_url.split('/j/')[1]}/accept`, { from_city: 'Pune' });
  expect(joined.body?.already === false, 'Kabir joins with his own Supabase token');
  const msg = await call(kabir.access, 'POST', `/app/v1/trips/${trip.body.trip_id}/messages`, { client_id: 'rh-1', text: '@Go hello from the rehearsal' });
  expect(msg.status === 200, 'Kabir talks to Go');
  const t0 = Date.now();
  while (go.replies.length === 0 && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 100));
  expect(go.replies.length > 0, "the fake Go answered through our server (events out, Go's requests in, on Supabase Postgres)");
  const types = go.events.filter((e) => e.trip_id === trip.body.trip_id).map((e) => e.type);
  expect(['trip.created', 'person.joined', 'message.created'].every((t) => types.includes(t)), `Go got the events (${types.join(', ')})`);
  expect(!JSON.stringify(go.events).includes('@example.test'), 'no email address ever reached Go');

  console.log('\n4. Bad tokens are refused');
  expect((await call(KEY.startsWith('ey') ? KEY : status.ANON_KEY!, 'GET', '/app/v1/me')).status === 401, "the project's anon key is not a sign-in (401)");
  const [h, , s] = priya.access.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: kabir.userId, role: 'authenticated', aud: 'authenticated', iss: `${SB}/auth/v1`, exp: 9_999_999_999 })).toString('base64url');
  expect((await call(`${h}.${forged}.${s}`, 'GET', '/app/v1/me')).status === 401, 'a token with changed claims (401)');
  expect((await call(null, 'POST', '/app/v1/dev/sign-in', { name: 'x' })).status === 404, 'POST /app/v1/dev/sign-in does not exist (404)');

  console.log("\n5. Supabase's public Data API cannot see our tables");
  // As any visitor would call it (just the publishable key), and as a signed-in person would (plus their token).
  for (const [who, token] of [['the publishable key alone (anon)', null], ["a signed-in person's token", priya.access]] as const) {
    for (const table of ['people', 'trips', 'messages', 'spend_approvals']) {
      const r = await fetch(`${SB}/rest/v1/${table}?select=*&limit=1`, { headers: { apikey: KEY, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
      const text = await r.text();
      const hidden = r.status === 401 || r.status === 403 || r.status === 404 || (r.status === 200 && text.trim() === '[]');
      expect(hidden && !text.includes('Priya'), `${who} gets nothing from /rest/v1/${table} (${r.status})`, text.slice(0, 120));
    }
  }
} catch (err) {
  fail(`stopped: ${(err as Error).message}`);
} finally {
  server.kill('SIGTERM');
  await new Promise((r) => (server.exitCode !== null ? r(null) : server.once('exit', r)));
  await go.close();
}

console.log(failed ? `\n${failed} problem(s).\n` : '\nAll good: production sign-in and database work on Supabase.\n');
process.exit(failed ? 1 : 0);
