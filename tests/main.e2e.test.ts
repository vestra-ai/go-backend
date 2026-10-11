import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FakeSupabaseAuth } from './helpers/fake-supabase-auth.js';
import { MockGo } from './helpers/mock-go.js';

const spend = JSON.parse(readFileSync(new URL('../contract/test-vectors/spend-approval.json', import.meta.url), 'utf8'));
const freePort = () => new Promise<number>((resolve) => { const s = createServer(); s.listen(0, () => { const p = (s.address() as any).port; s.close(() => resolve(p)); }); });

let go: MockGo;
const auth = new FakeSupabaseAuth();
let proc: ChildProcess;
let port: number;
let out = '';

beforeAll(async () => {
  go = new MockGo();
  const base = await go.listen();
  await auth.start();
  const admin = new pg.Client({ connectionString: `${process.env.TEST_PG_URL}/postgres` });
  await admin.connect();
  await admin.query('create database e2e');
  await admin.end();
  port = await freePort();
  proc = spawn('node_modules/.bin/tsx', ['src/main.ts'], {
    env: {
      ...process.env,
      DATABASE_URL: `${process.env.TEST_PG_URL}/e2e`,
      GO_URL: base.replace('ws://', 'http://'),
      GO_SIGNING_SECRET: go.secret,
      GO_SPEND_PRIVATE_KEY: spend.private_key_pem.replace(/\n/g, '\\n'), // a one-line env value
      INSTANCE_NAME: 'e2e-1',
      GO_SERVER_NAME: '', // none, whatever the shell running the tests has set: the address is then as it always was
      PORT: String(port),
      APP_SESSION_SECRET: 'e2e-secret',
      AUTH_MODE: 'supabase',
      SUPABASE_URL: auth.url,
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
  await auth.close();
});

it('starts: migrates, opens the signed socket as its own instance, and serves the app API', async () => {
  await go.untilConnected(10000);
  expect(go.targets[0]).toBe('/v1/socket?instance=e2e-1');
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  expect(health).toEqual({ ok: true, go: true });
  expect(await (await fetch(`http://127.0.0.1:${port}/app/v1/health`)).json()).toEqual({ ok: true, go: true });
  const config = await fetch(`http://127.0.0.1:${port}/app/v1/config`);
  expect(config.headers.get('x-request-id')).toMatch(/^[0-9a-f]{12}$/);
  expect(await config.json()).toEqual({
    contract: '1.0.0', min_client_version: '1.0.0', currency_default: 'INR',
    features: { checkin: false, visa: false, calls: false, vote_retract: false, vote_flexible: false, claim: false },
  });
});

it('a new trip reaches Go as trip.created, and Go can read it back', async () => {
  const api = (path: string, init: RequestInit & { token?: string } = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) } }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const token = await auth.mint({ name: 'Rahul', email: 'rahul@gmail.com' });
  expect((await api('/app/v1/me', { token })).body).toMatchObject({ name: 'Rahul', email: 'rahul@gmail.com', auth_provider: 'google' });
  const t = await api('/app/v1/trips', { method: 'POST', body: JSON.stringify({ title: 'Goa 🌴' }), token });
  expect(t.status).toBe(201);
  const end = Date.now() + 5000;
  while (go.events.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  expect(go.events[0]).toMatchObject({ type: 'trip.created', seq: 1, trip_id: t.body.trip_id });
  const read = await go.call('read_trip', { trip_id: t.body.trip_id });
  expect(read.result).toMatchObject({ trip_id: t.body.trip_id, seq: 2, title: 'Goa 🌴' }); // 2: the room's "Trip created · Rahul joined" pill took a change number
  // ...and reached Go as message.created at that number
  while (go.events.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  expect(go.events[1]).toMatchObject({ type: 'message.created', seq: 2, trip_id: t.body.trip_id, data: { message: { seq: 2, author: { kind: 'system' }, text: 'Trip created · Rahul joined' } } });
  // Go speaks: a message with a card reaches the room and comes back to Go as an event
  const posted = await go.call('post_message', { request_id: 'rq_1', trip_id: t.body.trip_id, text: 'Hi, I\'m Go.' });
  expect(posted.result.seq).toBe(3);
  const end2 = Date.now() + 5000;
  while (go.events.length < 3 && Date.now() < end2) await new Promise((r) => setTimeout(r, 50));
  expect(go.events.map((e) => [e.seq, e.type])).toEqual([[1, 'trip.created'], [2, 'message.created'], [3, 'message.created']]);
  expect(go.events[2]!.data.message).toMatchObject({ author: { kind: 'go' }, text: 'Hi, I\'m Go.' });
});

it('shuts down cleanly on SIGTERM', async () => {
  const exited = new Promise<number | null>((r) => proc.on('exit', (code) => r(code)));
  proc.kill('SIGTERM');
  expect(await exited).toBe(0);
});
