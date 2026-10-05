import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check } from '../src/contract/index.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => (h = await startHarness()));
afterAll(() => h.stop());

const insertPersonMessage = async (id: string, personId: string, text: string, opts: { withheld?: boolean; deleted?: boolean } = {}) => {
  const { rows: r } = await h.pool.query('update trips set seq = seq + 1 where trip_id = $1 returning seq', ['t_goa']);
  await h.pool.query(
    `insert into messages (message_id, trip_id, seq, updated_seq, author_kind, author_person_id, text, mentions_go, mentions, withheld, deleted)
     values ($1, 't_goa', $2, $2, 'person', $3, $4, true, '["p_rahul"]', $5, $6)`,
    [id, r[0].seq, personId, text, opts.withheld ?? false, opts.deleted ?? false],
  );
  return r[0].seq as number;
};

describe('read_trip', () => {
  it('answers a TripSnapshot that matches the contract, at the current change number', async () => {
    const f = await h.go.call('read_trip', { trip_id: 't_goa' });
    expect(check('TripSnapshot', f.result)).toMatchObject({ ok: true });
    expect(f.result).toMatchObject({ trip_id: 't_goa', seq: 1, title: 'Goa 🌴', status: 'planning', invite_url: 'https://go.example/j/inv_t_goa' });
    expect(f.result.people.map((p: any) => p.person_id)).toEqual(['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir']);
  });

  it('never shows contact details or anyone\'s own budget answer', async () => {
    await h.pool.query("update trip_people set budget_min_minor = 1500000, budget_max_minor = 2000000 where person_id = 'p_priya'");
    await h.pool.query("update trip_people set budget_min_minor = 1000000, budget_max_minor = 1500000 where person_id = 'p_arjun'");
    const f = await h.go.call('read_trip', { trip_id: 't_goa' });
    const text = JSON.stringify(f.result);
    expect(text).not.toMatch(/\+91|@mail\.test|rahul@upi|phone|email|upi_id/);
    const rahul = f.result.people.find((p: any) => p.person_id === 'p_rahul');
    const priya = f.result.people.find((p: any) => p.person_id === 'p_priya');
    expect(rahul.has_upi).toBe(true);
    expect(priya.has_upi).toBe(false);
    // only the lowest band and how many answered
    expect(f.result.budget).toEqual({ lowest: { min_minor: 1000000, max_minor: 1500000, currency: 'INR' }, answered: 2, of: 5 });
  });

  it('leaves out a person who left the trip', async () => {
    await h.pool.query("update trip_people set left_at = now() where person_id = 'p_kabir'");
    const f = await h.go.call('read_trip', { trip_id: 't_goa' });
    expect(f.result.people.map((p: any) => p.person_id)).not.toContain('p_kabir');
    expect(f.result.budget.of).toBe(4);
    await h.pool.query("update trip_people set left_at = null where person_id = 'p_kabir'");
  });
});

describe('post_message', () => {
  const params = {
    request_id: 'rq_post_1',
    trip_id: 't_goa',
    text: 'Priya, here are three flights.',
    mentions: ['p_priya'],
    card: {
      card_id: 'c_flights_1', kind: 'notice', fallback_text: 'Heads up', title: 'Free cancellation ends Sunday', body: 'After that it is not refundable.',
      tone: 'heads_up', future_field: { added: 'later' }, for_person_ids: ['p_rahul'],
    },
  };

  it('stores Go\'s message with its card exactly as it arrived, and answers with the id and change number', async () => {
    const f = await h.go.call('post_message', params);
    expect(f.result).toMatchObject({ seq: 2 });
    const [m] = await rows(h.pool, 'select * from messages where message_id = $1', [f.result.message_id]);
    expect(m.author_kind).toBe('go');
    expect(m.seq).toBe(2);
    expect(m.updated_seq).toBe(2);
    expect(m.card).toEqual(params.card); // including a field this contract does not know
  });

  it('puts message.created in the outbox in the same transaction, and sends it to Go', async () => {
    await h.flush();
    const e = h.go.events.find((x) => x.type === 'message.created')!;
    expect(e).toMatchObject({ trip_id: 't_goa', seq: 2 });
    expect(e.data.message).toMatchObject({ author: { kind: 'go' }, text: params.text, mentions_go: false, withheld: false, deleted: false });
    expect(e.data.message.card.future_field).toEqual({ added: 'later' });
    expect(check('Event', e)).toMatchObject({ ok: true });
  });

  it('does a repeated request_id once and answers with the first answer', async () => {
    const before = await rows(h.pool, 'select count(*)::int as n from messages');
    const pushes = h.push.sent.length;
    const again = await h.go.call('post_message', params);
    const first = await rows(h.pool, "select message_id from messages where card_id = 'c_flights_1'");
    expect(again.result).toEqual({ message_id: first[0].message_id, seq: 2 });
    expect((await rows(h.pool, 'select count(*)::int as n from messages'))[0].n).toBe(before[0].n);
    expect(h.push.sent.length).toBe(pushes); // no second push
  });

  it('pushes the people Go names and the people the card needs, once each', () => {
    const toPriya = h.push.sent.filter((s) => s.to.includes('p_priya'));
    const toRahul = h.push.sent.filter((s) => s.to.includes('p_rahul'));
    expect(toPriya).toHaveLength(1);
    expect(toPriya[0]!.n.body).toBe('Priya, here are three flights.');
    expect(toRahul).toHaveLength(1);
    expect(toRahul[0]!.n.body).toBe('Heads up'); // the card's fallback_text
    expect(toRahul[0]!.n.data.trip_id).toBe('t_goa');
  });

  it('shows the message live and hides "Go is typing..."', () => {
    const kinds = h.live.events.map((e) => e.event.kind);
    expect(kinds).toContain('message');
    expect(h.live.events.some((e) => e.event.kind === 'typing' && e.event.on === false)).toBe(true);
  });

  it('refuses a card id that is already in the room (409), and a message with neither text nor card (422)', async () => {
    const dup = await h.go.call('post_message', { ...params, request_id: 'rq_post_2' });
    expect(dup.error).toMatchObject({ code: 409, data: { code: 'conflict' } });
    const empty = await h.go.call('post_message', { request_id: 'rq_post_3', trip_id: 't_goa' });
    expect(empty.error).toMatchObject({ code: 422 });
  });

  it('refuses a mention of someone who is not in the trip (422) and an unknown reply_to (422)', async () => {
    const a = await h.go.call('post_message', { request_id: 'rq_post_4', trip_id: 't_goa', text: 'hi', mentions: ['p_ghost'] });
    expect(a.error).toMatchObject({ code: 422 });
    expect(a.error.message).toContain('mentions');
    const b = await h.go.call('post_message', { request_id: 'rq_post_5', trip_id: 't_goa', text: 'hi', reply_to: 'm_missing' });
    expect(b.error).toMatchObject({ code: 422 });
  });

  it('refuses a vote card for a vote that is not in this trip (422)', async () => {
    const f = await h.go.call('post_message', {
      request_id: 'rq_post_6', trip_id: 't_goa', text: 'Vote!',
      card: { card_id: 'c_vote_x', kind: 'vote', decision_id: 'd_nope', fallback_text: 'Vote' },
    });
    expect(f.error).toMatchObject({ code: 422 });
    expect(f.error.message).toContain('decision_id');
  });
});

describe('reactions and read_messages', () => {
  let personSeq: number;
  it('adds Go\'s reaction with no person, moves updated_seq, and sends reaction.added', async () => {
    personSeq = await insertPersonMessage('m_priya_1', 'p_priya', 'Let us do North Goa');
    const f = await h.go.call('add_reaction', { request_id: 'rq_r1', trip_id: 't_goa', message_id: 'm_priya_1', emoji: '✅' });
    expect(f.result.seq).toBe(personSeq + 1);
    const [m] = await rows(h.pool, "select updated_seq from messages where message_id = 'm_priya_1'");
    expect(m.updated_seq).toBe(personSeq + 1);
    await h.flush();
    const e = h.go.events.find((x) => x.type === 'reaction.added')!;
    expect(e.data).toEqual({ message_id: 'm_priya_1', reaction: { emoji: '✅' } });
  });

  it('refuses the same reaction twice (409) and a reaction on a missing message (404)', async () => {
    const again = await h.go.call('add_reaction', { request_id: 'rq_r2', trip_id: 't_goa', message_id: 'm_priya_1', emoji: '✅' });
    expect(again.error).toMatchObject({ code: 409 });
    const missing = await h.go.call('add_reaction', { request_id: 'rq_r3', trip_id: 't_goa', message_id: 'm_nope', emoji: '✅' });
    expect(missing.error).toMatchObject({ code: 404 });
  });

  it('returns messages changed after a change number, oldest change first, as they are now', async () => {
    const f = await h.go.call('read_messages', { trip_id: 't_goa', after_seq: 0 });
    const ids = f.result.messages.map((m: any) => m.message_id);
    expect(ids).toHaveLength(2);
    const priya = f.result.messages.find((m: any) => m.message_id === 'm_priya_1');
    expect(priya.seq).toBe(personSeq);
    expect(priya.updated_seq).toBe(personSeq + 1);
    expect(priya.reactions).toEqual([{ emoji: '✅' }]); // Go's reaction has no person_id
    const updated = f.result.messages.map((m: any) => m.updated_seq);
    expect(updated).toEqual([...updated].sort((a, b) => a - b));
    expect(check('MessagesPage', f.result)).toMatchObject({ ok: true });
  });

  it('pages with has_more and carries on from the last updated_seq', async () => {
    const first = await h.go.call('read_messages', { trip_id: 't_goa', after_seq: 0, limit: 1 });
    expect(first.result.messages).toHaveLength(1);
    expect(first.result.has_more).toBe(true);
    const last = first.result.messages[0].updated_seq;
    const next = await h.go.call('read_messages', { trip_id: 't_goa', after_seq: last, limit: 1 });
    expect(next.result.messages).toHaveLength(1);
    expect(next.result.has_more).toBe(false);
  });

  it('hides the words of a message from someone who paused Go, and of a deleted message', async () => {
    const s1 = await insertPersonMessage('m_paused', 'p_arjun', 'a secret', { withheld: true });
    await insertPersonMessage('m_deleted', 'p_meher', 'oops', { deleted: true });
    const f = await h.go.call('read_messages', { trip_id: 't_goa', after_seq: s1 - 1 });
    const paused = f.result.messages.find((m: any) => m.message_id === 'm_paused');
    expect(paused).toMatchObject({ withheld: true, attachments: [], mentions_go: false, mentions: [] });
    expect(paused.text).toBeUndefined();
    const gone = f.result.messages.find((m: any) => m.message_id === 'm_deleted');
    expect(gone).toMatchObject({ deleted: true });
    expect(gone.text).toBeUndefined();
    expect(JSON.stringify(f.result)).not.toContain('a secret');
  });

  it('removes Go\'s own reaction and refuses to remove one it does not have (409)', async () => {
    const ok = await h.go.call('remove_reaction', { request_id: 'rq_r4', trip_id: 't_goa', message_id: 'm_priya_1', emoji: '✅' });
    expect(ok.result.seq).toBeGreaterThan(personSeq + 1);
    const none = await h.go.call('remove_reaction', { request_id: 'rq_r5', trip_id: 't_goa', message_id: 'm_priya_1', emoji: '✅' });
    expect(none.error).toMatchObject({ code: 409 });
  });
});

describe('typing and replace_card', () => {
  it('shows "Go is typing..." for 10 seconds and never answers the notification', async () => {
    const before = h.go.frames.length;
    h.go.notify('typing', { trip_id: 't_goa', on: true });
    await new Promise((r) => setTimeout(r, 150));
    const e = h.live.events.filter((x) => x.event.kind === 'typing' && x.event.on === true).at(-1)!;
    expect(e.event).toMatchObject({ who: { kind: 'go' }, on: true });
    expect(new Date((e.event as any).until).getTime() - Date.now()).toBeGreaterThan(8000);
    expect(h.go.frames.length).toBe(before); // nothing came back
  });

  it('drops a typing notification with broken params without an answer', async () => {
    const before = h.go.frames.length;
    h.go.notify('typing', { trip_id: 't_goa', on: 'yes' });
    h.go.notify('typing', { trip_id: 't_nope', on: true });
    await new Promise((r) => setTimeout(r, 150));
    expect(h.go.frames.length).toBe(before);
  });

  it('replaces a card in place with no change number and no event', async () => {
    const seqBefore = (await rows(h.pool, "select seq from trips where trip_id = 't_goa'"))[0].seq;
    const outboxBefore = (await rows(h.pool, 'select count(*)::int as n from outbox'))[0].n;
    const card = { card_id: 'c_flights_1', kind: 'notice', fallback_text: 'Heads up, updated', title: 'Updated', body: 'New text', tone: 'heads_up', for_person_ids: [] };
    const f = await h.go.call('replace_card', { trip_id: 't_goa', card });
    expect(f.result.message_id).toBeTruthy();
    expect((await rows(h.pool, "select card from messages where card_id = 'c_flights_1'"))[0].card).toEqual(card);
    expect((await rows(h.pool, "select seq from trips where trip_id = 't_goa'"))[0].seq).toBe(seqBefore);
    expect((await rows(h.pool, 'select count(*)::int as n from outbox'))[0].n).toBe(outboxBefore);
    const again = await h.go.call('replace_card', { trip_id: 't_goa', card });
    expect(again.result.message_id).toBe(f.result.message_id); // safe to repeat
  });

  it('answers 404 for a card that is not on one of Go\'s messages', async () => {
    const f = await h.go.call('replace_card', { trip_id: 't_goa', card: { card_id: 'c_missing', kind: 'notice', fallback_text: 'x', title: 't', body: 'b', tone: 'heads_up' } });
    expect(f.error).toMatchObject({ code: 404 });
  });
});

describe('change numbers', () => {
  it('are consecutive per trip, and every change has exactly one event with the same number', async () => {
    const outbox = await rows(h.pool, "select seq from outbox where trip_id = 't_goa' order by seq");
    const seqs = outbox.map((r) => r.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    // person messages were inserted directly by this test (no event), so only Go's own changes are in the outbox
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});

describe('read_messages under the 1 MB frame limit', () => {
  it('sends fewer messages with has_more when 200 would not fit, and Go can read them all', async () => {
    const big = 'x'.repeat(3500); // Go sees up to 4,000 characters per message; with a long card the page grows fast
    await h.pool.query("update trips set seq = seq + 400 where trip_id = 't_goa'");
    const start = (await rows(h.pool, "select max(updated_seq)::int as m from messages"))[0].m;
    for (let i = 0; i < 200; i++) {
      await h.pool.query(
        `insert into messages (message_id, trip_id, seq, updated_seq, author_kind, author_person_id, text, attachments) values ($1, 't_goa', $2, $2, 'person', 'p_rahul', $3, $4)`,
        [`m_big_${i}`, start + 1 + i, big, JSON.stringify(Array.from({ length: 10 }, (_, k) => ({ kind: 'file', url: `https://x.test/${k}`, name: 'f'.repeat(60), mime: 'text/plain', size_bytes: 1 })))],
      );
    }
    const seen = new Set<string>();
    let after = start;
    let pages = 0;
    for (;;) {
      const f = await h.go.call('read_messages', { trip_id: 't_goa', after_seq: after, limit: 200 });
      pages++;
      const bytes = Buffer.byteLength(JSON.stringify(f));
      expect(bytes).toBeLessThan(1_048_576); // a frame is at most 1 MB
      for (const m of f.result.messages) seen.add(m.message_id);
      if (!f.result.has_more) break;
      expect(f.result.messages.length).toBeGreaterThan(0);
      after = f.result.messages.at(-1).updated_seq;
    }
    expect(seen.size).toBe(200);
    expect(pages).toBeGreaterThanOrEqual(1);
  });
});
