import { randomBytes } from 'node:crypto';
import { buildApp } from './api/app.js';
import { loadConfig, socketUrl } from './config.js';
import { createPool } from './db/pool.js';
import { GoSocket } from './go/go-socket.js';
import { goRequestHandlers } from './requests/index.js';
import { startJobs } from './jobs/votes.js';
import { PgLive } from './live/live.js';
import { OutboxSender } from './outbox/sender.js';
import { LogPush } from './push/push.js';
import type { Ctx } from './context.js';
import { migrate } from '../scripts/migrate.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.dbPoolMax);
await migrate(pool);

const live = new PgLive(pool);
await live.listen();
const ctx: Ctx = {
  pool,
  live,
  push: new LogPush(pool),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'https://go.example',
  spendPrivateKey: config.goSpendPrivateKey,
};

// 1. The socket to Go, with a fresh signature on every connect. Any instance can answer any of Go's requests.
const go = new GoSocket({
  url: socketUrl(config.goUrl, config.instance),
  secret: config.goSigningSecret,
  handlers: goRequestHandlers(ctx),
  log: (m) => console.log(`[go] ${m}`),
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

// 3. Votes that run out of time, and the "closing soon" pushes.
const stopJobs = startJobs(ctx);

// 4. The app's API.
const app = buildApp({ ctx, go, sessionSecret: process.env.APP_SESSION_SECRET ?? randomBytes(32).toString('hex') });
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`server ${config.instance} listening on :${config.port}`);

const shutdown = async () => {
  setTimeout(() => process.exit(1), 10_000).unref(); // never hang on the way out
  stopJobs();
  sender.stop();
  await sender.idle(); // let an event that is on the way get its answer
  go.stop();
  await app.close();
  await live.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
