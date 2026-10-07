// A whole local stack for trying the server by hand or with Postman, with nothing to install or configure:
//   - a temporary Postgres (embedded, deleted on exit),
//   - a fake Go that behaves as the guide's "Work without the other side" describes (tests/helpers/mock-go.ts),
//   - the real server (src/main.ts) on :8080, connected to that fake Go over the real signed socket,
//   - a small "act as Go" control API on :8090, for the things only Go can do (open a vote, set a mandate,
//     post a card, write a record line, ask for a spend approval): POST /sim/<method> with the params as JSON.
// Dev only: nothing in src/ imports this. Run it with `pnpm dev:stack`; stop it with Ctrl-C.
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { FakeSupabaseAuth } from '../tests/helpers/fake-supabase-auth.js';
import { MockGo } from '../tests/helpers/mock-go.js';

const PORT = Number(process.env.PORT ?? 8080);
const SIM_PORT = Number(process.env.SIM_PORT ?? 8090);
const PG_PORT = Number(process.env.DEV_PG_PORT ?? 54329);
const spend = JSON.parse(readFileSync(new URL('../contract/test-vectors/spend-approval.json', import.meta.url), 'utf8'));

// 1. A temporary Postgres.
const dir = mkdtempSync(join(tmpdir(), 'go-dev-pg-'));
const db = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PG_PORT, persistent: false, onLog: () => {}, onError: () => {} });
await db.initialise();
await db.start();
const admin = new pg.Client({ connectionString: `postgres://postgres:postgres@localhost:${PG_PORT}/postgres` });
await admin.connect();
await admin.query('create database go');
await admin.end();

// 2. The fake Go.
// 2b. With --supabase-auth: sign-in with Supabase-style access tokens from a fake Supabase Auth on :54331
// (GET http://127.0.0.1:54331/mint?name=Priya gives one), exactly as the app will sign in with the real Supabase.
const supabaseAuth = process.argv.includes('--supabase-auth') ? new FakeSupabaseAuth() : null;
const authUrl = supabaseAuth ? await supabaseAuth.start(Number(process.env.DEV_AUTH_PORT ?? 54331), { mint: true }) : null;

const go = new MockGo();
go.fakeGo = true;
const goBase = await go.listen();

// 3. The real server.
const server = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
  env: {
    ...process.env,
    DATABASE_URL: `postgres://postgres:postgres@localhost:${PG_PORT}/go`,
    GO_URL: goBase.replace('ws://', 'http://'),
    GO_SIGNING_SECRET: go.secret,
    GO_SPEND_PRIVATE_KEY: spend.private_key_pem.replace(/\n/g, '\\n'), // the contract's test key: for local use only
    INSTANCE_NAME: 'dev-1',
    PORT: String(PORT),
    PUBLIC_BASE_URL: `http://localhost:${PORT}`,
    APP_SESSION_SECRET: 'dev-stack-session-secret',
    ...(authUrl ? { AUTH_MODE: 'supabase', SUPABASE_URL: authUrl } : { AUTH_MODE: 'dev' }),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let started = false;
const onOutput = (d: Buffer) => {
  const text = d.toString();
  for (const line of text.split('\n').filter(Boolean)) console.log(`[server] ${line}`);
  if (!started && text.includes('listening')) started = true;
};
server.stdout!.on('data', onOutput);
server.stderr!.on('data', onOutput);
const deadline = Date.now() + 30_000;
while (!started) {
  if (server.exitCode !== null || Date.now() > deadline) throw new Error('the server did not start');
  await new Promise((r) => setTimeout(r, 100));
}
await go.untilConnected(10_000);

// 4. "Act as Go": POST /sim/<method> sends Go's request to the server and answers with the server's answer.
// A `typing` call is sent as a notification (it has no answer). GET /sim/state shows what the fake Go has seen.
const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const sim = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${SIM_PORT}`);
    if (req.method === 'GET' && url.pathname === '/sim/state') {
      return json(res, 200, { connected: go.connected, events: go.events.length, last_events: go.events.slice(-10), requests: go.requests.slice(-10), replies: go.replies });
    }
    const m = /^\/sim\/([a-z_]+)$/.exec(url.pathname);
    if (req.method !== 'POST' || !m) return json(res, 404, { error: { code: 'not_found', message: 'use POST /sim/<method> or GET /sim/state' } });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const params = raw ? JSON.parse(raw) : {};
    if (m[1] === 'typing') {
      go.notify('typing', params);
      return json(res, 200, { ok: true });
    }
    const frame = await go.call(m[1]!, params);
    if (frame.result) return json(res, 200, frame.result);
    const code = frame.error?.code;
    return json(res, [404, 409, 422, 429, 503].includes(code) ? code : 502, { error: frame.error });
  } catch (err) {
    return json(res, 500, { error: { code: 'internal', message: (err as Error).message } });
  }
});
await new Promise<void>((r) => sim.listen(SIM_PORT, r));

console.log(`
  Go Server dev stack is up.
    App API      http://localhost:${PORT}        (the real server; Postman's {{baseUrl}})
    Act as Go    http://localhost:${SIM_PORT}/sim    (POST /sim/<method>, GET /sim/state; Postman's {{simUrl}})
    Postgres     postgres://postgres:postgres@localhost:${PG_PORT}/go  (temporary)
  The fake Go answers every message that names it (@Go): typing, ✅, then a reply with a card.
${authUrl
  ? `  Sign-in      Supabase-style tokens from a fake Supabase Auth: GET ${authUrl}/mint?name=Priya&email=priya@gmail.com
               (send the access_token as Authorization: Bearer …; POST /app/people is off, as in production)
`
  : '  Sign-in      dev tokens: POST /app/people (add --supabase-auth to sign in like production)\n'}  Ctrl-C stops everything.
`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  server.kill('SIGTERM');
  await new Promise((r) => server.once('exit', r));
  sim.close();
  await go.close();
  await supabaseAuth?.close();
  await db.stop();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
