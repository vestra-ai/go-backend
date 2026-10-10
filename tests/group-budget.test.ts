// §4.1, §5.1 and §5.2 (rev 4): a trip has one optional budget per person, the same for everyone, that any member sets with
// PATCH /trips/:trip; the private per-person budgets, their routes and the spend band are gone; and every member's starting
// city and earliest leave are visible to every member.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check } from '../src/contract/index.js';
import { appApi } from './helpers/app-api.js';
import { startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness(); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
});
afterAll(() => h.stop());

const trip = '/app/v1/trips/t_goa';
const call = (who: string, method: 'GET' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown) => t.api(t.as(who), method, url, body);
const setBudget = (who: string, value: number | null) => call(who, 'PATCH', trip, { budget_per_person_minor: value });
/** The number of events Go has received so far, once everything sent before is delivered. */
const markNow = async () => (await h.flush(), h.go.events.length);
/** What Go was told about the trip's details since `mark`: [who, what changed]. */
const tripUpdates = async (mark: number) => {
  await h.flush();
  return h.go.events.slice(mark).filter((e) => e.trip_id === 't_goa' && e.type === 'trip.updated').map((e) => [e.data.by, e.data.changed]);
};

describe('the group budget', () => {
  it('is set, changed and cleared with PATCH: it is stored, and each change tells Go "budget" by the person who made it', async () => {
    const mark = await markNow();
    const live = h.live.events.length;
    const stored = async () => (await h.pool.query("select budget_per_person_minor as b from trips where trip_id = 't_goa'")).rows[0].b;
    const set = await setBudget('p_priya', 500000);
    const afterSet = Number(await stored());
    const changed = await setBudget('p_arjun', 750000);
    const afterChange = Number(await stored());
    const cleared = await setBudget('p_meher', null);
    expect([set.status, afterSet, changed.status, afterChange, cleared.status, await stored()]).toEqual([200, 500000, 200, 750000, 200, null]);
    expect(await tripUpdates(mark)).toEqual([
      [{ kind: 'person', person_id: 'p_priya' }, ['budget']],
      [{ kind: 'person', person_id: 'p_arjun' }, ['budget']],
      [{ kind: 'person', person_id: 'p_meher' }, ['budget']],
    ]);
    const notices = h.live.events.slice(live).filter((e) => e.event.kind === 'trip').map((e) => e.event as any);
    expect(notices).toEqual([set, changed, cleared].map((r) => ({ kind: 'trip', seq: r.body.seq, kinds: ['trip', 'budget'] })));
    expect(h.go.events.slice(mark).filter((e) => e.type === 'trip.updated').every((e) => check('Event', e).ok)).toBe(true); // the event passes the contract
  });

  it('two members setting it at once: different values give two events and the later one is stored; the same value gives one event', async () => {
    const mark = await markNow();
    const [a, b] = await Promise.all([setBudget('p_priya', 610000), setBudget('p_arjun', 620000)]);
    const later = a.body.seq > b.body.seq ? 610000 : 620000;
    const stored = Number((await h.pool.query("select budget_per_person_minor as b from trips where trip_id = 't_goa'")).rows[0].b);
    const same = await Promise.all([setBudget('p_meher', 630000), setBudget('p_kabir', 630000)]);
    expect([a.status, b.status, stored, same.map((r) => r.body.seq === null).sort()]).toEqual([200, 200, later, [false, true]]);
    expect((await tripUpdates(mark)).length).toBe(3);
    // And one edit of two things names both, once.
    const both = await call('p_rahul', 'PATCH', trip, { title: 'Goa, the long way', budget_per_person_minor: null });
    expect([both.status, (await tripUpdates(mark)).at(-1)]).toEqual([200, [{ kind: 'person', person_id: 'p_rahul' }, ['title', 'budget']]]);
  });

  it('the same value again answers seq null and sends nothing; 0, a fraction, a negative and a string are refused with 422 naming the field', async () => {
    await setBudget('p_rahul', 400000);
    const mark = await markNow();
    const live = h.live.events.length;
    const same = await setBudget('p_priya', 400000);
    const zero = await setBudget('p_priya', 0);
    const others = await Promise.all([1.5, -1, '500'].map((v) => call('p_priya', 'PATCH', trip, { budget_per_person_minor: v })));
    expect(others.map((r) => [r.status, r.body.error.field])).toEqual(Array(3).fill([422, 'budget_per_person_minor']));
    expect([same.status, same.body]).toEqual([200, { seq: null }]);
    expect([zero.status, zero.body.error.code, zero.body.error.field]).toEqual([422, 'invalid', 'budget_per_person_minor']);
    expect(await tripUpdates(mark)).toEqual([]);
    expect(h.live.events.length).toBe(live);
    await setBudget('p_rahul', null);
  });

  it('what Go reads: not set is { answered: 0, of: N }; set to X is the 1.0 band X to X for everyone plus per_person_minor; both pass the contract', async () => {
    const unset = (await h.go.call('read_trip', { trip_id: 't_goa' })).result;
    await setBudget('p_kabir', 600000);
    const set = (await h.go.call('read_trip', { trip_id: 't_goa' })).result;
    expect(unset.budget).toEqual({ answered: 0, of: 5 });
    expect(set.budget).toEqual({ lowest: { min_minor: 600000, max_minor: 600000, currency: 'INR' }, answered: 5, of: 5, per_person_minor: 600000 });
    expect([check('TripSnapshot', unset).ok, check('TripSnapshot', set).ok]).toEqual([true, true]);
    await setBudget('p_kabir', null);
  });

  it('what the app reads: TripView.budget.per_person_minor and the home card carry it when set and not when cleared; TripView.me has no budget', async () => {
    const read = async () => ({
      view: (await call('p_meher', 'GET', trip)).body,
      card: (await call('p_meher', 'GET', '/app/v1/home')).body.trips.find((x: any) => x.trip_id === 't_goa'),
    });
    await setBudget('p_rahul', 450000);
    const withBudget = await read();
    await setBudget('p_rahul', null);
    const without = await read();
    expect([withBudget.view.budget.per_person_minor, withBudget.card.budget_per_person_minor]).toEqual([450000, 450000]);
    expect(['per_person_minor' in without.view.budget, 'budget_per_person_minor' in without.card]).toEqual([false, false]);
    expect([withBudget.view.me, without.view.me].map((me) => 'budget' in me)).toEqual([false, false]);
  });
});

describe('what each member shows the others', () => {
  it('another member\'s Person in TripView.people carries from_city and earliest_leave', async () => {
    const set = await call('p_priya', 'PUT', `${trip}/me/join-answers`, { from_city: 'Delhi', earliest_leave: 'Fri after 6 pm' });
    const seenByKabir = (await call('p_kabir', 'GET', trip)).body.people.find((p: any) => p.person_id === 'p_priya');
    const seenByPriya = (await call('p_priya', 'GET', trip)).body.people.find((p: any) => p.person_id === 'p_priya');
    expect(set.status).toBe(200);
    expect([seenByKabir.from_city, seenByKabir.earliest_leave]).toEqual(['Delhi', 'Fri after 6 pm']);
    expect([seenByPriya.from_city, seenByPriya.earliest_leave]).toEqual(['Delhi', 'Fri after 6 pm']);
  });
});

describe('joining and leaving, and what is gone', () => {
  it('joining and leaving send no budget event: person.joined and person.left only, each with a "people" live notice', async () => {
    const sam = await h.signIn('Sam');
    const mark = await markNow();
    const live = h.live.events.length;
    const joined = await t.api(sam, 'POST', '/app/v1/invites/inv_t_goa/accept', { join_answers: { from_city: 'Pune' } });
    const left = await t.api(sam, 'POST', `${trip}/leave`);
    await h.flush();
    expect([joined.status, left.status]).toEqual([200, 204]);
    expect(h.go.events.slice(mark).filter((e) => e.trip_id === 't_goa').map((e) => e.type)).toEqual(['person.joined', 'person.left']);
    expect(h.live.events.slice(live).filter((e) => e.event.kind === 'trip').map((e) => (e.event as any).kinds)).toEqual([['people'], ['people']]);
  });

  it('the private budget is gone: its routes answer 404, spend_band is refused with 422 on accept and on join-answers, and no read carries a budget on me', async () => {
    const stranger = await h.signIn('Stranger');
    const accept = await t.api(stranger, 'POST', '/app/v1/invites/inv_t_goa/accept', { join_answers: { spend_band: 'lt15' } });
    const answers = await call('p_priya', 'PUT', `${trip}/me/join-answers`, { spend_band: '15to25' });
    expect([(await call('p_priya', 'PUT', `${trip}/me/budget`, { min_minor: 1 })).status, (await call('p_priya', 'DELETE', `${trip}/me/budget`)).status]).toEqual([404, 404]);
    expect([accept.status, accept.body.error.field, answers.status, answers.body.error.field]).toEqual([422, expect.stringContaining('spend_band'), 422, expect.stringContaining('spend_band')]);
    expect('budget' in (await call('p_priya', 'GET', `${trip}/me`)).body).toBe(false);
    expect('budget' in (await call('p_priya', 'GET', `${trip}/money`)).body.me).toBe(false);
  });
});
