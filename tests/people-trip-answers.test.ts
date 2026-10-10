import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

  it('GET shows the five answers and the role, with no budget; GET refuses an outsider and an unsigned caller', async () => {
    await t.api(priya(), 'PUT', '/app/v1/trips/t_b/me/join-answers', { from_city: 'Delhi', know: ['Window seat'] });
    expect((await t.api(priya(), 'GET', '/app/v1/trips/t_b/me')).body).toEqual({ from_city: 'Delhi', earliest_leave: null, know: ['Window seat'], role: 'member', go_paused: false });
    expect(refusal(await t.api(t.as('p_stranger'), 'GET', '/app/v1/trips/t_b/me'))).toEqual([403, 'forbidden']);
    expect(refusal(await t.api(null, 'GET', '/app/v1/trips/t_b/me'))).toEqual([401, 'unauthorized']);
  });

  it('refuses an empty edit, a null list, a city over 60 characters, text the database cannot store, a vibe that is not one of the four and the removed spend band, all with 422', async () => {
    const edit = async (body: unknown) => refusal(await t.api(priya(), 'PUT', '/app/v1/trips/t_a/me/join-answers', body));
    expect(await edit({})).toEqual([422, 'invalid']);
    expect(await edit({ know: null })).toEqual([422, 'invalid']);
    expect(await edit({ from_city: 'c'.repeat(61) })).toEqual([422, 'invalid']);
    expect(await edit({ earliest_leave: 'a\u0000b' })).toEqual([422, 'invalid']);
    expect(await edit({ vibe: 'mountains' })).toEqual([422, 'invalid']);
    expect(await edit({ spend_band: 'lt15' })).toEqual([422, 'invalid']); // no longer an answer
  });
});

describe('the Quick start sheet (vibe)', () => {
  it('the vibe is one "Vibe: …" know entry (replaced, not added); the answer is my own Person; Go hears the know change each time it differs', async () => {
    const arjun = t.as('p_arjun');
    const first = await t.api(arjun, 'PUT', '/app/v1/trips/t_b/me/join-answers', { know: ['Vegetarian'], vibe: 'beach' });
    const second = await t.api(arjun, 'PUT', '/app/v1/trips/t_b/me/join-answers', { vibe: 'hills' });
    const same = await t.api(arjun, 'PUT', '/app/v1/trips/t_b/me/join-answers', { vibe: 'hills' });
    await h.flush();
    expect(first.body).toEqual({ person_id: 'p_arjun', name: 'Arjun', role: 'member', joined_at: expect.any(String), know: ['Vegetarian', 'Vibe: beach'], has_upi: false, go_paused: false, seq: expect.any(Number) });
    expect([second.body.know, same.body.seq]).toEqual([['Vegetarian', 'Vibe: hills'], null]);
    const sent = h.go.events.filter((e) => e.trip_id === 't_b' && e.seq >= first.body.seq).map((e) => [e.type, e.data.changed]);
    expect(sent).toEqual([['person.updated', ['know']], ['person.updated', ['know']]]);
  });
});

describe('the trip as the app reads it (TripView)', () => {
  it('my from_city and earliest_leave are on me.person and on my row in people, and every other member sees them on my row too', async () => {
    await t.api(priya(), 'PUT', '/app/v1/trips/t_b/me/join-answers', { from_city: 'Delhi', earliest_leave: 'Fri 6 pm' });
    const mine = (await t.api(priya(), 'GET', '/app/v1/trips/t_b')).body;
    const theirs = (await t.api(t.as('p_kabir'), 'GET', '/app/v1/trips/t_b')).body;
    const pick = (view: any) => view.people.find((p: any) => p.person_id === 'p_priya');
    expect([mine.me.person.from_city, mine.me.person.earliest_leave, pick(mine).from_city, pick(theirs).from_city, pick(theirs).earliest_leave, theirs.me.person.person_id]).toEqual(['Delhi', 'Fri 6 pm', 'Delhi', 'Delhi', 'Fri 6 pm', 'p_kabir']);
    expect((await h.go.call('read_trip', { trip_id: 't_b' })).result.people.find((p: any) => p.person_id === 'p_priya').from_city).toBe('Delhi');
  });

  it('carries stage, me, chat, needs_you_count and can; unread counts others\' messages after my read marker; POST /read moves it by seq or by message; ETag answers 304; include trims', async () => {
    const rahul = t.as('p_rahul');
    const arjun = t.as('p_arjun');
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
    expect([Object.keys(trimmed).sort(), trimmed.people.length]).toEqual([['budget', 'can', 'chat', 'created_at', 'dates', 'invite_url', 'me', 'money', 'needs_you_count', 'organizer_person_id', 'people', 'seq', 'stage', 'status', 'title', 'trip_id', 'vibe'], 5]);
    expect((await t.api(rahul, 'GET', '/app/v1/trips/t_a?include=people,photos')).body.error.field).toBe('include');
  });
});
