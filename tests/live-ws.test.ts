// The live connection (app contract §3): tickets, hello, subscribe with replay, resync, trip_changed, typing, one socket per device, pongs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLOSE_BAD_TICKET, CLOSE_NO_PONG, CLOSE_REPLACED, REPLAY_MAX_MESSAGES } from '../src/live/ws.js';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';
import { LiveClient, settle } from './helpers/live-client.js';
import { seedTrip } from './helpers/seed.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
const open: LiveClient[] = [];
const connect = async (...args: Parameters<typeof LiveClient.open> extends [any, ...infer R] ? R : never) => {
  const c = await LiveClient.open(h, ...args);
  open.push(c);
  return c;
};
beforeAll(async () => {
  h = await startHarness({ live: { heartbeatMs: 200 } }); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
  await seedTrip(h.pool, 't_other', [{ id: 'p_orgx', name: 'Orgx', role: 'organizer' }]);
});
afterAll(async () => {
  for (const c of open) c.close();
  await h.stop();
});

const post = (who: string, text: string) => t.api(t.as(who), 'POST', '/app/v1/trips/t_goa/messages', { client_message_id: `cm-${text}`, text });

describe('the ticket', () => {
  it('is single use and valid 30 seconds: a second connect with it, or an expired or unknown one, closes with 4401', async () => {
    const r = await t.api(t.as('p_rahul'), 'POST', '/app/v1/live/ticket', {});
    expect([r.status, r.body.ticket.startsWith('tk_'), Date.parse(r.body.expires_at) - Date.now() > 25_000]).toEqual([201, true, true]);
    const first = await connect('p_rahul', { ticket: r.body.ticket });
    expect(await first.until((f) => f.type === 'hello')).toMatchObject({ type: 'hello', person_id: 'p_rahul', heartbeat_seconds: 0.2, server_time: expect.any(String) });
    const again = await connect('p_rahul', { ticket: r.body.ticket });
    expect(await again.closed()).toBe(CLOSE_BAD_TICKET);
    const stale = await t.api(t.as('p_rahul'), 'POST', '/app/v1/live/ticket', {});
    await h.pool.query(`update live_tickets set expires_at = now() - interval '1 second' where ticket = $1`, [stale.body.ticket]);
    expect(await (await connect('p_rahul', { ticket: stale.body.ticket })).closed()).toBe(CLOSE_BAD_TICKET);
    expect(await (await connect('p_rahul', { ticket: 'tk_made_up' })).closed()).toBe(CLOSE_BAD_TICKET);
    expect(first.closeCode).toBeUndefined(); // the first socket is untouched
    expect((await t.api(t.as('p_rahul'), 'POST', '/app/v1/live/ticket', { device: 'x' })).status).toBe(422); // strict body
    expect((await t.api(null, 'GET', '/app/v1/live')).status).toBe(426); // a plain GET is told it is a WebSocket
  });
});

describe('subscribe and replay', () => {
  it('replays the messages changed after since_seq as message frames, then one trip_changed with the current seq; rejects a trip the person is not in', async () => {
    const a = await post('p_priya', 'one');
    const b = await post('p_arjun', 'two');
    await t.api(t.as('p_rahul'), 'PUT', `/app/v1/trips/t_goa/messages/${a.body.message_id}/reaction`, { emoji: '👍' }); // a's updated_seq moves past b's
    const seq = (await rows(h.pool, `select seq from trips where trip_id = 't_goa'`))[0].seq as number;
    const c = await connect('p_rahul');
    await c.until((f) => f.type === 'hello');
    c.subscribe('t_goa', a.body.seq); // the app holds a's change number: it misses b and the reaction on a
    c.send({ type: 'subscribe', trips: [{ trip_id: 't_other', since_seq: 0 }] });
    await c.until((f) => f.type === 'trip_changed');
    await c.until((f) => f.type === 'error');
    expect(c.of('message').map((f) => [f.trip_id, f.message.message_id, f.message.reactions.length])).toEqual([['t_goa', b.body.message_id, 0], ['t_goa', a.body.message_id, 1]]); // oldest change first, as they are now
    expect(c.of('trip_changed')).toEqual([{ type: 'trip_changed', trip_id: 't_goa', seq }]);
    expect(c.of('error')).toEqual([{ type: 'error', trip_id: 't_other', code: 'forbidden' }]);
  });

  it('with since_seq at the current seq nothing is replayed, not even trip_changed; a new message then arrives live, as the whole Message', async () => {
    const seq = (await rows(h.pool, `select seq from trips where trip_id = 't_goa'`))[0].seq as number;
    const c = await connect('p_priya');
    c.subscribe('t_goa', seq);
    await settle(300);
    expect(c.frames.filter((f) => f.type !== 'hello' && f.type !== 'ping')).toEqual([]);
    const m = await post('p_kabir', 'live one');
    const frame = await c.until((f) => f.type === 'message');
    expect(frame).toEqual({ type: 'message', trip_id: 't_goa', message: m.body });
  });

  it(`more than ${REPLAY_MAX_MESSAGES} changed messages since since_seq is one resync frame instead`, async () => {
    await seedTrip(h.pool, 't_big');
    const start = (await rows(h.pool, `select seq from trips where trip_id = 't_big'`))[0].seq as number;
    for (let i = 0; i < REPLAY_MAX_MESSAGES + 1; i++) {
      await h.pool.query(
        `insert into messages (message_id, trip_id, seq, updated_seq, author_kind, author_person_id, text) values ($1, 't_big', $2, $2, 'person', 'p_rahul', $3)`,
        [`m_big_${i}`, start + 1 + i, `message ${i}`],
      );
    }
    await h.pool.query(`update trips set seq = $1 where trip_id = 't_big'`, [start + REPLAY_MAX_MESSAGES + 1]);
    const c = await connect('p_rahul');
    c.subscribe('t_big', 0);
    expect(await c.until((f) => f.type === 'resync')).toEqual({ type: 'resync', trip_id: 't_big' });
    expect(c.of('message')).toEqual([]);
    // After the app re-read the room it subscribes from the current seq and is up to date.
    c.send({ type: 'subscribe', trips: [{ trip_id: 't_big', since_seq: start + REPLAY_MAX_MESSAGES + 1 }] });
    await settle(200);
    expect(c.of('trip_changed')).toEqual([]);
  });

  it('a vote and a replaced card reach subscribers as trip_changed (with kinds) and card (no seq); unsubscribe stops them', async () => {
    const seq = (await rows(h.pool, `select seq from trips where trip_id = 't_goa'`))[0].seq as number;
    const c = await connect('p_meher');
    c.subscribe('t_goa', seq);
    const o = (await h.go.call('open_vote', { request_id: 'rq_ws_vote', trip_id: 't_goa', question: 'Where?', kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }] })).result;
    expect(await c.until((f) => f.type === 'trip_changed')).toEqual({ type: 'trip_changed', trip_id: 't_goa', seq: o.seq, kinds: ['decision'] });
    const card = { card_id: 'c_ws_notice', kind: 'notice', fallback_text: 'Heads up', title: 'Fares', body: 'rising', tone: 'heads_up' };
    const m = (await h.go.call('post_message', { request_id: 'rq_ws_card', trip_id: 't_goa', text: 'A card', card })).result;
    await c.until((f) => f.type === 'message' && f.message.message_id === m.message_id);
    await h.go.call('replace_card', { trip_id: 't_goa', card: { ...card, body: 'falling' } });
    expect(await c.until((f) => f.type === 'card')).toEqual({ type: 'card', trip_id: 't_goa', message_id: m.message_id, card: { ...card, body: 'falling' } });
    c.send({ type: 'unsubscribe', trip_ids: ['t_goa'] });
    await settle(100);
    const before = c.frames.length;
    await post('p_rahul', 'after unsubscribe');
    await settle(200);
    expect(c.frames.slice(before).filter((f) => f.type !== 'ping')).toEqual([]);
  });

  it('home_changed reaches the person\'s sockets whatever they subscribe to: when they create or join a trip', async () => {
    const c = await connect('p_kabir');
    await c.until((f) => f.type === 'hello');
    const r = await t.api(t.as('p_kabir'), 'POST', '/app/v1/trips', { title: 'Kabir\'s own' });
    expect(r.status).toBe(201);
    expect(await c.until((f) => f.type === 'home_changed')).toEqual({ type: 'home_changed' });
    const others = await connect('p_rahul');
    await others.until((f) => f.type === 'hello');
    await t.api(t.as('p_rahul'), 'POST', `/app/v1/invites/${r.body.invite_url.split('/j/')[1]}/accept`, {});
    expect(await others.until((f) => f.type === 'home_changed')).toEqual({ type: 'home_changed' }); // the joiner's home gained a trip
    expect(await c.until((f) => f.type === 'home_changed' && c.of('home_changed').length === 2)).toBeTruthy(); // the organizer's card shows one more face
  });
});

describe('typing', () => {
  it('fans a person\'s typing out to the other subscribers with a 6 s expiry, never back to them and never to Go; at most one per 2 s per trip', async () => {
    const seq = (await rows(h.pool, `select seq from trips where trip_id = 't_goa'`))[0].seq as number;
    const typer = await connect('p_priya');
    const watcher = await connect('p_arjun');
    typer.subscribe('t_goa', seq);
    watcher.subscribe('t_goa', seq);
    await settle(150);
    const goFrames = h.go.frames.length;
    typer.send({ type: 'typing', trip_id: 't_goa', on: true });
    typer.send({ type: 'typing', trip_id: 't_goa', on: true }); // within 2 s: dropped
    typer.send({ type: 'typing', trip_id: 't_other', on: true }); // not subscribed: dropped
    const f = await watcher.until((x) => x.type === 'typing');
    expect(f).toMatchObject({ type: 'typing', trip_id: 't_goa', who: { kind: 'person', person_id: 'p_priya' }, on: true });
    expect(Date.parse(f.until) - Date.now()).toBeGreaterThan(4000);
    await settle(200);
    expect(watcher.of('typing')).toHaveLength(1);
    expect(typer.of('typing')).toEqual([]);
    typer.send({ type: 'typing', trip_id: 't_goa', on: false }); // "stopped" always goes through
    expect(await watcher.until((x) => x.type === 'typing' && x.on === false)).toMatchObject({ who: { kind: 'person', person_id: 'p_priya' }, on: false });
    expect(f.until).toBeDefined();
    expect(h.go.frames.length).toBe(goFrames);
  });

  it('Go\'s typing notification is a typing frame with who.kind go', async () => {
    const seq = (await rows(h.pool, `select seq from trips where trip_id = 't_goa'`))[0].seq as number;
    const c = await connect('p_rahul');
    c.subscribe('t_goa', seq);
    await settle(100);
    h.go.notify('typing', { trip_id: 't_goa', on: true });
    expect(await c.until((f) => f.type === 'typing')).toMatchObject({ trip_id: 't_goa', who: { kind: 'go' }, on: true, until: expect.any(String) });
  });
});

describe('devices and heartbeats', () => {
  it('a second connect from the same device closes the first with 4000; another device keeps its own socket', async () => {
    const phone = await connect('p_rahul', { device_id: 'dev_phone' });
    const laptop = await connect('p_rahul', { device_id: 'dev_laptop' });
    await phone.until((f) => f.type === 'hello');
    const phoneAgain = await connect('p_rahul', { device_id: 'dev_phone' });
    expect(await phone.closed()).toBe(CLOSE_REPLACED);
    await phoneAgain.until((f) => f.type === 'hello');
    await settle(100);
    expect([laptop.closeCode, phoneAgain.closeCode]).toEqual([undefined, undefined]);
  });

  it('pings every heartbeat; a socket that misses two pongs is closed, one that answers stays', async () => {
    const quiet = await connect('p_priya', { pong: false });
    const chatty = await connect('p_priya');
    await quiet.until((f) => f.type === 'ping');
    expect(await quiet.closed(3000)).toBe(CLOSE_NO_PONG);
    expect(chatty.of('ping').length).toBeGreaterThanOrEqual(2);
    expect(chatty.closeCode).toBeUndefined();
  });

  it('frames that are not JSON or have an unknown type are ignored', async () => {
    const c = await connect('p_rahul');
    await c.until((f) => f.type === 'hello');
    c.ws.send('not json');
    c.send({ type: 'teleport' });
    c.send({ type: 'subscribe', trips: 'nope' });
    await settle(200);
    expect(c.closeCode).toBeUndefined();
    expect(c.frames.filter((f) => f.type !== 'hello' && f.type !== 'ping')).toEqual([]);
  });
});
