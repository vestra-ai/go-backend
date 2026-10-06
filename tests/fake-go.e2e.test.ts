// F9. The real server process (src/main.ts) against a fake Go that behaves as the guide's "Work without the
// other side" describes, watched from the app's side: HTTP for actions, the live stream (server-sent events) for
// what people see. Nothing here reaches into the server's code or database: it is what Saket's app will see.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { MockGo } from './helpers/mock-go.js';

const spend = JSON.parse(readFileSync(new URL('../contract/test-vectors/spend-approval.json', import.meta.url), 'utf8'));
const freePort = () => new Promise<number>((resolve) => { const s = createServer(); s.listen(0, () => { const p = (s.address() as any).port; s.close(() => resolve(p)); }); });

let go: MockGo;
let proc: ChildProcess;
let base: string;
let out = '';

beforeAll(async () => {
  go = new MockGo();
  go.fakeGo = true;
  const goBase = await go.listen();
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

/** Opens the live stream and collects its events. */
async function liveStream(tripId: string, token: string) {
  const res = await fetch(`${base}/app/trips/${tripId}/live`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.headers.get('content-type')).toBe('text/event-stream');
  const reader = res.body!.getReader();
  const events: Array<{ type: string; data: any }> = [];
  let buffer = '';
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buffer += new TextDecoder().decode(value);
      let i: number;
      while ((i = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const type = /^event: (.*)$/m.exec(chunk)?.[1];
        const data = /^data: (.*)$/m.exec(chunk)?.[1];
        if (type && data) events.push({ type, data: JSON.parse(data) });
      }
    }
  })();
  const waitFor = async (pick: (e: { type: string; data: any }) => boolean, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = events.find(pick);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`no live event matched; got ${JSON.stringify(events.map((e) => e.type))}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return { events, waitFor, close: () => reader.cancel() };
}

let rahul: { person_id: string; token: string };
let priya: { person_id: string; token: string };
let trip: string;

it('setup: two people make a trip through the real server', async () => {
  rahul = (await api('/app/people', { method: 'POST', body: { name: 'Rahul' } })).body;
  priya = (await api('/app/people', { method: 'POST', body: { name: 'Priya' } })).body;
  const t = await api('/app/trips', { method: 'POST', body: { title: 'Goa with the fake Go' }, token: rahul.token });
  expect(t.status).toBe(201);
  trip = t.body.trip_id;
  expect((await api(`/app/join/${t.body.invite_url.split('/j/')[1]}`, { method: 'POST', body: {}, token: priya.token })).status).toBe(200);
});

it('a message that names Go: the app sees "Go is typing...", Go\'s ✅ on the message, then Go\'s reply with a card', async () => {
  const live = await liveStream(trip, rahul.token);
  await live.waitFor((e) => e.type === 'hello');
  const asked = await api(`/app/trips/${trip}/messages`, { method: 'POST', body: { client_id: 'fake_1', text: '@Go find us flights for Friday' }, token: priya.token });
  expect(asked.status).toBe(200);
  const q = asked.body.message_id;
  await live.waitFor((e) => e.type === 'typing' && e.data.who.kind === 'go' && e.data.on === true);
  await live.waitFor((e) => e.type === 'message' && e.data.message_id === q && e.data.reactions.some((r: any) => r.emoji === '✅' && !r.person_id));
  const reply = await live.waitFor((e) => e.type === 'message' && e.data.author.kind === 'go' && e.data.reply_to === q);
  expect(reply.data).toMatchObject({ text: 'On it! Here is a options card.', card: { kind: 'options', card_id: expect.any(String) } });
  await live.waitFor((e) => e.type === 'typing' && e.data.who.kind === 'go' && e.data.on === false);
  // The room, read again from scratch, holds the question with Go's ✅ and Go's reply.
  const room = (await api(`/app/trips/${trip}/messages?after_seq=0`, { token: rahul.token })).body.messages;
  expect(room.find((m: any) => m.message_id === q).reactions).toContainEqual({ emoji: '✅' });
  expect(room.at(-1)).toMatchObject({ author: { kind: 'go' }, reply_to: q });
  expect(go.replies[0]).toMatchObject({ trip_id: trip, to_message_id: q, card_kind: 'options' });
  await live.close();
});

it('each answer uses a different one of Go\'s card kinds, and a tap on Go\'s card reaches Go', async () => {
  for (const [i, text] of ['@Go compare villas', '@Go call Villa Sol', '@Go book it', 'Go, any news?'].entries()) {
    await api(`/app/trips/${trip}/messages`, { method: 'POST', body: { client_id: `fake_more_${i}`, text }, token: priya.token });
  }
  const end = Date.now() + 10000;
  while (go.replies.length < 5 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  expect(go.replies.map((r) => r.card_kind)).toEqual(['options', 'working', 'call', 'pay', 'notice']);
  // The pay card names Rahul (the organizer): it is in his "needs you" strip.
  const strip = (await api(`/app/trips/${trip}/needs-you`, { token: rahul.token })).body;
  expect(strip).toContainEqual(expect.objectContaining({ kind: 'card', text: 'Approve ₹54,200 for Villa Sol' }));
  // A tap on the options card goes to Go and its fixed answer comes back.
  const options = (await api(`/app/trips/${trip}/messages?after_seq=0`, { token: rahul.token })).body.messages.find((m: any) => m.card?.kind === 'options');
  const tap = await api(`/app/trips/${trip}/card-taps`, { method: 'POST', body: { card_id: options.card.card_id, action_id: 'pick', option_id: 'opt_fl_1' }, token: rahul.token });
  expect(tap).toEqual({ status: 200, body: { result: 'done', toast: 'Noted. Go will reply in the room.' } });
  expect(go.requests.at(-1)).toMatchObject({ method: 'card_tap', params: { card_id: options.card.card_id, person_id: rahul.person_id } });
});

it('every event reached Go once, in change-number order, with no gaps', async () => {
  const end = Date.now() + 5000;
  const want = async () => (await api(`/app/trips/${trip}`, { token: rahul.token })).body.seq as number;
  const seq = await want();
  while (go.events.filter((e) => e.trip_id === trip).length < seq && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  const seqs = go.events.filter((e) => e.trip_id === trip).map((e) => e.seq);
  expect(seqs).toEqual(Array.from({ length: seq }, (_, i) => i + 1));
});
