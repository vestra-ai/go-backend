// §4.9 the settle_up card's two buttons: the UPI pay link and the nudge (phase 3; the old GET …/settle-up is gone: its data is MoneyView.me).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upiPayUri } from '../src/domain/transfers.js';
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
  await spend('t_goa', 'p_rahul', 100000, ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir']); // each of the four owes Rahul 20000 (pending approval, which already counts)
  await spend('t_two', 'p_meher', 30000, ['p_meher', 'p_kabir']); // Kabir owes Meher 15000; Priya owes nobody
  await spend('t_usd', 'p_rahul', 2500, ['p_rahul', 'p_priya']); // Priya owes Rahul $12.50
  await spend('t_n', 'p_kabir', 3000, ['p_kabir', 'p_arjun', 'p_meher']); // Arjun and Meher owe Kabir (no UPI id) 1000 each
  await spend('t_gone', 'p_kabir', 2000, ['p_kabir', 'p_arjun']);
  await t.api(t.as('p_arjun'), 'POST', '/app/v1/trips/t_gone/leave'); // the debt stays in the trip's transfers
});
afterAll(() => h.stop());

const refusal = (r: { status: number; body: any }) => [r.status, r.body?.error?.code, r.body?.error?.field];
const reminders = () => h.push.sent.filter((s) => s.n.body.includes('reminded you'));

describe('pay by UPI', () => {
  it('builds a upi://pay link to the payee with the amount in the currency\'s units, good for ten minutes, and writes nothing', async () => {
    const seqBefore = (await rows(h.pool, `select seq from trips where trip_id = 't_goa'`))[0].seq;
    const r = await t.api(t.as('p_priya'), 'POST', '/app/v1/trips/t_goa/transfers/pay-link', { to_person_id: 'p_rahul', amount_minor: 20000 });
    expect([r.status, r.body.upi_uri]).toEqual([200, 'upi://pay?pa=rahul%40upi&pn=Rahul&am=200.00&cu=INR&tn=Goa%20%F0%9F%8C%B4%20%C2%B7%20settle%20up']);
    expect(Math.abs(Date.parse(r.body.expires_at) - Date.now() - 10 * 60_000)).toBeLessThan(60_000);
    const usd = await t.api(t.as('p_priya'), 'POST', '/app/v1/trips/t_usd/transfers/pay-link', { to_person_id: 'p_rahul', amount_minor: 1250 });
    expect(usd.body.upi_uri).toContain('am=12.50&cu=USD');
    expect([(await rows(h.pool, `select seq from trips where trip_id = 't_goa'`))[0].seq, h.live.events.filter((e) => e.tripId === 't_goa').length]).toEqual([seqBefore, 1]); // no change number, no notice beyond the expense's
    expect(upiPayUri({ pa: 'a@b', pn: 'A', amount_minor: 5000, currency: 'JPY', tn: 'x'.repeat(60) })).toBe(`upi://pay?pa=a%40b&pn=A&am=5000&cu=JPY&tn=${'x'.repeat(50)}`); // yen have no fraction; the note is cut to UPI's 50
  });

  it('answers 409 when the payee has no UPI id or is not in the trip, and 422 when I do not owe that person', async () => {
    expect(refusal(await t.api(t.as('p_arjun'), 'POST', '/app/v1/trips/t_n/transfers/pay-link', { to_person_id: 'p_kabir', amount_minor: 1000 }))).toEqual([409, 'conflict', null]); // Kabir has no UPI id
    expect(refusal(await t.api(t.as('p_kabir'), 'POST', '/app/v1/trips/t_gone/transfers/pay-link', { to_person_id: 'p_arjun', amount_minor: 1000 }))).toEqual([409, 'conflict', null]); // Arjun left
    expect(refusal(await t.api(t.as('p_rahul'), 'POST', '/app/v1/trips/t_goa/transfers/pay-link', { to_person_id: 'p_meher', amount_minor: 1000 }))).toEqual([422, 'invalid', 'to_person_id']); // Rahul is owed, not owing (Meher has an id)
    expect(refusal(await t.api(t.as('p_priya'), 'POST', '/app/v1/trips/t_two/transfers/pay-link', { to_person_id: 'p_meher', amount_minor: 1000 }))).toEqual([422, 'invalid', 'to_person_id']); // Priya owes nobody here
    expect(refusal(await t.api(t.as('p_priya'), 'POST', '/app/v1/trips/t_goa/transfers/pay-link', { to_person_id: 'p_rahul', amount_minor: 0 }))).toEqual([422, 'invalid', 'amount_minor']);
  });

  it('refuses an unsigned caller and a member of another trip on both routes', async () => {
    expect(refusal(await t.api(null, 'POST', '/app/v1/trips/t_two/transfers/pay-link', { to_person_id: 'p_meher', amount_minor: 1 })).slice(0, 2)).toEqual([401, 'unauthorized']);
    expect(refusal(await t.api(t.as('p_orgx'), 'POST', '/app/v1/trips/t_two/transfers/pay-link', { to_person_id: 'p_meher', amount_minor: 1 })).slice(0, 2)).toEqual([403, 'forbidden']); // a member of t_other only
    expect(refusal(await t.api(null, 'POST', '/app/v1/trips/t_two/transfers/nudge', { from_person_id: 'p_kabir' })).slice(0, 2)).toEqual([401, 'unauthorized']);
    expect(refusal(await t.api(t.as('p_orgx'), 'POST', '/app/v1/trips/t_two/transfers/nudge', { from_person_id: 'p_kabir' })).slice(0, 2)).toEqual([403, 'forbidden']);
  });
});

describe('nudges', () => {
  it('answer 204 and send one notification to the right person with the amount in the trip\'s currency, tagged by the nudger; write no event and move no change number; refuse someone who does not owe and an unknown field', async () => {
    const seqBefore = (await rows(h.pool, `select seq from trips where trip_id = 't_usd'`))[0].seq;
    const outboxBefore = (await rows(h.pool, `select count(*)::int as n from outbox where trip_id = 't_usd'`))[0].n;
    const ok = await t.api(t.as('p_rahul'), 'POST', '/app/v1/trips/t_usd/transfers/nudge', { from_person_id: 'p_priya' });
    const sent = reminders().filter((s) => s.n.trip_id === 't_usd');
    expect([ok.status, ok.body, sent.length, sent[0]!.to]).toEqual([204, null, 1, ['p_priya']]);
    expect(sent[0]!.n).toEqual({ type: 'nudge', trip_id: 't_usd', title: 'Goa 🌴', body: 'Rahul reminded you: you owe $12.50', deep_link: '/trips/t_usd/expenses', tag: 't_usd:nudge:p_rahul' });
    const [claim] = await rows(h.pool, `select last_sent_at from nudges where trip_id = 't_usd' and from_person_id = 'p_rahul' and to_person_id = 'p_priya'`);
    expect(Math.abs(Date.now() - new Date(claim.last_sent_at).getTime()) < 60_000).toBe(true); // the 24 hours run from now
    expect([(await rows(h.pool, `select seq from trips where trip_id = 't_usd'`))[0].seq, (await rows(h.pool, `select count(*)::int as n from outbox where trip_id = 't_usd'`))[0].n]).toEqual([seqBefore, outboxBefore]);
    expect(refusal(await t.api(t.as('p_rahul'), 'POST', '/app/v1/trips/t_usd/transfers/nudge', { from_person_id: 'p_kabir' })).slice(0, 2)).toEqual([409, 'conflict']); // Kabir owes nothing here
    expect(refusal(await t.api(t.as('p_rahul'), 'POST', '/app/v1/trips/t_usd/transfers/nudge', { from_person_id: 'p_priya', extra: 1 })).slice(0, 2)).toEqual([422, 'invalid']);
  });

  it('allow one reminder per pair per 24 hours: a second is 429 with retry_after_seconds and Retry-After and sends nothing, two at once send one, and after the window it works again', async () => {
    const kabir = t.as('p_kabir');
    const nudge = (to: string) => t.api(kabir, 'POST', '/app/v1/trips/t_n/transfers/nudge', { from_person_id: to });
    const first = await nudge('p_arjun');
    const second = await nudge('p_arjun');
    const wait = second.body.error.retry_after_seconds;
    expect([first.status, second.status, second.body.error.code, wait > 0 && wait <= 86400, Number(second.headers['retry-after']), reminders().filter((s) => s.n.trip_id === 't_n').length]).toEqual([204, 429, 'rate_limited', true, wait, 1]);
    const two = await Promise.all([nudge('p_meher'), nudge('p_meher')]);
    expect([two.map((r) => r.status).sort(), reminders().filter((s) => s.n.trip_id === 't_n').length]).toEqual([[204, 429], 2]); // one more send, not two
    await h.pool.query(`update nudges set last_sent_at = now() - interval '25 hours' where trip_id = 't_n' and to_person_id = 'p_arjun'`);
    expect([(await nudge('p_arjun')).status, reminders().filter((s) => s.n.trip_id === 't_n').length]).toEqual([204, 3]);
  });

  it('refuse reminding someone who has left, and a debtor reminding the person they owe', async () => {
    expect(refusal(await t.api(t.as('p_kabir'), 'POST', '/app/v1/trips/t_gone/transfers/nudge', { from_person_id: 'p_arjun' })).slice(0, 2)).toEqual([409, 'conflict']); // Arjun still owes, but is no longer in the trip
    expect(refusal(await t.api(t.as('p_priya'), 'POST', '/app/v1/trips/t_usd/transfers/nudge', { from_person_id: 'p_rahul' })).slice(0, 2)).toEqual([409, 'conflict']); // Priya owes Rahul, not the other way round
  });
});
