import { createECDH, randomBytes } from 'node:crypto';
import webpush from 'web-push';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { LogPush } from '../src/push/push.js';
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
const subscribe = (who: string, endpoint: string) => t.api(t.as(who), 'PUT', '/app/push/subscription', { endpoint, keys });
const subscriptionOwner = async (endpoint: string) => (await rows(h.pool, 'select person_id from push_subscriptions where endpoint = $1', [endpoint]))[0]?.person_id ?? null;

describe('subscribing', () => {
  it('serves the key (503 when the server has none), and falls back to the log-only sender, warning without values, when the keys are missing or not valid', async () => {
    const keyless = buildApp({ ctx: h.ctx, go: h.socket, sessionSecret: h.sessionSecret });
    await keyless.ready();
    const none = await keyless.inject({ method: 'GET', url: '/app/push/key' });
    await keyless.close();
    const have = await t.api(null, 'GET', '/app/push/key');
    expect([none.statusCode, JSON.parse(none.body).error.code, have.status, have.body]).toEqual([503, 'unavailable', 200, { public_key: 'PUBLIC-KEY-FOR-BROWSERS' }]);
    const warned: string[] = [];
    const partial = createPush({ pool: h.pool, keys: { publicKey: 'SECRETPUBLIC123', subject: 'mailto:a@b.co' }, warn: (m) => warned.push(m) });
    const invalid = createPush({ pool: h.pool, keys: { publicKey: 'SECRETPUBLIC123', privateKey: 'SECRETPRIVATE456', subject: 'mailto:a@b.co' }, warn: (m) => warned.push(m) });
    expect([partial.push instanceof LogPush, partial.publicKey, invalid.push instanceof LogPush, invalid.publicKey, warned.length, /SECRET/.test(warned.join(' '))]).toEqual([true, null, true, null, 2, false]);
    const good = webpush.generateVAPIDKeys();
    const real = createPush({ pool: h.pool, keys: { ...good, subject: 'mailto:a@b.co' }, warn: (m) => warned.push(m) });
    expect([real.push instanceof WebPushSender, real.publicKey === good.publicKey]).toEqual([true, true]);
  });

  it('registers an address, moves it to another person, removes only the caller\'s own and is safe to repeat; refuses a host the library would read differently, lookalike hosts, a plain-http address and keys of the wrong shape', async () => {
    const mozilla = 'https://updates.push.services.mozilla.com/wpush/v2/abc';
    const apple = 'https://web.push.apple.com/abc';
    const windows = 'https://wns2-par02p.notify.windows.com/w/?token=abc';
    const statuses = [await subscribe('p_priya', FCM), await subscribe('p_priya', mozilla), await subscribe('p_priya', apple), await subscribe('p_priya', windows)].map((r) => r.status);
    const moved = await subscribe('p_arjun', FCM);
    const byOther = await t.api(t.as('p_priya'), 'POST', '/app/push/unsubscribe', { endpoint: FCM }); // no longer hers
    const stillArjun = await subscriptionOwner(FCM);
    const own = await t.api(t.as('p_arjun'), 'POST', '/app/push/unsubscribe', { endpoint: FCM });
    const again = await t.api(t.as('p_arjun'), 'POST', '/app/push/unsubscribe', { endpoint: FCM });
    expect([statuses, moved.status, byOther.status, stillArjun, own.status, again.status, await subscriptionOwner(FCM)]).toEqual([[204, 204, 204, 204], 204, 204, 'p_arjun', 204, 204, null]);
    // The library re-reads a stored address with an older parser that ends this host at the semicolon: the server would be aimed at evil.example.
    const aimed = await subscribe('p_priya', 'https://evil.example;.push.apple.com/abc');
    const lookalikes = ['https://evilpush.apple.com/abc', 'https://push.apple.com.evil.example/x', 'https://fcm.googleapis.com@evil.example/x', 'https://x.notify.windows.com.evil/x', 'https://evil.example%2Ex.push.apple.com/x', 'https://user:pw@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://fcm.googleapis.com:0443/x'];
    expect([aimed.status, aimed.body.error.code, lookalikes.map(isAllowedPushEndpoint)]).toEqual([422, 'invalid', lookalikes.map(() => false)]);
    expect((await subscribe('p_priya', 'http://fcm.googleapis.com/fcm/send/abc')).status).toBe(422);
    expect((await t.api(t.as('p_priya'), 'PUT', '/app/push/subscription', { endpoint: FCM, keys: { p256dh: 'short', auth: 'x' } })).status).toBe(422); // not keys a browser makes
  });

  it('refuses an unsigned caller and an unknown field, on both subscribe and unsubscribe', async () => {
    const status = async (method: 'PUT' | 'POST', url: string, who: string | null, body: unknown) => (await t.api(who ? t.as(who) : null, method, url, body)).status;
    expect(await status('PUT', '/app/push/subscription', null, { endpoint: FCM, keys })).toBe(401);
    expect(await status('PUT', '/app/push/subscription', 'p_priya', { endpoint: FCM, keys, extra: 1 })).toBe(422);
    expect(await status('POST', '/app/push/unsubscribe', null, { endpoint: FCM })).toBe(401);
    expect(await status('POST', '/app/push/unsubscribe', 'p_priya', { endpoint: FCM, extra: 1 })).toBe(422);
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
    const spent = await t.api(t.as('p_rahul'), 'POST', '/app/trips/t_goa/expenses', { paid_by_person_id: 'p_rahul', amount_minor: 40000, note: 'Cab', category: 'getting_around', split_person_ids: ['p_rahul', 'p_priya'] });
    for (let i = 0; i < 50 && svc.calls.length < 2; i++) await sleep(20);
    expect([elapsed < 1800, posted.error === undefined, spent.status, (await rows(h.pool, `select 1 from messages where message_id = $1`, [posted.result.message_id])).length, svc.calls.length]).toEqual([true, true, 200, 1, 2]);
    svc.release();
    svc.set('ok');
    await sender.drain();
  });

  it('deletes a subscription the push service says is gone, and keeps one after any other failure without logging its address or keys; the write already succeeded', async () => {
    await subscribe('p_meher', FCM);
    svc.set('gone');
    await sender.send(['p_meher'], { body: 'x', data: { trip_id: 't_goa' } });
    await sender.drain();
    const afterGone = await subscriptionOwner(FCM);
    await subscribe('p_meher', FCM);
    svc.set('fail');
    logs.length = 0;
    const write = await t.api(t.as('p_rahul'), 'POST', '/app/trips/t_goa/expenses', { paid_by_person_id: 'p_rahul', amount_minor: 20000, note: 'Tea', category: 'food', split_person_ids: ['p_rahul', 'p_meher'] });
    await sender.drain();
    svc.set('ok');
    expect([afterGone, write.status, await subscriptionOwner(FCM), logs.length > 0, new RegExp(`fcm\\.googleapis|abc123|${keys.p256dh}|${keys.auth}`).test(logs.join(' '))]).toEqual([null, 200, 'p_meher', true, false]);
  });

  it('ends a send that hangs at the per-send limit, lets a drain finish a pending send, and returns from a drain within its bound when a send never ends', async () => {
    const ours = fakeService();
    const own = (over: Record<string, number>) => new WebPushSender({ pool: h.pool, vapid: VAPID, send: ours.send, log: (m) => logs.push(m), ...over });
    await subscribe('p_kabir', FCM);
    const limited = own({ sendTimeoutMs: 60, drainWaitMs: 2000 });
    ours.set('hang');
    const t0 = Date.now();
    await limited.send(['p_kabir'], { body: 'x', data: { trip_id: 't_goa' } });
    await limited.drain();
    const hangEnded = Date.now() - t0 < 1500;
    ours.release();
    let finished = false;
    const slowish: SendFn = async () => (await sleep(80), void (finished = true));
    const finishing = new WebPushSender({ pool: h.pool, vapid: VAPID, send: slowish, sendTimeoutMs: 4000, drainWaitMs: 2000 });
    await finishing.send(['p_kabir'], { body: 'x', data: { trip_id: 't_goa' } });
    await finishing.drain();
    const finishedBeforeDrainReturned = finished;
    const stuck = own({ sendTimeoutMs: 5000, drainWaitMs: 150 });
    ours.set('hang');
    await stuck.send(['p_kabir'], { body: 'x', data: { trip_id: 't_goa' } });
    const t1 = Date.now();
    await stuck.drain();
    const bounded = Date.now() - t1 < 1500;
    ours.release();
    expect([hangEnded, finishedBeforeDrainReturned, bounded]).toEqual([true, true, true]);
  });

  it('with the real library and throwaway keys, produces a signed, encrypted request whose payload is only the text (cut to 300) and where a tap goes, with no link', async () => {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const subscription = { endpoint: FCM, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
    const vapid = webpush.generateVAPIDKeys();
    const payload = payloadOf({ body: 'x'.repeat(400), data: { trip_id: 't_goa', message_id: 'm_1' } });
    const request = webpush.generateRequestDetails(subscription, payload, { vapidDetails: { subject: 'mailto:ops@example.com', ...vapid } });
    const sent = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    await h.pool.query('delete from push_subscriptions');
    await h.pool.query('insert into push_subscriptions (endpoint, person_id, p256dh, auth) values ($1, $2, $3, $4)', [subscription.endpoint, 'p_priya', subscription.keys.p256dh, subscription.keys.auth]);
    const real = new WebPushSender({ pool: h.pool, vapid: { ...vapid, subject: 'mailto:ops@example.com' } });
    await real.send(['p_priya'], { body: 'x'.repeat(400), data: { trip_id: 't_goa', message_id: 'm_1' } });
    await real.drain();
    const args = sent.mock.calls[0]!;
    sent.mockRestore();
    expect([
      request.endpoint, request.method, String(request.headers.Authorization).startsWith('vapid t='), request.headers['Content-Encoding'], request.body.length === Buffer.byteLength(payload) + 103, request.body.includes(Buffer.from('trip_id')),
      Object.keys(JSON.parse(payload)), JSON.parse(payload).body.length, /https?:|\/\//.test(payload), [args[0].endpoint, args[1], (args[2] as any).vapidDetails.publicKey === vapid.publicKey],
    ]).toEqual([FCM, 'POST', true, 'aes128gcm', true, false, ['body', 'data'], 300, false, [FCM, payload, true]]);
  });
});
