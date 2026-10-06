// One test per bug found in the full review against the docs (docs/REVIEW.md, "Bugs found and fixed").
// Each would have failed before its fix.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate.js';
import { signSession } from '../src/api/auth.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => (h = await startHarness()));
afterAll(() => h.stop());

const T = 't_goa';
let n = 0;
const rq = () => `rq_fix_${++n}`;
const ok = async (method: string, params: Record<string, unknown>) => {
  const f = await h.go.call(method, { request_id: rq(), trip_id: T, ...params });
  if (f.error) throw new Error(`${method}: ${JSON.stringify(f.error)}`);
  return f.result;
};
const goErr = async (method: string, params: Record<string, unknown>) => (await h.go.call(method, { request_id: rq(), trip_id: T, ...params })).error;
const token = (id: string) => signSession(id, h.sessionSecret);
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const api = async (who: string | null, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const r = await h.app.inject({ method, url, payload: payload as any, headers: { ...(who ? { authorization: `Bearer ${token(who)}` } : {}), ...headers } });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, headers: r.headers };
};
const events = (type: string) => h.go.events.filter((e) => e.type === type);
const msg = (who: string, client_id: string, text: string) => api(who, 'POST', `/app/trips/${T}/messages`, { client_id, text });

describe('A1: a person\'s message without client_id', () => {
  it('is refused with 400 instead of being silently dropped as a "repeat"', async () => {
    const first = await api('p_rahul', 'POST', `/app/trips/${T}/messages`, { text: 'first' });
    const second = await api('p_rahul', 'POST', `/app/trips/${T}/messages`, { text: 'second' });
    expect(first.status).toBe(400);
    expect(second.status).toBe(400);
    expect(first.body.error.code).toBe('invalid');
    expect((await rows(h.pool, "select count(*)::int as n from messages where text in ('first','second')"))[0].n).toBe(0);
  });

  it('two different client ids are two messages; the same one is one', async () => {
    const a = await msg('p_rahul', 'fx_a', 'one');
    const b = await msg('p_rahul', 'fx_b', 'two');
    const a2 = await msg('p_rahul', 'fx_a', 'one');
    expect(a.body.message_id).not.toBe(b.body.message_id);
    expect(a2.body).toEqual(a.body);
  });
});

describe('A2: bad app input answers 400 or 422 with the standard error, never 500', () => {
  const bad: Array<[string, Method, string, unknown, number]> = [
    ['text over 4000 characters', 'POST', `/app/trips/${T}/messages`, { client_id: 'fx_long', text: 'x'.repeat(4001) }, 400],
    ['an empty JSON object for a message', 'POST', `/app/trips/${T}/messages`, {}, 400],
    ['an attachment of the wrong shape', 'POST', `/app/trips/${T}/messages`, { client_id: 'fx_att', text: 'pic', attachments: [{ kind: 'video' }] }, 422],
    ['an emoji longer than 16 characters', 'POST', `/app/trips/${T}/messages/m_any/reactions`, { emoji: '👍'.repeat(17) }, 400],
    ['a vote with no option', 'POST', `/app/trips/${T}/decisions/d_any/vote`, {}, 400],
    ['an expense of zero', 'POST', `/app/trips/${T}/expenses`, { paid_by_person_id: 'p_rahul', amount_minor: 0, note: 'x', category: 'food', split_person_ids: ['p_rahul'] }, 400],
    ['an expense with no amount', 'POST', `/app/trips/${T}/expenses`, { paid_by_person_id: 'p_rahul', note: 'x', category: 'food', split_person_ids: ['p_rahul'] }, 400],
    ['an expense with an empty split', 'POST', `/app/trips/${T}/expenses`, { paid_by_person_id: 'p_rahul', amount_minor: 100, note: 'x', category: 'food', split_person_ids: [] }, 400],
    ['an expense with an unknown category', 'POST', `/app/trips/${T}/expenses`, { paid_by_person_id: 'p_rahul', amount_minor: 100, note: 'x', category: 'banana', split_person_ids: ['p_rahul'] }, 422],
    ['an expense note over 120 characters', 'POST', `/app/trips/${T}/expenses`, { paid_by_person_id: 'p_rahul', amount_minor: 100, note: 'x'.repeat(121), category: 'food', split_person_ids: ['p_rahul'] }, 400],
    ['a card tap with an action id the contract refuses', 'POST', `/app/trips/${T}/card-taps`, { card_id: 'c_any', action_id: 'Pick' }, 400],
    ['a card tap with no card', 'POST', `/app/trips/${T}/card-taps`, { action_id: 'pick' }, 400],
    ['pausing Go with no answer', 'POST', `/app/trips/${T}/go-paused`, {}, 400],
    ['typing with no on/off', 'POST', `/app/trips/${T}/typing`, {}, 400],
    ['a vault link to a page that does not exist', 'POST', '/app/me/vault-link', { start: 'bogus' }, 400],
    ['carry-over with no value', 'PUT', '/app/me/carry-over', {}, 400],
    ['a device with no token', 'POST', '/app/devices', { platform: 'ios' }, 400],
    ['a device on an unknown platform', 'POST', '/app/devices', { token: 't', platform: 'windows' }, 400],
  ];
  for (const [what, method, url, body, status] of bad) {
    it(`${what}: ${status}`, async () => {
      const r = await api('p_rahul', method, url, body);
      expect(r.status).toBe(status);
      expect(r.body.error.code).toBe('invalid');
    });
  }

  it('join answers over the contract limits: 400', async () => {
    const stranger = (await api(null, 'POST', '/app/people', { name: 'New' })).body.person_id;
    expect((await api(stranger, 'POST', '/app/join/inv_t_goa', { know: Array.from({ length: 21 }, (_, i) => `k${i}`) })).status).toBe(400);
    expect((await api(stranger, 'POST', '/app/join/inv_t_goa', { from_city: 'x'.repeat(61) })).status).toBe(400);
    expect((await api(stranger, 'POST', '/app/join/inv_t_goa', { budget: {} })).status).toBe(400);
  });

  it('unreadable JSON and an empty JSON body: 400, not 500', async () => {
    const broken = await api('p_rahul', 'POST', `/app/trips/${T}/messages`, '{"client_id": "x", ', { 'content-type': 'application/json' });
    expect(broken.status).toBe(400);
    expect(broken.body.error.code).toBe('invalid');
    const empty = await h.app.inject({ method: 'POST', url: `/app/trips/${T}/messages`, payload: '', headers: { authorization: `Bearer ${token('p_rahul')}`, 'content-type': 'application/json' } });
    expect(empty.statusCode).toBe(400);
  });

  it('a bad after_seq or limit on the message list: 400', async () => {
    expect((await api('p_rahul', 'GET', `/app/trips/${T}/messages?after_seq=abc`)).status).toBe(400);
    expect((await api('p_rahul', 'GET', `/app/trips/${T}/messages?limit=500`)).status).toBe(400);
    expect((await api('p_rahul', 'GET', `/app/trips/${T}/messages?after_seq=0&limit=2`)).status).toBe(200);
  });

  it('PATCH with no text is refused and the message keeps its words', async () => {
    const m = await msg('p_priya', 'fx_keep', 'keep these words');
    const r = await api('p_priya', 'PATCH', `/app/trips/${T}/messages/${m.body.message_id}`, {});
    expect(r.status).toBe(400);
    expect((await rows(h.pool, 'select text from messages where message_id = $1', [m.body.message_id]))[0].text).toBe('keep these words');
  });

  it('an unknown route answers 404 in the standard error shape', async () => {
    const r = await api('p_rahul', 'GET', '/app/nope');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: 'not_found', message: 'no route GET /app/nope' } });
  });

  it('a POST with no body at all still works for routes that need none', async () => {
    const r = await h.app.inject({ method: 'POST', url: `/app/trips/${T}/seen`, headers: { authorization: `Bearer ${token('p_rahul')}` } });
    expect(r.statusCode).toBe(200);
  });
});

describe('A3: an update that sends only fields the contract does not know', () => {
  it('update_trip answers 422, not 500, and sends no event', async () => {
    await h.flush();
    const before = h.go.events.length;
    expect(await goErr('update_trip', { colour: 'blue' })).toMatchObject({ code: 422, data: { code: 'invalid' } });
    await h.flush();
    expect(h.go.events.length).toBe(before);
  });

  it('update_booking and update_record_line answer 422 and send no empty event', async () => {
    const b = await ok('add_booking', { kind: 'cab', title: 'Cab', vendor: 'Kabir', ref: 'cab-x', amount_minor: 100000, currency: 'INR', payer_person_id: 'p_kabir', for_person_ids: ['p_kabir'] });
    const m = await msg('p_rahul', 'fx_proof', 'proof');
    const l = await ok('add_record_line', { kind: 'doing', text: 'Kabir books the cab', proof: [{ message_id: m.body.message_id }], person_ids: ['p_kabir'] });
    await h.flush();
    const before = h.go.events.length;
    expect(await goErr('update_booking', { booking_id: b.booking_id, colour: 'blue' })).toMatchObject({ code: 422 });
    expect(await goErr('update_record_line', { line_id: l.line_id, colour: 'blue' })).toMatchObject({ code: 422 });
    await h.flush();
    expect(h.go.events.length).toBe(before);
  });
});

describe('A4: the "you owe" push comes from money.transfers', () => {
  it('someone in credit for the whole trip is not pushed, even when they are in the new split', async () => {
    // A new small trip so the balances are easy to follow.
    const [a, b] = (await Promise.all(['Asha', 'Ben'].map(async (name) => (await api(null, 'POST', '/app/people', { name })).body.person_id))) as [string, string];
    const t = (await api(a, 'POST', '/app/trips', { title: 'Owe test' })).body;
    await api(b, 'POST', `/app/join/${t.invite_url.split('/j/')[1]}`, {});
    // Asha pays ₹1,000 for both: Ben owes Asha ₹500.
    h.push.sent.length = 0;
    await api(a, 'POST', `/app/trips/${t.trip_id}/expenses`, { paid_by_person_id: a, amount_minor: 100000, note: 'Dinner', category: 'food', split_person_ids: [a, b] });
    expect(h.push.sent).toEqual([{ to: [b], n: { body: 'You owe Asha ₹500 for Dinner', data: { trip_id: t.trip_id } } }]);
    // Ben pays ₹200 for both: Asha's share is ₹100, but she is still owed ₹400 overall, so she gets no push.
    h.push.sent.length = 0;
    await api(b, 'POST', `/app/trips/${t.trip_id}/expenses`, { paid_by_person_id: b, amount_minor: 20000, note: 'Coffee', category: 'food', split_person_ids: [a, b] });
    expect(h.push.sent).toEqual([]);
  });
});

describe('A5: a booking after a person undid the decided line', () => {
  it('leaves the undone line undone and gives the booking a booked line of its own', async () => {
    const d = await ok('open_vote', { question: 'Which villa?', kind: 'choice', anonymous: false, options: [{ label: 'Villa Sol' }, { label: 'Casa Azul' }] });
    for (const p of ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir']) await h.pool.query('insert into votes (decision_id, person_id, option_index) values ($1,$2,0)', [d.decision_id, p]);
    await ok('close_vote', { decision_id: d.decision_id });
    const [decided] = await rows(h.pool, "select line_id from record_lines where decision_id = $1 and kind = 'decided'", [d.decision_id]);
    expect((await api('p_priya', 'POST', `/app/trips/${T}/record/${decided.line_id}/undo`)).status).toBe(200);
    const b = await ok('add_booking', { kind: 'stay', title: 'Villa Sol, 3 nights', vendor: 'ixigo', ref: 'IXG-1', amount_minor: 5420000, currency: 'INR', payer_person_id: 'p_rahul', for_person_ids: ['p_rahul'], decision_id: d.decision_id });
    const lines = await rows(h.pool, 'select line_id, kind, status, booking_id from record_lines where decision_id = $1 order by created_at', [d.decision_id]);
    expect(lines).toEqual([
      { line_id: decided.line_id, kind: 'decided', status: 'undone', booking_id: null },
      { line_id: expect.any(String), kind: 'booked', status: 'active', booking_id: b.booking_id },
    ]);
    await h.flush();
    expect(events('record.changed').at(-1)!.data).toMatchObject({ change: 'added', by: { kind: 'system' }, line: { kind: 'booked', status: 'active' } });
  });
});

describe('A6: two different requests for the same thing at the same moment', () => {
  it('the same ✅ from Go twice at once: one is done, the other is a 409, never a 500', async () => {
    const m = await msg('p_rahul', 'fx_race', 'race me');
    const answers = await Promise.all([1, 2].map(() => h.go.call('add_reaction', { request_id: rq(), trip_id: T, message_id: m.body.message_id, emoji: '✅' })));
    expect(answers.filter((a) => a.result)).toHaveLength(1);
    expect(answers.find((a) => a.error)!.error).toMatchObject({ code: 409, data: { code: 'conflict' } });
  });

  it('the same card id in two post_message calls at once: one is posted, the other is a 409', async () => {
    const card = { card_id: 'c_race', kind: 'notice', fallback_text: 'x', title: 'x', body: 'x', tone: 'info' };
    const answers = await Promise.all([1, 2].map(() => h.go.call('post_message', { request_id: rq(), trip_id: T, text: 'card', card })));
    expect(answers.filter((a) => a.result)).toHaveLength(1);
    expect(answers.find((a) => a.error)!.error).toMatchObject({ code: 409 });
  });
});

describe('A7: someone with a budget answer leaves', () => {
  it('sends trip.updated ["budget"] by the system after person.left, so Go knows the band moved', async () => {
    const p = (await api(null, 'POST', '/app/people', { name: 'Budgeter' })).body.person_id;
    await api(p, 'POST', '/app/join/inv_t_goa', { budget: { min_minor: 900000 } });
    const before = (await h.go.call('read_trip', { trip_id: T })).result.budget;
    expect(before.lowest.min_minor).toBe(900000);
    await api(p, 'POST', `/app/trips/${T}/leave`);
    await h.flush();
    const left = events('person.left').at(-1)!;
    const updated = events('trip.updated').at(-1)!;
    expect(left.data).toEqual({ person_id: p });
    expect(updated).toMatchObject({ seq: left.seq + 1, data: { by: { kind: 'system' }, changed: ['budget'] } });
    const after = (await h.go.call('read_trip', { trip_id: T })).result.budget;
    expect(after.answered).toBe(before.answered - 1);
  });

  it('someone with no budget answer leaving sends no budget event', async () => {
    const p = (await api(null, 'POST', '/app/people', { name: 'NoBudget' })).body.person_id;
    await api(p, 'POST', '/app/join/inv_t_goa', {});
    await api(p, 'POST', `/app/trips/${T}/leave`);
    await h.flush();
    expect(h.go.events.at(-1)).toMatchObject({ type: 'person.left', data: { person_id: p } });
  });
});

describe('A8: not-found answers carry the not_found code', () => {
  it('a tap on a card that does not exist: 404 not_found', async () => {
    const r = await api('p_rahul', 'POST', `/app/trips/${T}/card-taps`, { card_id: 'c_missing', action_id: 'pick' });
    expect(r).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
  });

  it('Go answering 404 for a fact it does not have: 404 not_found to the app', async () => {
    h.go.answers.delete_fact = () => ({ error: { code: 404, message: 'no fact f_x', data: { code: 'not_found' } } });
    const r = await api('p_rahul', 'DELETE', '/app/me/facts/f_x');
    expect(r).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
    h.go.answers.delete_fact = () => ({ result: { ok: true } });
  });
});

describe('A9: an expense for a booking in another trip', () => {
  it('is refused with 422', async () => {
    const r = await api('p_rahul', 'POST', `/app/trips/${T}/expenses`, { paid_by_person_id: 'p_rahul', amount_minor: 100, note: 'x', category: 'stay', split_person_ids: ['p_rahul'], booking_id: 'b_elsewhere' });
    expect(r).toMatchObject({ status: 422, body: { error: { code: 'invalid' } } });
  });
});

describe('B11: two instances starting at the same moment', () => {
  it('apply the migration once: the second waits for the first, then finds it applied', async () => {
    const base = process.env.TEST_PG_URL!;
    const name = `t_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Client({ connectionString: `${base}/postgres` });
    await admin.connect();
    await admin.query(`create database ${name}`);
    await admin.end();
    const a = new pg.Pool({ connectionString: `${base}/${name}` });
    const b = new pg.Pool({ connectionString: `${base}/${name}` });
    const [ra, rb] = await Promise.all([migrate(a), migrate(b)]);
    expect([...ra, ...rb]).toEqual(['001_core.sql']);
    await a.end();
    await b.end();
  });
});

describe('B13: frames that are not JSON-RPC', () => {
  it('an object that is neither a request nor an answer gets -32700 with a null id', async () => {
    expect(await h.go.raw('{"jsonrpc":"2.0"}')).toMatchObject({ id: null, error: { code: -32700 } });
    expect(await h.go.raw('{"id":"x","method":"read_trip"}')).toMatchObject({ id: null, error: { code: -32700 } });
  });

  it('an answer to a request we no longer wait for is ignored, not refused', async () => {
    const before = h.go.frames.length;
    const ws = (h.go as any).sockets.values().next().value;
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'gs_gone', result: { ok: true } }));
    await new Promise((r) => setTimeout(r, 100));
    expect(h.go.frames.slice(before).find((f) => f.error?.code === -32700)).toBeUndefined();
  });
});

describe('B16: cancelling an approval that already expired', () => {
  it('answers ok and changes nothing', async () => {
    const [d] = await rows(h.pool, "select decision_id from decisions where trip_id = $1 and status = 'closed' limit 1", [T]);
    await h.pool.query(
      `insert into spend_approvals (approval_id, trip_id, request_id, decision_id, payer_person_id, amount_minor, currency, merchant, approval, expires_at)
       values ('ap_expired01', $1, 'rq_old', $2, 'p_rahul', 100, 'INR', 'x', 'token', now() - interval '1 minute')`,
      [T, d.decision_id],
    );
    expect(await ok('cancel_spend_approval', { approval_id: 'ap_expired01', reason: 'other' })).toEqual({ ok: true });
    expect((await rows(h.pool, "select cancelled_at from spend_approvals where approval_id = 'ap_expired01'"))[0].cancelled_at).toBeNull();
  });
});
