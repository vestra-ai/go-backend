import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => (h = await startHarness()));
afterAll(() => h.stop());

const post = (request_id: string, text: string) => h.go.call('post_message', { request_id, trip_id: 't_goa', text });

describe('at the same moment', () => {
  it('the same request_id arriving twice at once is done once and both get the first answer', async () => {
    const [a, b, c] = await Promise.all([post('rq_same', 'once only'), post('rq_same', 'once only'), post('rq_same', 'once only')]);
    expect(a.result).toBeTruthy();
    expect(b.result).toEqual(a.result);
    expect(c.result).toEqual(a.result);
    expect((await rows(h.pool, "select count(*)::int as n from messages where text = 'once only'"))[0].n).toBe(1);
    expect((await rows(h.pool, "select count(*)::int as n from outbox where seq = $1", [a.result.seq]))[0].n).toBe(1);
  });

  it('many writes to one trip take consecutive change numbers: no gaps, no repeats, events in the same order', async () => {
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => post(`rq_many_${i}`, `message ${i}`)));
    const seqs = results.map((r) => r.result.seq as number).sort((x, y) => x - y);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1]! + 1);
    await h.flush();
    const received = h.go.events.map((e) => e.seq as number);
    expect(received).toEqual([...received].sort((x, y) => x - y)); // Go got them in change-number order
    expect(new Set(received).size).toBe(received.length);
  });

  it('two requests for a spend approval on the same vote cannot both pass the last rule', async () => {
    const d = await h.go.call('open_vote', { request_id: 'rq_v', trip_id: 't_goa', question: 'Stay?', kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }] });
    const id = d.result.decision_id;
    await h.pool.query("insert into votes (decision_id, person_id, option_index) values ($1, 'p_rahul', 0)", [id]);
    await h.go.call('close_vote', { request_id: 'rq_c', trip_id: 't_goa', decision_id: id });
    await h.go.call('set_mandate', { request_id: 'rq_m', trip_id: 't_goa', decision_id: id, choice_index: 0, cap_minor: 100000, currency: 'INR', refundable_only: false, payer_person_id: 'p_rahul' });
    await h.pool.query("update decisions set mandate = jsonb_set(mandate, '{confirmed_at}', to_jsonb(now()::text)) where decision_id = $1", [id]);
    const ask = (n: number) => h.go.call('request_spend_approval', { request_id: `rq_race_${n}`, trip_id: 't_goa', decision_id: id, amount_minor: 90000, currency: 'INR', merchant: 'm', purpose: 'p' });
    const answers = await Promise.all([ask(1), ask(2), ask(3), ask(4), ask(5)]);
    const outcome = answers.map((a) => a.result.status === 'approved' ? 'approved' : a.result.reason).sort();
    expect(outcome).toEqual(['approval_outstanding', 'approval_outstanding', 'approval_outstanding', 'approval_outstanding', 'approved']);
    expect((await rows(h.pool, 'select count(*)::int as n from spend_approvals where decision_id = $1', [id]))[0].n).toBe(1);
  });

  it('a booking recorded twice at once with the same approval is stored once', async () => {
    const [{ approval_id, decision_id }] = await rows(h.pool, 'select approval_id, decision_id from spend_approvals limit 1');
    const book = (rid: string) => h.go.call('add_booking', {
      request_id: rid, trip_id: 't_goa', kind: 'stay', title: 'Villa', vendor: 'ixigo', ref: 'R1', amount_minor: 90000, currency: 'INR',
      payer_person_id: 'p_rahul', for_person_ids: ['p_rahul'], decision_id, approval_id,
    });
    const [a, b] = await Promise.all([book('rq_book_a'), book('rq_book_b')]); // two different requests, one approval
    const wins = [a, b].filter((x) => x.result);
    const losses = [a, b].filter((x) => x.error);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(losses[0]!.error).toMatchObject({ code: 409 });
    expect((await rows(h.pool, 'select count(*)::int as n from bookings'))[0].n).toBe(1);
  });

  it('the same booking request arriving twice at once gets the first answer both times, never a fresh 409', async () => {
    const [{ decision_id }] = await rows(h.pool, 'select decision_id from spend_approvals limit 1');
    const a = await h.go.call('request_spend_approval', { request_id: 'rq_sp_new', trip_id: 't_goa', decision_id, amount_minor: 90000, currency: 'INR', merchant: 'm', purpose: 'p' });
    expect(a.result.status).toBe('approved');
    const book = () => h.go.call('add_booking', {
      request_id: 'rq_book_same', trip_id: 't_goa', kind: 'stay', title: 'Villa 2', vendor: 'ixigo', ref: 'R2', amount_minor: 90000, currency: 'INR',
      payer_person_id: 'p_rahul', for_person_ids: ['p_rahul'], decision_id, approval_id: a.result.approval_id,
    });
    const [x, y, z] = await Promise.all([book(), book(), book()]);
    expect(x.error ?? y.error ?? z.error).toBeUndefined();
    expect(y.result).toEqual(x.result);
    expect(z.result).toEqual(x.result);
    expect((await rows(h.pool, "select count(*)::int as n from bookings where title = 'Villa 2'"))[0].n).toBe(1);
  });
});
