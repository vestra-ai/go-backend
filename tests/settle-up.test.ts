import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';
import { seedTrip } from './helpers/seed.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness(); // t_goa: p_rahul (organizer, UPI rahul@upi), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
  for (const trip of ['t_two', 't_usd', 't_n', 't_other']) await seedTrip(h.pool, trip, trip === 't_other' ? [{ id: 'p_orgx', name: 'Orgx', role: 'organizer' }] : undefined);
  await h.pool.query(`update trips set currency = 'USD' where trip_id = 't_usd'`);
  await seedTrip(h.pool, 't_gone'); // Arjun owes Kabir, then Arjun leaves
  await h.pool.query(`update people set upi_id = 'meher@upi' where person_id = 'p_meher'`);
  const spend = (trip: string, paid_by_person_id: string, amount_minor: number, split_person_ids: string[]) =>
    t.api(t.as(paid_by_person_id), 'POST', `/app/v1/trips/${trip}/expenses`, { paid_by_person_id, amount_minor, note: 'Dinner', category: 'food', split_person_ids });
  await spend('t_goa', 'p_rahul', 100000, ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir']); // each of the four owes Rahul 20000
  await spend('t_two', 'p_meher', 30000, ['p_meher', 'p_kabir']); // Kabir owes Meher 15000; Priya owes nobody
  await spend('t_usd', 'p_rahul', 2500, ['p_rahul', 'p_priya']); // Priya owes Rahul $12.50
  await spend('t_n', 'p_kabir', 3000, ['p_kabir', 'p_arjun', 'p_meher']); // Arjun and Meher owe Kabir 1000 each
  await spend('t_gone', 'p_kabir', 2000, ['p_kabir', 'p_arjun']);
  await t.api(t.as('p_arjun'), 'POST', '/app/v1/trips/t_gone/leave'); // the debt stays in the trip's transfers
});
afterAll(() => h.stop());

const refusal = (r: { status: number; body: any }) => [r.status, r.body?.error?.code];
const reminders = () => h.push.sent.filter((s) => s.n.body.includes('reminded you'));

describe('settle-up', () => {
  it('equals the trip read\'s transfers at the same change number, shows the UPI id only to someone who owes that payee, and hides it once the payee has left', async () => {
    const priya = await t.api(t.as('p_priya'), 'GET', '/app/v1/trips/t_goa/settle-up');
    const snap = (await h.go.call('read_trip', { trip_id: 't_goa' })).result;
    const mine = snap.money.transfers.filter((x: any) => x.from_person_id === 'p_priya').map((x: any) => ({ to_person_id: x.to_person_id, amount_minor: x.amount_minor, currency: x.currency }));
    expect([priya.headers['cache-control'], priya.body.seq === snap.seq, priya.body.you_pay.map(({ upi_id, ...rest }: any) => rest), priya.body.you_pay[0].upi_id, priya.body.owed_to_you]).toEqual(['no-store', true, mine, 'rahul@upi', []]);
    const rahul = await t.api(t.as('p_rahul'), 'GET', '/app/v1/trips/t_goa/settle-up'); // the payee: owed money, owes nobody, and is not shown his own id here
    const priyaTwo = await t.api(t.as('p_priya'), 'GET', '/app/v1/trips/t_two/settle-up'); // owes nobody in this trip, where Meher (UPI meher@upi) is a payee
    const owedToRahul = snap.money.transfers.filter((x: any) => x.to_person_id === 'p_rahul').map((x: any) => ({ from_person_id: x.from_person_id, amount_minor: x.amount_minor, currency: x.currency }));
    expect([rahul.body.you_pay, rahul.body.owed_to_you.map(({ nudge_allowed_at, ...rest }: any) => [rest, nudge_allowed_at]), JSON.stringify(rahul.body).includes('rahul@upi'), JSON.stringify(priyaTwo.body).includes('meher@upi')]).toEqual([[], owedToRahul.map((x: any) => [x, null]), false, false]);
    await t.api(t.as('p_rahul'), 'POST', '/app/v1/trips/t_goa/leave');
    expect((await t.api(t.as('p_priya'), 'GET', '/app/v1/trips/t_goa/settle-up')).body.you_pay.map((x: any) => [x.to_person_id, x.upi_id])).toEqual([['p_rahul', null]]); // the debt stays; the id does not
  });

  it('refuses an unsigned caller and a member of another trip on both routes', async () => {
    expect(refusal(await t.api(null, 'GET', '/app/v1/trips/t_two/settle-up'))).toEqual([401, 'unauthorized']);
    expect(refusal(await t.api(t.as('p_orgx'), 'GET', '/app/v1/trips/t_two/settle-up'))).toEqual([403, 'forbidden']); // a member of t_other only
    expect(refusal(await t.api(null, 'POST', '/app/v1/trips/t_two/transfers/nudge', { from_person_id: 'p_kabir' }))).toEqual([401, 'unauthorized']);
    expect(refusal(await t.api(t.as('p_orgx'), 'POST', '/app/v1/trips/t_two/transfers/nudge', { from_person_id: 'p_kabir' }))).toEqual([403, 'forbidden']);
  });
});

describe('nudges', () => {
  it('send one notification to the right person with the amount in the trip\'s currency, write no event and move no change number; refuse someone who does not owe and an unknown field', async () => {
    const seqBefore = (await rows(h.pool, `select seq from trips where trip_id = 't_usd'`))[0].seq;
    const outboxBefore = (await rows(h.pool, `select count(*)::int as n from outbox where trip_id = 't_usd'`))[0].n;
    const ok = await t.api(t.as('p_rahul'), 'POST', '/app/v1/trips/t_usd/transfers/nudge', { from_person_id: 'p_priya' });
    const sent = reminders().filter((s) => s.n.data.trip_id === 't_usd');
    expect([ok.status, ok.body.reminded, sent.length, sent[0]!.to, sent[0]!.n.body, sent[0]!.n.data]).toEqual([200, true, 1, ['p_priya'], 'Rahul reminded you: you owe $12.50', { trip_id: 't_usd' }]);
    const listed = (await t.api(t.as('p_rahul'), 'GET', '/app/v1/trips/t_usd/settle-up')).body.owed_to_you[0];
    expect([Math.abs(Date.parse(ok.body.nudge_allowed_at) - Date.now() - 24 * 3_600_000) < 60_000, listed.nudge_allowed_at === ok.body.nudge_allowed_at]).toEqual([true, true]); // 24 hours on, and the list says the same
    expect([(await rows(h.pool, `select seq from trips where trip_id = 't_usd'`))[0].seq, (await rows(h.pool, `select count(*)::int as n from outbox where trip_id = 't_usd'`))[0].n]).toEqual([seqBefore, outboxBefore]);
    expect(refusal(await t.api(t.as('p_rahul'), 'POST', '/app/v1/trips/t_usd/transfers/nudge', { from_person_id: 'p_kabir' }))).toEqual([409, 'conflict']); // Kabir owes nothing here
    expect(refusal(await t.api(t.as('p_rahul'), 'POST', '/app/v1/trips/t_usd/transfers/nudge', { from_person_id: 'p_priya', extra: 1 }))).toEqual([422, 'invalid']);
  });

  it('allow one reminder per pair per 24 hours: a second is 429 with Retry-After and sends nothing, two at once send one, and after the window it works again', async () => {
    const kabir = t.as('p_kabir');
    const nudge = (to: string) => t.api(kabir, 'POST', '/app/v1/trips/t_n/transfers/nudge', { from_person_id: to });
    const first = await nudge('p_arjun');
    const second = await nudge('p_arjun');
    expect([first.status, second.status, second.body.error.code, Number(second.headers['retry-after']) > 0 && Number(second.headers['retry-after']) <= 86400, reminders().filter((s) => s.n.data.trip_id === 't_n').length]).toEqual([200, 429, 'rate_limited', true, 1]);
    const two = await Promise.all([nudge('p_meher'), nudge('p_meher')]);
    expect([two.map((r) => r.status).sort(), reminders().filter((s) => s.n.data.trip_id === 't_n').length]).toEqual([[200, 429], 2]); // one more send, not two
    await h.pool.query(`update nudges set last_sent_at = now() - interval '25 hours' where trip_id = 't_n' and to_person_id = 'p_arjun'`);
    expect([(await nudge('p_arjun')).status, reminders().filter((s) => s.n.data.trip_id === 't_n').length]).toEqual([200, 3]);
  });

  it('refuse reminding someone who has left, and a debtor reminding the person they owe', async () => {
    expect(refusal(await t.api(t.as('p_kabir'), 'POST', '/app/v1/trips/t_gone/transfers/nudge', { from_person_id: 'p_arjun' }))).toEqual([409, 'conflict']); // Arjun still owes, but is no longer in the trip
    expect(refusal(await t.api(t.as('p_priya'), 'POST', '/app/v1/trips/t_usd/transfers/nudge', { from_person_id: 'p_rahul' }))).toEqual([409, 'conflict']); // Priya owes Rahul, not the other way round
  });
});
