// The App team's internal routes (rev 5 D): hidden (404) without INTERNAL_API_KEY or with a wrong key, never any CORS,
// rate-limited, one log line per call with ids only; and with the key, the same effects as the person's own routes:
// the account delete, forget, and resetting a test trip.
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { INTERNAL_CALLS_PER_MINUTE } from '../src/api/internal.js';
import { TRIP_TABLES } from '../src/domain/trip-reset.js';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, v1, type Harness } from './helpers/harness.js';

const KEY = 'test-internal-key-0123456789abcdef';
const ORIGIN = 'https://web.example';

let h: Harness;
let t: ReturnType<typeof appApi>;
let keyed: FastifyInstance;
beforeAll(async () => {
  h = await startHarness({ origins: [ORIGIN] }); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir. h.app runs without the key.
  t = appApi(h);
  keyed = buildApp({ ctx: h.ctx, go: h.socket, sessionSecret: h.sessionSecret, origins: [ORIGIN], internalKey: KEY });
  await keyed.ready();
});
afterAll(async () => {
  await keyed.close();
  await h.stop();
});
afterEach(() => vi.restoreAllMocks());

type Call = { method: 'GET' | 'POST' | 'DELETE' | 'OPTIONS'; url: string; payload?: object; headers?: Record<string, string> };
const call = async (app: FastifyInstance, c: Call, key: string | null = KEY) => {
  const r = await app.inject({ method: c.method, url: c.url, payload: c.payload, headers: { ...(key === null ? {} : { 'x-internal-key': key }), ...c.headers } });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, headers: r.headers };
};
const ROUTES: Call[] = [
  { method: 'GET', url: '/internal/v1/people?email=p_priya@mail.test' },
  { method: 'DELETE', url: '/internal/v1/people/p_priya' },
  { method: 'POST', url: '/internal/v1/people/p_priya/forget', payload: {} },
  { method: 'POST', url: '/internal/v1/trips/t_goa/reset' },
];

describe('hidden unless the key matches', () => {
  it('without INTERNAL_API_KEY every route answers 404 like an unknown path, even with a key sent', async () => {
    for (const c of ROUTES) {
      const r = await call(h.app, c);
      expect([r.status, r.body.error.code, r.body.error.message]).toEqual([404, 'not_found', `no route ${c.method} ${c.url.split('?')[0]}`]);
    }
    expect((await rows(h.pool, `select count(*)::int as n from trips where trip_id = 't_goa'`))[0].n).toBe(1);
  });

  it('with the key set, a missing or wrong key is the same 404, before any rule about the body or query is checked', async () => {
    for (const c of ROUTES) {
      for (const key of [null, '', 'wrong', `${KEY}x`]) expect((await call(keyed, c, key)).status).toBe(404);
    }
    expect((await call(keyed, { method: 'GET', url: '/internal/v1/people' }, 'wrong')).status).toBe(404); // no email: still 404, not 422
    expect((await call(keyed, { method: 'POST', url: '/internal/v1/people/p_priya/forget', payload: { colour: 1 } }, null)).status).toBe(404);
    expect(h.go.requests.filter((q) => q.method === 'forget_person')).toEqual([]);
  });

  it('never a CORS header: a preflight from the web app\'s own origin is not answered, and no response carries allow-origin', async () => {
    const preflight = await call(keyed, { method: 'OPTIONS', url: '/internal/v1/people?email=x@y.z', headers: { origin: ORIGIN, 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-internal-key' } });
    expect([preflight.status, preflight.headers['access-control-allow-origin'], preflight.headers['access-control-allow-headers']]).toEqual([404, undefined, undefined]);
    const get = await call(keyed, { method: 'GET', url: '/internal/v1/people?email=p_priya@mail.test', headers: { origin: ORIGIN } });
    expect([get.status, get.headers['access-control-allow-origin'], get.headers.vary]).toEqual([200, undefined, undefined]);
    // The app's own routes keep theirs.
    expect((await call(keyed, { method: 'GET', url: v1('/config'), headers: { origin: ORIGIN } }, null)).headers['access-control-allow-origin']).toBe(ORIGIN);
  });
});

describe('with the key', () => {
  it('GET /people?email= finds the person (any case), with name, created_at and deleted; 404 for an unknown email; logs no email', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const r = await call(keyed, { method: 'GET', url: '/internal/v1/people?email=P_Priya@Mail.Test' });
    expect([r.status, r.headers['cache-control'], r.body]).toEqual([200, 'no-store', { person_id: 'p_priya', name: 'Priya', created_at: expect.stringMatching(/^\d{4}-/), deleted: false }]);
    expect((await call(keyed, { method: 'GET', url: '/internal/v1/people?email=nobody@mail.test' })).status).toBe(404);
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[internal]'));
    expect(lines).toEqual(['[internal] GET /people by email → 200', '[internal] GET /people by email → 404']);
  });

  it('POST /people/:id/forget is DELETE /me/go: Go forgets in the trip (or everywhere) and the join answers there go', async () => {
    await t.api(t.as('p_meher'), 'PUT', v1('/trips/t_goa/me/join-answers'), { from_city: 'Pune' });
    const before = h.go.requests.length;
    const one = await call(keyed, { method: 'POST', url: '/internal/v1/people/p_meher/forget', payload: { trip_id: 't_goa' } });
    const all = await call(keyed, { method: 'POST', url: '/internal/v1/people/p_meher/forget' });
    expect([one.status, one.body, all.status]).toEqual([200, { deleted_facts: 3, remaining_facts: 0 }, 200]);
    expect(h.go.requests.slice(before).map((q) => [q.method, q.params])).toEqual([
      ['forget_person', { person_id: 'p_meher', trip_id: 't_goa' }],
      ['forget_person', { person_id: 'p_meher' }],
    ]);
    expect((await rows(h.pool, `select from_city from trip_people where trip_id = 't_goa' and person_id = 'p_meher'`))[0].from_city).toBeNull();
    expect((await call(keyed, { method: 'POST', url: '/internal/v1/people/p_nobody/forget' })).status).toBe(404);
    expect((await call(keyed, { method: 'POST', url: '/internal/v1/people/p_meher/forget', payload: { trip_id: 't_elsewhere' } })).status).toBe(403); // never in that trip
  });

  it('DELETE /people/:id is DELETE /me: 202, Go forgets everywhere, the person reads "Former member", their token gets 401; then 404', async () => {
    const kabir = t.as('p_kabir');
    expect((await t.api(kabir, 'GET', v1('/me'))).status).toBe(200);
    const before = h.go.requests.length;
    const r = await call(keyed, { method: 'DELETE', url: '/internal/v1/people/p_kabir' });
    expect([r.status, r.body]).toEqual([202, null]);
    expect(h.go.requests.slice(before).map((q) => [q.method, q.params])).toEqual([['forget_person', { person_id: 'p_kabir' }]]);
    expect((await rows(h.pool, `select name, email, deleted_at is not null as deleted from people where person_id = 'p_kabir'`))[0]).toEqual({ name: 'Former member', email: null, deleted: true });
    expect((await rows(h.pool, `select left_at is not null as left from trip_people where person_id = 'p_kabir'`))).toEqual([{ left: true }]);
    expect((await t.api(kabir, 'GET', v1('/me'))).status).toBe(401);
    expect((await call(keyed, { method: 'DELETE', url: '/internal/v1/people/p_kabir' })).status).toBe(404); // already deleted
  });

  it('POST /trips/:id/reset deletes the trip and everything in it, outbox included; Go then gets not_found; the people stay; then 404', async () => {
    const rahul = t.as('p_rahul');
    const priya = t.as('p_priya');
    await t.api(rahul, 'POST', v1('/trips/t_goa/messages'), { client_message_id: 'r1', text: 'Hello' });
    const vote = (await h.go.call('open_vote', { request_id: 'rq_reset_v', trip_id: 't_goa', question: 'Where?', kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }] })).result;
    await t.api(priya, 'PUT', v1(`/trips/t_goa/decisions/${vote.decision_id}/vote`), { option_index: 0 });
    const booking = (await t.api(rahul, 'POST', v1('/trips/t_goa/bookings'), { kind: 'stay', title: 'Villa Sol', vendor: 'ixigo', ref: 'R1', amount_minor: 100000, payer_person_id: 'p_rahul', for_person_ids: ['p_rahul'] })).body;
    await t.api(rahul, 'POST', v1('/trips/t_goa/expenses'), { paid_by_person_id: 'p_rahul', amount_minor: 2000, note: 'Chai', category: 'food', split_person_ids: ['p_rahul', 'p_priya'] });
    await t.api(priya, 'POST', v1('/trips/t_goa/settlements'), { to_person_id: 'p_rahul', amount_minor: 1000, currency: 'INR', method: 'cash' });
    await h.go.call('add_record_line', { request_id: 'rq_reset_l', trip_id: 't_goa', kind: 'open', text: 'Sunscreen', proof: [], person_ids: ['p_priya'] });
    expect(booking.booking_id).toEqual(expect.any(String));
    const pending = (await rows(h.pool, `select count(*)::int as n from outbox where trip_id = 't_goa' and status = 'pending'`))[0].n;
    expect(pending).toBeGreaterThan(0); // events not sent yet: they must go with the trip

    const homes = h.live.events.length;
    const r = await call(keyed, { method: 'POST', url: '/internal/v1/trips/t_goa/reset' });
    expect([r.status, r.body]).toEqual([200, { deleted: true }]);
    const counts = await rows(h.pool, TRIP_TABLES.map((table) => table === 'votes' ? `select 'votes' as t, count(*)::int as n from votes where decision_id = '${vote.decision_id}'`
      : ['checkins', 'booking_documents'].includes(table) ? `select '${table}' as t, count(*)::int as n from ${table} where booking_id = '${booking.booking_id}'`
        : `select '${table}' as t, count(*)::int as n from ${table} where trip_id = 't_goa'`).join(' union all '));
    expect(counts.filter((c) => c.n !== 0)).toEqual([]);
    expect((await rows(h.pool, `select count(*)::int as n from people where person_id in ('p_rahul', 'p_priya')`))[0].n).toBe(2);
    // Everyone who was in it hears home_changed; the trip is gone from their home; Go reads not_found.
    expect(h.live.events.slice(homes).filter((e) => e.event.kind === 'home').map((e) => (e.event as { person_id: string }).person_id).sort()).toEqual(['p_arjun', 'p_meher', 'p_priya', 'p_rahul']); // Kabir deleted his account above
    expect((await t.api(rahul, 'GET', v1('/home'))).body.trips.map((x: any) => x.trip_id)).not.toContain('t_goa');
    expect((await t.api(rahul, 'GET', v1('/trips/t_goa'))).status).toBe(403);
    expect((await h.go.call('read_trip', { trip_id: 't_goa' })).error).toMatchObject({ code: 404, data: { code: 'not_found' } });
    await h.flush(); // nothing is left to send for it
    expect((await call(keyed, { method: 'POST', url: '/internal/v1/trips/t_goa/reset' })).status).toBe(404);
  });

  it('the reset covers every table that has a trip_id column', async () => {
    const withTripId = (await rows(h.pool, `select table_name from information_schema.columns where table_schema = 'public' and column_name = 'trip_id' order by table_name`)).map((r) => r.table_name);
    expect(withTripId.filter((name) => !(TRIP_TABLES as readonly string[]).includes(name))).toEqual([]);
  });

  it(`at most ${INTERNAL_CALLS_PER_MINUTE} calls a minute: then 429`, async () => {
    const fresh = buildApp({ ctx: h.ctx, go: h.socket, sessionSecret: h.sessionSecret, internalKey: KEY });
    await fresh.ready();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const statuses: number[] = [];
    for (let i = 0; i <= INTERNAL_CALLS_PER_MINUTE; i++) statuses.push((await call(fresh, { method: 'GET', url: '/internal/v1/people?email=p_rahul@mail.test' })).status);
    await fresh.close();
    expect([statuses.slice(0, -1).every((s) => s === 200), statuses.at(-1)]).toEqual([true, 429]);
  });
});
