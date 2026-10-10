import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { MockGo } from './helpers/mock-go.js';

const spend = JSON.parse(readFileSync(new URL('../contract/test-vectors/spend-approval.json', import.meta.url), 'utf8'));
const freePort = () => new Promise<number>((resolve) => { const s = createServer(); s.listen(0, () => { const p = (s.address() as any).port; s.close(() => resolve(p)); }); });
const PWA = 'https://pwa.example';

let go: MockGo;
let proc: ChildProcess;
let port: number;
let out = '';

// The real process as it is released, with the web app's origin set.
beforeAll(async () => {
  go = new MockGo();
  const base = await go.listen();
  const admin = new pg.Client({ connectionString: `${process.env.TEST_PG_URL}/postgres` });
  await admin.connect();
  await admin.query('create database release_e2e');
  await admin.end();
  port = await freePort();
  proc = spawn('node_modules/.bin/tsx', ['src/main.ts'], {
    env: {
      ...process.env,
      DATABASE_URL: `${process.env.TEST_PG_URL}/release_e2e`,
      GO_URL: base.replace('ws://', 'http://'),
      GO_SIGNING_SECRET: go.secret,
      GO_SPEND_PRIVATE_KEY: spend.private_key_pem.replace(/\n/g, '\\n'),
      INSTANCE_NAME: 'release-1',
      PORT: String(port),
      APP_SESSION_SECRET: 'release-secret',
      APP_ORIGINS: PWA,
    },
  });
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (out += d));
  const end = Date.now() + 20000;
  while (!out.includes('listening')) {
    if (Date.now() > end || proc.exitCode !== null) throw new Error(`server did not start:\n${out}`);
    await new Promise((r) => setTimeout(r, 100));
  }
});

afterAll(async () => {
  proc.kill('SIGKILL');
  await go.close();
  const admin = new pg.Client({ connectionString: `${process.env.TEST_PG_URL}/postgres` });
  await admin.connect();
  await admin.query('drop database if exists release_e2e with (force)'); // the cluster is discarded after each run too; this keeps a re-run in one cluster safe
  await admin.end();
});

it('starts with an origin set, serves the config with no push members, answers a preflight for the origin, and shuts down cleanly on SIGTERM', async () => {
  const config = await fetch(`http://127.0.0.1:${port}/app/v1/config`, { headers: { origin: PWA } });
  const pre = await fetch(`http://127.0.0.1:${port}/app/v1/trips/t_x/messages`, { method: 'OPTIONS', headers: { origin: PWA, 'access-control-request-method': 'POST' } });
  const body = await config.json();
  expect([config.status, 'vapid_public_key' in body, 'web_push' in body.features, config.headers.get('access-control-allow-origin'), pre.status, pre.headers.get('access-control-allow-origin')]).toEqual([200, false, false, PWA, 204, PWA]);
  const exited = new Promise<number | null>((r) => proc.on('exit', (code) => r(code)));
  proc.kill('SIGTERM');
  expect(await exited).toBe(0);
});
