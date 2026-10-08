// Votes, the mandate and the record for the app (app contract §4.8): GET with my_vote, "I'm flexible" and taking a vote
// back behind their flags, who may close, the Mandate and RecordLine answers, and the record with include_undone.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check } from '../src/contract/index.js';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness({ features: { vote_flexible: true, vote_retract: true } }); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
});
afterAll(() => h.stop());

const as = (id: string) => t.as(id);
const openVote = async (who = 'p_priya', question = `Q ${Math.random()}`) =>
  (await t.api(as(who), 'POST', '/app/v1/trips/t_goa/decisions', { client_id: `v-${question}`, question, kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }] })).body.decision.decision_id as string;
const vote = (who: string, did: string, body: unknown) => t.api(as(who), 'PUT', `/app/v1/trips/t_goa/decisions/${did}/vote`, body);
const get = (who: string, did: string) => t.api(as(who), 'GET', `/app/v1/trips/t_goa/decisions/${did}`);
const votedEvents = (did: string) => h.go.events.filter((e) => e.type === 'decision.voted' && e.data.decision_id === did);

describe('reading a vote', () => {
  it('answers the Decision with my_vote for the caller only; 404 for another trip\'s vote; 403 for a stranger', async () => {
    const did = await openVote();
    await vote('p_rahul', did, { option_index: 1 });
    const mine = await get('p_rahul', did);
    expect([mine.status, mine.body.my_vote, mine.body.tally, mine.body.voted]).toEqual([200, { option_index: 1 }, [0, 1], 1]);
    expect((await get('p_priya', did)).body.my_vote).toBeNull();
    const { my_vote: _m, ...decision } = mine.body;
    expect(check('Decision', decision)).toMatchObject({ ok: true });
    expect((await get('p_rahul', 'd_nope')).status).toBe(404);
    expect((await get('p_stranger', did)).status).toBe(403);
  });

  it('PUT vote answers the Decision with my_vote, and the closed one when the last vote closes it', async () => {
    const did = await openVote();
    const r = await vote('p_rahul', did, { option_index: 0 });
    expect([r.status, r.body.my_vote, r.body.status]).toEqual([200, { option_index: 0 }, 'open']);
    for (const p of ['p_priya', 'p_arjun', 'p_meher']) await vote(p, did, { option_index: 0 });
    const last = await vote('p_kabir', did, { option_index: 1 });
    expect([last.body.status, last.body.result_index, last.body.my_vote]).toEqual(['closed', 0, { option_index: 1 }]);
    expect((await vote('p_kabir', did, { option_index: 0 })).status).toBe(409);
  });
});

describe('"I\'m flexible" (features.vote_flexible)', () => {
  it('counts in voted and flexible_count, not in the tally or votes[]; the event says flexible with no option; moving to an option undoes it', async () => {
    const did = await openVote();
    const r = await vote('p_rahul', did, { flexible: true });
    expect([r.status, r.body.voted, r.body.tally, r.body.flexible_count, r.body.votes, r.body.my_vote]).toEqual([200, 1, [0, 0], 1, [], { flexible: true }]);
    await vote('p_priya', did, { option_index: 0 });
    const both = await get('p_rahul', did);
    expect([both.body.voted, both.body.tally, both.body.flexible_count, both.body.votes]).toEqual([2, [1, 0], 1, [{ person_id: 'p_priya', option_index: 0 }]]);
    await h.flush();
    expect(votedEvents(did)[0]!.data).toEqual({ decision_id: did, person_id: 'p_rahul', flexible: true, voted: 1, of: 5, tally: [0, 0] });
    expect(check('Event', votedEvents(did)[0]!)).toMatchObject({ ok: true });
    const moved = await vote('p_rahul', did, { option_index: 1 });
    expect([moved.body.tally, moved.body.flexible_count, moved.body.my_vote]).toEqual([[1, 1], undefined, { option_index: 1 }]);
    expect((await vote('p_rahul', did, { option_index: 0, flexible: true })).status).toBe(422);
    expect((await vote('p_rahul', did, {})).status).toBe(422);
    expect((await vote('p_rahul', did, { flexible: false })).status).toBe(422);
  });

  it('flexible votes never decide: everyone flexible closes with no result and no decided line; an anonymous flexible vote names nobody', async () => {
    const did = await openVote();
    for (const p of ['p_rahul', 'p_priya', 'p_arjun', 'p_meher']) await vote(p, did, { flexible: true });
    const last = await vote('p_kabir', did, { flexible: true });
    expect([last.body.status, last.body.result_index, last.body.flexible_count, last.body.voted]).toEqual(['closed', undefined, 5, 5]);
    expect(await rows(h.pool, 'select 1 from record_lines where decision_id = $1', [did])).toEqual([]);
    const secret = (await t.api(as('p_priya'), 'POST', '/app/v1/trips/t_goa/decisions', { client_id: 'anon-flex', question: 'Secret?', kind: 'yesno', anonymous: true, options: [{ label: 'Yes' }, { label: 'No' }] })).body.decision.decision_id;
    await vote('p_rahul', secret, { flexible: true });
    await h.flush();
    expect(votedEvents(secret)[0]!.data).toEqual({ decision_id: secret, flexible: true, voted: 1, of: 5, tally: [0, 0] });
  });

  it('is 409 when the flag is off', async () => {
    const off = await startHarness({ seed: true });
    try {
      const did = (await off.app.inject({ method: 'POST', url: '/app/v1/trips/t_goa/decisions', payload: { client_id: 'x', question: 'Q', kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }] }, headers: { authorization: `Bearer ${await off.token('p_priya')}` } })).json().decision.decision_id;
      const r = await off.app.inject({ method: 'PUT', url: `/app/v1/trips/t_goa/decisions/${did}/vote`, payload: { flexible: true }, headers: { authorization: `Bearer ${await off.token('p_rahul')}` } });
      expect([r.statusCode, r.json().error.code]).toEqual([409, 'conflict']);
      const del = await off.app.inject({ method: 'DELETE', url: `/app/v1/trips/t_goa/decisions/${did}/vote`, headers: { authorization: `Bearer ${await off.token('p_rahul')}` } });
      expect([del.statusCode, del.json().error.code]).toEqual([409, 'conflict']);
    } finally {
      await off.stop();
    }
  });
});

describe('taking a vote back (features.vote_retract)', () => {
  it('removes the vote, sends decision.voted with retracted and the new totals, answers the Decision; 409 with no vote or a closed vote', async () => {
    const did = await openVote();
    await vote('p_rahul', did, { option_index: 0 });
    await vote('p_priya', did, { option_index: 0 });
    const r = await t.api(as('p_rahul'), 'DELETE', `/app/v1/trips/t_goa/decisions/${did}/vote`);
    expect([r.status, r.body.voted, r.body.tally, r.body.my_vote, r.body.votes]).toEqual([200, 1, [1, 0], null, [{ person_id: 'p_priya', option_index: 0 }]]);
    expect((await t.api(as('p_rahul'), 'DELETE', `/app/v1/trips/t_goa/decisions/${did}/vote`)).status).toBe(409);
    await h.flush();
    expect(votedEvents(did).at(-1)!.data).toEqual({ decision_id: did, person_id: 'p_rahul', retracted: true, voted: 1, of: 5, tally: [1, 0] });
    expect(check('Event', votedEvents(did).at(-1)!)).toMatchObject({ ok: true });
    expect((await t.api(as('p_rahul'), 'GET', '/app/v1/trips/t_goa/needs-you')).body).toContainEqual(expect.objectContaining({ kind: 'vote', decision_id: did })); // it needs him again
    await t.api(as('p_priya'), 'POST', `/app/v1/trips/t_goa/decisions/${did}/close`);
    expect((await t.api(as('p_priya'), 'DELETE', `/app/v1/trips/t_goa/decisions/${did}/vote`)).status).toBe(409);
  });
});

describe('closing and calling off', () => {
  it('the organizer or the opener may close or cancel; another member is 403; the answer is the Decision with my_vote', async () => {
    const did = await openVote('p_priya');
    await vote('p_kabir', did, { option_index: 1 });
    expect((await t.api(as('p_kabir'), 'POST', `/app/v1/trips/t_goa/decisions/${did}/close`)).status).toBe(403);
    expect((await t.api(as('p_kabir'), 'POST', `/app/v1/trips/t_goa/decisions/${did}/cancel`)).status).toBe(403);
    const closed = await t.api(as('p_priya'), 'POST', `/app/v1/trips/t_goa/decisions/${did}/close`);
    expect([closed.status, closed.body.status, closed.body.result_index, closed.body.my_vote]).toEqual([200, 'closed', 1, null]);
    const other = await openVote('p_arjun');
    const cancelled = await t.api(as('p_rahul'), 'POST', `/app/v1/trips/t_goa/decisions/${other}/cancel`); // the organizer
    expect([cancelled.status, cancelled.body.status, cancelled.body.my_vote]).toEqual([200, 'cancelled', null]);
    const goVote = (await h.go.call('open_vote', { request_id: 'rq_dec_go', trip_id: 't_goa', question: 'Go asks', kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }] })).result.decision_id;
    expect((await t.api(as('p_priya'), 'POST', `/app/v1/trips/t_goa/decisions/${goVote}/close`)).status).toBe(403); // nobody opened it but Go: the organizer only
    expect((await t.api(as('p_rahul'), 'POST', `/app/v1/trips/t_goa/decisions/${goVote}/close`)).status).toBe(200);
  });
});

describe('the mandate and the record', () => {
  it('confirm and decline answer the Mandate', async () => {
    const did = await openVote();
    for (const p of ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir']) await vote(p, did, { option_index: 0 });
    await h.go.call('set_mandate', { request_id: 'rq_dec_m', trip_id: 't_goa', decision_id: did, choice_index: 0, cap_minor: 5500000, currency: 'INR', refundable_only: true, payer_person_id: 'p_rahul' });
    const declined = await t.api(as('p_rahul'), 'POST', `/app/v1/trips/t_goa/decisions/${did}/mandate/decline`);
    expect([declined.status, declined.body]).toEqual([200, expect.objectContaining({ choice_index: 0, cap_minor: 5500000, payer_person_id: 'p_rahul', declined_at: expect.any(String) })]);
    expect(check('Mandate', declined.body)).toMatchObject({ ok: true });
    const confirmed = await t.api(as('p_rahul'), 'POST', `/app/v1/trips/t_goa/decisions/${did}/mandate/confirm`);
    expect(confirmed.body).toMatchObject({ confirmed_at: expect.any(String), declined_at: expect.any(String) });
    expect((await t.api(as('p_priya'), 'POST', `/app/v1/trips/t_goa/decisions/${did}/mandate/confirm`)).status).toBe(403);
  });

  it('GET record lists active and done lines oldest first with seq; include_undone adds the undone ones; undo and redo answer the RecordLine', async () => {
    const m = (await t.api(as('p_rahul'), 'POST', '/app/v1/trips/t_goa/messages', { client_message_id: 'rec-1', text: 'scuba?' })).body;
    const a = (await h.go.call('add_record_line', { request_id: 'rq_rl_a', trip_id: 't_goa', kind: 'open', text: 'Scuba on Saturday?', proof: [{ message_id: m.message_id }], person_ids: ['p_priya'] })).result;
    const b = (await h.go.call('add_record_line', { request_id: 'rq_rl_b', trip_id: 't_goa', kind: 'doing', text: 'Kabir books the cab', proof: [], person_ids: ['p_kabir'] })).result;
    await h.go.call('update_record_line', { request_id: 'rq_rl_c', trip_id: 't_goa', line_id: b.line_id, status: 'done' });
    const undone = await t.api(as('p_meher'), 'POST', `/app/v1/trips/t_goa/record/${a.line_id}/undo`);
    expect([undone.status, undone.body.line_id, undone.body.status]).toEqual([200, a.line_id, 'undone']);
    expect(check('RecordLine', undone.body)).toMatchObject({ ok: true });
    const seq = (await rows(h.pool, `select seq from trips where trip_id = 't_goa'`))[0].seq as number;
    const record = await t.api(as('p_rahul'), 'GET', '/app/v1/trips/t_goa/record');
    expect([record.status, record.body.seq]).toEqual([200, seq]);
    expect(record.body.lines.map((l: any) => l.line_id)).not.toContain(a.line_id);
    expect(record.body.lines.find((l: any) => l.line_id === b.line_id)).toMatchObject({ kind: 'doing', status: 'done' });
    const all = await t.api(as('p_rahul'), 'GET', '/app/v1/trips/t_goa/record?include_undone=true');
    expect(all.body.lines.find((l: any) => l.line_id === a.line_id)).toMatchObject({ status: 'undone' });
    expect(all.body.lines.map((l: any) => Date.parse(l.created_at))).toEqual([...all.body.lines.map((l: any) => Date.parse(l.created_at))].sort((x: number, y: number) => x - y));
    expect((await t.api(as('p_rahul'), 'POST', `/app/v1/trips/t_goa/record/${b.line_id}/redo`)).status).toBe(409); // not undone
    const redone = await t.api(as('p_rahul'), 'POST', `/app/v1/trips/t_goa/record/${a.line_id}/redo`);
    expect([redone.status, redone.body.status]).toEqual([200, 'active']);
    await h.flush();
    expect(h.go.events.filter((e) => e.type === 'record.changed' && e.data.line.line_id === a.line_id).map((e) => e.data.change)).toEqual(['added', 'undone', 'updated']);
    expect((await t.api(as('p_rahul'), 'GET', '/app/v1/trips/t_goa/record')).body.lines.map((l: any) => l.line_id)).toContain(a.line_id);
    expect((await t.api(as('p_rahul'), 'POST', '/app/v1/trips/t_goa/record/r_nope/redo')).status).toBe(404);
  });
});
