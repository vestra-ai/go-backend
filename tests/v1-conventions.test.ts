// The app contract's conventions (§1, phase 0): the one error shape with a request id, the Idempotency-Key store,
// GET /config, and the Me fields filled at sign-in.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepIdempotencyKeys } from '../src/api/idempotency.js';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, v1, type Harness } from './helpers/harness.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness({ features: { checkin: true } }); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
});
afterAll(() => h.stop());

const rahul = () => t.as('p_rahul');
const message = (text: string, headers: Record<string, string> = {}, who = rahul()) => t.api(who, 'POST', v1('/trips/t_goa/messages'), { client_message_id: `cm-${text}`, text }, headers);

describe('the error shape', () => {
  it('every refusal is { error: { code, message, field, retry_after_seconds, request_id } }, with X-Request-Id on every response', async () => {
    const ok = await t.api(rahul(), 'GET', v1('/trips/t_goa'));
    const unsigned = await t.api(null, 'GET', v1('/trips/t_goa'));
    const outsider = await t.api(t.as('p_nobody'), 'GET', v1('/trips/t_goa'));
    const missing = await t.api(rahul(), 'GET', v1('/trips/t_goa/messages/m_nope'));
    const rule = await t.api(rahul(), 'PATCH', v1('/trips/t_goa'), { dates: { start: '2026-11-09', end: '2026-11-06' } });
    const unknownField = await t.api(rahul(), 'PATCH', v1('/trips/t_goa'), { colour: 'blue' });
    const wrongType = await t.api(rahul(), 'PATCH', v1('/trips/t_goa'), { title: 5 });
    const shape = (r: { body: any; headers: any }) => ({ ...r.body.error, request_id: r.body.error.request_id === r.headers['x-request-id'] ? 'matches the header' : r.body.error.request_id });
    expect(ok.headers['x-request-id']).toMatch(/^[0-9a-f]{12}$/);
    expect(shape(unsigned)).toEqual({ code: 'unauthorized', message: 'sign in first', field: null, retry_after_seconds: null, request_id: 'matches the header' });
    expect(shape(outsider)).toMatchObject({ code: 'forbidden', field: null, retry_after_seconds: null, request_id: 'matches the header' });
    expect(shape(missing)).toMatchObject({ code: 'not_found', request_id: 'matches the header' });
    expect([rule.status, shape(rule)]).toEqual([422, { code: 'invalid', message: 'dates.start must be on or before dates.end', field: null, retry_after_seconds: null, request_id: 'matches the header' }]);
    expect([unknownField.status, unknownField.body.error.field, wrongType.status, wrongType.body.error.field]).toEqual([422, 'colour', 422, 'title']);
  });

  it('the notification and Nudge routes are gone: 404 like any unknown route, for a member too', async () => {
    const gone = [
      await t.api(rahul(), 'POST', v1('/me/devices'), { platform: 'web_push', web_push: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'a', auth: 'b' } } }),
      await t.api(rahul(), 'DELETE', v1('/me/devices/dev_1')),
      await t.api(rahul(), 'POST', v1('/trips/t_goa/transfers/nudge'), { from_person_id: 'p_priya' }),
    ];
    expect(gone.map((r) => [r.status, r.body.error.code])).toEqual([[404, 'not_found'], [404, 'not_found'], [404, 'not_found']]);
  });

  it('a 429 carries retry_after_seconds in the body and the Retry-After header', async () => {
    h.ctx.limits = { messagesPerMinute: 1 };
    await t.api(rahul(), 'POST', v1('/trips/t_goa/messages'), { client_message_id: 'cm_429_a', text: 'one' });
    const again = await t.api(rahul(), 'POST', v1('/trips/t_goa/messages'), { client_message_id: 'cm_429_b', text: 'two' });
    h.ctx.limits = undefined;
    expect([again.status, again.body.error.code, again.body.error.retry_after_seconds, Number(again.headers['retry-after'])]).toEqual([429, 'rate_limited', expect.any(Number), again.body.error.retry_after_seconds]);
  });
});

describe('Idempotency-Key', () => {
  it('a repeat with the same key and body replays the first answer (status, body, Idempotent-Replayed: true) and writes nothing more', async () => {
    const first = await message('hello once', { 'idempotency-key': 'k-1' });
    const again = await message('hello once', { 'idempotency-key': 'k-1' });
    expect([first.status, first.headers['idempotent-replayed'], again.status, again.headers['idempotent-replayed'], again.body]).toEqual([201, undefined, 201, 'true', first.body]);
    expect((await rows(h.pool, `select count(*)::int as n from messages where text = 'hello once'`))[0].n).toBe(1);
    expect((await rows(h.pool, `select method, path, status from idempotency_keys where key = 'k-1'`))[0]).toEqual({ method: 'POST', path: v1('/trips/t_goa/messages'), status: 201 });
  });

  it('the same key with a different body is 422 idempotency_key_reused; keys are per person, method and path', async () => {
    await message('body a', { 'idempotency-key': 'k-2' });
    const reused = await message('body b', { 'idempotency-key': 'k-2' });
    expect([reused.status, reused.body.error.code, reused.body.error.field, reused.body.error.message]).toEqual([422, 'invalid', 'Idempotency-Key', expect.stringMatching(/^idempotency_key_reused/)]);
    const other = await message('body a', { 'idempotency-key': 'k-2' }, t.as('p_priya')); // Priya's own key space
    const elsewhere = await t.api(rahul(), 'POST', v1('/trips/t_goa/read'), { up_to_seq: 1 }, { 'idempotency-key': 'k-2' }); // another path
    expect([other.status, other.headers['idempotent-replayed'], elsewhere.status]).toEqual([201, undefined, 204]);
  });

  it('an error answer is replayed too; a key that is too long is refused; a key on a GET is ignored', async () => {
    const refused = await t.api(rahul(), 'PUT', v1('/trips/t_goa/decisions/d_nope/vote'), { option_index: 0 }, { 'idempotency-key': 'k-3' });
    const replay = await t.api(rahul(), 'PUT', v1('/trips/t_goa/decisions/d_nope/vote'), { option_index: 0 }, { 'idempotency-key': 'k-3' });
    expect([refused.status, replay.status, replay.headers['idempotent-replayed'], replay.body]).toEqual([404, 404, 'true', refused.body]);
    expect((await message('x', { 'idempotency-key': 'k'.repeat(129) })).status).toBe(422);
    expect((await t.api(rahul(), 'GET', v1('/trips/t_goa'), undefined, { 'idempotency-key': 'k-4' })).status).toBe(200);
    expect(await rows(h.pool, `select 1 from idempotency_keys where key = 'k-4'`)).toEqual([]);
  });

  it('a create without client_id works with the header, and the header stands in for the press key', async () => {
    const vote = { question: 'Where to eat?', kind: 'yesno', anonymous: false, options: [{ label: 'Yes' }, { label: 'No' }] };
    const noKey = await t.api(rahul(), 'POST', v1('/trips/t_goa/decisions'), vote);
    const withHeader = await t.api(rahul(), 'POST', v1('/trips/t_goa/decisions'), vote, { 'idempotency-key': 'k-5' });
    const repeat = await t.api(rahul(), 'POST', v1('/trips/t_goa/decisions'), vote, { 'idempotency-key': 'k-5' });
    expect([noKey.status, noKey.body.error.field, withHeader.status, repeat.status, repeat.body]).toEqual([422, 'client_id', 201, 201, withHeader.body]);
    expect((await rows(h.pool, `select count(*)::int as n from decisions where question = 'Where to eat?'`))[0].n).toBe(1);
  });

  it('the sweep forgets keys older than 24 hours', async () => {
    await h.pool.query(`update idempotency_keys set created_at = now() - interval '25 hours' where key = 'k-1'`);
    expect(await sweepIdempotencyKeys(h.pool)).toBe(1);
    const fresh = await message('hello once', { 'idempotency-key': 'k-1' }); // a new press after the window
    expect([fresh.status, fresh.headers['idempotent-replayed']]).toEqual([201, undefined]);
  });
});

describe('GET /config and /health', () => {
  it('answers the contract version, the flags (defaults, then the environment), without sign-in', async () => {
    const config = await t.api(null, 'GET', v1('/config'));
    expect(config.body).toEqual({
      contract: '1.0.0', min_client_version: '1.0.0', currency_default: 'INR',
      features: { checkin: true, visa: false, calls: false, vote_retract: false, vote_flexible: false, claim: false },
    });
    expect((await t.api(null, 'GET', v1('/health'))).body).toEqual({ ok: true, go: true });
    expect((await t.api(null, 'GET', '/health')).body).toEqual({ ok: true, go: true });
  });
});

describe('Me', () => {
  it('a new sign-in fills email and auth_provider from the token; the profile shows the app\'s fields', async () => {
    const asha = await h.signIn('Asha', { email: 'asha@gmail.com' });
    const me = await t.api(asha, 'GET', v1('/me'));
    expect(me.body).toEqual({
      person_id: asha.id, name: 'Asha', photo_url: 'https://lh3.googleusercontent.com/a/test-photo', has_upi: false, upi_id_masked: null, email: 'asha@gmail.com', auth_provider: 'google', from_city: null,
      counts: { active_trips: 0, past_trips: 0 }, created_at: expect.any(String),
    });
    expect(Date.now() - Date.parse(me.body.created_at)).toBeLessThan(60_000);
  });
});
