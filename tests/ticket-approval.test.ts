// Go's 1.2 ticket form of request_spend_approval (rev 5 H): one traveller's own ticket, paid by them, with no group vote.
// The Server keeps each person's pick on Go's options cards (option_picks) and grants the ticket against their most recent
// pick from the last 30 minutes at that price. The rules run in order: not_in_trip, payer_has_not_confirmed (no such
// pick), approval_outstanding, already_booked. add_booking then takes the approval with no decision_id, for that person alone.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { check, signSpendApproval, spendFormProblem, verifySpendApproval } from '../src/contract/index.js';
import { appApi } from './helpers/app-api.js';
import { SPEND_PUBLIC_KEY, rows, startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness();
  t = appApi(h);
});
afterAll(() => h.stop());

let n = 0;
const rq = () => `rq_tk_${++n}`;
const call = (method: string, params: Record<string, unknown>) => h.go.call(method, { request_id: rq(), trip_id: 't_goa', ...params });
const ok = async (method: string, params: Record<string, unknown>) => {
  const f = await call(method, params);
  if (f.error) throw new Error(`${method}: ${JSON.stringify(f.error)}`);
  return f.result;
};

const PRICE = 592000; // the option's price on the card; up to ceil(592000 × 1.05) = 621600 is allowed
let cards = 0;
/** Go posts an options card of flights; its first option is priced at PRICE. */
const postFlights = async () => {
  const card_id = `c_fl_${++cards}`;
  await ok('post_message', {
    text: 'Flights', card: {
      card_id, kind: 'options', fallback_text: 'Flights to Goa', title: 'Flights', option_kind: 'flight', checked_at: '2026-10-05T06:49:30Z',
      options: [
        { option_id: 'o1', title: 'IndiGo 6E 2134', price_minor: PRICE, currency: 'INR', highlights: ['Non-stop'] },
        { option_id: 'o2', title: 'Air India AI 881', highlights: ['1 stop'] }, // no price on the card
      ],
      actions: [{ action_id: 'pick', label: 'Pick', style: 'primary', per_option: true }],
    },
  });
  return card_id;
};
const tap = (personId: string, cardId: string, optionId = 'o1') =>
  t.api(t.as(personId), 'POST', `/app/v1/trips/t_goa/cards/${cardId}/actions`, { action_id: 'pick', option_id: optionId });
const ask = async (forPersonId: string, over: Record<string, unknown> = {}) =>
  (await call('request_spend_approval', { amount_minor: 600000, currency: 'INR', merchant: 'IndiGo', purpose: 'Flight to Goa', kind: 'ticket', for_person_id: forPersonId, ...over })).result;
const booking = (personId: string, over: Record<string, unknown> = {}) => ({
  kind: 'flight', title: 'IndiGo 6E 2134', vendor: 'ixigo', ref: `PNR${++n}`, amount_minor: 600000, currency: 'INR',
  payer_person_id: personId, for_person_ids: [personId], ...over,
});

// Each test starts with no picks and no ticket approvals.
beforeEach(async () => {
  await h.pool.query('delete from spend_approvals where pick_id is not null');
  await h.pool.query('delete from option_picks');
});

describe('the pick', () => {
  it('a tap on an option of an options card keeps the pick with the price the card showed, before Go hears of it', async () => {
    const card = await postFlights();
    expect((await tap('p_priya', card)).status).toBe(200);
    const message = (await rows(h.pool, 'select message_id from messages where card_id = $1', [card]))[0].message_id;
    expect(await rows(h.pool, 'select person_id, card_id, message_id, option_id, price_minor::int, currency from option_picks')).toEqual([
      { person_id: 'p_priya', card_id: card, message_id: message, option_id: 'o1', price_minor: PRICE, currency: 'INR' },
    ]);
    await tap('p_priya', card, 'o2'); // an option with no price
    expect((await rows(h.pool, `select price_minor, currency from option_picks where option_id = 'o2'`))[0]).toEqual({ price_minor: null, currency: null });
  });

  it('is kept even when Go does not answer; a tap with no option, or an option not on the card, is not a pick', async () => {
    const card = await postFlights();
    const before = h.go.answers.card_tap!;
    h.go.answers.card_tap = () => ({ error: { code: 503, message: 'deploy', data: { code: 'unavailable' } } });
    try {
      expect((await tap('p_arjun', card)).body).toMatchObject({ result: 'refused' });
    } finally {
      h.go.answers.card_tap = before;
    }
    await t.api(t.as('p_arjun'), 'POST', `/app/v1/trips/t_goa/cards/${card}/actions`, { action_id: 'pick' });
    await tap('p_arjun', card, 'o_nope');
    expect(await rows(h.pool, 'select person_id, option_id from option_picks')).toEqual([{ person_id: 'p_arjun', option_id: 'o1' }]);
  });
});

describe('request_spend_approval, kind ticket', () => {
  it('happy path: a pick, a ticket approval that verifies and names the traveller, then add_booking with no decision_id uses it', async () => {
    const card = await postFlights();
    await tap('p_priya', card);
    const approved = await ask('p_priya');
    expect(approved.status).toBe('approved');
    expect(check('SpendApprovalResult', approved)).toMatchObject({ ok: true });
    const v = verifySpendApproval(approved.approval, SPEND_PUBLIC_KEY);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.claims).toMatchObject({ iss: 'server', aud: 'go-vault', jti: approved.approval_id, trip_id: 't_goa', for_person_id: 'p_priya', kind: 'ticket', payer_person_id: 'p_priya', amount_minor: 600000, currency: 'INR' });
      expect(v.claims).not.toHaveProperty('decision_id');
      expect(check('SpendApprovalClaims', v.claims)).toMatchObject({ ok: true });
      // The claims are in Go's key order: for_person_id and kind come right before payer_person_id.
      expect(Object.keys(v.claims).slice(3, 7)).toEqual(['trip_id', 'for_person_id', 'kind', 'payer_person_id']);
    }
    const stored = (await rows(h.pool, 'select decision_id, for_person_id, payer_person_id, pick_id from spend_approvals where approval_id = $1', [approved.approval_id]))[0];
    expect(stored).toMatchObject({ decision_id: null, for_person_id: 'p_priya', payer_person_id: 'p_priya', pick_id: expect.stringMatching(/^pk_/) });
    // The same request_id again gets the same answer, token and all.
    const again = await h.go.call('request_spend_approval', { request_id: `rq_tk_${n}`, trip_id: 't_goa', amount_minor: 600000, currency: 'INR', merchant: 'IndiGo', purpose: 'Flight to Goa', kind: 'ticket', for_person_id: 'p_priya' });
    expect(again.result).toEqual(approved);

    const b = await ok('add_booking', { ...booking('p_priya'), approval_id: approved.approval_id });
    expect(b.booking_id).toBeTruthy();
    expect((await rows(h.pool, 'select used_at is not null as used, booking_id from spend_approvals where approval_id = $1', [approved.approval_id]))[0]).toEqual({ used: true, booking_id: b.booking_id });
    expect((await rows(h.pool, 'select decision_id, approval_id from bookings where booking_id = $1', [b.booking_id]))[0]).toEqual({ decision_id: null, approval_id: approved.approval_id });
  });

  it('up to 5% over the picked price is allowed (ceil); a pick with no price fits any amount in its currency', async () => {
    const card = await postFlights();
    await tap('p_meher', card);
    expect((await ask('p_meher', { amount_minor: 621600 })).status).toBe('approved');
    await h.pool.query('delete from spend_approvals where pick_id is not null');
    await h.pool.query('delete from option_picks');
    await tap('p_meher', card, 'o2');
    // o2 has no price and no currency on the card, so there is no currency to match: not a pick a ticket can use.
    expect((await ask('p_meher', { amount_minor: 5_000_000 })).reason).toBe('payer_has_not_confirmed');
    await h.pool.query(`update option_picks set currency = 'INR'`);
    expect((await ask('p_meher', { amount_minor: 5_000_000 })).status).toBe('approved');
  });

  describe('denials, in order', () => {
    it('not_in_trip: a stranger, and a traveller who picked and then left (checked before the pick)', async () => {
      expect(await ask('p_nobody')).toMatchObject({ status: 'denied', reason: 'not_in_trip' });
      const card = await postFlights();
      await tap('p_kabir', card);
      await h.pool.query(`update trip_people set left_at = now() where trip_id = 't_goa' and person_id = 'p_kabir'`);
      try {
        const denied = await ask('p_kabir');
        expect(denied).toMatchObject({ status: 'denied', reason: 'not_in_trip' });
        expect(check('SpendApprovalResult', denied)).toMatchObject({ ok: true });
      } finally {
        await h.pool.query(`update trip_people set left_at = null where trip_id = 't_goa' and person_id = 'p_kabir'`);
      }
    });

    it('payer_has_not_confirmed: no pick, or only someone else\'s', async () => {
      expect(await ask('p_arjun')).toEqual({ status: 'denied', reason: 'payer_has_not_confirmed', detail: 'no option picked by this traveller in the last 30 minutes at this price' });
      await tap('p_priya', await postFlights());
      expect((await ask('p_arjun')).reason).toBe('payer_has_not_confirmed');
    });

    it('payer_has_not_confirmed: a pick more than 30 minutes old', async () => {
      await tap('p_arjun', await postFlights());
      await h.pool.query(`update option_picks set picked_at = now() - interval '31 minutes'`);
      expect((await ask('p_arjun')).reason).toBe('payer_has_not_confirmed');
    });

    it('payer_has_not_confirmed: more than 5% over the picked price, or another currency', async () => {
      await tap('p_arjun', await postFlights());
      expect((await ask('p_arjun', { amount_minor: 621601 })).reason).toBe('payer_has_not_confirmed');
      expect((await ask('p_arjun', { currency: 'USD', amount_minor: 7000 })).reason).toBe('payer_has_not_confirmed');
      expect((await ask('p_arjun', { amount_minor: 621600 })).status).toBe('approved');
    });

    it('approval_outstanding: a second ticket for the same pick while the first waits, even after tapping the option again', async () => {
      const card = await postFlights();
      await tap('p_arjun', card);
      const first = await ask('p_arjun');
      expect(first.status).toBe('approved');
      expect(await ask('p_arjun')).toMatchObject({ status: 'denied', reason: 'approval_outstanding' });
      await tap('p_arjun', card); // a second tap on the same option is the same pick
      expect((await ask('p_arjun')).reason).toBe('approval_outstanding');
      // Once Go cancels the first, a new one may be granted.
      await ok('cancel_spend_approval', { approval_id: first.approval_id, reason: 'other' });
      expect((await ask('p_arjun')).status).toBe('approved');
    });

    it('already_booked: the pick was booked with a ticket approval; a cancelled booking does not count', async () => {
      const card = await postFlights();
      await tap('p_arjun', card);
      const approved = await ask('p_arjun');
      const b = await ok('add_booking', { ...booking('p_arjun'), approval_id: approved.approval_id });
      const denied = await ask('p_arjun');
      expect(denied).toMatchObject({ status: 'denied', reason: 'already_booked' });
      expect(denied.detail).toMatch(/^this pick is already booked/);
      expect(check('SpendApprovalResult', denied)).toMatchObject({ ok: true });
      await ok('update_booking', { booking_id: b.booking_id, status: 'cancelled' });
      expect((await ask('p_arjun')).status).toBe('approved');
    });
  });
});

describe('add_booking with a ticket approval', () => {
  it('is for that traveller alone, paid by them, with no vote: anyone else\'s booking, a group booking or a vote is refused (409)', async () => {
    await tap('p_priya', await postFlights());
    const approved = await ask('p_priya');
    const err = async (over: Record<string, unknown>) => (await call('add_booking', { ...booking('p_priya'), approval_id: approved.approval_id, ...over })).error;
    expect(await err({ payer_person_id: 'p_arjun', for_person_ids: ['p_arjun'] })).toMatchObject({ code: 409 });
    expect(await err({ for_person_ids: ['p_priya', 'p_arjun'] })).toMatchObject({ code: 409 });
    expect(await err({ payer_person_id: 'p_arjun' })).toMatchObject({ code: 409 });
    expect(await err({ amount_minor: 600001 })).toMatchObject({ code: 409 });
    const vote = (await ok('open_vote', { question: 'Which flight?', kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }] })).decision_id;
    expect(await err({ decision_id: vote })).toMatchObject({ code: 409 });
    expect((await rows(h.pool, 'select used_at from spend_approvals where approval_id = $1', [approved.approval_id]))[0].used_at).toBeNull();
    // Priya's own booking, for less, uses it.
    expect(await err({ amount_minor: 590000 })).toBeUndefined();
  });

  it('a group approval cannot be used for a booking with no vote', async () => {
    await h.pool.query(
      `insert into spend_approvals (approval_id, trip_id, request_id, decision_id, payer_person_id, amount_minor, currency, merchant, approval, expires_at)
       values ('ap_group_x', 't_goa', 'rq_group_x', 'd_some_vote', 'p_rahul', 600000, 'INR', 'IndiGo', 'x', now() + interval '10 minutes')`,
    );
    expect((await call('add_booking', { ...booking('p_rahul'), approval_id: 'ap_group_x' })).error).toMatchObject({ code: 409 });
  });
});

describe('the signer', () => {
  it('refuses claims Go\'s vault would refuse (spendFormProblem): both forms, neither, a ticket paid by someone else, a group approval with a kind', () => {
    const base = { iss: 'server', aud: 'go-vault', jti: 'ap_0123456789', trip_id: 't_goa', payer_person_id: 'p_priya', amount_minor: 1, currency: 'INR', merchant: 'm', purpose: 'p', iat: 1, exp: 600 } as const;
    expect(spendFormProblem({ ...base, decision_id: 'd_1' })).toBeNull();
    expect(spendFormProblem({ ...base, for_person_id: 'p_priya', kind: 'ticket' })).toBeNull();
    expect(spendFormProblem({ ...base, decision_id: 'd_1', for_person_id: 'p_priya' })).toBe('exactly one of decision_id and for_person_id');
    expect(spendFormProblem(base)).toBe('exactly one of decision_id and for_person_id');
    expect(spendFormProblem({ ...base, for_person_id: 'p_arjun' })).toBe("a ticket's payer is the person it is for");
    expect(spendFormProblem({ ...base, decision_id: 'd_1', kind: 'ticket' })).toBe('a group approval has no kind');
    expect(() => signSpendApproval({ ...base, for_person_id: 'p_arjun', kind: 'ticket' }, h.ctx.spendPrivateKey)).toThrow(/payer is the person/);
  });
});
