import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check } from '../src/contract/index.js';
import { closeDueVotes } from '../src/jobs/votes.js';
import { appApi } from './helpers/app-api.js';
import { cancelFlow } from './helpers/cancel-flow.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';
import { seedTrip } from './helpers/seed.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
let f: ReturnType<typeof cancelFlow>;
beforeAll(async () => {
  h = await startHarness(); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
  f = cancelFlow(h, t);
});
afterAll(() => h.stop());

const priya = () => t.as('p_priya');
const vote = { client_id: 'c1', question: 'Where do we stay?', kind: 'choice', anonymous: false, options: [{ label: 'Villa Sol', price_minor: 1200000 }, { label: 'Beach hut' }] };

describe('a member opens a vote', () => {
  it('Go hears it by that person, others see it in their strip, it closes when all vote, and no push is sent', async () => {
    const r = await t.api(priya(), 'POST', '/app/v1/trips/t_goa/decisions', vote);
    expect([r.status, Object.keys(r.body).sort()]).toEqual([201, ['decision', 'message']]);
    const did = r.body.decision.decision_id as string;
    // The poll shows in the room at once: a system message carrying the vote card, with a change number of its own and no event (D8).
    expect(r.body.message).toMatchObject({ author: { kind: 'system' }, text: 'Where do we stay?', card: { kind: 'vote', decision_id: did, fallback_text: 'Where do we stay?' } });
    expect(r.body.decision).toMatchObject({ decision_id: did, status: 'open', voted: 0, of: 5, my_vote: null });
    await h.flush();
    const opened = t.events('decision.opened').find((e) => e.data.decision.decision_id === did)!;
    expect(r.body.message.seq).toBe(opened.seq + 1);
    expect(await rows(h.pool, 'select 1 from outbox where trip_id = $1 and seq = $2', ['t_goa', r.body.message.seq])).toEqual([]);
    expect(check('Event', opened)).toMatchObject({ ok: true });
    expect(opened.data).toMatchObject({ by: { kind: 'person', person_id: 'p_priya' }, decision: { opened_by_person_id: 'p_priya', of: 5, voted: 0, status: 'open', options: [{ label: 'Villa Sol', price_minor: 1200000, currency: 'INR' }, { label: 'Beach hut' }] } });
    expect(opened.data.decision.options[1]).not.toHaveProperty('currency');
    expect((await t.api(t.as('p_kabir'), 'GET', '/app/v1/trips/t_goa/needs-you')).body.items).toContainEqual({ item_id: `vote:${did}:p_kabir`, kind: 'vote', title: 'Where do we stay?', subtitle: '0 of 5 voted', cta_label: 'Vote', since: expect.any(String), target: { decision_id: did, message_id: r.body.message.message_id } });
    expect(h.live.events).toContainEqual({ tripId: 't_goa', event: { kind: 'trip', seq: opened.seq, kinds: ['decision'] } });
    for (const p of ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir']) await t.api(t.as(p), 'PUT', `/app/v1/trips/t_goa/decisions/${did}/vote`, { option_index: 0 });
    await h.flush();
    expect(t.events('decision.closed').find((e) => e.data.decision.decision_id === did)!.data).toMatchObject({ reason: 'everyone_voted', decision: { result_index: 0 } });
    expect(h.push.sent).toEqual([]);
  });

  it('refuses an unsigned caller, someone outside the trip, an unknown field and a closing time in the past', async () => {
    const post = (who: any, body: unknown) => t.api(who, 'POST', '/app/v1/trips/t_goa/decisions', body);
    const refused = async (who: any, body: unknown) => { const r = await post(who, body); return [r.status, r.body.error.code]; };
    expect(await refused(null, vote)).toEqual([401, 'unauthorized']);
    expect(await refused(t.as('p_stranger'), vote)).toEqual([403, 'forbidden']);
    expect(await refused(priya(), { ...vote, client_id: 'c2', extra: 1 })).toEqual([422, 'invalid']);
    expect(await refused(priya(), { ...vote, client_id: 'c3', closes_at: new Date(Date.now() - 60_000).toISOString() })).toEqual([422, 'invalid']);
  });

  it('the same client id twice, in sequence and three at once, makes one vote with one event', async () => {
    const press = (question: string) => t.api(priya(), 'POST', '/app/v1/trips/t_goa/decisions', { ...vote, client_id: `press-${question}`, question });
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
    const post = (patch: Record<string, unknown>) => t.api(priya(), 'POST', '/app/v1/trips/t_goa/decisions', { ...vote, client_id: `odd-${Math.random()}`, ...patch });
    const refused = async (patch: Record<string, unknown>) => { const r = await post(patch); return [r.status, r.body.error.code]; };
    expect(await refused({ question: 'a\u0000b' })).toEqual([422, 'invalid']);
    expect(await refused({ options: [{ label: '\ud800' }, { label: 'b' }] })).toEqual([422, 'invalid']);
    expect(await refused({ closes_at: '2016-12-31T23:59:60Z' })).toEqual([422, 'invalid']); // a leap second JavaScript cannot read
    const far = await post({ closes_at: '2099-01-01T10:00:00+20:00' }); // an offset Postgres refuses as written
    const [stored] = await rows(h.pool, 'select closes_at from decisions where decision_id = $1', [far.body.decision.decision_id]);
    expect([far.status, stored.closes_at.toISOString()]).toEqual([201, '2098-12-31T14:00:00.000Z']);
  });

  it('a closing time that falls outside years 1 to 9999 once its offset is applied is refused with 422; the last instant of 9999 is accepted', async () => {
    const post = (closes_at: string) => t.api(priya(), 'POST', '/app/v1/trips/t_goa/decisions', { ...vote, client_id: `year-${closes_at}`, closes_at });
    const over = await post('9999-12-31T23:30:00-01:00'); // year 10000 in UTC
    expect([over.status, over.body.error.code]).toEqual([422, 'invalid']);
    expect((await post('9999-12-31T23:30:00Z')).status).toBe(201);
  });
});

describe('cancelling a booking by group vote', () => {
  const refused = (r: { status: number; body: any }) => [r.status, r.body.error.code];
  const closedEvent = (did: string) => t.events('decision.closed').find((e) => e.data.decision.decision_id === did)!;

  it('passes with 3 of 5 for "Cancel": the booking is cancelled in the closing transaction, as the next change, and Go hears it all in order', async () => {
    const bid = await f.addBooking('t_goa', { title: 'Villa Sol' });
    const p = await f.propose(bid);
    expect(p.status).toBe(201);
    const did = p.body.decision_id;
    for (const who of ['p_rahul', 'p_priya', 'p_arjun']) await f.castVote(did, who, 0);
    await f.closeEarly(did);
    await h.flush();
    const opened = t.events('decision.opened').find((e) => e.data.decision.decision_id === did)!;
    const closed = closedEvent(did);
    const booking = f.cancelledEvents(bid)[0]!;
    const line = t.events('record.changed').find((e) => e.data.line.decision_id === did)!;
    expect(opened.data).toMatchObject({ by: { kind: 'person', person_id: 'p_priya' }, decision: { kind: 'yesno', anonymous: false, of: 5, question: 'Cancel this booking? Villa Sol', options: [{ label: 'Cancel: Villa Sol' }, { label: 'Keep: Villa Sol' }] } });
    expect(Math.abs(Date.parse(opened.data.decision.closes_at) - Date.parse(opened.data.decision.opened_at) - 24 * 3_600_000)).toBeLessThan(60_000);
    expect([opened, closed, booking, line].map((e) => check('Event', e).ok)).toEqual([true, true, true, true]);
    expect(closed.data).toMatchObject({ reason: 'closed_by_person', decision: { status: 'closed', result_index: 0, tally: [3, 0] } });
    expect([booking.seq, line.seq]).toEqual([closed.seq + 1, closed.seq + 2]); // decision.closed, booking.changed, then the decided line
    expect(booking.data).toMatchObject({ change: 'cancelled', by: { kind: 'system' }, booking: { booking_id: bid, status: 'cancelled' } });
    expect(line.data.line).toMatchObject({ kind: 'decided', text: 'Cancel: Villa Sol' });
    expect(await f.bookingStatus(bid)).toBe('cancelled');
    const everything = JSON.stringify([(await rows(h.pool, 'select body from outbox')).map((r) => r.body), (await h.go.call('read_trip', { trip_id: 't_goa' })).result]); // Go's events and the trip as Go reads it (the app's own read carries the marker: see tests/follow-ups.test.ts)
    expect([everything.includes('cancels_booking'), h.push.sent.length]).toEqual([false, 0]); // the link is in no event; no push
  });

  it('2 of 5 closed early leaves the booking standing and a new proposal succeeds; one "Cancel" vote closed early does not cancel', async () => {
    const a = await f.addBooking();
    const pa = await f.propose(a);
    for (const who of ['p_rahul', 'p_priya']) await f.castVote(pa.body.decision_id, who, 0);
    await f.closeEarly(pa.body.decision_id);
    const again = await f.propose(a);
    await h.flush();
    expect([await f.bookingStatus(a), f.cancelledEvents(a).length, again.status]).toEqual(['confirmed', 0, 201]);
    const b = await f.addBooking();
    const pb = await f.propose(b);
    await f.castVote(pb.body.decision_id, 'p_rahul', 0);
    await f.closeEarly(pb.body.decision_id);
    await h.flush();
    expect([await f.bookingStatus(b), f.cancelledEvents(b).length]).toEqual(['confirmed', 0]);
  });

  it('a 2-2 tie, time running out, and calling off each leave the booking standing with no booking event', async () => {
    const outcome = async (bid: string, did: string) => {
      await h.flush();
      const [d] = await rows(h.pool, 'select status, result_index from decisions where decision_id = $1', [did]);
      return [await f.bookingStatus(bid), f.cancelledEvents(bid).length, d.status, d.result_index];
    };
    const tie = await f.addBooking();
    const pt = (await f.propose(tie)).body.decision_id;
    for (const [who, option] of [['p_rahul', 0], ['p_priya', 0], ['p_arjun', 1], ['p_meher', 1]] as const) await f.castVote(pt, who, option);
    await f.closeEarly(pt);
    expect(await outcome(tie, pt)).toEqual(['confirmed', 0, 'closed', null]);
    const late = await f.addBooking();
    const pl = (await f.propose(late)).body.decision_id;
    await f.castVote(pl, 'p_rahul', 0);
    await h.pool.query(`update decisions set closes_at = now() - interval '1 minute' where decision_id = $1`, [pl]);
    await closeDueVotes(h.ctx);
    expect(await outcome(late, pl)).toEqual(['confirmed', 0, 'closed', null]);
    const off = await f.addBooking();
    const po = (await f.propose(off)).body.decision_id;
    await t.api(t.as('p_rahul'), 'POST', `/app/v1/trips/t_goa/decisions/${po}/cancel`);
    expect(await outcome(off, po)).toEqual(['confirmed', 0, 'cancelled', null]);
  });

  it('a 2-1 lead for "Cancel" among 5 closes with no result, whether a person or Go closes it; "Keep" leading gives "Keep"', async () => {
    const lead = async (close: (did: string) => Promise<unknown>) => {
      const bid = await f.addBooking();
      const did = (await f.propose(bid)).body.decision_id;
      for (const [who, option] of [['p_rahul', 0], ['p_priya', 0], ['p_arjun', 1]] as const) await f.castVote(did, who, option);
      await close(did);
      await h.flush();
      return [await f.bookingStatus(bid), closedEvent(did).data.decision.result_index];
    };
    expect(await lead((did) => f.closeEarly(did))).toEqual(['confirmed', undefined]);
    expect(await lead((did) => h.go.call('close_vote', { request_id: `rq_cv_${f.next()}`, trip_id: 't_goa', decision_id: did }))).toEqual(['confirmed', undefined]);
    const bid = await f.addBooking('t_goa', { title: 'Casa Azul' });
    const did = (await f.propose(bid)).body.decision_id;
    for (const [who, option] of [['p_rahul', 0], ['p_priya', 1], ['p_arjun', 1]] as const) await f.castVote(did, who, option);
    await f.closeEarly(did);
    await h.flush();
    expect([await f.bookingStatus(bid), closedEvent(did).data.decision.result_index, t.events('record.changed').find((e) => e.data.line.decision_id === did)!.data.line.text]).toEqual(['confirmed', 1, 'Keep: Casa Azul']);
  });

  it('two proposals at the same moment give one 201 and one 409 naming the open vote; a repeated Idempotency-Key gets the first answer; two at once with the same key still open one vote', async () => {
    const bid = await f.addBooking();
    const two = await Promise.all([f.propose(bid, 't_goa', 'p_priya', 'race-a'), f.propose(bid, 't_goa', 'p_arjun', 'race-b')]);
    const [won, lost] = two[0].status === 201 ? two : [two[1]!, two[0]!];
    expect([won.status, lost.status, lost.body.error.code, lost.body.error.message.includes(won.body.decision_id)]).toEqual([201, 409, 'conflict', true]);
    const other = await f.addBooking();
    const first = await f.propose(other, 't_goa', 'p_priya', 'same-press');
    const second = await f.propose(other, 't_goa', 'p_priya', 'same-press');
    expect([second.status, second.body, second.headers['idempotent-replayed']]).toEqual([201, first.body, 'true']);
    // The header's store is written after the answer, so two copies racing past the lookup both run: the booking lock makes the second a 409, never a second vote.
    const third = await f.addBooking();
    const both = await Promise.all([f.propose(third, 't_goa', 'p_priya', 'same-tap'), f.propose(third, 't_goa', 'p_priya', 'same-tap')]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await rows(h.pool, 'select count(*)::int as n from decisions where cancels_booking_id = $1', [third])).toEqual([{ n: 1 }]);
  });

  it('refuses a cancelled booking and one paid through Go\'s vault with 409, and a 120-character title (with characters outside the basic plane) gives a contract-valid vote', async () => {
    const gone = await f.addBooking();
    await h.pool.query(`update bookings set status = 'cancelled' where booking_id = $1`, [gone]);
    expect(refused(await f.propose(gone))).toEqual([409, 'conflict']);
    const vault = await f.addBooking();
    await h.pool.query(`update bookings set approval_id = 'ap_vault' where booking_id = $1`, [vault]);
    expect(refused(await f.propose(vault))).toEqual([409, 'conflict']);
    const title = 'a' + '🌴'.repeat(119); // 120 characters; cutting it by UTF-16 units at 112 would end on half a pair
    const long = await f.addBooking('t_goa', { title });
    const p = await f.propose(long);
    await h.flush();
    const opened = t.events('decision.opened').find((e) => e.data.decision.decision_id === p.body.decision_id)!;
    expect([p.status, check('Event', opened).ok, opened.data.decision.options.map((o: any) => Array.from(o.label).length)]).toEqual([201, true, [120, 118]]); // "Cancel: " or "Keep: " plus 112
  });

  it('refuses an unsigned caller, someone outside the trip, an unknown field, and another trip\'s booking', async () => {
    await seedTrip(h.pool, 't_other', [{ id: 'p_orgx', name: 'Orgx', role: 'organizer' }]);
    await h.pool.query(`insert into bookings (booking_id, trip_id, kind, title, vendor, ref, amount_minor, currency, payer_person_id) values ('b_elsewhere', 't_other', 'stay', 'Villa', 'V', 'R', 1, 'INR', 'p_orgx')`);
    const bid = await f.addBooking();
    const post = (who: any, id: string, body: unknown) => t.api(who, 'POST', `/app/v1/trips/t_goa/bookings/${id}/cancel-vote`, body);
    expect(refused(await post(null, bid, {}))).toEqual([401, 'unauthorized']);
    expect(refused(await post(t.as('p_stranger'), bid, {}))).toEqual([403, 'forbidden']);
    expect(refused(await post(t.as('p_priya'), bid, { extra: 1 }))).toEqual([422, 'invalid']);
    expect(refused(await post(t.as('p_priya'), bid, { client_id: 'x' }))).toEqual([422, 'invalid']); // the press key is gone: the Idempotency-Key header is the one mechanism
    expect(refused(await post(t.as('p_priya'), 'b_elsewhere', {}))).toEqual([404, 'not_found']);
  });

  it('when Go cancels the booking while the vote is open and the vote then passes, there is no second booking event', async () => {
    const bid = await f.addBooking();
    const did = (await f.propose(bid)).body.decision_id;
    await h.go.call('update_booking', { request_id: `rq_gc_${f.next()}`, trip_id: 't_goa', booking_id: bid, status: 'cancelled' });
    for (const who of ['p_rahul', 'p_priya', 'p_arjun']) await f.castVote(did, who, 0);
    await f.closeEarly(did);
    await h.flush();
    expect([f.cancelledEvents(bid).map((e) => e.data.by.kind), closedEvent(did).data.decision.result_index]).toEqual([['go'], 0]);
  });

  it('the proposer leaving mid-vote does not stop it, and a "Cancel" voter who then left still counts in the tally and the head count', async () => {
    await seedTrip(h.pool, 't_leave1');
    await seedTrip(h.pool, 't_leave2');
    const a = await f.addBooking('t_leave1');
    const pa = (await f.propose(a, 't_leave1', 'p_priya')).body.decision_id;
    await t.api(t.as('p_priya'), 'POST', '/app/v1/trips/t_leave1/leave');
    for (const who of ['p_rahul', 'p_arjun', 'p_meher']) await f.castVote(pa, who, 0, 't_leave1');
    await f.closeEarly(pa, 't_leave1');
    const b = await f.addBooking('t_leave2');
    const pb = (await f.propose(b, 't_leave2', 'p_priya')).body.decision_id;
    await f.castVote(pb, 'p_kabir', 0, 't_leave2');
    await t.api(t.as('p_kabir'), 'POST', '/app/v1/trips/t_leave2/leave');
    for (const who of ['p_rahul', 'p_arjun']) await f.castVote(pb, who, 0, 't_leave2');
    await f.closeEarly(pb, 't_leave2');
    await h.flush();
    expect([await f.bookingStatus(a), closedEvent(pa).data.decision.of, await f.bookingStatus(b), closedEvent(pb).data.decision.tally, closedEvent(pb).data.decision.of]).toEqual(['cancelled', 4, 'cancelled', [3, 0], 5]);
  });
});

