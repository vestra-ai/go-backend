import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { buildApp } from './api/app.js';
import { DevAuth, SupabaseAuth } from './api/auth.js';
import { loadConfig, socketUrl } from './config.js';
import { createPool } from './db/pool.js';
import { closePdfBrowser, pdfSelfTest, pdfStatus } from './demo/pdf.js';
import { GoSocket, type TrafficEntry } from './go/go-socket.js';
import { goRequestHandlers } from './requests/index.js';
import { startJobs } from './jobs/votes.js';
import { PgLive } from './live/live.js';
import { OutboxSender } from './outbox/sender.js';
import { MemoryStorage } from './storage/memory-storage.js';
import { SupabaseStorage } from './storage/supabase-storage.js';
import type { Ctx } from './context.js';
import { migrate } from '../scripts/migrate.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.dbPoolMax, config.databaseCaCert);
await migrate(pool);

const live = new PgLive(pool);
await live.listen();
// Files: Supabase Storage (the private bucket, signed URLs) when the service key is set; otherwise the in-process fake,
// which keeps uploads in memory and serves them itself (lost on restart: local use only).
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? 'https://go.example';
const storage = config.storage === 'supabase'
  ? new SupabaseStorage({ supabaseUrl: config.supabaseUrl!, secretKey: config.supabaseSecretKey!, bucket: config.supabaseStorageBucket })
  : new MemoryStorage(process.env.PUBLIC_BASE_URL ?? `http://localhost:${config.port}`);
if (config.storage === 'memory') console.warn('[storage] STORAGE=memory: uploads live in memory and are lost on restart. Set SUPABASE_SECRET_KEY (and SUPABASE_URL) for Supabase Storage.');
else console.log(`storage: supabase bucket ${config.supabaseStorageBucket}`);
// The demo's ticket PDFs need a Chromium (PUPPETEER_EXECUTABLE_PATH); without one a demo booking has no file.
console.log(`ticket pdfs: ${pdfStatus()}`);
// A real render right after start, so the deploy log proves the e-tickets and vouchers work (it never blocks the start).
void pdfSelfTest().then((r) => (r.startsWith('ok') ? console.log : console.error)(`ticket pdfs: ${r}`));
const ctx: Ctx = {
  pool,
  live,
  storage,
  publicBaseUrl,
  spendPrivateKey: config.goSpendPrivateKey,
  features: config.features,
  goContract: config.goContract,
};
// Go keeps a trip with the Server of this name: without one, a redeploy strands the trips made before it.
console.log(config.serverName ? `go server name: ${config.serverName}` : 'go server name: none (set GO_SERVER_NAME: without it a redeploy strands older trips on Go)');
console.log(`go contract: ${config.goContract}${process.env.GO_CONTRACT && process.env.GO_CONTRACT !== config.goContract ? ` (GO_CONTRACT=${process.env.GO_CONTRACT})` : ''}${config.goContract === '1.0' ? ' (a re-split expense is not sent as an event; Go reads it)' : ''}`);

// 1. The socket to Go, with a fresh signature on every connect. Any instance can answer any of Go's requests.
// LOG_GO_TRAFFIC=1: one JSON line per frame on the socket in logs/go-traffic.jsonl, for testing against a real Go.
let traffic: ((e: TrafficEntry) => void) | undefined;
if (process.env.LOG_GO_TRAFFIC === '1') {
  mkdirSync('logs', { recursive: true });
  const out = createWriteStream('logs/go-traffic.jsonl', { flags: 'a' });
  traffic = (e) => out.write(`${JSON.stringify({ at: new Date().toISOString(), instance: config.instance, ...e })}\n`);
}
const go = new GoSocket({
  url: socketUrl(config.goUrl, config.instance, config.serverName),
  secret: config.goSigningSecret,
  handlers: goRequestHandlers(ctx),
  log: (m) => console.log(`[go] ${m}`),
  traffic,
});
go.start();

// 2. The outbox: every trip change goes to Go with send_event, one at a time per trip, in change-number order.
// Each trip being sent holds a connection while it waits for Go, so it gets at most a third of the pool.
const sender = new OutboxSender({
  pool,
  send: (event) => go.request('send_event', event, { timeoutMs: 2500 }),
  ready: () => go.connected,
  log: (m, e) => console.error(`[outbox] ${m}`, e ?? ''),
}, { maxTrips: Math.max(1, Math.floor(config.dbPoolMax / 3)) });
sender.start();

// 3. Votes that run out of time.
const stopJobs = startJobs(ctx, undefined, undefined, go);

// 4. The app's API.
// Sign-in: Supabase access tokens, or our dev tokens for local testing (refused in production by loadConfig).
const sessionSecret = process.env.APP_SESSION_SECRET ?? randomBytes(32).toString('hex');
const auth = config.authMode === 'supabase'
  ? new SupabaseAuth({ supabaseUrl: config.supabaseUrl!, pool, jwtSecret: config.supabaseJwtSecret })
  : new DevAuth(sessionSecret);
console.log(`sign-in: ${config.authMode}${config.authMode === 'supabase' ? ` (${config.supabaseUrl})` : ' tokens from POST /app/v1/dev/sign-in'}`);
const app = buildApp({ ctx, go, sessionSecret, auth, origins: config.appOrigins, features: config.features, internalKey: config.internalApiKey });
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`server ${config.instance} listening on :${config.port}`);
console.log(`internal routes (/internal/v1): ${config.internalApiKey ? 'on (INTERNAL_API_KEY is set)' : 'off'}`);

const shutdown = async () => {
  setTimeout(() => process.exit(1), 10_000).unref(); // never hang on the way out
  stopJobs();
  sender.stop();
  await sender.idle(); // let an event that is on the way get its answer
  go.stop();
  await app.close();
  await closePdfBrowser();
  await live.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
