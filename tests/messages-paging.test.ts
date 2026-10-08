// GET /trips/:trip/messages (app contract §4.6, the two read modes table), the message rate limit, and quick replies.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check } from '../src/contract/index.js';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';
import { fakeQuickReplies } from './helpers/mock-go.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness(); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
});
afterAll(() => h.stop());

const rahul = () => t.as('p_rahul');
const read = (query: string) => t.api(rahul(), 'GET', `/app/v1/trips/t_goa/messages${query}`);
const ids = (r: { body: any }) => r.body.messages.map((m: any) => m.message_id);
/** Writes a person's message straight into the table (no event), so the paging has rows to page without the rate limit. */
const insert = async (id: string, text: string) => {
  const { rows: r } = await h.pool.query(`update trips set seq = seq + 1 where trip_id = 't_goa' returning seq`);
  await h.pool.query(`insert into messages (message_id, trip_id, seq, updated_seq, author_kind, author_person_id, text) values ($1, 't_goa', $2, $2, 'person', 'p_priya', $3)`, [id, r[0].seq, text]);
  return r[0].seq as number;
};

describe('history mode and changes mode', () => {
  const posted: Record<string, number> = {};
  beforeAll(async () => {
    for (let i = 1; i <= 7; i++) posted[`m_${i}`] = await insert(`m_${i}`, `message ${i}`);
  });

  it('no cursor: the newest limit (default 50) by seq ascending, has_more when older exist, seq = the trip\'s change number', async () => {
    const all = await read('');
    expect([all.status, ids(all), all.body.has_more, all.body.seq]).toEqual([200, ['m_1', 'm_2', 'm_3', 'm_4', 'm_5', 'm_6', 'm_7'], false, posted.m_7]);
    const page = await read('?limit=3');
    expect([ids(page), page.body.has_more]).toEqual([['m_5', 'm_6', 'm_7'], true]);
    for (const m of page.body.messages) expect(check('Message', m)).toMatchObject({ ok: true });
  });

  it('before_seq scrolls back: the newest limit posted before it, ascending; has_more says whether to ask again with the smallest seq', async () => {
    const older = await read(`?before_seq=${posted.m_5}&limit=3`);
    expect([ids(older), older.body.has_more]).toEqual([['m_2', 'm_3', 'm_4'], true]);
    const oldest = await read(`?before_seq=${posted.m_2}&limit=3`);
    expect([ids(oldest), oldest.body.has_more]).toEqual([['m_1'], false]);
    expect(ids(await read(`?before_seq=${posted.m_1}`))).toEqual([]);
  });

  it('history mode shows each message as it is now, placed by its posting seq: an edited old message does not move', async () => {
    const seq = (await rows(h.pool, `select seq from trips where trip_id = 't_goa'`))[0].seq as number;
    await h.pool.query(`update messages set text = 'message 2, edited', edited_at = now(), updated_seq = $1 where message_id = 'm_2'`, [seq + 1]);
    await h.pool.query(`update trips set seq = $1 where trip_id = 't_goa'`, [seq + 1]);
    const page = await read('?limit=4');
    expect(ids(page)).toEqual(['m_4', 'm_5', 'm_6', 'm_7']); // m_2 stays where it was posted
    const back = await read(`?before_seq=${posted.m_4}`);
    expect(back.body.messages.find((m: any) => m.message_id === 'm_2')).toMatchObject({ text: 'message 2, edited', seq: posted.m_2, updated_seq: seq + 1 });
  });

  it('after_seq: messages posted or changed after it by updated_seq ascending, the first limit (default and max 200), has_more for the rest', async () => {
    const changes = await read(`?after_seq=${posted.m_5}`);
    expect(ids(changes)).toEqual(['m_6', 'm_7', 'm_2']); // the edit of m_2 is the latest change
    expect(changes.body.has_more).toBe(false);
    const first = await read(`?after_seq=0&limit=2`);
    expect([ids(first), first.body.has_more]).toEqual([['m_1', 'm_3'], true]); // m_2 moved: it comes later
    const next = await read(`?after_seq=${first.body.messages.at(-1).updated_seq}&limit=2`);
    expect(ids(next)).toEqual(['m_4', 'm_5']);
    expect(check('MessagesPage', { messages: changes.body.messages, has_more: changes.body.has_more })).toMatchObject({ ok: true });
  });

  it('422 for both cursors, for a limit over the mode\'s maximum (100 in history, 200 in changes) or under 1, and for a cursor that is not a number', async () => {
    const refused = async (q: string) => { const r = await read(q); return [r.status, r.body.error?.field]; };
    expect(await refused(`?before_seq=5&after_seq=2`)).toEqual([422, 'after_seq']);
    expect(await refused('?limit=101')).toEqual([422, 'limit']);
    expect(await refused('?after_seq=0&limit=201')).toEqual([422, 'limit']);
    expect(await refused('?limit=0')).toEqual([422, 'limit']);
    expect(await refused('?before_seq=x')).toEqual([422, 'before_seq']);
    expect((await read('?limit=100')).status).toBe(200);
    expect((await read('?after_seq=0&limit=200')).status).toBe(200);
  });
});

describe('the rate limit', () => {
  it('a person\'s 31st message in a minute in one trip is 429 with retry_after_seconds', async () => {
    h.ctx.limits = { messagesPerMinute: 3 };
    try {
      for (let i = 0; i < 3; i++) expect((await t.api(t.as('p_meher'), 'POST', '/app/v1/trips/t_goa/messages', { client_message_id: `rl-${i}`, text: `fast ${i}` })).status).toBe(201);
      const r = await t.api(t.as('p_meher'), 'POST', '/app/v1/trips/t_goa/messages', { client_message_id: 'rl-3', text: 'too fast' });
      expect([r.status, r.body.error.code, r.body.error.retry_after_seconds, r.headers['retry-after']]).toEqual([429, 'rate_limited', 10, '10']);
      expect((await t.api(t.as('p_kabir'), 'POST', '/app/v1/trips/t_goa/messages', { client_message_id: 'rl-k', text: 'someone else' })).status).toBe(201); // per person
    } finally {
      delete h.ctx.limits;
    }
  });

  it('a person\'s 21st reaction in a minute in one trip is 429 rate_limited with retry_after_seconds and Retry-After (app contract Appendix A); another person is not affected', async () => {
    const mid = await insert('m_react', 'react to me');
    const react = (who: string, emoji: string | null) => t.api(t.as(who), 'PUT', `/app/v1/trips/t_goa/messages/m_react/reaction`, { emoji });
    h.ctx.limits = { reactionsPerMinute: 3 };
    try {
      for (const emoji of ['🔥', '👍', null]) expect((await react('p_arjun', emoji)).status).toBe(200);
      const r = await react('p_arjun', '🔥');
      expect([r.status, r.body.error.code, r.body.error.retry_after_seconds > 0, Number(r.headers['retry-after']) === r.body.error.retry_after_seconds, mid > 0]).toEqual([429, 'rate_limited', true, true, true]);
      expect((await react('p_kabir', '🔥')).status).toBe(200); // per person
    } finally {
      delete h.ctx.limits;
    }
  });
});

describe('quick replies from Go (GO-CHANGES 1.3)', () => {
  it('are stored as sent and returned to the app and to Go; a message without them has none', async () => {
    const quick_replies = fakeQuickReplies();
    const m = (await h.go.call('post_message', { request_id: 'rq_qr', trip_id: 't_goa', text: 'Beach or mountains?', quick_replies })).result;
    const page = await read(`?after_seq=${m.seq - 1}`);
    expect(page.body.messages[0]).toMatchObject({ message_id: m.message_id, author: { kind: 'go' }, quick_replies });
    expect(check('Message', page.body.messages[0])).toMatchObject({ ok: true });
    const viaGo = (await h.go.call('read_messages', { trip_id: 't_goa', after_seq: m.seq - 1 })).result.messages[0];
    expect(viaGo.quick_replies).toEqual(quick_replies);
    await h.flush();
    expect(h.go.events.find((e) => e.type === 'message.created' && e.data.message.message_id === m.message_id)!.data.message.quick_replies).toEqual(quick_replies);
    const plain = (await h.go.call('post_message', { request_id: 'rq_qr2', trip_id: 't_goa', text: 'ok' })).result;
    expect((await read(`?after_seq=${plain.seq - 1}`)).body.messages[0]).not.toHaveProperty('quick_replies');
  });
});
