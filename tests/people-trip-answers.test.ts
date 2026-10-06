import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';
import { seedTrip } from './helpers/seed.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness({ seed: false });
  t = appApi(h);
  await seedTrip(h.pool, 't_a'); // p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  await seedTrip(h.pool, 't_b'); // the same five people again
  await seedTrip(h.pool, 't_bud');
});
afterAll(() => h.stop());

const priya = () => t.as('p_priya');
const refusal = (r: { status: number; body: any }) => [r.status, r.body?.error?.code];

describe('a person\'s answers in one trip', () => {
  it('an edit tells that trip only, null and an empty list clear, the same values again change nothing; refuses unsigned, outside the trip and unknown fields', async () => {
    const set = await t.api(priya(), 'PATCH', '/app/trips/t_a/me', { from_city: 'Delhi', earliest_leave: 'Fri after 6 pm', know: ['Vegetarian'] });
    const cleared = await t.api(priya(), 'PATCH', '/app/trips/t_a/me', { from_city: null, know: [] });
    const same = await t.api(priya(), 'PATCH', '/app/trips/t_a/me', { from_city: null, know: [] });
    await h.flush();
    const updates = t.events('person.updated').filter((e) => e.data.person.person_id === 'p_priya');
    expect(updates.map((e) => [e.trip_id, e.data.changed])).toEqual([['t_a', ['from_city', 'earliest_leave', 'know']], ['t_a', ['from_city', 'know']]]); // nothing in t_b
    expect([typeof set.body.seq, typeof cleared.body.seq, same.body.seq]).toEqual(['number', 'number', null]);
    expect((await rows(h.pool, `select from_city, earliest_leave, know from trip_people where trip_id = 't_a' and person_id = 'p_priya'`))[0]).toEqual({ from_city: null, earliest_leave: 'Fri after 6 pm', know: [] });
    expect(refusal(await t.api(null, 'PATCH', '/app/trips/t_a/me', { from_city: 'x' }))).toEqual([401, 'unauthorized']);
    expect(refusal(await t.api(t.as('p_stranger'), 'PATCH', '/app/trips/t_a/me', { from_city: 'x' }))).toEqual([403, 'forbidden']);
    expect(refusal(await t.api(priya(), 'PATCH', '/app/trips/t_a/me', { from_city: 'x', extra: 1 }))).toEqual([422, 'invalid']);
  });

  it('a budget change tells Go only that the budget moved, the same answer tells nothing, and leaving afterwards sends the departure and the moved band; refuses unsigned, outside the trip and unknown fields', async () => {
    const logged: string[] = [];
    const spies = (['log', 'error', 'warn'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...args: unknown[]) => void logged.push(JSON.stringify(args))));
    const kabir = t.as('p_kabir');
    const set = await t.api(kabir, 'PUT', '/app/trips/t_a/me/budget', { min_minor: 1234500, max_minor: 2345600 });
    const same = await t.api(kabir, 'PUT', '/app/trips/t_a/me/budget', { min_minor: 1234500, max_minor: 2345600 });
    await t.api(kabir, 'POST', '/app/trips/t_a/leave');
    await h.flush();
    spies.forEach((s) => s.mockRestore());
    const budgetEvents = t.events('trip.updated').filter((e) => e.trip_id === 't_a');
    const sinceLeave = h.go.events.filter((e) => e.trip_id === 't_a' && e.seq > set.body.seq).map((e) => e.type);
    expect([budgetEvents[0]!.data, same.body.seq, budgetEvents.length, sinceLeave]).toEqual([{ by: { kind: 'system' }, changed: ['budget'] }, null, 2, ['person.left', 'trip.updated']]); // set, then the leaver's answer stops counting
    expect(/1234500|2345600/.test(JSON.stringify([h.go.events, logged]))).toBe(false); // no amount in any event or log line
    expect(refusal(await t.api(null, 'PUT', '/app/trips/t_a/me/budget', { min_minor: 1 }))).toEqual([401, 'unauthorized']);
    expect(refusal(await t.api(t.as('p_stranger'), 'PUT', '/app/trips/t_a/me/budget', { min_minor: 1 }))).toEqual([403, 'forbidden']);
    expect(refusal(await t.api(priya(), 'PUT', '/app/trips/t_a/me/budget', { min_minor: 1, extra: 1 }))).toEqual([422, 'invalid']);
  });

  it('refuses a maximum below the minimum and a withdrawal; GET shows the six fields with the caller\'s own budget; GET refuses an outsider', async () => {
    expect(refusal(await t.api(priya(), 'PUT', '/app/trips/t_b/me/budget', { min_minor: 500, max_minor: 100 }))).toEqual([422, 'invalid']);
    expect(refusal(await t.api(priya(), 'PUT', '/app/trips/t_b/me/budget', { min_minor: null }))).toEqual([422, 'invalid']);
    await t.api(priya(), 'PUT', '/app/trips/t_b/me/budget', { min_minor: 100000 });
    await t.api(priya(), 'PATCH', '/app/trips/t_b/me', { from_city: 'Delhi', know: ['Window seat'] });
    expect((await t.api(priya(), 'GET', '/app/trips/t_b/me')).body).toEqual({ from_city: 'Delhi', earliest_leave: null, know: ['Window seat'], budget: { min_minor: 100000 }, role: 'member', go_paused: false });
    expect(refusal(await t.api(t.as('p_stranger'), 'GET', '/app/trips/t_b/me'))).toEqual([403, 'forbidden']);
  });

  it('two people changing their budget at once give two events, and Go\'s read shows the lower band and the right count', async () => {
    const both = await Promise.all([
      t.api(t.as('p_arjun'), 'PUT', '/app/trips/t_bud/me/budget', { min_minor: 2000000, max_minor: 3000000 }),
      t.api(t.as('p_meher'), 'PUT', '/app/trips/t_bud/me/budget', { min_minor: 1500000, max_minor: 2500000 }),
    ]);
    await h.flush();
    const snap = (await h.go.call('read_trip', { trip_id: 't_bud' })).result;
    expect([both.map((r) => r.status), t.events('trip.updated').filter((e) => e.trip_id === 't_bud').length, snap.budget]).toEqual([[200, 200], 2, { lowest: { min_minor: 1500000, max_minor: 2500000, currency: 'INR' }, answered: 2, of: 5 }]);
    const meher = t.as('p_meher');
    const upperOnly = await t.api(meher, 'PUT', '/app/trips/t_bud/me/budget', { min_minor: 1500000, max_minor: 2600000 }); // only the upper limit moves
    const noUpper = await t.api(meher, 'PUT', '/app/trips/t_bud/me/budget', { min_minor: 1500000 }); // the whole answer is replaced: no upper limit now
    expect([typeof upperOnly.body.seq, typeof noUpper.body.seq, (await rows(h.pool, `select budget_max_minor from trip_people where trip_id = 't_bud' and person_id = 'p_meher'`))[0].budget_max_minor]).toEqual(['number', 'number', null]);
    expect(refusal(await t.api(null, 'GET', '/app/trips/t_bud/me'))).toEqual([401, 'unauthorized']);
  });

  it('refuses an empty edit, a null list, a city over 60 characters and text the database cannot store, all with 422', async () => {
    const edit = async (body: unknown) => refusal(await t.api(priya(), 'PATCH', '/app/trips/t_a/me', body));
    expect(await edit({})).toEqual([422, 'invalid']);
    expect(await edit({ know: null })).toEqual([422, 'invalid']);
    expect(await edit({ from_city: 'c'.repeat(61) })).toEqual([422, 'invalid']);
    expect(await edit({ earliest_leave: 'a\u0000b' })).toEqual([422, 'invalid']);
  });
});
