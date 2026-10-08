import { createECDH, randomBytes } from 'node:crypto';
import webpush from 'web-push';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { pushClosingSoon } from '../src/jobs/votes.js';
import { LogPush, pushPayload } from '../src/push/push.js';
import { WebPushSender, createPush, isAllowedPushEndpoint, payloadOf, type SendFn } from '../src/push/web-push.js';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';

const VAPID = { publicKey: 'public-key', privateKey: 'private-key', subject: 'mailto:ops@example.com' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FCM = 'https://fcm.googleapis.com/fcm/send/abc123';

/** A stand-in for the push service: records each send, and answers as the test says. */
function fakeService() {
  const calls: Array<{ endpoint: string; payload: string }> = [];
  let mode: 'ok' | 'hang' | 'gone' | 'fail' = 'ok';
  const held: Array<() => void> = [];
  const send: SendFn = async (sub, payload) => {
    calls.push({ endpoint: sub.endpoint, payload });
    if (mode === 'hang') await new Promise<void>((resolve) => held.push(resolve));
    if (mode === 'gone') throw Object.assign(new Error('gone'), { statusCode: 410 });
    if (mode === 'fail') throw Object.assign(new Error(`refused ${sub.endpoint} ${sub.keys.p256dh} ${sub.keys.auth}`), { statusCode: 500 });
  };
  return { calls, send, set: (m: typeof mode) => (mode = m), release: () => held.splice(0).forEach((r) => r()) };
}

let h: Harness;
let t: ReturnType<typeof appApi>;
let svc: ReturnType<typeof fakeService>;
const logs: string[] = [];
let sender: WebPushSender;
beforeAll(async () => {
  svc = fakeService();
  h = await startHarness({
    pushPublicKey: 'PUBLIC-KEY-FOR-BROWSERS',
    makePush: (pool) => (sender = new WebPushSender({ pool, vapid: VAPID, send: svc.send, sendTimeoutMs: 4000, drainWaitMs: 300, log: (m) => logs.push(m) })),
  });
  t = appApi(h);
});
afterAll(async () => {
  svc.release();
  await h.stop();
});

/** A subscription's keys as a browser makes them: a 65-byte public key and a 16-byte secret, base64url. */
const realKeys = () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
};
const keys = realKeys();
/** Registers the browser as a device of the person (POST /me/devices). */
const subscribe = (who: string, endpoint: string, over: Record<string, unknown> = {}) => t.api(t.as(who), 'POST', '/app/v1/me/devices', { platform: 'web_push', web_push: { endpoint, keys }, ...over });
const unsubscribe = (who: string, deviceId: string) => t.api(t.as(who), 'DELETE', `/app/v1/me/devices/${deviceId}`);
const subscriptionOwner = async (endpoint: string) => (await rows(h.pool, 'select person_id from push_subscriptions where endpoint = $1', [endpoint]))[0]?.person_id ?? null;

describe('subscribing', () => {
  it('serves the key in the config (null, with web_push off, when the server has none), and falls back to the log-only sender, warning without values, when the keys are missing or not valid', async () => {
    const keyless = buildApp({ ctx: h.ctx, go: h.socket, sessionSecret: h.sessionSecret });
    await keyless.ready();
    const none = await keyless.inject({ method: 'GET', url: '/app/v1/config' });
    await keyless.close();
    const have = await t.api(null, 'GET', '/app/v1/config');
    expect([none.statusCode, JSON.parse(none.body).vapid_public_key, JSON.parse(none.body).features.web_push, have.status, have.body.vapid_public_key, have.body.features.web_push]).toEqual([200, null, false, 200, 'PUBLIC-KEY-FOR-BROWSERS', true]);
    const warned: string[] = [];
    const partial = createPush({ pool: h.pool, keys: { publicKey: 'SECRETPUBLIC123', subject: 'mailto:a@b.co' }, warn: (m) => warned.push(m) });
    const invalid = createPush({ pool: h.pool, keys: { publicKey: 'SECRETPUBLIC123', privateKey: 'SECRETPRIVATE456', subject: 'mailto:a@b.co' }, warn: (m) => warned.push(m) });
    expect([partial.push instanceof LogPush, partial.publicKey, invalid.push instanceof LogPush, invalid.publicKey, warned.length, /SECRET/.test(warned.join(' ')), warned.every((m) => m.includes('VAPID'))]).toEqual([true, null, true, null, 2, false, true]); // the warning names the settings (the release test relies on that word)
    const good = webpush.generateVAPIDKeys();
    const real = createPush({ pool: h.pool, keys: { ...good, subject: 'mailto:a@b.co' }, warn: (m) => warned.push(m) });
    expect([real.push instanceof WebPushSender, real.publicKey === good.publicKey]).toEqual([true, true]);
  });

  it('registers an address as a device, moves it to another person, removes only the caller\'s own and is safe to repeat; refuses a host the library would read differently, lookalike hosts, a plain-http address and keys of the wrong shape', async () => {
    const mozilla = 'https://updates.push.services.mozilla.com/wpush/v2/abc';
    const apple = 'https://web.push.apple.com/abc';
    const windows = 'https://wns2-par02p.notify.windows.com/w/?token=abc';
    const first = await subscribe('p_priya', FCM);
    const statuses = [first, await subscribe('p_priya', mozilla), await subscribe('p_priya', apple), await subscribe('p_priya', windows)].map((r) => r.status);
    const moved = await subscribe('p_arjun', FCM);
    const byOther = await unsubscribe('p_priya', moved.body.device_id); // Arjun's device now: nothing of hers to remove
    const stillArjun = await subscriptionOwner(FCM);
    const own = await unsubscribe('p_arjun', moved.body.device_id);
    const again = await unsubscribe('p_arjun', moved.body.device_id);
    expect([statuses, first.body.device_id, moved.status, moved.body.device_id !== first.body.device_id, byOther.status, stillArjun, own.status, again.status, await subscriptionOwner(FCM)])
      .toEqual([[201, 201, 201, 201], expect.stringMatching(/^dev_/), 201, true, 204, 'p_arjun', 204, 204, null]);
    // The library re-reads a stored address with an older parser that ends this host at the semicolon: the server would be aimed at evil.example.
    const aimed = await subscribe('p_priya', 'https://evil.example;.push.apple.com/abc');
    const lookalikes = ['https://evilpush.apple.com/abc', 'https://push.apple.com.evil.example/x', 'https://fcm.googleapis.com@evil.example/x', 'https://x.notify.windows.com.evil/x', 'https://evil.example%2Ex.push.apple.com/x', 'https://user:pw@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://fcm.googleapis.com:0443/x'];
    expect([aimed.status, aimed.body.error.code, aimed.body.error.field, lookalikes.map(isAllowedPushEndpoint)]).toEqual([422, 'invalid', 'web_push.endpoint', lookalikes.map(() => false)]);
    expect((await subscribe('p_priya', 'http://fcm.googleapis.com/fcm/send/abc')).status).toBe(422);
    expect((await t.api(t.as('p_priya'), 'POST', '/app/v1/me/devices', { platform: 'web_push', web_push: { endpoint: FCM, keys: { p256dh: 'short', auth: 'x' } } })).status).toBe(422); // not keys a browser makes
    expect((await t.api(t.as('p_priya'), 'POST', '/app/v1/me/devices', { platform: 'ios', web_push: { endpoint: FCM, keys } })).status).toBe(422); // the PWA is the only client in v1
  });

  it('keeps at most 10 subscriptions per person: a newer address replaces the oldest, and saving an old address again makes it the newest', async () => {
    await h.pool.query('delete from push_subscriptions');
    const address = (i: number) => `https://fcm.googleapis.com/fcm/send/device-${i}`;
    await subscribe('p_arjun', address(99)); // someone else's subscription must survive Kabir's trimming
    for (let i = 1; i <= 10; i++) await subscribe('p_kabir', address(i));
    await subscribe('p_kabir', address(1)); // the oldest device is used again: it is now the newest, so device 2 is the oldest
    const eleventh = await subscribe('p_kabir', address(11));
    const left = (await rows(h.pool, `select endpoint from push_subscriptions where person_id = 'p_kabir'`)).map((r) => r.endpoint);
    expect([eleventh.status, left.length, left.includes(address(1)), left.includes(address(2)), left.includes(address(11)), await subscriptionOwner(address(99))]).toEqual([201, 10, true, false, true, 'p_arjun']);
    await h.pool.query('delete from push_subscriptions');
  });

  it('refuses an unsigned caller and an unknown field, on both registering and removing a device', async () => {
    const status = async (method: 'DELETE' | 'POST', url: string, who: string | null, body?: unknown) => (await t.api(who ? t.as(who) : null, method, url, body)).status;
    expect(await status('POST', '/app/v1/me/devices', null, { platform: 'web_push', web_push: { endpoint: FCM, keys } })).toBe(401);
    expect(await status('POST', '/app/v1/me/devices', 'p_priya', { platform: 'web_push', web_push: { endpoint: FCM, keys }, extra: 1 })).toBe(422);
    expect(await status('POST', '/app/v1/me/devices', 'p_priya', { platform: 'web_push', web_push: { endpoint: FCM, keys, extra: 1 } })).toBe(422);
    expect(await status('DELETE', '/app/v1/me/devices/dev_x', null)).toBe(401);
  });
});

describe('delivery', () => {
  it('a push service that never answers does not delay or fail Go\'s message or an app expense: both are committed and the sends happen afterwards', async () => {
    await h.pool.query('delete from push_subscriptions');
    await subscribe('p_priya', FCM);
    svc.calls.length = 0;
    svc.set('hang');
    const started = Date.now();
    const posted = await h.go.call('post_message', { request_id: 'rq_slow1', trip_id: 't_goa', text: 'Priya, take a look', mentions: ['p_priya'] });
    const elapsed = Date.now() - started;
    const spent = await t.api(t.as('p_rahul'), 'POST', '/app/v1/trips/t_goa/expenses', { paid_by_person_id: 'p_rahul', amount_minor: 40000, note: 'Cab', category: 'getting_around', split_person_ids: ['p_rahul', 'p_priya'] });
    for (let i = 0; i < 50 && svc.calls.length < 2; i++) await sleep(20);
    expect([elapsed < 1800, posted.error === undefined, spent.status, (await rows(h.pool, `select 1 from messages where message_id = $1`, [posted.result.message_id])).length, svc.calls.length]).toEqual([true, true, 201, 1, 2]);
    svc.release();
    svc.set('ok');
    await sender.drain();
  });

  it('deletes a subscription the push service says is gone, and keeps one after any other failure without logging its address or keys; the write already succeeded', async () => {
    await subscribe('p_meher', FCM);
    svc.set('gone');
    await sender.send(['p_meher'], pushPayload({ type: 'nudge', trip_id: 't_goa', title: 'Goa 🌴', body: 'x' }));
    await sender.drain();
    const afterGone = await subscriptionOwner(FCM);
    await subscribe('p_meher', FCM);
    svc.set('fail');
    logs.length = 0;
    const write = await t.api(t.as('p_rahul'), 'POST', '/app/v1/trips/t_goa/expenses', { paid_by_person_id: 'p_rahul', amount_minor: 20000, note: 'Tea', category: 'food', split_person_ids: ['p_rahul', 'p_meher'] });
    await sender.drain();
    svc.set('ok');
    expect([afterGone, write.status, await subscriptionOwner(FCM), logs.length > 0, new RegExp(`fcm\\.googleapis|abc123|${keys.p256dh}|${keys.auth}`).test(logs.join(' '))]).toEqual([null, 201, 'p_meher', true, false]);
  });

  it('ends a send that hangs at the per-send limit, lets a drain finish a pending send, and returns from a drain within its bound when a send never ends', async () => {
    const ours = fakeService();
    const own = (over: Record<string, number>) => new WebPushSender({ pool: h.pool, vapid: VAPID, send: ours.send, log: (m) => logs.push(m), ...over });
    await subscribe('p_kabir', FCM);
    const limited = own({ sendTimeoutMs: 60, drainWaitMs: 2000 });
    ours.set('hang');
    const t0 = Date.now();
    await limited.send(['p_kabir'], pushPayload({ type: 'nudge', trip_id: 't_goa', title: 'Goa 🌴', body: 'x' }));
    await limited.drain();
    const hangEnded = Date.now() - t0 < 1500;
    ours.release();
    let finished = false;
    const slowish: SendFn = async () => (await sleep(80), void (finished = true));
    const finishing = new WebPushSender({ pool: h.pool, vapid: VAPID, send: slowish, sendTimeoutMs: 4000, drainWaitMs: 2000 });
    await finishing.send(['p_kabir'], pushPayload({ type: 'nudge', trip_id: 't_goa', title: 'Goa 🌴', body: 'x' }));
    await finishing.drain();
    const finishedBeforeDrainReturned = finished;
    const stuck = own({ sendTimeoutMs: 5000, drainWaitMs: 150 });
    ours.set('hang');
    await stuck.send(['p_kabir'], pushPayload({ type: 'nudge', trip_id: 't_goa', title: 'Goa 🌴', body: 'x' }));
    const t1 = Date.now();
    await stuck.drain();
    const bounded = Date.now() - t1 < 1500;
    ours.release();
    expect([hangEnded, finishedBeforeDrainReturned, bounded]).toEqual([true, true, true]);
  });

  it('with the real library and throwaway keys, produces a signed, encrypted request whose payload is the contract\'s (type, trip, message, title, text cut to 300, deep link, tag), with no absolute link', async () => {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const subscription = { endpoint: FCM, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
    const vapid = webpush.generateVAPIDKeys();
    const notification = pushPayload({ type: 'mention', trip_id: 't_goa', title: 'Goa 🌴', body: 'x'.repeat(400), message_id: 'm_1' });
    const payload = payloadOf(notification);
    const request = webpush.generateRequestDetails(subscription, payload, { vapidDetails: { subject: 'mailto:ops@example.com', ...vapid } });
    const sent = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    await h.pool.query('delete from push_subscriptions');
    await h.pool.query('insert into push_subscriptions (endpoint, person_id, p256dh, auth) values ($1, $2, $3, $4)', [subscription.endpoint, 'p_priya', subscription.keys.p256dh, subscription.keys.auth]);
    const real = new WebPushSender({ pool: h.pool, vapid: { ...vapid, subject: 'mailto:ops@example.com' } });
    await real.send(['p_priya'], notification);
    await real.drain();
    const args = sent.mock.calls[0]!;
    sent.mockRestore();
    expect([
      request.endpoint, request.method, String(request.headers.Authorization).startsWith('vapid t='), request.headers['Content-Encoding'], request.body.length === Buffer.byteLength(payload) + 103, request.body.includes(Buffer.from('trip_id')),
      Object.keys(JSON.parse(payload)), JSON.parse(payload).body.length, /https?:|\/\//.test(payload), [args[0].endpoint, args[1], (args[2] as any).vapidDetails.publicKey === vapid.publicKey],
    ]).toEqual([FCM, 'POST', true, 'aes128gcm', true, false, ['type', 'trip_id', 'message_id', 'title', 'body', 'deep_link', 'tag'], 300, false, [FCM, payload, true]]);
    expect(JSON.parse(payload)).toMatchObject({ type: 'mention', trip_id: 't_goa', message_id: 'm_1', title: 'Goa 🌴', deep_link: '/trips/t_goa/chat?msg=m_1', tag: 't_goa:m_1' });
  });
});

describe('the payload per type (app contract §8), and the notifications switch', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** The payloads the fake push service received since `from`, parsed. */
  const received = (from: number) => svc.calls.slice(from).map((c) => JSON.parse(c.payload));

  it('builds deep_link and tag by type: a message opens the room at it, money opens the Expenses tab, a check-in its flight, anything else the trip; no badge_count', () => {
    const p = (type: any, extra: Record<string, unknown> = {}) => pushPayload({ type, trip_id: 't_goa', title: 'Goa 🌴', body: 'b', ...extra });
    expect(p('mention', { message_id: 'm_1' })).toEqual({ type: 'mention', trip_id: 't_goa', message_id: 'm_1', title: 'Goa 🌴', body: 'b', deep_link: '/trips/t_goa/chat?msg=m_1', tag: 't_goa:m_1' });
    expect(p('card', { message_id: 'm_2' })).toMatchObject({ deep_link: '/trips/t_goa/chat?msg=m_2', tag: 't_goa:m_2' });
    expect(p('vote_closing', { id: 'd_1' })).toMatchObject({ deep_link: '/trips/t_goa', tag: 't_goa:vote_closing:d_1' });
    expect(p('joined', { id: 'p_priya' })).toMatchObject({ deep_link: '/trips/t_goa', tag: 't_goa:joined:p_priya' });
    expect(p('checkin', { id: 'b_1' })).toMatchObject({ deep_link: '/trips/t_goa/checkin/b_1', tag: 't_goa:checkin:b_1' }); // the booking's check-in (§4.12)
    expect(p('checkin', {})).toMatchObject({ deep_link: '/trips/t_goa', tag: 't_goa:checkin' });
    for (const type of ['owe', 'settlement', 'nudge', 'expense']) expect(p(type, { id: 'x' })).toMatchObject({ deep_link: '/trips/t_goa/expenses', tag: `t_goa:${type}:x` });
    expect(Object.keys(p('owe'))).not.toContain('badge_count');
  });

  it('a mention, a card, an owe and a vote closing soon each reach the browser with their type, the trip\'s title and the deep link', async () => {
    await h.pool.query('delete from push_subscriptions');
    await subscribe('p_priya', FCM);
    await subscribe('p_kabir', 'https://fcm.googleapis.com/fcm/send/kabir');
    const from = svc.calls.length;
    const m = (await h.go.call('post_message', { request_id: 'rq_pl_1', trip_id: 't_goa', text: 'Priya, look', mentions: ['p_priya'], card: { card_id: 'c_pl_1', kind: 'notice', fallback_text: 'Kabir, heads up', title: 'Heads up', body: 'x', tone: 'heads_up', for_person_ids: ['p_kabir'] } })).result;
    // A vault payment is approved at once, so the "you owe" push goes out (an expense added by hand waits for approval first: §4.9).
    await h.go.call('add_expense', { request_id: 'rq_pl_e', trip_id: 't_goa', paid_by_person_id: 'p_rahul', amount_minor: 20000, currency: 'INR', note: 'Tea', category: 'food', split_person_ids: ['p_rahul', 'p_priya'], approval_id: 'ap_pl_tea' });
    const soon = new Date(Date.now() + 30 * 60_000).toISOString();
    const d = (await h.go.call('open_vote', { request_id: 'rq_pl_v', trip_id: 't_goa', question: 'Brunch where?', kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }], closes_at: soon })).result;
    await pushClosingSoon(h.ctx);
    for (let i = 0; i < 50 && svc.calls.length - from < 5; i++) await sleep(20);
    await sender.drain();
    const got = received(from);
    expect(got.find((p) => p.type === 'mention')).toEqual({ type: 'mention', trip_id: 't_goa', message_id: m.message_id, title: 'Goa 🌴', body: 'Priya, look', deep_link: `/trips/t_goa/chat?msg=${m.message_id}`, tag: `t_goa:${m.message_id}` });
    expect(got.find((p) => p.type === 'card')).toMatchObject({ trip_id: 't_goa', message_id: m.message_id, title: 'Goa 🌴', body: 'Kabir, heads up' });
    expect(got.find((p) => p.type === 'owe')).toEqual({ type: 'owe', trip_id: 't_goa', title: 'Goa 🌴', body: expect.stringMatching(/^You owe Rahul ₹[\d,.]+ for Tea$/), deep_link: '/trips/t_goa/expenses', tag: 't_goa:owe:p_rahul' }); // the amount is Priya's whole balance (earlier expenses count)
    expect(got.filter((p) => p.type === 'vote_closing')).toEqual([expect.objectContaining({ body: 'Brunch where? closes in 30 minutes', deep_link: '/trips/t_goa', tag: `t_goa:vote_closing:${d.decision_id}` }), expect.anything()]); // Priya and Kabir
  });

  it('"Priya joined Goa" goes to the organizer when someone accepts an invite, not when the organizer re-accepts or someone already in does', async () => {
    await h.pool.query('delete from push_subscriptions');
    await subscribe('p_rahul', 'https://fcm.googleapis.com/fcm/send/rahul');
    const code = (await t.api(t.as('p_rahul'), 'GET', '/app/v1/trips/t_goa/invite')).body.code;
    const from = svc.calls.length;
    const asha = await t.person('Asha');
    await t.api(asha, 'POST', `/app/v1/invites/${code}/accept`, {});
    await t.api(asha, 'POST', `/app/v1/invites/${code}/accept`, {}); // already in: nothing
    await t.api(t.as('p_rahul'), 'POST', `/app/v1/invites/${code}/accept`, {}); // the organizer: nothing
    for (let i = 0; i < 50 && svc.calls.length - from < 1; i++) await sleep(20);
    await sender.drain();
    expect(received(from)).toEqual([{ type: 'joined', trip_id: 't_goa', title: 'Goa 🌴', body: 'Asha joined Goa 🌴', deep_link: '/trips/t_goa', tag: `t_goa:joined:${asha.id}` }]);
  });

  it('a person with notifications off gets nothing, from any site: the domain drops them before the sender, and the sender drops them again for a payload handed to it directly; on again, they are back', async () => {
    await h.pool.query('delete from push_subscriptions');
    await subscribe('p_meher', 'https://fcm.googleapis.com/fcm/send/meher');
    await t.api(t.as('p_meher'), 'PATCH', '/app/v1/me', { notifications_enabled: false });
    const from = svc.calls.length;
    await h.go.call('post_message', { request_id: 'rq_off_1', trip_id: 't_goa', text: 'Meher?', mentions: ['p_meher'] });
    await t.api(t.as('p_rahul'), 'POST', '/app/v1/trips/t_goa/expenses', { paid_by_person_id: 'p_rahul', amount_minor: 20000, note: 'Chai', category: 'food', split_person_ids: ['p_rahul', 'p_meher'] });
    await sender.send(['p_meher'], pushPayload({ type: 'nudge', trip_id: 't_goa', title: 'Goa 🌴', body: 'direct' })); // a payload that did not come through sendPush
    await sleep(100);
    await sender.drain();
    expect(svc.calls.length - from).toBe(0);
    await t.api(t.as('p_meher'), 'PATCH', '/app/v1/me', { notifications_enabled: true });
    await h.go.call('post_message', { request_id: 'rq_off_2', trip_id: 't_goa', text: 'Meher!', mentions: ['p_meher'] });
    for (let i = 0; i < 50 && svc.calls.length - from < 1; i++) await sleep(20);
    await sender.drain();
    expect(received(from).map((p) => [p.type, p.body])).toEqual([['mention', 'Meher!']]);
  });

  it('registers a device with its locale and time zone', async () => {
    const r = await subscribe('p_arjun', 'https://fcm.googleapis.com/fcm/send/arjun-tz', { locale: 'en-IN', tz: 'Asia/Kolkata' });
    expect([r.status, (await rows(h.pool, 'select locale, tz from push_subscriptions where device_id = $1', [r.body.device_id]))[0]]).toEqual([201, { locale: 'en-IN', tz: 'Asia/Kolkata' }]);
  });
});
