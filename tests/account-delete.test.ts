// §4.1 DELETE /me: the deletion sequence in order (Go forgets, answers cleared, every trip left, messages read "Former
// member", email/UPI/photo gone), the token refused afterwards, and nothing at all when Go does not answer.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, v1, type Harness } from './helpers/harness.js';
import { seedTrip } from './helpers/seed.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness(); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
  await seedTrip(h.pool, 't_other', [{ id: 'p_orgx', name: 'Orgx', role: 'organizer' }]);
});
afterAll(() => h.stop());

describe('deleting an account', () => {
  it('in order: Go forgets everywhere, the answers go, every trip is left, the person reads "Former member", contact details go; the token stops working; messages, votes and the room stay', async () => {
    const kabir = t.as('p_kabir');
    await h.pool.query(`update people set photo_url = 'https://x.example/kabir.png' where person_id = 'p_kabir'`);
    await t.api(kabir, 'PUT', v1('/trips/t_goa/me/join-answers'), { from_city: 'Pune' });
    await t.api(kabir, 'PUT', v1('/me/upi'), { upi_id: 'kabir@okbank' });
    const m = await t.api(kabir, 'POST', v1('/trips/t_goa/messages'), { client_message_id: 'k1', text: 'I booked the cab' });
    await t.api(kabir, 'POST', v1('/invites/inv_t_other/later'));
    const vote = (await h.go.call('open_vote', { request_id: 'rq_v1', trip_id: 't_goa', question: 'Where?', kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }] })).result;
    await t.api(kabir, 'PUT', v1(`/trips/t_goa/decisions/${vote.decision_id}/vote`), { option_index: 0 });
    await h.flush();
    const mark = h.go.events.length;
    const before = h.go.requests.length;

    const r = await t.api(kabir, 'DELETE', v1('/me'), { confirm: true });
    await h.flush();
    expect([r.status, r.body]).toEqual([202, null]);
    expect(h.go.requests.slice(before).map((q) => [q.method, q.params])).toEqual([['forget_person', { person_id: 'p_kabir' }]]); // everywhere: no trip id
    const after = h.go.events.slice(mark).map((e) => [e.type, e.data.changed ?? e.data.person_id ?? e.data.by?.kind]);
    expect(after).toEqual([
      ['person.updated', ['from_city', 'earliest_leave', 'know']], // the answers cleared, while he was still in the trip
      ['person.left', 'p_kabir'], // and nothing after it: no budget event
    ]);
    expect((await rows(h.pool, `select name, photo_url, email, phone, upi_id, from_city_default, deleted_at is not null as deleted, auth_user_id is not null as linked from people where person_id = 'p_kabir'`))[0])
      .toEqual({ name: 'Former member', photo_url: null, email: null, phone: null, upi_id: null, from_city_default: null, deleted: true, linked: true });
    expect((await rows(h.pool, `select left_at is not null as left, from_city from trip_people where person_id = 'p_kabir'`))).toEqual([{ left: true, from_city: null }]);
    expect(await rows(h.pool, `select 1 from invite_marks where person_id = 'p_kabir'`)).toEqual([]);
    // What stays: the message (its author now reads "Former member"), the vote he cast.
    expect((await rows(h.pool, 'select text, author_person_id from messages where message_id = $1', [m.body.message_id]))[0]).toEqual({ text: 'I booked the cab', author_person_id: 'p_kabir' });
    expect((await rows(h.pool, 'select count(*)::int as n from votes where person_id = $1', ['p_kabir']))[0].n).toBe(1);
    const room = (await t.api(t.as('p_rahul'), 'GET', v1('/trips/t_goa/messages?after_seq=0'))).body.messages.find((x: any) => x.message_id === m.body.message_id);
    expect(room).toMatchObject({ text: 'I booked the cab', author: { kind: 'person', person_id: 'p_kabir' } });
    const snap = (await h.go.call('read_trip', { trip_id: 't_goa' })).result;
    expect(snap.people.map((p: any) => p.person_id)).not.toContain('p_kabir');
    // His token is refused from now on, everywhere.
    expect((await t.api(kabir, 'GET', v1('/me'))).status).toBe(401);
    expect((await t.api(kabir, 'GET', v1('/home'))).status).toBe(401);
    expect((await t.api(kabir, 'POST', v1('/trips/t_goa/messages'), { client_message_id: 'k2', text: 'still here?' })).status).toBe(401);
    expect((await t.api(kabir, 'DELETE', v1('/me'), { confirm: true })).status).toBe(401);
    expect((await t.api(null, 'GET', v1('/invites/inv_t_goa'))).body.joined_count).toBe(4);
  });

  it('when Go does not answer, nothing happens: 502 go_unavailable, still a member, still a person', async () => {
    const saved = h.go.answers.forget_person!;
    h.go.answers.forget_person = () => ({ error: { code: 503, message: 'deploy', data: { code: 'unavailable' } } });
    const meher = t.as('p_meher');
    const mark = h.go.events.length;
    const r = await t.api(meher, 'DELETE', v1('/me'), { confirm: true });
    await h.flush();
    expect([r.status, r.body.error.code, h.go.events.length - mark]).toEqual([502, 'go_unavailable', 0]);
    expect((await rows(h.pool, `select name, deleted_at from people where person_id = 'p_meher'`))[0]).toEqual({ name: 'Meher', deleted_at: null });
    expect((await t.api(meher, 'GET', v1('/me'))).status).toBe(200);
    h.go.answers.forget_person = () => null; // silent: a timeout is a failure too
    expect((await t.api(meher, 'DELETE', v1('/me'), { confirm: true })).status).toBe(502);
    h.go.answers.forget_person = saved;
  });

  it('needs { confirm: true } and nothing else; the write is idempotent under one key', async () => {
    const arjun = t.as('p_arjun');
    expect((await t.api(arjun, 'DELETE', v1('/me'), {})).body.error.field).toBe('confirm');
    expect((await t.api(arjun, 'DELETE', v1('/me'), { confirm: false })).status).toBe(422);
    expect((await t.api(arjun, 'DELETE', v1('/me'), { confirm: true, why: 'leaving' })).status).toBe(422);
    expect((await t.api(null, 'DELETE', v1('/me'), { confirm: true })).status).toBe(401);
    expect((await rows(h.pool, `select deleted_at from people where person_id = 'p_arjun'`))[0].deleted_at).toBeNull();
  });
});
