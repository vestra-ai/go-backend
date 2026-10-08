// GET /trips/:trip/cards?kind=&state= and POST …/cards/:card_id/share (app contract §4.11, APP-CONTRACT-CHANGES §4.11,
// GO-CHANGES 2.3): the latest version of each card by kind and state, and a call recording copied into the room.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { SupabaseAuth } from '../src/api/auth.js';
import { check } from '../src/contract/index.js';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';
import { fakeCard } from './helpers/mock-go.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
/** A stand-in for Go's recording host. */
let files: Server;
let filesBase: string;
beforeAll(async () => {
  h = await startHarness({ features: { calls: true } }); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
  files = createServer((req, res) => {
    if (req.url?.startsWith('/call.m4a')) return res.writeHead(200, { 'content-type': 'audio/mp4' }).end(Buffer.from('m4a-bytes-of-the-call'));
    if (req.url?.startsWith('/page.html')) return res.writeHead(200, { 'content-type': 'text/html' }).end('<html>');
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => files.listen(0, '127.0.0.1', r));
  filesBase = `http://127.0.0.1:${(files.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await h.stop();
  await new Promise<void>((r) => files.close(() => r()));
});

let n = 0;
const post = (card: Record<string, unknown>, text = 'card') => h.go.call('post_message', { request_id: `rq_cards_${++n}`, trip_id: 't_goa', text, card }).then((r) => {
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r.result as { message_id: string; seq: number };
});
const replace = (card: Record<string, unknown>) => h.go.call('replace_card', { trip_id: 't_goa', card });
const cards = (query = '', who = 'p_rahul') => t.api(t.as(who), 'GET', `/app/v1/trips/t_goa/cards${query}`);
const share = (cardId: string, who = 'p_priya') => t.api(t.as(who), 'POST', `/app/v1/trips/t_goa/cards/${cardId}/share`);
const ids = (r: { body: { items: any[] } }) => r.body.items.map((i) => i.card.card_id);

describe('GET /cards', () => {
  it('lists the latest version of each card newest first, filtered by kind and by a state list; cards without a state never match a state filter; 422 for junk', async () => {
    const call1 = { ...fakeCard('call', 'c_call_1', 'p_rahul'), state: 'dialing' };
    const call2 = { ...fakeCard('call', 'c_call_2', 'p_rahul'), state: 'talking', started_at: new Date().toISOString() };
    const working = fakeCard('working', 'c_work_1', 'p_rahul');
    const pay = fakeCard('pay', 'c_pay_1', 'p_rahul');
    const notice = fakeCard('notice', 'c_notice_1', 'p_rahul');
    const m1 = await post(call1);
    await post(call2);
    await post(working);
    await post(pay);
    await post(notice);
    const all = await cards();
    expect([all.status, ids(all)]).toEqual([200, ['c_notice_1', 'c_pay_1', 'c_work_1', 'c_call_2', 'c_call_1']]);
    expect(all.body.items[4]).toEqual({ message_id: m1.message_id, card: call1, posted_at: expect.stringMatching(/^\d{4}-/) });
    expect(ids(await cards('?kind=call'))).toEqual(['c_call_2', 'c_call_1']);
    expect(ids(await cards('?kind=call&state=dialing,talking'))).toEqual(['c_call_2', 'c_call_1']);
    expect(ids(await cards('?kind=call&state=talking'))).toEqual(['c_call_2']);
    expect(ids(await cards('?state=running,waiting'))).toEqual(['c_pay_1', 'c_work_1']); // any kind with a state
    expect(ids(await cards('?kind=notice&state=talking'))).toEqual([]); // a notice has no state
    expect(ids(await cards('?kind=ticket'))).toEqual([]);
    // Go ends the first call with replace_card: the list shows the new version, and the live filter drops it.
    await replace({ ...call1, state: 'ended', ended_at: new Date().toISOString(), outcome: 'Late check-in confirmed', recording_url: `${filesBase}/call.m4a`, duration_s: 192 });
    expect(ids(await cards('?kind=call&state=dialing,talking'))).toEqual(['c_call_2']);
    expect((await cards('?kind=call&state=ended')).body.items[0].card).toMatchObject({ card_id: 'c_call_1', state: 'ended', recording_url: `${filesBase}/call.m4a`, duration_s: 192 }); // stored raw, returned as-is
    // The pay card names Rahul only; everyone still gets it here (the app draws it as it draws the room), with for_person_ids as stored.
    expect((await cards('?kind=pay', 'p_kabir')).body.items[0].card.for_person_ids).toEqual(['p_rahul']);
    // A person-opened poll's vote card (the Server's own) is a card too.
    const poll = (await t.api(t.as('p_priya'), 'POST', '/app/v1/trips/t_goa/decisions', { client_id: 'cards-poll', question: 'Where to eat?', kind: 'yesno', anonymous: false, options: [{ label: 'Yes' }, { label: 'No' }] })).body;
    expect(ids(await cards('?kind=vote'))).toEqual([poll.message.card.card_id]);
    expect((await cards('?kind=Call')).status).toBe(422);
    expect((await cards('?state=dialing;drop')).status).toBe(422);
    expect((await t.api(t.as('p_stranger'), 'GET', '/app/v1/trips/t_goa/cards')).status).toBe(403);
    expect((await t.api(null, 'GET', '/app/v1/trips/t_goa/cards')).status).toBe(401);
  });
});

describe('POST /cards/:card_id/actions: claim (GO-CHANGES 1.10, APP-CONTRACT-CHANGES §11.13)', () => {
  it('two people tapping "I\'ll book it" at once each reach Go as their own card_tap with distinct tap_ids, and each gets Go\'s answer back unchanged: done for the first Go sees, refused for the other', async () => {
    await post({ ...fakeCard('notice', 'c_claim', 'p_rahul'), title: 'One person books for all', body: 'Villa Sol won. Who books it?', actions: [{ action_id: 'claim', label: "I'll book it", style: 'primary' }] });
    const was = h.go.answers.card_tap!;
    let claimed: string | null = null;
    // Go takes the first claim and refuses the rest (nothing on the Server side decides this).
    h.go.answers.card_tap = (p) => {
      if (p.action_id !== 'claim') return was(p);
      if (claimed) return { result: { result: 'refused', toast: `${claimed} is already booking this.` } };
      claimed = p.person_id;
      return { result: { result: 'done', toast: 'You are booking for all 5.' } };
    };
    try {
      const tap = (who: string, press: string) => t.api(t.as(who), 'POST', '/app/v1/trips/t_goa/cards/c_claim/actions', { action_id: 'claim', press_id: press });
      const [priya, kabir] = await Promise.all([tap('p_priya', '11111111-1111-4111-8111-111111111111'), tap('p_kabir', '22222222-2222-4222-8222-222222222222')]);
      const taps = h.go.requests.filter((r) => r.method === 'card_tap' && r.params.card_id === 'c_claim').map((r) => r.params);
      expect(taps.map((p) => p.person_id).sort()).toEqual(['p_kabir', 'p_priya']);
      expect(new Set(taps.map((p) => p.tap_id)).size).toBe(2);
      expect(taps.every((p) => /^tap_[0-9a-f]{32}$/.test(p.tap_id) && p.action_id === 'claim' && p.trip_id === 't_goa')).toBe(true);
      const byPerson = { p_priya: priya, p_kabir: kabir } as Record<string, { status: number; body: any }>;
      const winner = claimed!;
      const loser = winner === 'p_priya' ? 'p_kabir' : 'p_priya';
      expect([byPerson[winner]!.status, byPerson[winner]!.body]).toEqual([200, { result: 'done', toast: 'You are booking for all 5.' }]);
      expect([byPerson[loser]!.status, byPerson[loser]!.body]).toEqual([200, { result: 'refused', toast: `${winner} is already booking this.` }]);
      // The same press again is the same tap_id (Go answers it once); a new press by the winner is a new tap, which Go now refuses too.
      await tap(winner, winner === 'p_priya' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222');
      const again = h.go.requests.filter((r) => r.method === 'card_tap' && r.params.card_id === 'c_claim').map((r) => r.params.tap_id);
      expect(new Set(again).size).toBe(2);
    } finally {
      h.go.answers.card_tap = was;
    }
  });
});

describe('POST /cards/:card_id/share', () => {
  it('copies the recording into storage and posts a message by the caller with it as a file attachment; Go hears message.created; a second share answers the same message', async () => {
    const before = (await rows(h.pool, `select seq from trips where trip_id = 't_goa'`))[0].seq;
    const r = await share('c_call_1');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      author: { kind: 'person', person_id: 'p_priya' }, text: 'Call with Villa Sol · Late check-in confirmed', seq: before + 1, mentions_go: false,
      attachments: [{ kind: 'file', url: expect.stringContaining('/_dev/storage/'), name: 'Villa Sol call.m4a', mime: 'audio/mp4', size_bytes: 21, duration_s: 192, upload_id: expect.stringMatching(/^up_/) }],
    });
    expect(check('Message', r.body)).toMatchObject({ ok: true });
    expect(h.storage.files.get('recordings/t_goa/c_call_1.m4a')?.bytes.toString()).toBe('m4a-bytes-of-the-call');
    const fetched = await h.app.inject({ method: 'GET', url: new URL(r.body.attachments[0].url).pathname });
    expect([fetched.statusCode, fetched.headers['content-type'], fetched.body]).toEqual([200, 'audio/mp4', 'm4a-bytes-of-the-call']);
    expect(JSON.stringify(r.body)).not.toContain(filesBase); // never Go's link
    await h.flush();
    const e = h.go.events.find((x) => x.type === 'message.created' && x.data.message.message_id === r.body.message_id)!;
    expect([check('Event', e).ok, e.seq, e.data.message.author, e.data.message.attachments[0].mime]).toEqual([true, before + 1, { kind: 'person', person_id: 'p_priya' }, 'audio/mp4']);
    expect(h.live.events).toContainEqual({ tripId: 't_goa', event: { kind: 'message', message_id: r.body.message_id, updated_seq: before + 1 } });
    // Shared again, by someone else too: the first message, no new change.
    const again = await share('c_call_1', 'p_kabir');
    expect([again.status, again.body.message_id, (await rows(h.pool, `select seq from trips where trip_id = 't_goa'`))[0].seq]).toEqual([201, r.body.message_id, before + 1]);
    expect((await rows(h.pool, `select count(*)::int as n from messages where trip_id = 't_goa' and attachments::text like '%recordings/t_goa/c_call_1%' or (trip_id = 't_goa' and text like 'Call with Villa Sol%')`))[0].n).toBe(1);
    // The room re-signs the link on every read, like any upload.
    const room = (await t.api(t.as('p_rahul'), 'GET', '/app/v1/trips/t_goa/messages')).body.messages.find((m: any) => m.message_id === r.body.message_id);
    expect(room.attachments[0].url).toContain('/_dev/storage/');
  });

  it('409 for a live call, a card that is not a call, an ended call with no recording; 404 for an unknown card; 503 when the recording cannot be fetched; nothing is posted in those cases', async () => {
    const messages = async () => (await rows(h.pool, `select count(*)::int as n from messages where trip_id = 't_goa'`))[0].n;
    const count = await messages();
    const refusal = (r: { status: number; body: any }) => [r.status, r.body.error.code];
    expect(refusal(await share('c_call_2'))).toEqual([409, 'conflict']); // talking
    expect(refusal(await share('c_pay_1'))).toEqual([409, 'conflict']);
    await post({ ...fakeCard('call', 'c_call_3', 'p_rahul'), state: 'ended', outcome: 'No answer' });
    expect(refusal(await share('c_call_3'))).toEqual([409, 'conflict']); // no recording
    expect(refusal(await share('c_nope'))).toEqual([404, 'not_found']);
    await post({ ...fakeCard('call', 'c_call_4', 'p_rahul'), state: 'ended', recording_url: `${filesBase}/gone.m4a` });
    expect(refusal(await share('c_call_4'))).toEqual([503, 'unavailable']);
    await post({ ...fakeCard('call', 'c_call_5', 'p_rahul'), state: 'ended', recording_url: `${filesBase}/page.html` });
    expect(refusal(await share('c_call_5'))).toEqual([503, 'unavailable']); // not audio
    expect(refusal(await share('c_call_1', 'p_stranger'))).toEqual([403, 'forbidden']);
    expect(refusal(await t.api(null, 'POST', '/app/v1/trips/t_goa/cards/c_call_1/share'))).toEqual([401, 'unauthorized']);
    expect(await messages()).toBe(count + 3); // only the three cards Go posted
  });

  it('409 when features.calls is off; the cards query still works', async () => {
    const off = buildApp({ ctx: h.ctx, go: h.socket, sessionSecret: h.sessionSecret, auth: new SupabaseAuth({ supabaseUrl: h.fakeAuth!.url, pool: h.pool }), features: { calls: false } });
    await off.ready();
    try {
      const headers = { authorization: `Bearer ${await h.token('p_priya')}` };
      const r = await off.inject({ method: 'POST', url: '/app/v1/trips/t_goa/cards/c_call_1/share', headers });
      expect([r.statusCode, r.json().error.code, r.json().error.message]).toEqual([409, 'conflict', 'sharing call recordings is not on yet (features.calls)']);
      expect((await off.inject({ method: 'GET', url: '/app/v1/trips/t_goa/cards?kind=call', headers })).statusCode).toBe(200);
      expect((await off.inject({ method: 'GET', url: '/app/v1/config' })).json().features.calls).toBe(false);
    } finally {
      await off.close();
    }
  });
});

describe('the rate limit on taps (app contract Appendix A: 10 a minute per person per trip; a repeat of one press_id is free)', () => {
  it('counts distinct presses: the one over the limit is 429 rate_limited with retry_after_seconds and Retry-After, a press already seen still goes through, another person is not affected', async () => {
    await post({ ...fakeCard('notice', 'c_taps', 'p_rahul'), actions: [{ action_id: 'ok', label: 'OK', style: 'primary' }] });
    const tap = (who: string, press: string) => t.api(t.as(who), 'POST', '/app/v1/trips/t_goa/cards/c_taps/actions', { action_id: 'ok', press_id: press });
    h.ctx.limits = { cardTapsPerMinute: 2 };
    try {
      expect([(await tap('p_meher', 'press-1')).status, (await tap('p_meher', 'press-1')).status, (await tap('p_meher', 'press-2')).status]).toEqual([200, 200, 200]); // two presses, one of them twice
      const r = await tap('p_meher', 'press-3');
      expect([r.status, r.body.error.code, r.body.error.retry_after_seconds > 0, Number(r.headers['retry-after']) === r.body.error.retry_after_seconds]).toEqual([429, 'rate_limited', true, true]);
      expect((await tap('p_meher', 'press-1')).status).toBe(200); // a retry of a press that got through is still free
      expect((await tap('p_arjun', 'press-1')).status).toBe(200); // per person
    } finally {
      delete h.ctx.limits;
    }
  });
});
