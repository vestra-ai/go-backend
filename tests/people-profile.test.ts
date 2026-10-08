import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appApi } from './helpers/app-api.js';
import { holdAndObserve } from './helpers/hold.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';
import { seedTrip } from './helpers/seed.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness(); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
  await seedTrip(h.pool, 't_b'); // the same five people, in a second trip
  await seedTrip(h.pool, 't_c');
  await t.api(t.as('p_rahul'), 'POST', '/app/v1/trips/t_c/leave'); // Rahul has left t_c
  await seedTrip(h.pool, 't_join', [{ id: 'p_orgx', name: 'Orgx', role: 'organizer' }]); // a trip to join; invite code inv_t_join
});
afterAll(() => h.stop());

const rahul = () => t.as('p_rahul');
const personUpdates = (id: string) => t.events('person.updated').filter((e) => e.data.person.person_id === id);

describe('the account profile', () => {
  it('a name change tells each trip the person is in now, not one they left; the same name again changes nothing; GET returns their own values', async () => {
    const first = await t.api(rahul(), 'PATCH', '/app/v1/me', { name: 'Rahul K' });
    await h.flush();
    expect(personUpdates('p_rahul').map((e) => [e.trip_id, e.data.changed, e.data.person.name]).sort()).toEqual([['t_b', ['name'], 'Rahul K'], ['t_goa', ['name'], 'Rahul K']]);
    const again = await t.api(rahul(), 'PATCH', '/app/v1/me', { name: 'Rahul K' });
    await h.flush();
    expect([first.status, typeof first.body.seq, again.status, again.body.seq, personUpdates('p_rahul').length]).toEqual([200, 'number', 200, null, 2]); // the repeat sent nothing
    expect((await t.api(rahul(), 'GET', '/app/v1/me')).body).toEqual({
      person_id: 'p_rahul', name: 'Rahul K', photo_url: null, upi_id: 'rahul@upi', email: 'p_rahul@mail.test', auth_provider: 'google', from_city: null, notifications_enabled: true, created_at: expect.any(String),
    });
    expect((await t.api(null, 'GET', '/app/v1/me')).status).toBe(401);
    expect((await t.api(null, 'PATCH', '/app/v1/me', { name: 'x' })).status).toBe(401);
    expect((await t.api(rahul(), 'PATCH', '/app/v1/me', { name: 'x', extra: 1 })).status).toBe(422);
  });

  it('saving and clearing a UPI id tells Go only that one exists or not; replacing it tells nothing; no event and no log line holds the text', async () => {
    const logged: string[] = [];
    const spies = (['log', 'error', 'warn'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...args: unknown[]) => void logged.push(JSON.stringify(args))));
    const priya = t.as('p_priya');
    const saved = await t.api(priya, 'PATCH', '/app/v1/me', { upi_id: 'priya@okbank' });
    const replaced = await t.api(priya, 'PATCH', '/app/v1/me', { upi_id: 'priya@newbank' });
    const cleared = await t.api(priya, 'PATCH', '/app/v1/me', { upi_id: null });
    await h.flush();
    spies.forEach((s) => s.mockRestore());
    const everything = JSON.stringify([(await rows(h.pool, 'select body from outbox')).map((r) => r.body), logged]); // Go's events and the server's log, not the caller's own answer
    expect([saved.body.upi_id, personUpdates('p_priya').map((e) => e.data.changed), replaced.body.seq, cleared.body.upi_id]).toEqual(['priya@okbank', Array(6).fill(['has_upi']), null, null]); // 3 trips x (saved, cleared)
    expect(/okbank|newbank/.test(everything)).toBe(false);
  });

  it('refuses a 101-character UPI id without echoing it, a photo link that is not http(s), and a null name, all with 422 naming the field', async () => {
    const long = 'u'.repeat(101);
    const tooLong = await t.api(rahul(), 'PATCH', '/app/v1/me', { upi_id: long });
    expect([tooLong.status, tooLong.body.error.code, tooLong.body.error.field, JSON.stringify(tooLong.body).includes(long)]).toEqual([422, 'invalid', 'upi_id', false]);
    expect((await t.api(rahul(), 'PATCH', '/app/v1/me', { photo_url: 'ftp://x.example/a.png' })).status).toBe(422);
    expect((await t.api(rahul(), 'PATCH', '/app/v1/me', { name: null })).status).toBe(422);
  });

  it('the default "travelling from" and the notifications switch are the person\'s own: saved, cleared, and never sent to Go', async () => {
    const kabir = t.as('p_kabir');
    const before = t.events('person.updated').length;
    const set = await t.api(kabir, 'PATCH', '/app/v1/me', { from_city: 'Pune', notifications_enabled: false });
    const same = await t.api(kabir, 'PATCH', '/app/v1/me', { from_city: 'Pune' });
    const cleared = await t.api(kabir, 'PATCH', '/app/v1/me', { from_city: null });
    await h.flush();
    expect([set.status, set.body.from_city, set.body.notifications_enabled, set.body.seq, same.body.seq, cleared.body.from_city, t.events('person.updated').length - before]).toEqual([200, 'Pune', false, null, null, null, 0]);
    expect((await rows(h.pool, `select from_city_default, notifications_enabled from people where person_id = 'p_kabir'`))[0]).toEqual({ from_city_default: null, notifications_enabled: false });
    expect((await t.api(kabir, 'PATCH', '/app/v1/me', { notifications_enabled: 'yes' })).status).toBe(422);
  });

  it('a person whose stored photo link fails the URL test can still pause Go and edit their profile; Go\'s trip read leaves out that photo and nobody else\'s; the app still gets the stored value', async () => {
    await h.pool.query(`update people set photo_url = 'not a url' where person_id = 'p_arjun'`);
    await h.pool.query(`update people set photo_url = 'https://x.example/meher.png' where person_id = 'p_meher'`);
    const arjun = t.as('p_arjun');
    const paused = await t.api(arjun, 'PATCH', '/app/v1/trips/t_goa/me', { go_paused: true });
    const renamed = await t.api(arjun, 'PATCH', '/app/v1/me', { name: 'Arjun S' });
    expect([paused.status, renamed.status]).toEqual([200, 200]);
    const snap = (await h.go.call('read_trip', { trip_id: 't_goa' })).result;
    const photos = Object.fromEntries(snap.people.map((p: any) => [p.person_id, p.photo_url]));
    expect([photos.p_arjun, photos.p_meher, (await t.api(arjun, 'GET', '/app/v1/me')).body.photo_url]).toEqual([undefined, 'https://x.example/meher.png', 'not a url']);
  });

  it('a join or a new trip that starts during a rename waits for it and carries the new name; two edits by people who share two trips both finish', async () => {
    const renameHeld = (name: string) => async (side: any) => {
      await side.query(`select 1 from people where person_id = 'p_kabir' for no key update`);
      await side.query(`update people set name = $1 where person_id = 'p_kabir'`, [name]);
    };
    const kabir = t.as('p_kabir');
    const join = await holdAndObserve(h, renameHeld('Kabir Renamed'), () => t.api(kabir, 'POST', '/app/v1/invites/inv_t_join/accept', {}), 'commit');
    await h.flush();
    const joined = t.events('person.joined').find((e) => e.trip_id === 't_join')!;
    expect([join.waited, join.result.status, joined.data.person.name]).toEqual([true, 200, 'Kabir Renamed']);
    const create = await holdAndObserve(h, renameHeld('Kabir Again'), () => t.api(kabir, 'POST', '/app/v1/trips', { title: 'Kabir\'s trip' }), 'commit');
    await h.flush();
    const created = t.events('trip.created').find((e) => e.data.trip.people[0].person_id === 'p_kabir')!;
    expect([create.waited, create.result.status, created.data.trip.people[0].name]).toEqual([true, 201, 'Kabir Again']);
    const both = await Promise.all([t.api(rahul(), 'PATCH', '/app/v1/me', { name: 'Rahul K2' }), t.api(t.as('p_priya'), 'PATCH', '/app/v1/me', { name: 'Priya P' })]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
  });

  it('an edit that meets the same person leaving a trip at that moment waits for it and says nothing in that trip', async () => {
    const leaving = async (side: any) => side.query(`update trip_people set left_at = now() where trip_id = 't_b' and person_id = 'p_meher'`); // a leave that has not committed yet
    const seen = await holdAndObserve(h, leaving, () => t.api(t.as('p_meher'), 'PATCH', '/app/v1/me', { name: 'Meher M' }), 'commit');
    await h.flush();
    expect([seen.waited, seen.result.status, personUpdates('p_meher').map((e) => e.trip_id).sort()]).toEqual([true, 200, ['t_c', 't_goa']]);
  });
});
