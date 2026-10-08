import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check } from '../src/contract/index.js';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';
import { seedTrip } from './helpers/seed.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness(); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
  await seedTrip(h.pool, 't_other', [{ id: 'p_orgx', name: 'Orgx', role: 'organizer' }]);
});
afterAll(() => h.stop());

const EVERYONE = ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir'];
const arjun = () => t.as('p_arjun');
let n = 0;
const booking = (over: Record<string, unknown> = {}) => ({
  client_id: `bk-${++n}`, kind: 'stay', title: `Villa ${n}`, vendor: 'ixigo', ref: 'IXG-1', amount_minor: 5420000, payer_person_id: 'p_rahul', for_person_ids: EVERYONE, ...over,
});
const add = (body: unknown, who: any = arjun()) => t.api(who, 'POST', '/app/v1/trips/t_goa/bookings', body);
const patch = (bid: string, body: unknown, who: any = arjun()) => t.api(who, 'PATCH', `/app/v1/trips/t_goa/bookings/${bid}`, body);
/** [status, error code] of a refused call. */
const refusal = (r: { status: number; body: any }) => [r.status, r.body.error.code];
const vote = (over: Record<string, unknown> = {}) => ({
  client_id: `v-${++n}`, question: `Question ${n}?`, kind: 'choice', anonymous: false, options: [{ label: 'Villa Sol', price_minor: 5420000 }, { label: 'Casa Azul', price_minor: 6180000 }], ...over,
});
/** Opens a vote as a member, and has all five vote for the first option so it closes with a result. */
const closedVote = async (over: Record<string, unknown> = {}) => {
  const opened = await t.api(t.as('p_priya'), 'POST', '/app/v1/trips/t_goa/decisions', vote(over));
  for (const p of EVERYONE) await t.api(t.as(p), 'PUT', `/app/v1/trips/t_goa/decisions/${opened.body.decision.decision_id}/vote`, { option_index: 0 });
  return opened.body.decision.decision_id as string;
};
const journey = {
  mode: 'flight', origin: { name: 'Delhi', code: 'DEL' }, destination: { name: 'Goa', code: 'GOI' },
  depart_at: '2026-11-06T08:00:00Z', arrive_at: '2026-11-06T10:30:00Z', carrier_name: 'IndiGo', number: '6E 123',
};

describe('adding a booking', () => {
  it('stores it with the person, confirmed, no approval and no expense; Go hears the booking and then the booked line; a repeat or three at once make one booking', async () => {
    const body = booking({ kind: 'flight', title: 'Flight DEL to GOI', journey, starts_at: '2026-11-06T08:00:00Z', ends_at: '2026-11-06T10:30:00Z', refundable_until: '2026-11-01T00:00:00Z' });
    const r = await add(body);
    expect([r.status, Object.keys(r.body).sort()]).toEqual([201, ['booking_id', 'seq']]);
    await h.flush();
    const added = t.events('booking.changed').find((e) => e.data.booking.booking_id === r.body.booking_id)!;
    const line = t.events('record.changed').find((e) => e.data.line.booking_id === r.body.booking_id)!;
    expect([check('Event', added).ok, check('Event', line).ok]).toEqual([true, true]);
    expect(added.data).toMatchObject({ change: 'added', by: { kind: 'person', person_id: 'p_arjun' }, booking: { status: 'confirmed', currency: 'INR', added_by_person_id: 'p_arjun', journey } });
    expect(added.data.booking).not.toHaveProperty('approval_id');
    expect([line.seq, line.data.line.kind, line.data.line.text]).toEqual([added.seq + 1, 'booked', 'Flight DEL to GOI']);
    expect(await rows(h.pool, 'select count(*)::int as n from expenses')).toEqual([{ n: 0 }]);
    expect((await add(body)).body).toEqual(r.body);
    const same = booking({ title: 'Triple tap' });
    const three = await Promise.all([add(same), add(same), add(same)]);
    expect(three.map((x) => [x.status, x.body])).toEqual(Array(3).fill([201, three[0]!.body]));
    await h.flush();
    const made = await rows(h.pool, `select booking_id from bookings where title = 'Triple tap'`);
    expect([made.length, t.events('booking.changed').filter((e) => e.data.booking.title === 'Triple tap').length]).toEqual([1, 1]); // one booking, one event
  });

  it('refuses an unsigned caller, someone outside the trip, an unknown field, and a person outside the trip in for_person_ids', async () => {
    expect(refusal(await add(booking(), null))).toEqual([401, 'unauthorized']);
    expect(refusal(await add(booking(), t.as('p_stranger')))).toEqual([403, 'forbidden']);
    expect(refusal(await add({ ...booking(), extra: 1 }))).toEqual([422, 'invalid']);
    expect(refusal(await add(booking({ for_person_ids: ['p_rahul', 'p_stranger'] })))).toEqual([422, 'invalid']);
  });

  it('refuses a decision_id that is an open vote, a cancelled vote, a cancellation vote, or another trip\'s vote', async () => {
    const open = (await t.api(t.as('p_priya'), 'POST', '/app/v1/trips/t_goa/decisions', vote())).body.decision.decision_id;
    const cancelled = (await t.api(t.as('p_priya'), 'POST', '/app/v1/trips/t_goa/decisions', vote())).body.decision.decision_id;
    await t.api(t.as('p_priya'), 'POST', `/app/v1/trips/t_goa/decisions/${cancelled}/cancel`);
    // No code can open a cancellation vote yet, so this one is written straight into the table, closed, with the link set.
    await h.pool.query(
      `insert into decisions (decision_id, trip_id, question, kind, options, of_count, status, cancels_booking_id, closed_at)
       values ('d_cancelvote', 't_goa', 'Cancel this booking?', 'yesno', '[{"label":"Cancel: x"},{"label":"Keep: x"}]', 5, 'closed', 'b_some', now())`,
    );
    await h.pool.query(`insert into decisions (decision_id, trip_id, question, kind, options, of_count, status) values ('d_elsewhere', 't_other', 'Elsewhere?', 'choice', '[{"label":"a"},{"label":"b"}]', 1, 'closed')`);
    for (const decision_id of [open, cancelled, 'd_cancelvote', 'd_elsewhere']) expect(refusal(await add(booking({ decision_id })))).toEqual([422, 'invalid']);
  });

  it('accepts a closed vote and Go\'s spend approval for it still goes through; refuses ends before starts and an image that is not a URL', async () => {
    const decision_id = await closedVote();
    await h.go.call('set_mandate', { request_id: 'rq_m1', trip_id: 't_goa', decision_id, choice_index: 0, cap_minor: 5600000, currency: 'INR', refundable_only: false, payer_person_id: 'p_rahul' });
    await t.api(t.as('p_rahul'), 'POST', `/app/v1/trips/t_goa/decisions/${decision_id}/mandate/confirm`);
    const r = await add(booking({ decision_id }));
    const approval = await h.go.call('request_spend_approval', { request_id: 'rq_s1', trip_id: 't_goa', decision_id, amount_minor: 5420000, currency: 'INR', merchant: 'ixigo: Villa Sol', purpose: 'Villa Sol' });
    expect([r.status, approval.result.status]).toEqual([201, 'approved']);
    expect(await rows(h.pool, 'select kind, booking_id from record_lines where decision_id = $1', [decision_id])).toEqual([{ kind: 'booked', booking_id: r.body.booking_id }]); // the decided line became the booked line
    expect(refusal(await add(booking({ starts_at: '2026-11-09T10:00:00Z', ends_at: '2026-11-06T10:00:00Z' })))).toEqual([422, 'invalid']);
    expect(refusal(await add(booking({ image_url: 'not a url' })))).toEqual([422, 'invalid']);
  });
});

describe('updating a booking', () => {
  it('records the update by the person, null clears the three dates, and two identical updates at once give one event', async () => {
    const created = await add(booking({ ref: 'OLD', starts_at: '2026-11-06T08:00:00Z', ends_at: '2026-11-09T08:00:00Z', refundable_until: '2026-11-01T00:00:00Z' }));
    const bid = created.body.booking_id;
    const cleared = await patch(bid, { ref: 'NEW-1', refundable_until: null, starts_at: null, ends_at: null });
    await h.flush();
    const updated = t.events('booking.changed').find((e) => e.seq === cleared.body.seq)!;
    expect(updated.data).toMatchObject({ change: 'updated', by: { kind: 'person', person_id: 'p_arjun' }, booking: { booking_id: bid, ref: 'NEW-1' } });
    expect(updated.data.booking).not.toHaveProperty('starts_at');
    expect(updated.data.booking).not.toHaveProperty('ends_at');
    expect(updated.data.booking).not.toHaveProperty('refundable_until');
    const two = await Promise.all([patch(bid, { ref: 'NEW-2' }), patch(bid, { ref: 'NEW-2' })]);
    expect(two.map((x) => x.body.seq === null).sort()).toEqual([false, true]); // one change number, one "nothing changed"
    await h.flush();
    expect(t.events('booking.changed').filter((e) => e.data.change === 'updated' && e.data.booking.booking_id === bid && e.data.booking.ref === 'NEW-2')).toHaveLength(1);
    // A time the caller did not send keeps exactly what was stored, down to the microsecond (Go may have stored one).
    await h.pool.query(`update bookings set starts_at = '2026-11-06 08:00:00.123456+00' where booking_id = $1`, [bid]);
    await patch(bid, { ref: 'NEW-3' });
    expect((await rows(h.pool, `select to_char(starts_at at time zone 'UTC', 'HH24:MI:SS.US') as s from bookings where booking_id = $1`, [bid]))[0].s).toBe('08:00:00.123456');
  });

  it('refuses a merged result that ends before it starts, an empty update, and a cancelled booking', async () => {
    const bid = (await add(booking({ starts_at: '2026-11-06T08:00:00Z' }))).body.booking_id;
    expect(refusal(await patch(bid, { ends_at: '2026-11-05T08:00:00Z' }))).toEqual([422, 'invalid']);
    expect(refusal(await patch(bid, {}))).toEqual([422, 'invalid']); // nothing to change
    await h.pool.query(`update bookings set status = 'cancelled' where booking_id = $1`, [bid]);
    expect(refusal(await patch(bid, { ref: 'LATE' }))).toEqual([409, 'conflict']);
  });

  it('refuses an unsigned caller, someone outside the trip, an unknown field, and another trip\'s booking', async () => {
    const bid = (await add(booking())).body.booking_id;
    await h.pool.query(
      `insert into bookings (booking_id, trip_id, kind, title, vendor, ref, amount_minor, currency, payer_person_id) values ('b_elsewhere', 't_other', 'stay', 'Villa', 'V', 'R', 1, 'INR', 'p_orgx')`,
    );
    expect(refusal(await patch(bid, { ref: 'X' }, null))).toEqual([401, 'unauthorized']);
    expect(refusal(await patch(bid, { ref: 'X' }, t.as('p_stranger')))).toEqual([403, 'forbidden']);
    expect(refusal(await patch(bid, { ref: 'X', extra: 1 }))).toEqual([422, 'invalid']);
    expect(refusal(await patch('b_elsewhere', { ref: 'X' }))).toEqual([404, 'not_found']);
  });
});
