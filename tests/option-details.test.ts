// Rev 5 E: an option's Details page (Go's 1.3 get_option_details). GET …/cards/:card_id/options/:option_id/details asks
// Go when a member who can see the card opens Details, keeps a whole answer an hour, shows a partial one (`complete:
// false`) without keeping it, and still answers from the card's own details when Go cannot.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { optionDetails } from '../src/domain/option-details.js';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness(); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
});
afterAll(() => h.stop());

const INLINE = { why: ['Walk to Anjuna beach'], rating: 4.5 };
const FULL = { ...INLINE, address: 'Anjuna, Goa', check_in: '14:00', check_out: '11:00', stars: 4, policies: ['No pets'], reviews: [{ rating: 4.5, text: 'Quiet, great pool', date: '2026-09', source: 'ixigo' }], nearby: [{ name: 'Anjuna beach', distance_m: 600 }], url: 'https://www.ixigo.com/hotels/casa-azul' };
let n = 0;
/** Go posts a stays card: s1 carries its own details, s2 none. `only` makes the message visible to those people alone. */
const postStays = async (only?: string[]) => {
  const card_id = `c_st_${++n}`;
  const r = await h.go.call('post_message', {
    request_id: `rq_od_${n}`, trip_id: 't_goa', text: 'Stays', ...(only ? { visible_to_person_ids: only } : {}),
    card: { card_id, kind: 'options', fallback_text: 'Stays in Goa', title: 'Stays', option_kind: 'stay', checked_at: '2026-10-11T06:00:00Z', options: [{ option_id: 's1', title: 'Casa Azul', highlights: [], details: INLINE }, { option_id: 's2', title: 'Villa Sol', highlights: [] }] },
  });
  if (r.error) throw new Error(JSON.stringify(r.error));
  return card_id;
};
const details = (who: string, card: string, option = 's1') => t.api(t.as(who), 'GET', `/app/v1/trips/t_goa/cards/${card}/options/${option}/details`);
const asks = () => h.go.requests.filter((r) => r.method === 'get_option_details');
const goAway = { error: { code: 409, message: 'get_option_details is not available yet.', data: { code: 'conflict' } } };

beforeEach(() => {
  h.go.requests.length = 0;
  h.go.answers.get_option_details = () => ({ result: FULL });
  h.ctx.limits = undefined;
});

describe('GET …/cards/:card_id/options/:option_id/details', () => {
  it('asks Go for the person who opened it, answers what Go said, and keeps it an hour for everyone who can see the card', async () => {
    const card = await postStays();
    const first = await details('p_priya', card);
    expect(first.status).toBe(200);
    expect(first.body).toEqual(FULL);
    expect(first.headers['cache-control']).toBe('private, no-store');
    expect(asks()).toEqual([{ method: 'get_option_details', params: { trip_id: 't_goa', card_id: card, option_id: 's1', person_id: 'p_priya' } }]);
    expect((await details('p_arjun', card)).body).toEqual(FULL); // kept: Go is not asked again
    expect(asks()).toHaveLength(1);
    await h.pool.query(`update option_details set fetched_at = now() - interval '61 minutes'`);
    h.go.answers.get_option_details = () => ({ result: { ...FULL, stars: 5 } });
    expect((await details('p_arjun', card)).body.stars).toBe(5); // an hour on, Go is asked again and the new answer kept
    expect(await rows(h.pool, `select details->>'stars' as stars from option_details where card_id = $1`, [card])).toEqual([{ stars: '5' }]);
    // Go replaces the card: what was kept was about the old card, so the next open asks Go.
    const before = asks().length;
    expect((await h.go.call('replace_card', { trip_id: 't_goa', card: { card_id: card, kind: 'options', fallback_text: 'Stays in Goa', title: 'Stays', option_kind: 'stay', checked_at: '2026-10-11T07:00:00Z', options: [{ option_id: 's1', title: 'Casa Azul', highlights: ['New price'] }] } })).error).toBeUndefined();
    expect(await rows(h.pool, 'select 1 from option_details where card_id = $1', [card])).toEqual([]);
    expect((await details('p_arjun', card)).status).toBe(200);
    expect(asks()).toHaveLength(before + 1);
    // An answer that crosses a replace_card (the card changes while the Server waits on Go) is shown but not kept.
    await h.pool.query('delete from option_details');
    const slowGo = { request: async () => (await h.pool.query('update messages set updated_seq = updated_seq + 1000 where card_id = $1', [card]), FULL) };
    expect(await optionDetails(h.ctx, slowGo as any, 't_goa', 'p_arjun', card, 's1')).toEqual(FULL);
    expect(await rows(h.pool, 'select 1 from option_details where card_id = $1', [card])).toEqual([]);
  });

  it('a partial answer (complete: false) is shown but not kept: the next open asks Go again', async () => {
    const card = await postStays();
    h.go.answers.get_option_details = () => ({ result: { ...INLINE, complete: false } });
    expect((await details('p_priya', card)).body).toEqual({ ...INLINE, complete: false });
    expect(await rows(h.pool, 'select 1 from option_details where card_id = $1', [card])).toEqual([]);
    h.go.answers.get_option_details = () => ({ result: FULL });
    expect((await details('p_priya', card)).body).toEqual(FULL);
    expect(asks()).toHaveLength(2);
  });

  it('when Go cannot answer: the last kept answer however old, else what the card carries, marked partial; with neither, go_unavailable', async () => {
    const card = await postStays();
    h.go.answers.get_option_details = () => goAway;
    expect((await details('p_priya', card)).body).toEqual({ ...INLINE, complete: false }); // the card's own details
    const none = await details('p_priya', card, 's2'); // s2 carries no details and nothing is kept
    expect(none.status).toBe(409);
    expect(none.body.error.message).toMatch(/not available yet/);
    h.go.answers.get_option_details = () => ({ result: { junk: true, stars: 'four' } }); // an answer outside the contract is not shown
    expect((await details('p_priya', card)).body).toEqual({ ...INLINE, complete: false });
    await h.pool.query(`insert into option_details (trip_id, card_id, option_id, details, fetched_at) values ('t_goa', $1, 's2', $2, now() - interval '3 hours')`, [card, JSON.stringify(FULL)]);
    h.go.answers.get_option_details = () => goAway;
    expect((await details('p_priya', card, 's2')).body).toEqual({ ...FULL, complete: false });
    expect(await rows(h.pool, `select details ? 'complete' as marked from option_details where card_id = $1`, [card])).toEqual([{ marked: false }]); // the kept row is untouched
    // Go says it has no such option: the kept answer is about something gone, so it is dropped and not shown.
    h.go.answers.get_option_details = () => ({ error: { code: 404, message: 'no such option', data: { code: 'not_found' } } });
    expect((await details('p_priya', card, 's2')).status).toBe(404);
    expect(await rows(h.pool, 'select 1 from option_details where card_id = $1', [card])).toEqual([]);
    expect((await details('p_priya', card)).body).toEqual({ ...INLINE, complete: false }); // s1 still has what its card carries
  });

  it('is only for a member who can see the card: an unknown card or option, or a card on a message for someone else, is 404 and Go is not asked', async () => {
    const card = await postStays(['p_priya']);
    expect((await details('p_priya', card)).status).toBe(200);
    for (const r of [await details('p_arjun', card), await details('p_priya', card, 's9'), await details('p_priya', 'c_nope')]) expect(r.status).toBe(404);
    // Kept for Priya's card, and still not Arjun's to read.
    expect((await details('p_arjun', card)).status).toBe(404);
    const stranger = await h.signIn('Zoya');
    expect((await h.app.inject({ method: 'GET', url: `/app/v1/trips/t_goa/cards/${card}/options/s1/details`, headers: { authorization: `Bearer ${stranger.token}` } })).statusCode).toBe(403);
    expect(asks()).toHaveLength(1);
  });

  it('counts only real asks against the limit: a kept answer is free; over it, what the card carries is shown, and 429 only when there is nothing', async () => {
    h.ctx.limits = { optionDetailsPerMinute: 2 };
    const [a, b, c] = [await postStays(), await postStays(), await postStays()];
    expect((await details('p_meher', a)).status).toBe(200);
    expect((await details('p_meher', b)).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await details('p_meher', a)).status).toBe(200); // kept
    expect((await details('p_meher', c)).body).toEqual({ ...INLINE, complete: false }); // over the limit: the card's own details
    expect((await details('p_meher', c, 's2')).status).toBe(429); // s2 carries none
    expect(asks()).toHaveLength(2);
    expect((await details('p_kabir', c)).status).toBe(200); // someone else's own allowance
  });
});
