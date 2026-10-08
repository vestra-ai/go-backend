// F9. The real server process (src/main.ts) against a fake Go that behaves as the guide's "Work without the
// other side" describes, watched from the app's side: HTTP for actions, the live WebSocket (app contract §3) for
// what people see. Nothing here reaches into the server's code or database: it is what Saket's app will see.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { FakeSupabaseAuth } from './helpers/fake-supabase-auth.js';
import { MockGo } from './helpers/mock-go.js';

const spend = JSON.parse(readFileSync(new URL('../contract/test-vectors/spend-approval.json', import.meta.url), 'utf8'));
const freePort = () => new Promise<number>((resolve) => { const s = createServer(); s.listen(0, () => { const p = (s.address() as any).port; s.close(() => resolve(p)); }); });

let go: MockGo;
const auth = new FakeSupabaseAuth(); // people sign in as they will in production: with Supabase access tokens
let proc: ChildProcess;
let base: string;
let out = '';

beforeAll(async () => {
  go = new MockGo();
  go.fakeGo = true;
  const goBase = await go.listen();
  await auth.start();
  const admin = new pg.Client({ connectionString: `${process.env.TEST_PG_URL}/postgres` });
  await admin.connect();
  await admin.query('create database e2e_fake');
  await admin.end();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn('node_modules/.bin/tsx', ['src/main.ts'], {
    env: {
      ...process.env,
      DATABASE_URL: `${process.env.TEST_PG_URL}/e2e_fake`,
      GO_URL: goBase.replace('ws://', 'http://'),
      GO_SIGNING_SECRET: go.secret,
      GO_SPEND_PRIVATE_KEY: spend.private_key_pem.replace(/\n/g, '\\n'),
      INSTANCE_NAME: 'e2e-fake',
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
  await go.untilConnected(10000);
});

afterAll(async () => {
  proc.kill('SIGKILL');
  await go.close();
  await auth.close();
});

const api = async (path: string, init: { method?: string; body?: unknown; token?: string } = {}) => {
  const r = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
};

/** Opens the live WebSocket as the app does (a ticket, then the socket, then subscribe) and collects its frames. */
async function liveSocket(tripId: string, token: string) {
  const ticket = await api('/app/v1/live/ticket', { method: 'POST', body: {}, token });
  expect(ticket.status).toBe(201);
  const ws = new WebSocket(`${base.replace('http', 'ws')}/app/v1/live?ticket=${ticket.body.ticket}`);
  const events: Array<{ type: string; data: any }> = [];
  ws.on('message', (d) => {
    const frame = JSON.parse(d.toString());
    events.push({ type: frame.type, data: frame.type === 'message' ? frame.message : frame });
    if (frame.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
  });
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'subscribe', trips: [{ trip_id: tripId, since_seq: 0 }] }));
  const waitFor = async (pick: (e: { type: string; data: any }) => boolean, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = events.find(pick);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`no live frame matched; got ${JSON.stringify(events.map((e) => e.type))}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return { events, waitFor, close: () => ws.close() };
}

let rahul: { person_id: string; token: string };
let priya: { person_id: string; token: string };
let trip: string;

/** Signs in as the app does: a Supabase token, and the first request creates the person. */
const signIn = async (name: string) => {
  const token = await auth.mint({ name, email: `${name.toLowerCase()}@gmail.com` });
  const me = await api('/app/v1/me', { token });
  expect(me.status).toBe(200);
  return { person_id: me.body.person_id as string, token };
};

it('setup: two people make a trip through the real server', async () => {
  rahul = await signIn('Rahul');
  priya = await signIn('Priya');
  const t = await api('/app/v1/trips', { method: 'POST', body: { title: 'Goa with the fake Go' }, token: rahul.token });
  expect(t.status).toBe(201);
  trip = t.body.trip_id;
  expect((await api(`/app/v1/invites/${t.body.invite_url.split('/j/')[1]}/accept`, { method: 'POST', body: {}, token: priya.token })).status).toBe(200);
});

it('a message that names Go: the app sees "Go is typing...", Go\'s ✅ on the message, then Go\'s reply with a card', async () => {
  const live = await liveSocket(trip, rahul.token);
  await live.waitFor((e) => e.type === 'hello');
  await live.waitFor((e) => e.type === 'trip_changed'); // the replay since 0: the room so far, then where the trip stands
  const asked = await api(`/app/v1/trips/${trip}/messages`, { method: 'POST', body: { client_message_id: 'fake_1', text: '@Go find us flights for Friday' }, token: priya.token });
  expect(asked.status).toBe(201);
  const q = asked.body.message_id;
  await live.waitFor((e) => e.type === 'typing' && e.data.who.kind === 'go' && e.data.on === true);
  await live.waitFor((e) => e.type === 'message' && e.data.message_id === q && e.data.reactions.some((r: any) => r.emoji === '✅' && !r.person_id));
  const reply = await live.waitFor((e) => e.type === 'message' && e.data.author.kind === 'go' && e.data.reply_to === q);
  expect(reply.data).toMatchObject({ text: 'On it! Here is a options card.', card: { kind: 'options', card_id: expect.any(String) } });
  await live.waitFor((e) => e.type === 'typing' && e.data.who.kind === 'go' && e.data.on === false);
  // The room, read again from scratch, holds the question with Go's ✅ and Go's reply.
  const room = (await api(`/app/v1/trips/${trip}/messages?after_seq=0`, { token: rahul.token })).body.messages;
  expect(room.find((m: any) => m.message_id === q).reactions).toContainEqual({ emoji: '✅' });
  expect(room.at(-1)).toMatchObject({ author: { kind: 'go' }, reply_to: q });
  expect(go.replies[0]).toMatchObject({ trip_id: trip, to_message_id: q, card_kind: 'options' });
  await live.close();
});

it('each answer uses a different one of Go\'s card kinds, and a tap on Go\'s card reaches Go', async () => {
  for (const [i, text] of ['@Go compare villas', '@Go call Villa Sol', '@Go book it', 'Go, any news?'].entries()) {
    await api(`/app/v1/trips/${trip}/messages`, { method: 'POST', body: { client_message_id: `fake_more_${i}`, text }, token: priya.token });
  }
  const end = Date.now() + 10000;
  while (go.replies.length < 5 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  // The four answers are produced as the outbox delivers, so their order is not fixed; the first reply is the earlier test's.
  expect([go.replies[0]!.card_kind, go.replies.slice(1).map((r) => r.card_kind).sort()]).toEqual(['options', ['call', 'notice', 'pay', 'working']]);
  // The pay card names Rahul (the organizer): it is in his "needs you" strip.
  const strip = (await api(`/app/v1/trips/${trip}/needs-you`, { token: rahul.token })).body.items;
  expect(strip).toContainEqual(expect.objectContaining({ kind: 'card', title: 'Approve ₹54,200 for Villa Sol', cta_label: 'Approve' }));
  // A tap on the options card goes to Go and its fixed answer comes back.
  const options = (await api(`/app/v1/trips/${trip}/messages?after_seq=0`, { token: rahul.token })).body.messages.find((m: any) => m.card?.kind === 'options');
  const tap = await api(`/app/v1/trips/${trip}/cards/${options.card.card_id}/actions`, { method: 'POST', body: { action_id: 'pick', option_id: 'opt_fl_1' }, token: rahul.token });
  expect(tap).toEqual({ status: 200, body: { result: 'done', toast: 'Noted. Go will reply in the room.' } });
  expect(go.requests.at(-1)).toMatchObject({ method: 'card_tap', params: { card_id: options.card.card_id, person_id: rahul.person_id } });
});

it('every event reached Go once, in change-number order, with no gaps but the server\'s own pills (which have no event)', async () => {
  const end = Date.now() + 5000;
  const seq = (await api(`/app/v1/trips/${trip}`, { token: rahul.token })).body.seq as number;
  // The pills ("Trip created · Rahul joined", "Priya joined") took a change number each and were never sent to Go.
  const room = (await api(`/app/v1/trips/${trip}/messages?after_seq=0`, { token: rahul.token })).body.messages as any[];
  const pills = room.filter((m) => m.author.kind === 'system').map((m) => m.seq as number);
  expect(pills).toHaveLength(2);
  while (go.events.filter((e) => e.trip_id === trip).length < seq - pills.length && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  const seqs = go.events.filter((e) => e.trip_id === trip).map((e) => e.seq);
  expect(seqs).toEqual(Array.from({ length: seq }, (_, i) => i + 1).filter((n) => !pills.includes(n)));
});
