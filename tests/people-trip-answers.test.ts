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
    const set = await t.api(priya(), 'PUT', '/app/v1/trips/t_a/me/join-answers', { from_city: 'Delhi', earliest_leave: 'Fri after 6 pm', know: ['Vegetarian'] });
    const cleared = await t.api(priya(), 'PUT', '/app/v1/trips/t_a/me/join-answers', { from_city: null, know: [] });
    const same = await t.api(priya(), 'PUT', '/app/v1/trips/t_a/me/join-answers', { from_city: null, know: [] });
    await h.flush();
    const updates = t.events('person.updated').filter((e) => e.data.person.person_id === 'p_priya');
    expect(updates.map((e) => [e.trip_id, e.data.changed])).toEqual([['t_a', ['from_city', 'earliest_leave', 'know']], ['t_a', ['from_city', 'know']]]); // nothing in t_b
    expect([typeof set.body.seq, typeof cleared.body.seq, same.body.seq]).toEqual(['number', 'number', null]);
    expect((await rows(h.pool, `select from_city, earliest_leave, know from trip_people where trip_id = 't_a' and person_id = 'p_priya'`))[0]).toEqual({ from_city: null, earliest_leave: 'Fri after 6 pm', know: [] });
    expect(refusal(await t.api(null, 'PUT', '/app/v1/trips/t_a/me/join-answers', { from_city: 'x' }))).toEqual([401, 'unauthorized']);
    expect(refusal(await t.api(t.as('p_stranger'), 'PUT', '/app/v1/trips/t_a/me/join-answers', { from_city: 'x' }))).toEqual([403, 'forbidden']);
    expect(refusal(await t.api(priya(), 'PUT', '/app/v1/trips/t_a/me/join-answers', { from_city: 'x', extra: 1 }))).toEqual([422, 'invalid']);
  });

  it('a budget change tells Go only that the budget moved, the same answer tells nothing, and leaving afterwards sends the departure and the moved band; refuses unsigned, outside the trip and unknown fields', async () => {
    const logged: string[] = [];
    const spies = (['log', 'error', 'warn'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...args: unknown[]) => void logged.push(JSON.stringify(args))));
    const kabir = t.as('p_kabir');
    const set = await t.api(kabir, 'PUT', '/app/v1/trips/t_a/me/budget', { min_minor: 1234500, max_minor: 2345600 });
    const same = await t.api(kabir, 'PUT', '/app/v1/trips/t_a/me/budget', { min_minor: 1234500, max_minor: 2345600 });
    await t.api(kabir, 'POST', '/app/v1/trips/t_a/leave');
    await h.flush();
    spies.forEach((s) => s.mockRestore());
    const budgetEvents = t.events('trip.updated').filter((e) => e.trip_id === 't_a');
    const sinceLeave = h.go.events.filter((e) => e.trip_id === 't_a' && e.seq > set.body.seq).map((e) => e.type);
    expect([budgetEvents[0]!.data, same.body.seq, budgetEvents.length, sinceLeave]).toEqual([{ by: { kind: 'system' }, changed: ['budget'] }, null, 2, ['person.left', 'trip.updated']]); // set, then the leaver's answer stops counting
    expect(/1234500|2345600/.test(JSON.stringify([h.go.events, logged]))).toBe(false); // no amount in any event or log line
    expect(refusal(await t.api(null, 'PUT', '/app/v1/trips/t_a/me/budget', { min_minor: 1 }))).toEqual([401, 'unauthorized']);
    expect(refusal(await t.api(t.as('p_stranger'), 'PUT', '/app/v1/trips/t_a/me/budget', { min_minor: 1 }))).toEqual([403, 'forbidden']);
    expect(refusal(await t.api(priya(), 'PUT', '/app/v1/trips/t_a/me/budget', { min_minor: 1, extra: 1 }))).toEqual([422, 'invalid']);
  });

  it('refuses a maximum below the minimum and a withdrawal; GET shows the six fields with the caller\'s own budget; GET refuses an outsider', async () => {
    expect(refusal(await t.api(priya(), 'PUT', '/app/v1/trips/t_b/me/budget', { min_minor: 500, max_minor: 100 }))).toEqual([422, 'invalid']);
    expect(refusal(await t.api(priya(), 'PUT', '/app/v1/trips/t_b/me/budget', { min_minor: null }))).toEqual([422, 'invalid']);
    await t.api(priya(), 'PUT', '/app/v1/trips/t_b/me/budget', { min_minor: 100000 });
    await t.api(priya(), 'PUT', '/app/v1/trips/t_b/me/join-answers', { from_city: 'Delhi', know: ['Window seat'] });
    expect((await t.api(priya(), 'GET', '/app/v1/trips/t_b/me')).body).toEqual({ from_city: 'Delhi', earliest_leave: null, know: ['Window seat'], budget: { min_minor: 100000 }, role: 'member', go_paused: false });
    expect(refusal(await t.api(t.as('p_stranger'), 'GET', '/app/v1/trips/t_b/me'))).toEqual([403, 'forbidden']);
  });

  it('two people changing their budget at once give two events, and Go\'s read shows the lower band and the right count', async () => {
    const both = await Promise.all([
      t.api(t.as('p_arjun'), 'PUT', '/app/v1/trips/t_bud/me/budget', { min_minor: 2000000, max_minor: 3000000 }),
      t.api(t.as('p_meher'), 'PUT', '/app/v1/trips/t_bud/me/budget', { min_minor: 1500000, max_minor: 2500000 }),
    ]);
    await h.flush();
    const snap = (await h.go.call('read_trip', { trip_id: 't_bud' })).result;
    expect([both.map((r) => r.status), t.events('trip.updated').filter((e) => e.trip_id === 't_bud').length, snap.budget]).toEqual([[200, 200], 2, { lowest: { min_minor: 1500000, max_minor: 2500000, currency: 'INR' }, answered: 2, of: 5 }]);
    const meher = t.as('p_meher');
    const upperOnly = await t.api(meher, 'PUT', '/app/v1/trips/t_bud/me/budget', { min_minor: 1500000, max_minor: 2600000 }); // only the upper limit moves
    const noUpper = await t.api(meher, 'PUT', '/app/v1/trips/t_bud/me/budget', { min_minor: 1500000 }); // the whole answer is replaced: no upper limit now
    expect([typeof upperOnly.body.seq, typeof noUpper.body.seq, (await rows(h.pool, `select budget_max_minor from trip_people where trip_id = 't_bud' and person_id = 'p_meher'`))[0].budget_max_minor]).toEqual(['number', 'number', null]);
    expect(refusal(await t.api(null, 'GET', '/app/v1/trips/t_bud/me'))).toEqual([401, 'unauthorized']);
  });

  it('refuses an empty edit, a null list, a city over 60 characters, text the database cannot store and a vibe that is not one of the four, all with 422', async () => {
    const edit = async (body: unknown) => refusal(await t.api(priya(), 'PUT', '/app/v1/trips/t_a/me/join-answers', body));
    expect(await edit({})).toEqual([422, 'invalid']);
    expect(await edit({ know: null })).toEqual([422, 'invalid']);
    expect(await edit({ from_city: 'c'.repeat(61) })).toEqual([422, 'invalid']);
    expect(await edit({ earliest_leave: 'a\u0000b' })).toEqual([422, 'invalid']);
    expect(await edit({ vibe: 'mountains' })).toEqual([422, 'invalid']);
    expect(await edit({ spend_band: 'lots' })).toEqual([422, 'invalid']);
  });
});

describe('the Quick start sheet (vibe and spend band)', () => {
  it('the vibe is one "Vibe: …" know entry (replaced, not added), the band is the private budget answer; the answer is my own Person; Go hears the know change and then the band moving', async () => {
    const arjun = t.as('p_arjun');
    const first = await t.api(arjun, 'PUT', '/app/v1/trips/t_b/me/join-answers', { know: ['Vegetarian'], vibe: 'beach', spend_band: '15to25' });
    const second = await t.api(arjun, 'PUT', '/app/v1/trips/t_b/me/join-answers', { vibe: 'hills' });
    const same = await t.api(arjun, 'PUT', '/app/v1/trips/t_b/me/join-answers', { vibe: 'hills', spend_band: '15to25' });
    await h.flush();
    expect(first.body).toEqual({ person_id: 'p_arjun', name: 'Arjun', role: 'member', joined_at: expect.any(String), know: ['Vegetarian', 'Vibe: beach'], has_upi: false, go_paused: false, seq: expect.any(Number) });
    expect([second.body.know, same.body.seq]).toEqual([['Vegetarian', 'Vibe: hills'], null]);
    const sent = h.go.events.filter((e) => e.trip_id === 't_b' && e.seq >= first.body.seq - 1).map((e) => [e.type, e.data.changed]);
    expect(sent).toEqual([['person.updated', ['know']], ['trip.updated', ['budget']], ['person.updated', ['know']]]);
    expect((await rows(h.pool, `select budget_min_minor, budget_max_minor from trip_people where trip_id = 't_b' and person_id = 'p_arjun'`))[0]).toEqual({ budget_min_minor: 1500000, budget_max_minor: 2500000 });
    expect(JSON.stringify(h.go.events)).not.toMatch(/15to25|1500000/);
    expect((await t.api(arjun, 'GET', '/app/v1/trips/t_b')).body.me.budget).toEqual({ min_minor: 1500000, max_minor: 2500000, currency: 'INR' });
  });

  it('the budget route takes the contract\'s shape (max_minor null, the trip\'s currency), answers my answer with the summary, and DELETE withdraws it with the same event as a set', async () => {
    const meher = t.as('p_meher');
    const set = await t.api(meher, 'PUT', '/app/v1/trips/t_b/me/budget', { min_minor: 500000, max_minor: null, currency: 'INR' });
    expect(set.body).toEqual({ budget: { min_minor: 500000, max_minor: null, currency: 'INR' }, summary: { lowest: { min_minor: 100000, currency: 'INR' }, answered: 3, of: 5 }, seq: expect.any(Number) }); // Priya's 100000 is the lowest
    expect(refusal(await t.api(meher, 'PUT', '/app/v1/trips/t_b/me/budget', { min_minor: 500000, currency: 'USD' }))).toEqual([422, 'invalid']);
    const cleared = await t.api(meher, 'DELETE', '/app/v1/trips/t_b/me/budget');
    const again = await t.api(meher, 'DELETE', '/app/v1/trips/t_b/me/budget');
    await h.flush();
    expect([cleared.status, cleared.body.summary, cleared.body.seq, again.body.seq]).toEqual([200, { lowest: { min_minor: 100000, currency: 'INR' }, answered: 2, of: 5 }, set.body.seq + 1, null]);
    expect(h.go.events.find((e) => e.seq === cleared.body.seq && e.trip_id === 't_b')!.data).toEqual({ by: { kind: 'system' }, changed: ['budget'] });
    expect((await t.api(meher, 'GET', '/app/v1/trips/t_b')).body.me.budget).toBeNull();
    expect(refusal(await t.api(t.as('p_stranger'), 'DELETE', '/app/v1/trips/t_b/me/budget'))).toEqual([403, 'forbidden']);
  });
});

describe('the trip as the app reads it (TripView)', () => {
  it('my from_city and earliest_leave are on me.person and my own row only; other members\' are left out for me and shown to Go', async () => {
    await t.api(priya(), 'PUT', '/app/v1/trips/t_b/me/join-answers', { from_city: 'Delhi', earliest_leave: 'Fri 6 pm' });
    const mine = (await t.api(priya(), 'GET', '/app/v1/trips/t_b')).body;
    const theirs = (await t.api(t.as('p_kabir'), 'GET', '/app/v1/trips/t_b')).body;
    const pick = (view: any) => view.people.find((p: any) => p.person_id === 'p_priya');
    expect([mine.me.person.from_city, mine.me.person.earliest_leave, pick(mine).from_city, 'from_city' in pick(theirs), 'earliest_leave' in pick(theirs), theirs.me.person.person_id]).toEqual(['Delhi', 'Fri 6 pm', 'Delhi', false, false, 'p_kabir']);
    expect((await h.go.call('read_trip', { trip_id: 't_b' })).result.people.find((p: any) => p.person_id === 'p_priya').from_city).toBe('Delhi');
  });

  it('carries stage, me, chat, needs_you_count and can; unread counts others\' messages after my read marker; POST /read moves it by seq or by message; ETag answers 304; include trims', async () => {
    const rahul = t.as('p_rahul');
    const arjun = t.as('p_arjun'); // Kabir left t_a above
    const m1 = await t.api(arjun, 'POST', '/app/v1/trips/t_a/messages', { client_message_id: 'r1', text: 'hello' });
    const m2 = await t.api(arjun, 'POST', '/app/v1/trips/t_a/messages', { client_message_id: 'r2', text: 'anyone?' });
    await t.api(rahul, 'POST', '/app/v1/trips/t_a/messages', { client_message_id: 'r3', text: 'here' }); // my own: never unread for me
    let view = (await t.api(rahul, 'GET', '/app/v1/trips/t_a')).body;
    expect([view.stage, view.me.last_read_seq, view.me.unread_count, view.chat.unread_count, view.chat.participants_preview, view.needs_you_count, view.can]).toEqual([
      'deciding', 0, 2, 2, [{ kind: 'person', person_id: 'p_rahul' }, { kind: 'person', person_id: 'p_arjun' }], 0, { invite: true, manage_trip: true }, // dates seeded, no destination
    ]);
    expect(view.chat.last_message).toEqual({ message_id: expect.any(String), author: { kind: 'person', person_id: 'p_rahul' }, text_preview: 'here', sent_at: expect.any(String) });
    expect((await t.api(arjun, 'GET', '/app/v1/trips/t_a')).body.can).toEqual({ invite: true, manage_trip: false });
    expect((await t.api(rahul, 'POST', '/app/v1/trips/t_a/read', { message_id: m1.body.message_id })).status).toBe(204);
    expect((await t.api(rahul, 'GET', '/app/v1/trips/t_a')).body.me).toMatchObject({ last_read_seq: m1.body.seq, unread_count: 1 });
    await t.api(rahul, 'POST', '/app/v1/trips/t_a/read', { up_to_seq: m2.body.seq });
    view = (await t.api(rahul, 'GET', '/app/v1/trips/t_a')).body;
    expect([view.me.unread_count, view.me.last_read_seq]).toEqual([0, m2.body.seq]);
    expect((await t.api(rahul, 'POST', '/app/v1/trips/t_a/read', { message_id: 'm_nope' })).body.error.field).toBe('message_id');
    expect((await t.api(rahul, 'POST', '/app/v1/trips/t_a/read', { up_to_seq: 1, extra: true })).status).toBe(422);
    // ETag is the seq.
    const full = await t.api(rahul, 'GET', '/app/v1/trips/t_a');
    expect(full.headers.etag).toBe(`"${full.body.seq}"`);
    const unchanged = await t.api(rahul, 'GET', '/app/v1/trips/t_a', undefined, { 'if-none-match': full.headers.etag as string });
    expect([unchanged.status, unchanged.body]).toEqual([304, null]);
    expect((await t.api(rahul, 'GET', '/app/v1/trips/t_a', undefined, { 'if-none-match': '"0"' })).status).toBe(200);
    // include trims the big parts and nothing else.
    const trimmed = (await t.api(rahul, 'GET', '/app/v1/trips/t_a?include=people,money')).body;
    expect([Object.keys(trimmed).sort(), trimmed.people.length]).toEqual([['budget', 'can', 'chat', 'created_at', 'dates', 'invite_url', 'me', 'money', 'needs_you_count', 'organizer_person_id', 'people', 'seq', 'stage', 'status', 'title', 'trip_id', 'vibe'], 4]); // Kabir left
    expect((await t.api(rahul, 'GET', '/app/v1/trips/t_a?include=people,photos')).body.error.field).toBe('include');
  });
});
