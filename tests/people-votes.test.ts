import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check } from '../src/contract/index.js';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness(); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
});
afterAll(() => h.stop());

const priya = () => t.as('p_priya');
const vote = { client_id: 'c1', question: 'Where do we stay?', kind: 'choice', anonymous: false, options: [{ label: 'Villa Sol', price_minor: 1200000 }, { label: 'Beach hut' }] };

describe('a member opens a vote', () => {
  it('Go hears it by that person, others see it in their strip, it closes when all vote, and no push is sent', async () => {
    const r = await t.api(priya(), 'POST', '/app/trips/t_goa/decisions', vote);
    expect([r.status, Object.keys(r.body).sort()]).toEqual([201, ['decision_id', 'seq']]);
    await h.flush();
    const opened = t.events('decision.opened').find((e) => e.data.decision.decision_id === r.body.decision_id)!;
    expect(check('Event', opened)).toMatchObject({ ok: true });
    expect(opened.data).toMatchObject({ by: { kind: 'person', person_id: 'p_priya' }, decision: { opened_by_person_id: 'p_priya', of: 5, voted: 0, status: 'open', options: [{ label: 'Villa Sol', price_minor: 1200000, currency: 'INR' }, { label: 'Beach hut' }] } });
    expect(opened.data.decision.options[1]).not.toHaveProperty('currency');
    expect((await t.api(t.as('p_kabir'), 'GET', '/app/trips/t_goa/needs-you')).body).toContainEqual({ kind: 'vote', decision_id: r.body.decision_id, text: 'Where do we stay?' });
    expect(h.live.events).toContainEqual({ tripId: 't_goa', event: { kind: 'trip', seq: r.body.seq } });
    for (const p of ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir']) await t.api(t.as(p), 'POST', `/app/trips/t_goa/decisions/${r.body.decision_id}/vote`, { option_index: 0 });
    await h.flush();
    expect(t.events('decision.closed').find((e) => e.data.decision.decision_id === r.body.decision_id)!.data).toMatchObject({ reason: 'everyone_voted', decision: { result_index: 0 } });
    expect(h.push.sent).toEqual([]);
  });

  it('refuses an unsigned caller, someone outside the trip, an unknown field and a closing time in the past', async () => {
    const post = (who: any, body: unknown) => t.api(who, 'POST', '/app/trips/t_goa/decisions', body);
    const refused = async (who: any, body: unknown) => { const r = await post(who, body); return [r.status, r.body.error.code]; };
    expect(await refused(null, vote)).toEqual([401, 'unauthorized']);
    expect(await refused(t.as('p_stranger'), vote)).toEqual([403, 'forbidden']);
    expect(await refused(priya(), { ...vote, client_id: 'c2', extra: 1 })).toEqual([422, 'invalid']);
    expect(await refused(priya(), { ...vote, client_id: 'c3', closes_at: new Date(Date.now() - 60_000).toISOString() })).toEqual([422, 'invalid']);
  });

  it('the same client id twice, in sequence and three at once, makes one vote with one event', async () => {
    const press = (question: string) => t.api(priya(), 'POST', '/app/trips/t_goa/decisions', { ...vote, client_id: `press-${question}`, question });
    const first = await press('Same press');
    const second = await press('Same press');
    expect([second.status, second.body]).toEqual([201, first.body]);
    const three = await Promise.all([press('Triple tap'), press('Triple tap'), press('Triple tap')]);
    expect(three.map((r) => [r.status, r.body])).toEqual(Array(3).fill([201, three[0]!.body]));
    await h.flush();
    const made = await rows(h.pool, `select decision_id from decisions where question in ('Same press', 'Triple tap')`);
    expect(made).toHaveLength(2);
    expect(t.events('decision.opened').filter((e) => ['Same press', 'Triple tap'].includes(e.data.decision.question))).toHaveLength(2);
  });

  it('refuses text the database cannot store and times it cannot read with 422, and accepts a far offset as the same instant', async () => {
    const post = (patch: Record<string, unknown>) => t.api(priya(), 'POST', '/app/trips/t_goa/decisions', { ...vote, client_id: `odd-${Math.random()}`, ...patch });
    const refused = async (patch: Record<string, unknown>) => { const r = await post(patch); return [r.status, r.body.error.code]; };
    expect(await refused({ question: 'a\u0000b' })).toEqual([422, 'invalid']);
    expect(await refused({ options: [{ label: '\ud800' }, { label: 'b' }] })).toEqual([422, 'invalid']);
    expect(await refused({ closes_at: '2016-12-31T23:59:60Z' })).toEqual([422, 'invalid']); // a leap second JavaScript cannot read
    const far = await post({ closes_at: '2099-01-01T10:00:00+20:00' }); // an offset Postgres refuses as written
    const [stored] = await rows(h.pool, 'select closes_at from decisions where decision_id = $1', [far.body.decision_id]);
    expect([far.status, stored.closes_at.toISOString()]).toEqual([201, '2098-12-31T14:00:00.000Z']);
  });

  it('a closing time that falls outside years 1 to 9999 once its offset is applied is refused with 422; the last instant of 9999 is accepted', async () => {
    const post = (closes_at: string) => t.api(priya(), 'POST', '/app/trips/t_goa/decisions', { ...vote, client_id: `year-${closes_at}`, closes_at });
    const over = await post('9999-12-31T23:30:00-01:00'); // year 10000 in UTC
    expect([over.status, over.body.error.code]).toEqual([422, 'invalid']);
    expect((await post('9999-12-31T23:30:00Z')).status).toBe(201);
  });
});
