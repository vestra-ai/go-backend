// Go's 1.3 personal form of request_spend_approval (rev 5 H, G3): a person's own payment, with no group vote. Go names
// the person, its card and the option they tapped; the Server grants it against its own record of that tap
// (option_picks). The rules run in order: not_in_trip, no_pick (no such tap in 30 minutes, not their own card, or over the
// price plus 5%), approval_outstanding, already_booked. add_booking then takes the approval with no decision_id, for that
// person alone. 1.2's ticket form (kind "ticket", for_person_id) is gone: Go's 1.3 vault refuses its claims.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { check, parseParams, signSpendApproval, spendFormProblem, verifySpendApproval } from '../src/contract/index.js';
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

const PRICE = 592000; // the option's price on the card; up to floor(592000 × 1.05) = 621600 is allowed
let cards = 0;
/**
 * Go posts an options card of flights; its first option is priced at PRICE. `whose` makes it someone's own card: named
 * in for_person_ids (the default way), or on a message only they can see. With no `whose` it is a card for the group.
 */
const postFlights = async (whose?: string, how: 'named' | 'private' = 'named') => {
  const card_id = `c_fl_${++cards}`;
  await ok('post_message', {
    text: 'Flights', ...(whose && how === 'private' ? { visible_to_person_ids: [whose] } : {}),
    card: {
      card_id, kind: 'options', fallback_text: 'Flights to Goa', title: 'Flights', option_kind: 'flight', checked_at: '2026-10-05T06:49:30Z',
      ...(whose && how === 'named' ? { for_person_ids: [whose] } : {}),
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
const SPEND = { amount_minor: 600000, currency: 'INR', merchant: 'IndiGo', purpose: 'Flight to Goa' };
const ask = async (personId: string, cardId: string, over: Record<string, unknown> = {}, optionId = 'o1') =>
  (await call('request_spend_approval', { ...SPEND, personal: { person_id: personId, card_id: cardId, option_id: optionId }, ...over })).result;
/** Go posts that person their own flights card and they tap its first option. */
const picked = async (personId: string) => {
  const card = await postFlights(personId);
  await tap(personId, card);
  return card;
};
const booking = (personId: string, over: Record<string, unknown> = {}) => ({
  kind: 'flight', title: 'IndiGo 6E 2134', vendor: 'ixigo', ref: `PNR${++n}`, amount_minor: 600000, currency: 'INR',
  payer_person_id: personId, for_person_ids: [personId], ...over,
});

// Each test starts with no picks and no personal approvals. (Card taps are limited to 10 a minute per person, so the
// tests spread their taps over the trip's people.)
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

describe('request_spend_approval, the personal form', () => {
  it('happy path: a pick, an approval that verifies and names the pick, then add_booking with no decision_id uses it', async () => {
    const card = await picked('p_priya');
    const approved = await ask('p_priya', card);
    expect(approved.status).toBe('approved');
    expect(check('SpendApprovalResult', approved)).toMatchObject({ ok: true });
    const v = verifySpendApproval(approved.approval, SPEND_PUBLIC_KEY);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.claims).toMatchObject({ iss: 'server', aud: 'go-vault', jti: approved.approval_id, trip_id: 't_goa', personal: { person_id: 'p_priya', card_id: card, option_id: 'o1' }, payer_person_id: 'p_priya', amount_minor: 600000, currency: 'INR' });
      // Exactly the 1.3 claims: no vote, and nothing of 1.2's ticket form, which Go's vault no longer reads.
      for (const gone of ['decision_id', 'for_person_id', 'kind']) expect(v.claims).not.toHaveProperty(gone);
      expect(check('SpendApprovalClaims', v.claims)).toMatchObject({ ok: true });
      // The claims are in Go's key order: personal sits where a vote's approval has decision_id.
      expect(Object.keys(v.claims).slice(3, 6)).toEqual(['trip_id', 'personal', 'payer_person_id']);
      expect(Object.keys((v.claims as any).personal)).toEqual(['person_id', 'card_id', 'option_id']);
    }
    const stored = (await rows(h.pool, 'select decision_id, for_person_id, payer_person_id, pick_id from spend_approvals where approval_id = $1', [approved.approval_id]))[0];
    expect(stored).toMatchObject({ decision_id: null, for_person_id: 'p_priya', payer_person_id: 'p_priya', pick_id: expect.stringMatching(/^pk_/) });
    // The same request_id again gets the same answer, token and all.
    const again = await h.go.call('request_spend_approval', { request_id: `rq_tk_${n}`, trip_id: 't_goa', ...SPEND, personal: { person_id: 'p_priya', card_id: card, option_id: 'o1' } });
    expect(again.result).toEqual(approved);

    const b = await ok('add_booking', { ...booking('p_priya'), approval_id: approved.approval_id });
    expect(b.booking_id).toBeTruthy();
    expect((await rows(h.pool, 'select used_at is not null as used, booking_id from spend_approvals where approval_id = $1', [approved.approval_id]))[0]).toEqual({ used: true, booking_id: b.booking_id });
    expect((await rows(h.pool, 'select decision_id, approval_id from bookings where booking_id = $1', [b.booking_id]))[0]).toEqual({ decision_id: null, approval_id: approved.approval_id });
  });

  it('1.2\'s ticket form is refused as invalid, and a request with neither a vote nor a pick, or with both, too', async () => {
    for (const p of [{ ...SPEND, kind: 'ticket', for_person_id: 'p_priya' }, SPEND]) expect((await call('request_spend_approval', p)).error).toMatchObject({ code: 422 });
    expect(parseParams('request_spend_approval', { request_id: 'r', trip_id: 't', ...SPEND, personal: { person_id: 'p_priya', card_id: 'c_1' } })).toMatchObject({ ok: false });
    // Both at once passes the contract's anyOf; the Server refuses it: a personal request has no vote.
    expect((await call('request_spend_approval', { ...SPEND, decision_id: 'd_1', personal: { person_id: 'p_priya', card_id: 'c_1', option_id: 'o1' } })).error).toMatchObject({ code: 422 });
  });

  it('their own card is one naming them, or a message only they can see; up to 5% over the price is allowed (floor)', async () => {
    const card = await postFlights('p_meher', 'private');
    await tap('p_meher', card);
    expect((await ask('p_meher', card, { amount_minor: 621600 })).status).toBe('approved');
  });

  describe('denials, in order', () => {
    it('not_in_trip: a stranger, and a person who picked and then left (checked before the pick)', async () => {
      expect(await ask('p_nobody', 'c_any')).toMatchObject({ status: 'denied', reason: 'not_in_trip' });
      const card = await picked('p_kabir');
      await h.pool.query(`update trip_people set left_at = now() where trip_id = 't_goa' and person_id = 'p_kabir'`);
      try {
        const denied = await ask('p_kabir', card);
        expect(denied).toMatchObject({ status: 'denied', reason: 'not_in_trip' });
        expect(check('SpendApprovalResult', denied)).toMatchObject({ ok: true });
      } finally {
        await h.pool.query(`update trip_people set left_at = null where trip_id = 't_goa' and person_id = 'p_kabir'`);
      }
    });

    it('no_pick: no tap, someone else\'s tap, another option, or another card than the one they tapped', async () => {
      const card = await postFlights('p_arjun');
      const denied = await ask('p_arjun', card);
      expect(denied).toEqual({ status: 'denied', reason: 'no_pick', detail: 'that person has not picked that option on a card of theirs in the last 30 minutes' });
      expect(check('SpendApprovalResult', denied)).toMatchObject({ ok: true });
      const priyas = await picked('p_priya');
      expect((await ask('p_arjun', priyas)).reason).toBe('no_pick'); // Priya's tap is not Arjun's
      await tap('p_arjun', card);
      expect((await ask('p_arjun', card, {}, 'o2')).reason).toBe('no_pick'); // he tapped o1, not o2
      expect((await ask('p_arjun', await postFlights('p_arjun'))).reason).toBe('no_pick'); // his card, but not the one he tapped
      expect((await ask('p_arjun', card)).status).toBe('approved');
    });

    it('no_pick: a tap on a card addressed to someone else; a card that names nobody is the room\'s, and anyone may pick from it', async () => {
      const room = await postFlights();
      await tap('p_kabir', room);
      expect((await ask('p_kabir', room)).status).toBe('approved'); // Go books a room's flights card for whoever taps it
      // Only a room's card of tickets: a tap on the room's stays card (the group's to vote on and pay for) is no personal pick.
      await ok('post_message', { text: 'Stays', card: { card_id: 'c_room_stays', kind: 'options', fallback_text: 'Stays', title: 'Stays', option_kind: 'stay', checked_at: '2026-10-05T06:49:30Z', options: [{ option_id: 'o1', title: 'Casa Azul', price_minor: PRICE, currency: 'INR', highlights: [] }], actions: [{ action_id: 'pick', label: 'Pick', style: 'primary', per_option: true }] } });
      await tap('p_kabir', 'c_room_stays');
      expect((await ask('p_kabir', 'c_room_stays')).reason).toBe('no_pick');
      const priyas = await postFlights('p_priya');
      await tap('p_kabir', priyas); // the card is in the room, so the tap goes through; it is still Priya's card
      expect((await ask('p_kabir', priyas)).reason).toBe('no_pick');
      // Go's own step after a pick (travel/taps.ts): the card redrawn with the picked flight alone and no buttons. Still theirs.
      const shown = await picked('p_rahul');
      await ok('replace_card', { card: { card_id: shown, kind: 'options', fallback_text: 'Flights to Goa', title: 'Flights', option_kind: 'flight', checked_at: '2026-10-05T06:49:30Z', for_person_ids: ['p_rahul'], options: [{ option_id: 'o1', title: 'IndiGo 6E 2134', price_minor: PRICE, currency: 'INR', highlights: ['Non-stop'] }], actions: [] } });
      expect((await ask('p_rahul', shown)).status).toBe('approved');
      // Their own card, picked, then replaced by Go without that option: the card is read as it stands now.
      const own = await picked('p_kabir');
      await ok('replace_card', { card: { card_id: own, kind: 'notice', fallback_text: 'Gone', title: 'Sold out', body: 'That fare is gone', tone: 'heads_up', for_person_ids: ['p_kabir'] } });
      expect((await ask('p_kabir', own)).reason).toBe('no_pick');
    });

    it('no_pick: a pick more than 30 minutes old', async () => {
      const card = await picked('p_arjun');
      await h.pool.query(`update option_picks set picked_at = now() - interval '31 minutes'`);
      expect((await ask('p_arjun', card)).reason).toBe('no_pick');
    });

    it('no_pick: more than 5% over the picked price, another currency, or an option that showed no price', async () => {
      const card = await picked('p_meher');
      expect((await ask('p_meher', card, { amount_minor: 621601 })).reason).toBe('no_pick');
      expect((await ask('p_meher', card, { currency: 'USD', amount_minor: 7000 })).reason).toBe('no_pick');
      await tap('p_meher', card, 'o2');
      expect((await ask('p_meher', card, { amount_minor: 100 }, 'o2')).reason).toBe('no_pick');
      expect((await ask('p_meher', card, { amount_minor: 621600 })).status).toBe('approved');
    });

    it('approval_outstanding: a second approval for the same pick while the first waits, even after tapping the option again', async () => {
      const card = await picked('p_arjun');
      const first = await ask('p_arjun', card);
      expect(first.status).toBe('approved');
      expect(await ask('p_arjun', card)).toMatchObject({ status: 'denied', reason: 'approval_outstanding' });
      await tap('p_arjun', card); // a second tap on the same option is the same pick
      expect((await ask('p_arjun', card)).reason).toBe('approval_outstanding');
      // Once Go cancels the first, a new one may be granted.
      await ok('cancel_spend_approval', { approval_id: first.approval_id, reason: 'other' });
      expect((await ask('p_arjun', card)).status).toBe('approved');
    });

    it('already_booked: the pick was booked with its approval; a cancelled booking does not count', async () => {
      const card = await picked('p_arjun');
      const approved = await ask('p_arjun', card);
      const b = await ok('add_booking', { ...booking('p_arjun'), approval_id: approved.approval_id });
      const denied = await ask('p_arjun', card);
      expect(denied).toMatchObject({ status: 'denied', reason: 'already_booked' });
      expect(denied.detail).toMatch(/^this pick is already booked/);
      expect(check('SpendApprovalResult', denied)).toMatchObject({ ok: true });
      await ok('update_booking', { booking_id: b.booking_id, status: 'cancelled' });
      expect((await ask('p_arjun', card)).status).toBe('approved');
    });
  });
});

describe('add_booking with a personal approval', () => {
  it('is for that person alone, paid by them, with no vote: anyone else\'s booking, a group booking or a vote is refused (409)', async () => {
    const approved = await ask('p_priya', await picked('p_priya'));
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
  it('refuses claims Go\'s vault would refuse (spendFormProblem): both forms, neither, a personal approval paid by someone else', () => {
    const base = { iss: 'server', aud: 'go-vault', jti: 'ap_0123456789', trip_id: 't_goa', payer_person_id: 'p_priya', amount_minor: 1, currency: 'INR', merchant: 'm', purpose: 'p', iat: 1, exp: 600 } as const;
    const pick = (person_id: string) => ({ person_id, card_id: 'c_1', option_id: 'o1' });
    expect(spendFormProblem({ ...base, decision_id: 'd_1' })).toBeNull();
    expect(spendFormProblem({ ...base, personal: pick('p_priya') })).toBeNull();
    expect(spendFormProblem({ ...base, decision_id: 'd_1', personal: pick('p_priya') })).toBe('exactly one of decision_id and personal');
    expect(spendFormProblem(base)).toBe('exactly one of decision_id and personal');
    expect(spendFormProblem({ ...base, personal: pick('p_arjun') })).toBe("a personal approval's payer is the person who picked");
    expect(() => signSpendApproval({ ...base, personal: pick('p_arjun') }, h.ctx.spendPrivateKey)).toThrow(/payer is the person/);
  });
});
