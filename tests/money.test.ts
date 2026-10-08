import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check, verifySpendApproval } from '../src/contract/index.js';
import { SPEND_PUBLIC_KEY, rows, startHarness, type Harness } from './helpers/harness.js';
import { seedTrip } from './helpers/seed.js';

let h: Harness;
beforeAll(async () => (h = await startHarness()));
afterAll(() => h.stop());

let n = 0;
const rq = () => `rq_${++n}`;
const ok = async (method: string, params: Record<string, unknown>) => {
  const f = await h.go.call(method, { request_id: rq(), trip_id: 't_goa', ...params });
  if (f.error) throw new Error(`${method}: ${JSON.stringify(f.error)}`);
  return f.result;
};
const err = async (method: string, params: Record<string, unknown>) => (await h.go.call(method, { request_id: rq(), trip_id: 't_goa', ...params })).error;
const vote = (decisionId: string, personId: string, option: number) =>
  h.pool.query('insert into votes (decision_id, person_id, option_index) values ($1, $2, $3)', [decisionId, personId, option]);
const events = (type: string) => h.go.events.filter((e) => e.type === type);

const villaOptions = [
  { label: 'Villa Sol', price_minor: 5420000, currency: 'INR', option_ref: 'ixigo:stay:villa-sol-anjuna' },
  { label: 'Casa Azul', price_minor: 6180000, currency: 'INR' },
];

describe('votes', () => {
  let villa: string;
  it('opens a vote for everyone in the trip, keeps the options as sent, and sends decision.opened', async () => {
    const r = await ok('open_vote', { question: 'Where do we stay?', kind: 'choice', anonymous: false, options: villaOptions });
    villa = r.decision_id;
    await h.flush();
    const e = events('decision.opened').at(-1)!;
    expect(e.seq).toBe(r.seq);
    expect(e.data.decision).toMatchObject({ decision_id: villa, status: 'open', voted: 0, of: 5, tally: [0, 0], votes: [] });
    expect(e.data.by).toEqual({ kind: 'go' });
    expect(e.data.decision.options[0].option_ref).toBe('ixigo:stay:villa-sol-anjuna');
  });

  it('refuses an option priced in another currency (422)', async () => {
    expect(await err('open_vote', { question: 'x', kind: 'choice', anonymous: false, options: [{ label: 'A', price_minor: 100, currency: 'USD' }, { label: 'B' }] })).toMatchObject({ code: 422 });
  });

  it('refuses one option and a closing time in the past (422)', async () => {
    expect(await err('open_vote', { question: 'x', kind: 'choice', anonymous: false, options: [{ label: 'A' }] })).toMatchObject({ code: 422 });
    expect(await err('open_vote', { question: 'x', kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }], closes_at: '2020-01-01T00:00:00Z' })).toMatchObject({ code: 422 });
  });

  it('closes a vote as two changes: decision.closed, then the decided line in the record', async () => {
    for (const p of ['p_rahul', 'p_priya', 'p_arjun', 'p_meher']) await vote(villa, p, 0);
    await vote(villa, 'p_kabir', 1);
    const r = await ok('close_vote', { decision_id: villa });
    expect(r.decision).toMatchObject({ status: 'closed', result_index: 0, tally: [4, 1], voted: 5 });
    expect(check('Decision', r.decision)).toMatchObject({ ok: true });
    await h.flush();
    const closed = events('decision.closed').at(-1)!;
    const line = events('record.changed').at(-1)!;
    expect(closed.seq).toBe(r.seq);
    expect(closed.data.reason).toBe('closed_by_go');
    expect(line.seq).toBe(r.seq + 1); // its own change number
    expect(line.data).toMatchObject({ change: 'added', by: { kind: 'system' }, line: { kind: 'decided', text: 'Villa Sol', source: 'vote', decision_id: villa, status: 'active' } });
  });

  it('answers 409 when the vote is already closed, and 404 for a vote of another trip', async () => {
    expect(await err('close_vote', { decision_id: villa })).toMatchObject({ code: 409, data: { code: 'conflict' } });
    expect(await err('close_vote', { decision_id: 'd_nope' })).toMatchObject({ code: 404 });
  });

  it('a tie or no votes closes with no result and writes no decided line', async () => {
    const t = await ok('open_vote', { question: 'Beach?', kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }] });
    await vote(t.decision_id, 'p_rahul', 0);
    await vote(t.decision_id, 'p_priya', 1);
    const lines = (await rows(h.pool, 'select count(*)::int as n from record_lines'))[0].n;
    const r = await ok('close_vote', { decision_id: t.decision_id });
    expect(r.decision.result_index).toBeUndefined();
    expect((await rows(h.pool, 'select count(*)::int as n from record_lines'))[0].n).toBe(lines);
  });

  it('an anonymous vote shows totals only, to Go as well', async () => {
    const a = await ok('open_vote', { question: 'Secret?', kind: 'yesno', anonymous: true, options: [{ label: 'Yes' }, { label: 'No' }] });
    await vote(a.decision_id, 'p_rahul', 0);
    const snap = (await h.go.call('read_trip', { trip_id: 't_goa' })).result;
    const d = snap.decisions.find((x: any) => x.decision_id === a.decision_id);
    expect(d.votes).toBeUndefined();
    expect(d).toMatchObject({ voted: 1, tally: [1, 0] });
    expect(JSON.stringify(d)).not.toContain('p_rahul');
    expect(check('TripSnapshot', snap)).toMatchObject({ ok: true });
  });

  describe('set_mandate', () => {
    const mandate = { choice_index: 0, cap_minor: 5500000, currency: 'INR', refundable_only: true, payer_person_id: 'p_rahul' };
    it('stores the mandate and sends mandate.set', async () => {
      const r = await ok('set_mandate', { decision_id: villa, ...mandate });
      await h.flush();
      const e = events('mandate.set').at(-1)!;
      expect(e.seq).toBe(r.seq);
      expect(e.data.mandate).toMatchObject({ ...mandate });
      expect(e.data.mandate.confirmed_at).toBeUndefined();
    });
    it('refuses a bad choice (422), another currency (422), an unknown payer (422)', async () => {
      expect(await err('set_mandate', { decision_id: villa, ...mandate, choice_index: 5 })).toMatchObject({ code: 422 });
      expect(await err('set_mandate', { decision_id: villa, ...mandate, currency: 'USD' })).toMatchObject({ code: 422 });
      expect(await err('set_mandate', { decision_id: villa, ...mandate, payer_person_id: 'p_ghost' })).toMatchObject({ code: 422 });
    });
    it('refuses a vote that is still open (409) and a yes/no vote (409)', async () => {
      const open = await ok('open_vote', { question: 'Open?', kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }] });
      expect(await err('set_mandate', { decision_id: open.decision_id, ...mandate })).toMatchObject({ code: 409 });
      const yn = await ok('open_vote', { question: 'Yes?', kind: 'yesno', anonymous: false, options: [{ label: 'Yes' }, { label: 'No' }] });
      await vote(yn.decision_id, 'p_rahul', 0);
      await ok('close_vote', { decision_id: yn.decision_id });
      expect(await err('set_mandate', { decision_id: yn.decision_id, ...mandate, choice_index: 0 })).toMatchObject({ code: 409 });
    });
    it('a new mandate clears the payer\'s earlier yes', async () => {
      await h.pool.query("update decisions set mandate = jsonb_set(mandate, '{confirmed_at}', to_jsonb(now()::text)) where decision_id = $1", [villa]);
      await ok('set_mandate', { decision_id: villa, ...mandate, cap_minor: 5600000 });
      const [d] = await rows(h.pool, 'select mandate from decisions where decision_id = $1', [villa]);
      expect(d.mandate.confirmed_at).toBeUndefined();
      expect(d.mandate.cap_minor).toBe(5600000);
      await ok('set_mandate', { decision_id: villa, ...mandate });
    });
  });

  describe('request_spend_approval and add_booking', () => {
    const ask = (over: Record<string, unknown> = {}, request_id = rq()) =>
      h.go.call('request_spend_approval', {
        request_id, trip_id: 't_goa', decision_id: villa, amount_minor: 5420000, currency: 'INR',
        merchant: 'ixigo: Villa Sol, Anjuna', purpose: 'Villa Sol, 3 nights, 6 to 9 Nov', refundable_until: '2099-11-01T18:29:59Z', ...over,
      });
    const confirm = () => h.pool.query("update decisions set mandate = jsonb_set(mandate - 'declined_at', '{confirmed_at}', to_jsonb(now()::text)) where decision_id = $1", [villa]);
    let approval: { approval_id: string; approval: string };
    const booking = (over: Record<string, unknown> = {}) => ({
      kind: 'stay', title: 'Villa Sol, 3 nights', vendor: 'ixigo', ref: 'IXG-7Q2K9', amount_minor: 5420000, currency: 'INR',
      payer_person_id: 'p_rahul', for_person_ids: ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir'], decision_id: villa,
      place: { name: 'Villa Sol', address: 'Anjuna, North Goa' }, ...over,
    });

    it('denies until the payer has tapped "Yes, book it" (a denial is a result, not an error)', async () => {
      const f = await ask();
      expect(f.error).toBeUndefined();
      expect(f.result).toMatchObject({ status: 'denied', reason: 'payer_has_not_confirmed' });
      expect(check('SpendApprovalResult', f.result)).toMatchObject({ ok: true });
    });

    it('denies the other reasons in order', async () => {
      expect((await ask({ decision_id: 'd_nope' })).result.reason).toBe('decision_not_found');
      const open = await ok('open_vote', { question: 'Q?', kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }] });
      expect((await ask({ decision_id: open.decision_id })).result.reason).toBe('decision_not_closed');
      await confirm();
      expect((await ask({ currency: 'USD' })).result.reason).toBe('currency_mismatch');
      const over = await ask({ amount_minor: 5640000 });
      expect(over.result).toMatchObject({ reason: 'over_cap', detail: '5640000 INR is above the cap of 5500000 INR' });
      expect((await ask({ refundable_until: '2020-01-01T00:00:00Z' })).result.reason).toBe('not_refundable');
      expect((await ask({ refundable_until: undefined })).result.reason).toBe('not_refundable');
      await h.pool.query("update decisions set mandate = jsonb_set(mandate, '{declined_at}', to_jsonb((now() + interval '1 minute')::text)) where decision_id = $1", [villa]);
      expect((await ask()).result.reason).toBe('payer_declined');
      await confirm(); // "Yes, book it" again, after the "Not now"
    });

    it('signs a one-use approval that verifies against the public key, with the payer from the mandate', async () => {
      const f = await ask();
      expect(f.result.status).toBe('approved');
      approval = f.result;
      expect(approval.approval_id).toMatch(/^ap_[0-9a-f]{16}$/);
      const v = verifySpendApproval(approval.approval, SPEND_PUBLIC_KEY);
      expect(v.ok).toBe(true);
      if (v.ok) {
        expect(v.claims).toMatchObject({
          iss: 'server', aud: 'go-vault', jti: approval.approval_id, trip_id: 't_goa', decision_id: villa, payer_person_id: 'p_rahul',
          amount_minor: 5420000, currency: 'INR', merchant: 'ixigo: Villa Sol, Anjuna',
        });
        expect(v.claims.exp - v.claims.iat).toBe(600);
      }
      expect(check('SpendApprovalResult', f.result)).toMatchObject({ ok: true });
    });

    it('a repeated request_id gets the same token, not approval_outstanding; a new one is denied while it waits', async () => {
      const id = rq();
      const first = await ask({ amount_minor: 5400000 }, id).then((f) => f.result);
      // the earlier approval is outstanding, so a new request is denied...
      expect(first).toMatchObject({ status: 'denied', reason: 'approval_outstanding' });
      // ...and asking again with the same request_id gives the same denial from the stored answer
      expect((await ask({ amount_minor: 5400000 }, id)).result).toEqual(first);
    });

    it('does not mark an approval used and sends no event (not a change to the trip)', async () => {
      const [a] = await rows(h.pool, 'select used_at, cancelled_at from spend_approvals where approval_id = $1', [approval.approval_id]);
      expect(a).toEqual({ used_at: null, cancelled_at: null });
    });

    it('records the booking with the approval: marks it used, writes the booked line over the decided line', async () => {
      const [decided] = await rows(h.pool, "select line_id from record_lines where decision_id = $1 and kind = 'decided'", [villa]);
      const params = { request_id: rq(), ...booking(), approval_id: approval.approval_id };
      const r = (await h.go.call('add_booking', { trip_id: 't_goa', ...params })).result;
      expect(r.booking_id).toBeTruthy();
      const [a] = await rows(h.pool, 'select used_at, booking_id from spend_approvals where approval_id = $1', [approval.approval_id]);
      expect(a.used_at).not.toBeNull();
      expect(a.booking_id).toBe(r.booking_id);
      await h.flush();
      const added = events('booking.changed').at(-1)!;
      expect(added).toMatchObject({ seq: r.seq, data: { change: 'added', by: { kind: 'go' }, booking: { status: 'confirmed', approval_id: approval.approval_id } } });
      const line = events('record.changed').at(-1)!;
      expect(line.seq).toBe(r.seq + 1);
      expect(line.data).toMatchObject({ change: 'updated', by: { kind: 'system' }, line: { line_id: decided.line_id, kind: 'booked', text: 'Villa Sol, 3 nights', source: 'booking', booking_id: r.booking_id } });
      // a repeat gets the first answer even though the approval is used now (not a 409)
      const again = (await h.go.call('add_booking', { trip_id: 't_goa', ...params })).result;
      expect(again).toEqual(r);
      expect((await rows(h.pool, 'select count(*)::int as n from bookings'))[0].n).toBe(1);
    });

    it('refuses a second booking with a used approval (409)', async () => {
      expect(await err('add_booking', { ...booking(), approval_id: approval.approval_id })).toMatchObject({ code: 409, data: { code: 'conflict' } });
    });

    it('refuses a booking above the approved amount, for another vote, with a cancelled approval, or with an unknown one (409)', async () => {
      await h.pool.query("update spend_approvals set cancelled_at = now()");
      const f = await ask();
      expect(f.result.status).toBe('approved');
      const second = f.result.approval_id;
      expect(await err('add_booking', { ...booking({ amount_minor: 5420001 }), approval_id: second })).toMatchObject({ code: 409 });
      expect(await err('add_booking', { ...booking({ decision_id: undefined }), approval_id: second })).toMatchObject({ code: 409 });
      expect(await err('add_booking', { ...booking(), approval_id: 'ap_unknown' })).toMatchObject({ code: 409 });
      expect(await ok('cancel_spend_approval', { approval_id: second, reason: 'other' })).toEqual({ ok: true });
      expect(await err('add_booking', { ...booking(), approval_id: second })).toMatchObject({ code: 409 });
      expect(await ok('cancel_spend_approval', { approval_id: second, reason: 'other' })).toEqual({ ok: true }); // safe to repeat
      expect(await err('cancel_spend_approval', { approval_id: 'ap_unknown', reason: 'other' })).toMatchObject({ code: 404 });
      // a cancelled approval no longer counts as outstanding
      expect((await ask()).result.status).toBe('approved');
    });

    it('records a booking without an approval (a cab someone booked): no approval checks', async () => {
      const r = await ok('add_booking', { kind: 'cab', title: 'Airport cab', vendor: 'Kabir', ref: 'cab-1', amount_minor: 340000, currency: 'INR', payer_person_id: 'p_kabir', for_person_ids: ['p_kabir'] });
      expect(r.booking_id).toBeTruthy();
      const [line] = await rows(h.pool, "select kind, source from record_lines where booking_id = $1", [r.booking_id]);
      expect(line).toEqual({ kind: 'booked', source: 'booking' }); // no decided line to turn: a new booked line
    });

    it('updates and cancels a booking; a cancelled booking cannot change (409)', async () => {
      const [b] = await rows(h.pool, "select booking_id from bookings where title = 'Airport cab'");
      expect(await err('update_booking', { booking_id: b.booking_id })).toMatchObject({ code: 422 });
      await ok('update_booking', { booking_id: b.booking_id, ref: 'cab-2' });
      await ok('update_booking', { booking_id: b.booking_id, status: 'cancelled' });
      await h.flush();
      expect(events('booking.changed').at(-1)!.data).toMatchObject({ change: 'cancelled', booking: { status: 'cancelled', ref: 'cab-2' } });
      expect(await err('update_booking', { booking_id: b.booking_id, ref: 'x' })).toMatchObject({ code: 409 });
      expect(await err('update_booking', { booking_id: 'b_nope', ref: 'x' })).toMatchObject({ code: 404 });
    });
  });
});

describe('expenses and the money maths', () => {
  it('adds the villa and the cab, and works out the same transfers as the contract\'s example', async () => {
    const everyone = ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir'];
    const [b] = await rows(h.pool, "select booking_id from bookings where title = 'Villa Sol, 3 nights'");
    await ok('add_expense', { paid_by_person_id: 'p_rahul', amount_minor: 5420000, currency: 'INR', note: 'Villa Sol, 3 nights', category: 'stay', split_person_ids: everyone, booking_id: b.booking_id });
    await ok('add_expense', { paid_by_person_id: 'p_kabir', amount_minor: 340000, currency: 'INR', note: 'Airport cab', category: 'getting_around', split_person_ids: everyone });
    const snap = (await h.go.call('read_trip', { trip_id: 't_goa' })).result;
    expect(snap.money).toEqual({
      currency: 'INR',
      plan_minor: 7500000,
      spent_minor: 5760000,
      by_category: [{ category: 'stay', amount_minor: 5420000 }, { category: 'getting_around', amount_minor: 340000 }],
      transfers: [
        { from_person_id: 'p_priya', to_person_id: 'p_rahul', amount_minor: 1152000, currency: 'INR' },
        { from_person_id: 'p_arjun', to_person_id: 'p_rahul', amount_minor: 1152000, currency: 'INR' },
        { from_person_id: 'p_meher', to_person_id: 'p_rahul', amount_minor: 1152000, currency: 'INR' },
        { from_person_id: 'p_kabir', to_person_id: 'p_rahul', amount_minor: 812000, currency: 'INR' },
      ],
    });
    expect(check('TripSnapshot', snap)).toMatchObject({ ok: true });
  });

  it('refuses a non-positive amount, another currency, or someone outside the trip (422)', async () => {
    const base = { paid_by_person_id: 'p_rahul', amount_minor: 100, currency: 'INR', note: 'x', category: 'food', split_person_ids: ['p_rahul'] };
    expect(await err('add_expense', { ...base, amount_minor: 0 })).toMatchObject({ code: 422 });
    expect(await err('add_expense', { ...base, currency: 'USD' })).toMatchObject({ code: 422 });
    expect(await err('add_expense', { ...base, split_person_ids: ['p_ghost'] })).toMatchObject({ code: 422 });
  });
});

describe('the trip record and trip details', () => {
  let agreed: string;
  const proof = async () => {
    await h.pool.query("insert into messages (message_id, trip_id, seq, updated_seq, author_kind, author_person_id, text) values ('m_proof', 't_goa', 900, 900, 'person', 'p_priya', 'North Goa') on conflict do nothing");
    return [{ message_id: 'm_proof', person_id: 'p_priya' }];
  };
  it('writes an agreed line with proof, and refuses one without (422)', async () => {
    expect(await err('add_record_line', { kind: 'agreed', text: 'North Goa, not South', proof: [], person_ids: ['p_priya'] })).toMatchObject({ code: 422 });
    const r = await ok('add_record_line', { kind: 'agreed', text: 'North Goa, not South', proof: await proof(), person_ids: ['p_priya', 'p_arjun'] });
    agreed = r.line_id;
    await h.flush();
    expect(events('record.changed').at(-1)!.data).toMatchObject({ change: 'added', by: { kind: 'go' }, line: { kind: 'agreed', source: 'go', status: 'active' } });
  });
  it('refuses proof from a message outside the trip (422) and decided or booked kinds', async () => {
    expect(await err('add_record_line', { kind: 'agreed', text: 'x', proof: [{ message_id: 'm_nope' }], person_ids: [] })).toMatchObject({ code: 422 });
    expect(await err('add_record_line', { kind: 'decided', text: 'x', proof: [], person_ids: [] })).toMatchObject({ code: 422 });
  });
  it('marks a line done, and refuses to change a line the server wrote (409) or one a person undid (409)', async () => {
    await ok('update_record_line', { line_id: agreed, status: 'done' });
    await h.flush();
    expect(events('record.changed').at(-1)!.data.change).toBe('done');
    const [decided] = await rows(h.pool, "select line_id from record_lines where source = 'booking' limit 1");
    expect(await err('update_record_line', { line_id: decided.line_id, text: 'x' })).toMatchObject({ code: 409 });
    await h.pool.query("update record_lines set status = 'undone' where line_id = $1", [agreed]);
    expect(await err('update_record_line', { line_id: agreed, text: 'again' })).toMatchObject({ code: 409 });
    expect(await err('update_record_line', { line_id: 'r_nope', text: 'x' })).toMatchObject({ code: 404 });
  });
  it('updates only the fields sent and says what changed in trip.updated', async () => {
    await ok('update_trip', { destination: { name: 'North Goa', lat: 15.6, lng: 73.75 }, stay: 'villa with a pool' });
    await h.flush();
    expect(events('trip.updated').at(-1)!.data).toEqual({ by: { kind: 'go' }, changed: ['destination', 'stay'] });
    const snap = (await h.go.call('read_trip', { trip_id: 't_goa' })).result;
    expect(snap).toMatchObject({ title: 'Goa 🌴', stay: 'villa with a pool', destination: { name: 'North Goa' } });
  });
  it('refuses an empty update and dates the wrong way round (422)', async () => {
    expect(await err('update_trip', {})).toMatchObject({ code: 422 });
    expect(await err('update_trip', { dates: { start: '2026-11-09', end: '2026-11-06' } })).toMatchObject({ code: 422 });
    expect(await err('update_trip', { itinerary: [{ date: '2026-11-06', items: [{ title: 'x', category: 'food', status: 'idea', booking_id: 'b_nope' }] }] })).toMatchObject({ code: 422 });
  });
});

describe('change numbers over the whole flow', () => {
  it('every change took the next number and has exactly one event: no gaps, no repeats', async () => {
    await h.flush();
    const sent = await rows(h.pool, "select seq, status from outbox where trip_id = 't_goa' order by seq");
    expect(sent.every((r) => r.status === 'sent')).toBe(true);
    const seqs = sent.map((r) => r.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1] + 1);
    // and Go received them in that order
    const received = h.go.events.map((e) => e.seq);
    expect(received).toEqual([...received].sort((a, b) => a - b));
  });
});

// Phase 3, in a trip of its own (a settlement takes a change number with no event, which the check above would read as a gap).
describe('settlements and disputed expenses in Go\'s read_trip (phase 3)', () => {
  const T = 't_money';
  const everyone = ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir'];
  const api = async (who: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: unknown) => {
    const r = await h.app.inject({ method, url: `/app/v1/trips/${T}${path}`, payload: payload as any, headers: { authorization: `Bearer ${await h.token(who)}` } });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
  const money = async () => (await h.go.call('read_trip', { trip_id: T })).result;
  const owes = (snap: any, from: string) => snap.money.transfers.find((x: any) => x.from_person_id === from)?.amount_minor ?? 0;

  it('a recorded settlement counts at once, a disputed one does not; a disputed expense leaves the totals and the transfers; the snapshot still passes the contract', async () => {
    await seedTrip(h.pool, T);
    const e = await api('p_rahul', 'POST', '/expenses', { amount_minor: 100000, note: 'Dinner', category: 'food', split_person_ids: everyone });
    expect([e.status, e.body.status, owes(await money(), 'p_priya')]).toEqual([201, 'pending', 20000]); // pending already counts
    const s = await api('p_priya', 'POST', '/settlements', { to_person_id: 'p_rahul', amount_minor: 20000, currency: 'INR', method: 'upi' });
    expect([s.status, owes(await money(), 'p_priya')]).toEqual([201, 0]); // provisionally squared up
    await api('p_rahul', 'POST', `/settlements/${s.body.settlement.settlement_id}/dispute`);
    expect(owes(await money(), 'p_priya')).toBe(20000); // put back
    await api('p_kabir', 'POST', `/expenses/${e.body.expense_id}/dispute`, { reason: 'not me' });
    const snap = await money();
    expect([snap.money.spent_minor, snap.money.by_category, snap.money.transfers]).toEqual([0, [], []]);
    expect(snap.expenses[0]).toMatchObject({ status: 'disputed', confirmations: expect.arrayContaining([{ person_id: 'p_kabir', state: 'disputed', at: expect.any(String), reason: 'not me' }]) });
    expect(check('TripSnapshot', snap)).toMatchObject({ ok: true });
    expect(check('Money', snap.money)).toMatchObject({ ok: true });
  });
});
