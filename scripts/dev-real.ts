// The server against the REAL Go, for integration testing on a laptop:
//   - reads .env (GO_URL, GO_SIGNING_SECRET, GO_SPEND_PRIVATE_KEY, INSTANCE_NAME, ...),
//   - keeps a persistent local Postgres in .pgdata/ (embedded, no install) so trips survive restarts,
//   - starts src/main.ts and mirrors its output to logs/server.log.
// LOG_GO_TRAFFIC=1 in .env writes every socket frame to logs/go-traffic.jsonl; `pnpm inspect` summarises it.
// Dev only: nothing in src/ imports this. Ctrl-C stops everything.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

export function loadEnv(path = '.env'): Record<string, string> {
  if (!existsSync(path)) throw new Error(`${path} not found: copy .env.example and fill it in`);
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
  return env;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  // `--env <file>` runs against another settings file (for example one without the production DATABASE_URL).
  const env = loadEnv(process.argv.includes('--env') ? process.argv[process.argv.indexOf('--env') + 1] : '.env');
  const pgPort = Number(env.DEV_PG_PORT ?? 54330);
  const dataDir = '.pgdata';
  const db = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port: pgPort, persistent: true, onLog: () => {}, onError: () => {} });
  if (!existsSync(`${dataDir}/PG_VERSION`)) await db.initialise();
  await db.start();
  const admin = new pg.Client({ connectionString: `postgres://postgres:postgres@localhost:${pgPort}/postgres` });
  await admin.connect();
  if (!(await admin.query(`select 1 from pg_database where datname = 'go'`)).rowCount) await admin.query('create database go');
  await admin.end();

  mkdirSync('logs', { recursive: true });
  const log = createWriteStream('logs/server.log', { flags: 'a' });
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    env: { ...process.env, ...env, DATABASE_URL: env.DATABASE_URL ?? `postgres://postgres:postgres@localhost:${pgPort}/go` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const mirror = (d: Buffer) => {
    process.stdout.write(d);
    log.write(d);
  };
  server.stdout!.on('data', mirror);
  server.stderr!.on('data', mirror);
  console.log(`[dev:real] Postgres on :${pgPort} (data in ${dataDir}/), server → ${env.GO_URL} as ${env.INSTANCE_NAME}`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.kill('SIGTERM');
    await new Promise((r) => (server.exitCode !== null ? r(null) : server.once('exit', r)));
    await db.stop();
    process.exit(0);
  };
  server.on('exit', (code) => {
    if (!stopping) console.log(`[dev:real] server exited with ${code}; Postgres is still up (Ctrl-C to stop)`);
  });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
