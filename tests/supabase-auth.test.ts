// Sign-in with Supabase access tokens, proved locally against a fake Supabase Auth (tests/helpers/fake-supabase-auth.ts)
// that publishes keys and issues tokens exactly the way Supabase does. No network, no account.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupabaseAuth } from '../src/api/auth.js';
import { check } from '../src/contract/index.js';
import { FakeSupabaseAuth } from './helpers/fake-supabase-auth.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';

const LEGACY_SECRET = 'legacy-project-jwt-secret-at-least-32-characters';
const auth = new FakeSupabaseAuth();
let h: Harness;
beforeAll(async () => {
  await auth.start();
  h = await startHarness({ seed: false, makeAuth: (pool) => new SupabaseAuth({ supabaseUrl: auth.url, pool, jwtSecret: LEGACY_SECRET }) });
});
afterAll(async () => {
  await h.stop();
  await auth.close();
});

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const api = async (token: string | null, method: Method, url: string, payload?: unknown) => {
  const r = await h.app.inject({ method, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};

describe('the first sign-in creates the person from the Google profile', () => {
  it('GET /app/v1/me with a fresh Supabase token: a person with the Google name and photo, linked to the Supabase user', async () => {
    const token = await auth.mint({ name: 'Asha Rao', email: 'asha@gmail.com', picture: 'https://lh3.googleusercontent.com/a/asha' });
    const me = await api(token, 'GET', '/app/v1/me');
    expect(me.status).toBe(200);
    expect(me.body).toEqual({
      person_id: expect.any(String), name: 'Asha Rao', photo_url: 'https://lh3.googleusercontent.com/a/asha', has_upi: false, upi_id_masked: null,
      email: 'asha@gmail.com', auth_provider: 'google', from_city: null, notifications_enabled: true, counts: { active_trips: 0, past_trips: 0, pending_invites: 0 }, created_at: expect.any(String),
    });
    const [row] = await rows(h.pool, 'select name, email, auth_user_id, auth_provider from people where person_id = $1', [me.body.person_id]);
    expect(row).toEqual({ name: 'Asha Rao', email: 'asha@gmail.com', auth_user_id: auth.userId({ email: 'asha@gmail.com' }), auth_provider: 'google' });
  });

  it('a later sign-in (a new token for the same user) is the same person', async () => {
    const first = await api(await auth.mint({ name: 'Asha Rao', email: 'asha@gmail.com' }), 'GET', '/app/v1/me');
    const again = await api(await auth.mint({ name: 'Asha R.', email: 'asha@gmail.com' }), 'GET', '/app/v1/me');
    expect(again.body.person_id).toBe(first.body.person_id);
    expect(again.body.name).toBe('Asha Rao'); // later Google names never overwrite what the person set
  });

  it('five first requests at the same moment create exactly one person', async () => {
    const token = await auth.mint({ name: 'Ben', email: 'ben@gmail.com' });
    const answers = await Promise.all(Array.from({ length: 5 }, () => api(token, 'GET', '/app/v1/me')));
    expect(new Set(answers.map((a) => a.body.person_id)).size).toBe(1);
    expect((await rows(h.pool, 'select count(*)::int as n from people where auth_user_id = $1', [auth.userId({ email: 'ben@gmail.com' })]))[0].n).toBe(1);
  });

  it('with no name from Google, the start of the email address; a photo that is not https is left out', async () => {
    const token = await auth.mint({ name: '', email: 'kabir.s@gmail.com', picture: 'http://insecure.example/p.jpg' });
    const me = await api(token, 'GET', '/app/v1/me');
    expect(me.body).toMatchObject({ name: 'kabir.s', photo_url: null });
  });
});

describe('the whole app works with Supabase tokens', () => {
  it('create a trip, join it, talk, change a profile: Go gets every event and never the email', async () => {
    const asha = await auth.mint({ name: 'Asha Rao', email: 'asha@gmail.com' });
    const ben = await auth.mint({ name: 'Ben', email: 'ben@gmail.com' });
    const trip = await api(asha, 'POST', '/app/v1/trips', { title: 'Goa with Supabase sign-in' });
    expect(trip.status).toBe(201);
    const code = trip.body.invite_url.split('/j/')[1];
    expect((await api(ben, 'POST', `/app/v1/invites/${code}/accept`, { join_answers: { from_city: 'Pune' } })).body).toMatchObject({ landing: 'trip_home' });
    expect((await api(ben, 'POST', `/app/v1/trips/${trip.body.trip_id}/messages`, { client_message_id: 'sb-1', text: '@Go hello from Supabase' })).status).toBe(201);
    expect((await api(asha, 'PATCH', '/app/v1/me', { name: 'Asha' })).status).toBe(200);
    await h.flush();
    const events = h.go.events.filter((e) => e.trip_id === trip.body.trip_id);
    expect(events.map((e) => e.type)).toEqual(['trip.created', 'person.joined', 'message.created', 'person.updated']);
    for (const e of events) expect(check('Event', e)).toMatchObject({ ok: true });
    expect(events[0]!.data.trip.people[0]).toMatchObject({ name: 'Asha Rao', role: 'organizer' });
    expect(events[3]!.data).toMatchObject({ changed: ['name'], person: { name: 'Asha' } });
    expect(JSON.stringify(events)).not.toMatch(/@gmail\.com/); // contact details never reach Go
  });

  it('POST /app/v1/dev/sign-in (dev sign-in) does not exist in supabase mode', async () => {
    expect((await api(null, 'POST', '/app/v1/dev/sign-in', { name: 'Mallory' })).status).toBe(404);
  });
});

describe('every kind of bad token is refused with 401', () => {
  const refused = async (token: string | null, why: RegExp = /not valid/) => {
    const r = await api(token, 'GET', '/app/v1/me');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('unauthorized');
    expect(r.body.error.message).toMatch(why);
  };
  it('no token', () => refused(null, /sign in first/));
  it('an expired token, with a message telling the app to refresh', async () => refused(await auth.mint({ name: 'Old' }, { expiresIn: -120 }), /expired: refresh/));
  it('a token from another Supabase project (wrong issuer)', async () => refused(await auth.mint({ name: 'X' }, { issuer: 'https://other.supabase.co/auth/v1' })));
  it('a token meant for another audience', async () => refused(await auth.mint({ name: 'X' }, { audience: 'service_role' })));
  it("the project's anon/publishable key (an app key, not a person)", async () => refused(await auth.anonKey()));
  it('a token with role anon', async () => refused(await auth.mint({ name: 'X' }, { role: 'anon' })));
  it('an anonymous Supabase user', async () => refused(await auth.mint({ name: 'X' }, { isAnonymous: true })));
  it('a token signed with a key the project never published (forged)', async () => refused(await auth.mint({ name: 'X' }, { unpublishedKey: true })));
  it('a token whose claims were changed after signing', async () => {
    const [head, , sig] = (await auth.mint({ name: 'X' })).split('.');
    const forged = Buffer.from(JSON.stringify({ sub: '00000000-0000-0000-0000-000000000000', role: 'authenticated', aud: 'authenticated', iss: `${auth.url}/auth/v1`, exp: 9999999999 })).toString('base64url');
    await refused(`${head}.${forged}.${sig}`);
  });
  it('an unsigned token (alg none)', async () => {
    const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    await refused(`${part({ alg: 'none', typ: 'JWT' })}.${part({ sub: auth.userId({ email: 'asha@gmail.com' }), role: 'authenticated', aud: 'authenticated', iss: `${auth.url}/auth/v1`, exp: 9999999999 })}.`);
  });
  it('one of our own dev tokens', async () => refused('s1.eyJzdWIiOiJwXzEifQ.abc'));
  it('garbage', () => refused('not-a-token'));
});

describe('projects still on the legacy shared secret (HS256)', () => {
  it('a token signed with the project secret is accepted', async () => {
    const r = await api(await auth.mintLegacy(LEGACY_SECRET, { name: 'Legacy Lata', email: 'lata@gmail.com' }), 'GET', '/app/v1/me');
    expect(r).toMatchObject({ status: 200, body: { name: 'Legacy Lata', auth_provider: 'email' } }); // no provider in the token: a test user
  });
  it('a token signed with another secret is refused', async () => {
    expect((await api(await auth.mintLegacy('some-other-secret-that-is-also-long-enough', { name: 'X' }), 'GET', '/app/v1/me')).status).toBe(401);
  });
  it('without SUPABASE_JWT_SECRET configured, HS256 tokens are refused (only the published keys count)', async () => {
    const strict = new SupabaseAuth({ supabaseUrl: auth.url, pool: h.pool });
    expect(await strict.personFor(await auth.mintLegacy(LEGACY_SECRET, { name: 'X' }))).toEqual({ error: 'invalid' });
    expect(await strict.personFor(await auth.mint({ name: 'Asha Rao', email: 'asha@gmail.com' }))).toHaveProperty('personId');
  });
});

describe('migration 003 on a plain Postgres', () => {
  it('links people to Supabase users and turns row-level security on for every table', async () => {
    expect((await rows(h.pool, "select data_type from information_schema.columns where table_name = 'people' and column_name = 'auth_user_id'"))[0]).toEqual({ data_type: 'uuid' });
    const open = await rows(h.pool, "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity");
    expect(open).toEqual([]); // every table, including any added by later migrations, must turn RLS on
  });
});
