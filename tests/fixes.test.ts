// One test per bug found in an earlier full review against the docs.
// Each would have failed before its fix.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../scripts/migrate.js';
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
const token = (id: string) => h.token(id);
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/** `who` is a seeded person's id, or a person signed in with `h.signIn` (whose token is their own). */
const api = async (who: string | { token: string } | null, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const bearer = typeof who === 'string' ? await token(who) : who?.token;
  const r = await h.app.inject({ method, url, payload: payload as any, headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers } });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, headers: r.headers };
};
const events = (type: string) => h.go.events.filter((e) => e.type === type);
const msg = (who: string, client_message_id: string, text: string) => api(who, 'POST', `/app/v1/trips/${T}/messages`, { client_message_id, text });

describe('A1: a person\'s message without client_message_id', () => {
  it('is refused with 422 naming the field instead of being silently dropped as a "repeat"', async () => {
    const first = await api('p_rahul', 'POST', `/app/v1/trips/${T}/messages`, { text: 'first' });
    const second = await api('p_rahul', 'POST', `/app/v1/trips/${T}/messages`, { text: 'second' });
    expect(first.status).toBe(422);
    expect(second.status).toBe(422);
    expect(first.body.error).toMatchObject({ code: 'invalid', field: 'client_message_id' });
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

describe('A2: bad app input answers 422 with the standard error (400 only for unreadable JSON), never 500', () => {
  const bad: Array<[string, Method, string, unknown, number]> = [
    ['text over 4000 characters', 'POST', `/app/v1/trips/${T}/messages`, { client_message_id: 'fx_long', text: 'x'.repeat(4001) }, 422],
    ['an empty JSON object for a message', 'POST', `/app/v1/trips/${T}/messages`, {}, 422],
    ['an attachment of the wrong shape', 'POST', `/app/v1/trips/${T}/messages`, { client_message_id: 'fx_att', text: 'pic', attachments: [{ kind: 'video' }] }, 422],
    ['an emoji longer than 16 characters', 'PUT', `/app/v1/trips/${T}/messages/m_any/reaction`, { emoji: '👍'.repeat(17) }, 422],
    ['a vote that is both for an option and flexible', 'PUT', `/app/v1/trips/${T}/decisions/d_any/vote`, { option_index: 0, flexible: true }, 422],
    ['a card press with a payload the contract does not know', 'POST', `/app/v1/trips/${T}/cards/c_any/actions`, { action_id: 'pick', payload: { trip: 'triangle' } }, 422],
    ['an upload of a type that is not allowed', 'POST', '/app/v1/uploads', { purpose: 'chat_attachment', kind: 'photo', mime: 'image/gif', size_bytes: 10 }, 422],
    ['a vote with no option', 'PUT', `/app/v1/trips/${T}/decisions/d_any/vote`, {}, 422],
    ['an expense of zero', 'POST', `/app/v1/trips/${T}/expenses`, { paid_by_person_id: 'p_rahul', amount_minor: 0, note: 'x', category: 'food', split_person_ids: ['p_rahul'] }, 422],
    ['an expense with no amount', 'POST', `/app/v1/trips/${T}/expenses`, { paid_by_person_id: 'p_rahul', note: 'x', category: 'food', split_person_ids: ['p_rahul'] }, 422],
    ['an expense with an empty split', 'POST', `/app/v1/trips/${T}/expenses`, { paid_by_person_id: 'p_rahul', amount_minor: 100, note: 'x', category: 'food', split_person_ids: [] }, 422],
    ['an expense with an unknown category', 'POST', `/app/v1/trips/${T}/expenses`, { paid_by_person_id: 'p_rahul', amount_minor: 100, note: 'x', category: 'banana', split_person_ids: ['p_rahul'] }, 422],
    ['an expense note over 120 characters', 'POST', `/app/v1/trips/${T}/expenses`, { paid_by_person_id: 'p_rahul', amount_minor: 100, note: 'x'.repeat(121), category: 'food', split_person_ids: ['p_rahul'] }, 422],
    ['a card press with an action id the contract refuses', 'POST', `/app/v1/trips/${T}/cards/c_any/actions`, { action_id: 'Pick' }, 422],
    ['a card press with no action', 'POST', `/app/v1/trips/${T}/cards/c_any/actions`, {}, 422],
    ['pausing Go with no answer', 'PATCH', `/app/v1/trips/${T}/me`, {}, 422],
    ['pausing Go with a string', 'PATCH', `/app/v1/trips/${T}/me`, { go_paused: 'true' }, 422],
    ['a vault link to a page that does not exist', 'POST', '/app/v1/me/vault-link', { start: 'bogus' }, 422],
    ['carry-over with no value', 'PATCH', '/app/v1/me/go', {}, 422],
    ['carry-over with a string', 'PATCH', '/app/v1/me/go', { carry_over: 'yes' }, 422],
    ['an edit with no text', 'PATCH', `/app/v1/trips/${T}/messages/m_any`, {}, 422],
  ];
  for (const [what, method, url, body, status] of bad) {
    it(`${what}: ${status}`, async () => {
      const r = await api('p_rahul', method, url, body);
      expect(r.status).toBe(status);
      expect(r.body.error.code).toBe('invalid');
    });
  }

  it('the four routes that once used Fastify\'s own check are strict like the rest: an unknown field is 422 naming it, nothing is coerced', async () => {
    const unknown: Array<[Method, string, unknown, string]> = [
      ['PATCH', `/app/v1/trips/${T}/messages/m_any`, { text: 'x', bogus: 1 }, 'bogus'],
      ['PATCH', `/app/v1/trips/${T}/me`, { go_paused: true, bogus: 1 }, 'bogus'],
      ['PATCH', '/app/v1/me/go', { carry_over: true, bogus: 1 }, 'bogus'],
      ['POST', '/app/v1/me/vault-link', { start: 'add_card', bogus: 1 }, 'bogus'],
      ['POST', '/app/v1/me/vault-link', { start: 'add_documents', context: { trip_id: T, purpose: 'visa', extra: 1 } }, 'context.extra'],
      ['POST', '/app/v1/me/vault-link', { context: { trip_id: T } }, 'context.purpose'],
    ];
    for (const [method, url, body, field] of unknown) {
      const r = await api('p_rahul', method, url, body);
      expect([url, r.status, r.body.error.code, r.body.error.field]).toEqual([url, 422, 'invalid', field]);
    }
  });

  it('join answers over the contract limits: 422, naming the field', async () => {
    const stranger = await h.signIn('New');
    const over = await api(stranger, 'POST', '/app/v1/invites/inv_t_goa/accept', { join_answers: { know: Array.from({ length: 21 }, (_, i) => `k${i}`) } });
    expect([over.status, over.body.error.field]).toEqual([422, 'join_answers.know']);
    expect((await api(stranger, 'POST', '/app/v1/invites/inv_t_goa/accept', { join_answers: { from_city: 'x'.repeat(61) } })).status).toBe(422);
    expect((await api(stranger, 'POST', '/app/v1/invites/inv_t_goa/accept', { join_answers: { spend_band: 'lt15' } })).status).toBe(422); // no longer an answer
    expect((await api(stranger, 'POST', '/app/v1/invites/inv_t_goa/accept', { budget: { min_minor: 1 } })).status).toBe(422); // the old shape
  });

  it('unreadable JSON is 400 bad_request; an empty JSON body is 422 (a field is missing), not 500', async () => {
    const broken = await api('p_rahul', 'POST', `/app/v1/trips/${T}/messages`, '{"client_message_id": "x", ', { 'content-type': 'application/json' });
    expect(broken.status).toBe(400);
    expect(broken.body.error.code).toBe('bad_request');
    const empty = await h.app.inject({ method: 'POST', url: `/app/v1/trips/${T}/messages`, payload: '', headers: { authorization: `Bearer ${await token('p_rahul')}`, 'content-type': 'application/json' } });
    expect(empty.statusCode).toBe(422);
  });

  it('a bad after_seq or limit on the message list, or both cursors at once: 422', async () => {
    expect((await api('p_rahul', 'GET', `/app/v1/trips/${T}/messages?after_seq=abc`)).status).toBe(422);
    expect((await api('p_rahul', 'GET', `/app/v1/trips/${T}/messages?limit=500`)).status).toBe(422);
    expect((await api('p_rahul', 'GET', `/app/v1/trips/${T}/messages?after_seq=0&limit=201`)).status).toBe(422);
    expect((await api('p_rahul', 'GET', `/app/v1/trips/${T}/messages?after_seq=0&before_seq=5`)).status).toBe(422);
    expect((await api('p_rahul', 'GET', `/app/v1/trips/${T}/messages?after_seq=0&limit=2`)).status).toBe(200);
  });

  it('PATCH with no text is refused and the message keeps its words', async () => {
    const m = await msg('p_priya', 'fx_keep', 'keep these words');
    const r = await api('p_priya', 'PATCH', `/app/v1/trips/${T}/messages/${m.body.message_id}`, {});
    expect(r.status).toBe(422);
    expect((await rows(h.pool, 'select text from messages where message_id = $1', [m.body.message_id]))[0].text).toBe('keep these words');
  });

  it('an unknown route answers 404 in the standard error shape, with the request id', async () => {
    const r = await api('p_rahul', 'GET', '/app/v1/nope');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: 'not_found', message: 'no route GET /app/v1/nope', field: null, retry_after_seconds: null, request_id: r.headers['x-request-id'] } });
  });

  it('a POST with no body at all still works for routes that need none', async () => {
    const r = await h.app.inject({ method: 'POST', url: `/app/v1/trips/${T}/read`, headers: { authorization: `Bearer ${await token('p_rahul')}` } });
    expect(r.statusCode).toBe(204);
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

describe('A5: a booking after a person undid the decided line', () => {
  it('leaves the undone line undone and gives the booking a booked line of its own', async () => {
    const d = await ok('open_vote', { question: 'Which villa?', kind: 'choice', anonymous: false, options: [{ label: 'Villa Sol' }, { label: 'Casa Azul' }] });
    for (const p of ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir']) await h.pool.query('insert into votes (decision_id, person_id, option_index) values ($1,$2,0)', [d.decision_id, p]);
    await ok('close_vote', { decision_id: d.decision_id });
    const [decided] = await rows(h.pool, "select line_id from record_lines where decision_id = $1 and kind = 'decided'", [d.decision_id]);
    expect((await api('p_priya', 'POST', `/app/v1/trips/${T}/record/${decided.line_id}/undo`)).status).toBe(200);
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

describe('A7: leaving a trip sends no budget event', () => {
  it('person.left is the last event of a leave: no trip.updated for the budget follows it', async () => {
    const p = await h.signIn('NoBudget');
    await api(p, 'POST', '/app/v1/invites/inv_t_goa/accept', {});
    await api(p, 'POST', `/app/v1/trips/${T}/leave`);
    await h.flush();
    expect(h.go.events.at(-1)).toMatchObject({ type: 'person.left', data: { person_id: p.id } });
  });
});

describe('A8: not-found answers carry the not_found code', () => {
  it('a tap on a card that does not exist: 404 not_found', async () => {
    const r = await api('p_rahul', 'POST', `/app/v1/trips/${T}/cards/c_missing/actions`, { action_id: 'pick' });
    expect(r).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
  });

  it('Go answering 404 for a fact it does not have: 404 not_found to the app', async () => {
    h.go.answers.delete_fact = () => ({ error: { code: 404, message: 'no fact f_x', data: { code: 'not_found' } } });
    const r = await api('p_rahul', 'DELETE', '/app/v1/me/go/facts/f_x');
    expect(r).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
    h.go.answers.delete_fact = () => ({ result: { ok: true } });
  });
});

describe('A9: an expense for a booking in another trip', () => {
  it('is refused with 422', async () => {
    const r = await api('p_rahul', 'POST', `/app/v1/trips/${T}/expenses`, { paid_by_person_id: 'p_rahul', amount_minor: 100, note: 'x', category: 'stay', split_person_ids: ['p_rahul'], booking_id: 'b_elsewhere' });
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
    const applied = [...ra, ...rb];
    const sql = applied.filter((f) => f.endsWith('.sql'));
    expect(sql.slice(0, 5)).toEqual(['001_core.sql', '002_people_actions.sql', '003_supabase.sql', '004_v1_conventions.sql', '005_v1_people.sql']); // each file is applied once, by whichever instance got the lock first
    expect([new Set(sql).size === sql.length, sql.includes('006_v1_room.sql') && sql.includes('007_v1_money.sql'), applied.filter((f) => !f.endsWith('.sql'))]).toEqual([true, true, [expect.stringMatching(/^data\/cities-in\.json#/)]]); // no file twice, and the cities file once
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

describe('R2 (real Go): an empty body with content-type: application/json', () => {
  it('is read as no body: a POST that needs none works, and a route that needs fields still says 422', async () => {
    const headers = { authorization: `Bearer ${await token('p_rahul')}`, 'content-type': 'application/json' };
    expect((await h.app.inject({ method: 'POST', url: `/app/v1/trips/${T}/read`, payload: '', headers })).statusCode).toBe(204);
    const msg = await h.app.inject({ method: 'POST', url: `/app/v1/trips/${T}/messages`, payload: '', headers });
    expect(msg.statusCode).toBe(422);
    expect(JSON.parse(msg.body).error.message).toMatch(/client_message_id/);
  });
});

describe('R1 (real Go): forget me', () => {
  it('sends no person.updated when there were no join answers to clear', async () => {
    await h.flush();
    const before = h.go.events.length;
    expect((await api('p_meher', 'DELETE', `/app/v1/me/go?trip_id=${T}`)).status).toBe(200);
    await h.flush();
    expect(h.go.events.slice(before).filter((e) => e.type === 'person.updated')).toEqual([]);
  });

  it('clears the answers in a trip the person has left, without an event, by trip or everywhere', async () => {
    const p = await h.signIn('Leaver');
    await api(p, 'POST', '/app/v1/invites/inv_t_goa/accept', { join_answers: { from_city: 'Pune', know: ['Nuts'] } });
    await api(p, 'POST', `/app/v1/trips/${T}/leave`);
    await h.flush();
    const before = h.go.events.length;
    expect((await api(p, 'DELETE', `/app/v1/me/go?trip_id=${T}`)).status).toBe(200); // was 403
    expect((await rows(h.pool, 'select from_city, know from trip_people where trip_id = $1 and person_id = $2', [T, p.id]))[0]).toEqual({ from_city: null, know: [] });
    await h.flush();
    expect(h.go.events.length).toBe(before);
    expect((await api(p, 'DELETE', `/app/v1/me/go?trip_id=${'t_never'}`)).status).toBe(403);
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
