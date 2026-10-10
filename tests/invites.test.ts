// §4.3 Invites: the public preview and its personal state, accepting (with the landing), the removed "Not now" and
// "Decline" routes, the organizer's rotation, and the per-address limit on the preview.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, v1, type Harness } from './helpers/harness.js';
import { seedTrip } from './helpers/seed.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness(); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir; link inv_t_goa
  t = appApi(h);
});
afterAll(() => h.stop());

const preview = (code: string, who: any = null, headers: Record<string, string> = {}) => t.api(who, 'GET', v1(`/invites/${code}`), undefined, headers);
const FACES = [{ person_id: 'p_rahul', name: 'Rahul' }, { person_id: 'p_priya', name: 'Priya' }, { person_id: 'p_arjun', name: 'Arjun' }, { person_id: 'p_meher', name: 'Meher' }];
let sam: { id: string; token: string }; // a stranger to t_goa, signed in the way the app does

describe('the preview', () => {
  it('without sign-in: the trip, the inviter (the organizer), up to four faces organizer first, the count, state pending; no contact detail; 404 for a bad link', async () => {
    const r = await preview('inv_t_goa');
    expect([r.status, r.body]).toEqual([200, {
      code: 'inv_t_goa', state: 'pending', trip: { trip_id: 't_goa', title: 'Goa 🌴', dates: { start: '2026-11-06', end: '2026-11-09' } },
      inviter: { person_id: 'p_rahul', name: 'Rahul' }, people_preview: FACES, joined_count: 5,
    }]);
    expect(JSON.stringify(r.body)).not.toMatch(/@|\+91|upi|from_city/);
    expect((await preview('nope')).status).toBe(404);
    expect((await preview('inv_t_goa', null, { authorization: 'Bearer garbage' })).body.state).toBe('pending'); // a bad token is just anonymous here
  });

  it('signed in: already_member for someone in the trip, pending for anyone else; "Not now" and "Decline" are gone (404) and nobody is ever "declined"', async () => {
    expect((await preview('inv_t_goa', t.as('p_priya'))).body.state).toBe('already_member');
    sam = await h.signIn('Sam');
    const gone = [await t.api(sam, 'POST', v1('/invites/inv_t_goa/later')), await t.api(sam, 'POST', v1('/invites/inv_t_goa/decline'))];
    expect(gone.map((r) => [r.status, r.body.error.code])).toEqual([[404, 'not_found'], [404, 'not_found']]);
    expect([(await preview('inv_t_goa', sam)).body.state, (await preview('inv_t_goa')).body.state]).toEqual(['pending', 'pending']);
  });
});

describe('accepting', () => {
  it('joins with the join answers (vibe as a know entry), sends person.joined and no budget event, lands on the trip home when the room is quiet, says so again on a repeat', async () => {
    const before = h.live.events.length;
    const r = await t.api(sam, 'POST', v1('/invites/inv_t_goa/accept'), { join_answers: { from_city: 'Pune', vibe: 'beach' } });
    await h.flush();
    expect(r.body).toEqual({ trip_id: 't_goa', seq: expect.any(Number), landing: 'trip_home' });
    const joined = t.events('person.joined').at(-1)!;
    expect(joined.data.person).toMatchObject({ person_id: sam.id, from_city: 'Pune', know: ['Vibe: beach'] });
    expect(t.events('trip.updated')).toEqual([]);
    // The "Sam joined" pill, the trip notice, then a home notice for every member (their card shows one more face) and for Sam.
    const kinds = h.live.events.slice(before).map((e) => e.event.kind);
    expect([kinds.filter((k) => k !== 'home'), kinds.filter((k) => k === 'home').length]).toEqual([['trip', 'message'], 6]); // person.joined's notice, then its "… joined" line: change-number order
    const again = await t.api(sam, 'POST', v1('/invites/inv_t_goa/accept'), {});
    expect([again.body, t.events('person.joined').filter((e) => e.data.person.person_id === sam.id).length]).toEqual([{ trip_id: 't_goa', seq: r.body.seq, landing: 'trip_home' }, 1]); // both answers carry the trip's seq after the join: the "Sam joined" line
    expect((await preview('inv_t_goa', sam)).body.joined_count).toBe(6);
  });

  it('lands in the chat once anyone has spoken', async () => {
    await t.api(t.as('p_rahul'), 'POST', v1('/trips/t_goa/messages'), { client_message_id: 'c1', text: 'Welcome!' });
    const zoe = await h.signIn('Zoe');
    expect((await t.api(zoe, 'POST', v1('/invites/inv_t_goa/accept'), {})).body.landing).toBe('chat');
  });

  it('refuses unknown fields and the old answer shape with 422 naming the field', async () => {
    const zed = await h.signIn('Zed');
    expect((await t.api(zed, 'POST', v1('/invites/inv_t_goa/accept'), { join_answers: { vibe: 'mountains' } })).body.error.field).toBe('join_answers.vibe');
    expect((await t.api(zed, 'POST', v1('/invites/inv_t_goa/accept'), { from_city: 'Pune' })).body.error.field).toBe('from_city');
  });
});

describe('rotation', () => {
  it('only the organizer rotates; the old link answers revoked and cannot be accepted; the trip, Go and the Share sheet show the new one', async () => {
    expect((await t.api(t.as('p_priya'), 'POST', v1('/trips/t_goa/invite/rotate'))).status).toBe(403);
    const r = await t.api(t.as('p_rahul'), 'POST', v1('/trips/t_goa/invite/rotate'));
    const code: string = r.body.code;
    expect([r.status, code.length >= 10, r.body.invite_url]).toEqual([200, true, `https://go.example/j/${code}`]);
    expect((await preview('inv_t_goa')).body).toMatchObject({ state: 'revoked', trip: { trip_id: 't_goa' } });
    const late = await h.signIn('Late');
    expect((await t.api(late, 'POST', v1('/invites/inv_t_goa/accept'), {})).status).toBe(409);
    expect((await preview(code, late)).body.state).toBe('pending');
    expect((await t.api(late, 'POST', v1(`/invites/${code}/accept`), {})).status).toBe(200);
    expect((await t.api(t.as('p_rahul'), 'GET', v1('/trips/t_goa/invite'))).body).toEqual({ invite_url: `https://go.example/j/${code}`, code });
    expect((await h.go.call('read_trip', { trip_id: 't_goa' })).result.invite_url).toBe(`https://go.example/j/${code}`);
    expect((await t.api(t.as('p_rahul'), 'GET', v1('/trips/t_goa'))).body.invite_url).toBe(`https://go.example/j/${code}`);
    expect((await rows(h.pool, `select code, revoked_at is not null as revoked from invites where trip_id = 't_goa' order by created_at`)).map((x) => [x.code, x.revoked])).toEqual([['inv_t_goa', true], [code, false]]);
  });

  it('a trip that is over answers expired', async () => {
    await h.pool.query(`update trips set status = 'over' where trip_id = 't_goa'`);
    const code = (await rows(h.pool, `select invite_code from trips where trip_id = 't_goa'`))[0].invite_code;
    expect((await preview(code)).body.state).toBe('expired');
    await h.pool.query(`update trips set status = 'planning' where trip_id = 't_goa'`);
  });
});

describe('a link that no longer works', () => {
  it('revoked or expired: the trip\'s title only, no faces, no count, no dates; a working link still shows them', async () => {
    await seedTrip(h.pool, 't_closed', [{ id: 'p_olga', name: 'Olga', role: 'organizer' }, { id: 'p_nina', name: 'Nina' }]);
    const working = await preview('inv_t_closed');
    expect([working.status, working.body.state, working.body.trip, working.body.people_preview, working.body.joined_count]).toEqual([
      200, 'pending', { trip_id: 't_closed', title: 'Goa 🌴', dates: { start: '2026-11-06', end: '2026-11-09' } }, [{ person_id: 'p_olga', name: 'Olga' }, { person_id: 'p_nina', name: 'Nina' }], 2,
    ]);
    const rotated = await t.api(t.as('p_olga'), 'POST', v1('/trips/t_closed/invite/rotate'));
    expect(rotated.status).toBe(200);
    const revoked = await preview('inv_t_closed');
    expect([revoked.status, revoked.body.state, revoked.body.trip, revoked.body.people_preview, revoked.body.joined_count]).toEqual([200, 'revoked', { trip_id: 't_closed', title: 'Goa 🌴' }, [], 0]);
    const fresh = await preview(rotated.body.code); // the new link works: members and dates
    expect([fresh.body.state, fresh.body.trip.dates, fresh.body.joined_count, fresh.body.people_preview.length]).toEqual(['pending', { start: '2026-11-06', end: '2026-11-09' }, 2, 2]);
    await h.pool.query(`update trips set status = 'over' where trip_id = 't_closed'`);
    const expired = await preview(rotated.body.code);
    expect([expired.status, expired.body.state, expired.body.trip, expired.body.people_preview, expired.body.joined_count]).toEqual([200, 'expired', { trip_id: 't_closed', title: 'Goa 🌴' }, [], 0]);
  });
});

describe('the limit on previews', () => {
  it('after 30 previews in a minute from one address the next is 429 with a wait; a 429 names retry_after_seconds', async () => {
    const answers: number[] = [];
    for (let i = 0; i < 31; i++) answers.push((await preview('inv_t_goa')).status);
    const refused = answers.filter((s) => s === 429).length;
    expect([refused >= 1, answers.filter((s) => s === 200).length <= 30, answers.at(-1)]).toEqual([true, true, 429]);
    const r = await preview('inv_t_goa');
    expect([r.body.error.code, r.body.error.retry_after_seconds >= 1, r.headers['retry-after']]).toEqual(['rate_limited', true, String(r.body.error.retry_after_seconds)]);
  });
});
