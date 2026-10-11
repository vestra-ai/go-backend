// Rev 5 A (contract 1.3): the vote is on the options card itself. Go opens the vote, posts its options card carrying the
// vote's `decision_id`, and "see more" adds the new options to that same vote with add_vote_options. The new options
// take the next indexes, so votes already cast stay with the option they were cast for.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness(); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
});
afterAll(() => h.stop());

let n = 0;
const call = (method: string, params: Record<string, unknown>) => h.go.call(method, { request_id: `rq_voc_${++n}`, trip_id: 't_goa', ...params });
const ok = async (method: string, params: Record<string, unknown>) => {
  const f = await call(method, params);
  if (f.error) throw new Error(`${method}: ${JSON.stringify(f.error)}`);
  return f.result;
};
const stay = (i: number) => ({ label: `Stay ${i}`, option_ref: `opt_${i}`, price_minor: 1000000 + i, currency: 'INR' });
const stays = (from: number, count: number) => Array.from({ length: count }, (_, i) => stay(from + i));
const openVote = async (count = 2, over: Record<string, unknown> = {}) =>
  (await ok('open_vote', { question: 'Which stay?', kind: 'choice', anonymous: false, options: stays(1, count), ...over })).decision_id as string;
/** Go's options card for the options from..from+count-1, carrying the vote. */
const postCard = (decisionId: string, from: number, count: number) => call('post_message', {
  text: 'Stays', card: {
    card_id: `c_voc_${++n}`, kind: 'options', fallback_text: 'Stays in Goa', title: 'Stays', option_kind: 'stay', checked_at: '2026-10-11T06:00:00Z', decision_id: decisionId,
    options: stays(from, count).map((o) => ({ option_id: o.option_ref, title: o.label, highlights: [] })),
    actions: [{ action_id: 'more_options', label: 'See more', style: 'secondary' }],
  },
});
const vote = (who: string, decisionId: string, option_index: number) => t.api(t.as(who), 'PUT', `/app/v1/trips/t_goa/decisions/${decisionId}/vote`, { option_index });
const read = async (who: string, decisionId: string) => (await t.api(t.as(who), 'GET', `/app/v1/trips/t_goa/decisions/${decisionId}`)).body;

describe('a vote on the options card, and "see more" joining it', () => {
  it('add_vote_options appends to the open vote: indexes continue, votes cast stay, the new options can be voted for, and Go hears decision.options_added in order', async () => {
    const d = await openVote(2);
    expect((await postCard(d, 1, 2)).error).toBeUndefined();
    expect((await vote('p_priya', d, 1)).status).toBe(200);
    const added = await h.go.call('add_vote_options', { request_id: 'rq_voc_more', trip_id: 't_goa', decision_id: d, options: stays(3, 2) });
    expect(added.error).toBeUndefined();
    expect((await postCard(d, 3, 2)).error).toBeUndefined(); // the "see more" message, on the same vote

    const after = await read('p_priya', d);
    expect(after.options.map((o: any) => o.option_ref)).toEqual(['opt_1', 'opt_2', 'opt_3', 'opt_4']);
    expect([after.tally, after.my_vote, after.status]).toEqual([[0, 1, 0, 0], { option_index: 1 }, 'open']);
    expect((await vote('p_arjun', d, 3)).status).toBe(200); // one of the new options
    expect((await vote('p_arjun', d, 4)).status).toBe(422); // there is no fifth
    expect((await read('p_arjun', d)).tally).toEqual([0, 1, 0, 1]);

    // The same request again adds nothing and gets the same answer.
    const again = await h.go.call('add_vote_options', { request_id: 'rq_voc_more', trip_id: 't_goa', decision_id: d, options: stays(3, 2) });
    expect(again.result).toEqual(added.result);
    expect((await read('p_arjun', d)).options).toHaveLength(4);

    await h.flush();
    const mine = h.go.events.filter((e: any) => e.data?.decision_id === d || e.data?.decision?.decision_id === d);
    expect(mine.map((e: any) => e.type)).toEqual(['decision.opened', 'decision.voted', 'decision.options_added', 'decision.voted']);
    expect(mine.map((e: any) => e.seq)).toEqual([...mine.map((e: any) => e.seq)].sort((a, b) => a - b));
    expect(mine[2]!.seq).toBe(added.result.seq);
    expect(mine[2]!.data).toEqual({ decision_id: d, options: stays(3, 2), by: { kind: 'go' } });
  });

  it('only an open choice vote of this trip, and at most 20 options in all', async () => {
    const d = await openVote(10);
    expect((await call('add_vote_options', { decision_id: d, options: stays(11, 10) })).error).toBeUndefined(); // 20
    expect((await call('add_vote_options', { decision_id: d, options: stays(21, 1) })).error).toMatchObject({ code: 422, data: { code: 'invalid' } });
    expect((await read('p_priya', d)).options).toHaveLength(20);
    expect((await call('add_vote_options', { decision_id: 'd_nope', options: stays(1, 1) })).error).toMatchObject({ code: 404 });
    expect((await call('add_vote_options', { decision_id: d, options: [] })).error).toMatchObject({ code: 422 }); // the contract: at least one
    const other = await openVote(2);
    expect((await call('add_vote_options', { decision_id: other, options: [{ ...stay(3), currency: 'USD' }] })).error).toMatchObject({ code: 422 });
    // An option_ref stands for one option: one the vote already has, or the same one twice in the request, is refused.
    for (const options of [[stay(2)], [stay(5), stay(5)]]) expect((await call('add_vote_options', { decision_id: other, options })).error).toMatchObject({ code: 422, message: expect.stringMatching(/already an option/) });
    await ok('close_vote', { decision_id: other });
    expect((await call('add_vote_options', { decision_id: other, options: stays(3, 1) })).error).toMatchObject({ code: 409, data: { code: 'conflict' } });
    expect((await rows(h.pool, `select jsonb_array_length(options) as n from decisions where decision_id = $1`, [other]))[0].n).toBe(2);
    const yesNo = (await ok('open_vote', { question: 'Go in November?', kind: 'yesno', anonymous: false, options: [{ label: 'Yes' }, { label: 'No' }] })).decision_id;
    expect((await call('add_vote_options', { decision_id: yesNo, options: [{ label: 'Maybe' }] })).error).toMatchObject({ code: 409 });
  });

  it('an options card may carry only a vote of this trip that is open; other cards keep naming closed votes', async () => {
    const d = await openVote(2);
    expect((await postCard('d_nope', 1, 2)).error).toMatchObject({ code: 422 });
    await ok('close_vote', { decision_id: d });
    const refused = await postCard(d, 1, 2);
    expect(refused.error).toMatchObject({ code: 422 });
    expect(refused.error.message).toMatch(/closed, not open/);
    // A vote card for the closed vote is still fine: it shows the result.
    expect((await call('post_message', { text: 'Result', card: { card_id: `c_voc_${++n}`, kind: 'vote', decision_id: d, fallback_text: 'Stay 1 won' } })).error).toBeUndefined();
  });

  it('an open vote in "needs you" points at the newest message whose card carries it: the "see more" one', async () => {
    const d = await openVote(2);
    const told = () => h.live.events.filter((e) => e.event.kind === 'home').length;
    const before = told();
    const first = (await postCard(d, 1, 2)).result.message_id;
    expect(told()).toBeGreaterThan(before); // everyone's home is told: the vote's item now has its card
    const item = async () => (await t.api(t.as('p_meher'), 'GET', '/app/v1/trips/t_goa/needs-you')).body.items.find((i: any) => i.target?.decision_id === d);
    expect((await item()).target.message_id).toBe(first);
    await ok('add_vote_options', { decision_id: d, options: stays(3, 2) });
    const more = (await postCard(d, 3, 2)).result.message_id;
    expect((await item()).target.message_id).toBe(more);
    await vote('p_meher', d, 2);
    expect(await item()).toBeUndefined(); // voted: no longer waiting on her
  });
});
