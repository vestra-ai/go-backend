// Found by the end-to-end run against production Go (11 Oct 2026): a stranger learning a query rule before the 403, an
// itinerary 422 that named only the day, refused vault-link calls using up the allowance, buttonless Go notices waiting
// in "needs you" for ever, a deleted person's name left in the room's pills, and socket logs that said too little.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sections } from '../src/api/v1/index.js';
import { GoSocket } from '../src/go/go-socket.js';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, v1, type Harness } from './helpers/harness.js';
import { MockGo } from './helpers/mock-go.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness({ features: { checkin: true } }); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
});
afterAll(() => h.stop());
afterEach(() => vi.restoreAllMocks());

const trip = v1('/trips/t_goa');

describe('a stranger gets 403 before any query rule', () => {
  it('on the six routes with a query schema, a bad value is 403, not 422 naming the field', async () => {
    const x = t.as('p_stranger');
    const answers = await Promise.all([
      t.api(x, 'GET', `${trip}?include=${'a'.repeat(201)}`),
      t.api(x, 'GET', `${trip}/messages?limit=0`),
      t.api(x, 'GET', `${trip}/catch-up?force=maybe`),
      t.api(x, 'GET', `${trip}/record?include_undone=maybe`),
      t.api(x, 'GET', `${trip}/itinerary?scope=nobody`),
      t.api(x, 'GET', `${trip}/cards?kind=BAD`),
    ]);
    expect(answers.map((r) => [r.status, r.body.error?.code, r.body.error?.field ?? null])).toEqual(Array(6).fill([403, 'forbidden', null]));
    // A member still gets the 422 naming the field.
    expect((await t.api(t.as('p_rahul'), 'GET', `${trip}/messages?limit=0`)).body.error).toMatchObject({ code: 'invalid', field: 'limit' });
  });

  it('every route of a trip, for a trip that exists and one that does not, with every bad query value at once', async () => {
    const query = `?include=${'a'.repeat(201)}&limit=0&force=x&include_undone=x&scope=x&kind=BAD&state=BAD&before_seq=-1&after_seq=-1&filter=x&status=x`;
    const routes = sections.flatMap((s) => s.routes).filter((r) => r.path.startsWith('/app/v1/trips/:trip') && !r.dev);
    expect(routes.length).toBeGreaterThan(40);
    for (const tripId of ['t_goa', 't_nope']) {
      for (const r of routes) {
        const url = r.path.replace(':trip', tripId).replace(/:[a-z_]+/g, 'x') + query;
        const a = await t.api(t.as('p_stranger'), r.method, url, r.method === 'GET' || r.method === 'DELETE' ? undefined : { junk: true });
        expect([r.method, r.path, a.status, a.body?.error?.code]).toEqual([r.method, r.path, 403, 'forbidden']);
      }
    }
  });

  it('someone who left gets 403 too, but a repeated leave with its Idempotency-Key still gets its stored 204', async () => {
    const leaver = await t.person('Lea Ver');
    await t.api(leaver, 'POST', v1('/invites/inv_t_goa/accept'), {});
    const key = { 'idempotency-key': 'leave-once' };
    const first = await t.api(leaver, 'POST', `${trip}/leave`, {}, key);
    const again = await t.api(leaver, 'POST', `${trip}/leave`, {}, key);
    const read = await t.api(leaver, 'GET', `${trip}/cards?kind=BAD`);
    expect([first.status, again.status, again.headers['idempotent-replayed'], read.status]).toEqual([204, 204, 'true', 403]);
  });
});

describe('the itinerary 422', () => {
  it('names the exact field inside the day', async () => {
    const rahul = t.as('p_rahul');
    const ok = { title: 'Beach', category: 'activities', status: 'planned' };
    const missing = await t.api(rahul, 'PATCH', trip, { itinerary: [{ date: '2026-11-06', items: [ok] }, { date: '2026-11-07', items: [ok, { title: 'x', status: 'planned' }] }] });
    const wrong = await t.api(rahul, 'PATCH', trip, { itinerary: [{ date: '2026-11-06', items: [{ ...ok, time: '25:00' }] }] });
    const noItems = await t.api(rahul, 'PATCH', trip, { itinerary: [{ date: '2026-11-06' }] });
    expect([missing, wrong, noItems].map((r) => [r.status, r.body.error.field])).toEqual([
      [422, 'itinerary[1].items[1].category'],
      [422, 'itinerary[0].items[0].time'],
      [422, 'itinerary[0].items'],
    ]);
  });
});

describe('the vault-link allowance', () => {
  it('counts only calls that reach Go: six refused calls, then a good one still works', async () => {
    const who = t.as('p_meher');
    const refused = [];
    for (let i = 0; i < 6; i++) refused.push((await t.api(who, 'POST', v1('/me/vault-link'), { start: 'add_card', display: 'embedded' })).status);
    refused.push((await t.api(who, 'POST', v1('/me/vault-link'), { context: { trip_id: 't_nope', purpose: 'visa' } })).status);
    const good = await t.api(who, 'POST', v1('/me/vault-link'), {});
    expect([refused, good.status]).toEqual([[422, 422, 422, 422, 422, 422, 403], 200]);
  });
});

describe('"needs you" and Go notices', () => {
  it('a card naming me with no button is not an item; one with an action or a suggestion cta is; trip, strip and home agree', async () => {
    await h.go.call('post_message', { request_id: 'rq_pf_1', trip_id: 't_goa', text: 'FYI', card: { card_id: 'c_pf_info', kind: 'notice', fallback_text: 'Go forgot you in this trip', title: 'Forgotten', body: 'x', tone: 'info', for_person_ids: ['p_arjun'] } });
    await h.go.call('post_message', { request_id: 'rq_pf_2', trip_id: 't_goa', text: 'FYI', card: { card_id: 'c_pf_skip', kind: 'notice', fallback_text: 'ixigo login skipped', title: 'Skipped', body: 'x', tone: 'info', for_person_ids: ['p_arjun'], actions: [] } });
    await h.go.call('post_message', { request_id: 'rq_pf_3', trip_id: 't_goa', text: 'Visa', card: { card_id: 'c_pf_visa', kind: 'checklist', fallback_text: 'Visa for Arjun', title: 'Indonesia e-VOA', rows: [{ person_id: 'p_arjun', status: 'todo', label: 'Not yet' }], for_person_ids: ['p_arjun'], suggestion: { text: 'Start it now', cta: { action_id: 'start', label: 'Start' } } } });
    await h.go.call('post_message', { request_id: 'rq_pf_4', trip_id: 't_goa', text: 'Cab?', card: { card_id: 'c_pf_cab', kind: 'notice', fallback_text: 'Airport cab', title: 'Cab', body: 'x', tone: 'heads_up', for_person_ids: ['p_arjun'], actions: [{ action_id: 'book', label: 'Book', style: 'primary' }] } });
    const arjun = t.as('p_arjun');
    const strip = (await t.api(arjun, 'GET', `${trip}/needs-you`)).body.items;
    expect(strip.filter((i: any) => i.kind === 'card').map((i: any) => [i.target.card_id, i.cta_label])).toEqual([['c_pf_visa', 'Start'], ['c_pf_cab', 'Book']]);
    const view = (await t.api(arjun, 'GET', trip)).body;
    const home = (await t.api(arjun, 'GET', v1('/home'))).body;
    expect([view.needs_you_count, home.needs_you.total]).toEqual([strip.length, strip.length]);
    expect(home.needs_you.items.map((i: any) => i.target.card_id).filter(Boolean)).toEqual(['c_pf_visa', 'c_pf_cab']);
  });
});

describe('deleting an account takes the name out of the room', () => {
  it('every pill that named them reads "Former member"; a longer name, a person\'s words and other pills stay; apps and Go hear each change', async () => {
    const tara = await t.person('Tara Temp');
    const temple = await t.person('Tara Temple');
    await t.api(tara, 'POST', v1('/invites/inv_t_goa/accept'), {});
    await t.api(temple, 'POST', v1('/invites/inv_t_goa/accept'), {});
    await t.api(tara, 'POST', `${trip}/expenses`, { amount_minor: 200000, note: 'Dinner', category: 'food', split_person_ids: [tara.id, 'p_rahul'] });
    await t.api(t.as('p_rahul'), 'POST', `${trip}/expenses`, { amount_minor: 100000, note: 'Cab', category: 'getting_around', split_person_ids: [tara.id, 'p_rahul'], paid_by_person_id: tara.id });
    await t.api(t.as('p_rahul'), 'POST', `${trip}/settlements`, { to_person_id: tara.id, amount_minor: 50000, currency: 'INR', method: 'cash' });
    const said = await t.api(t.as('p_rahul'), 'POST', `${trip}/messages`, { client_message_id: 'pf_said', text: 'Tara Temp is driving' });
    const pillsNow = await rows(h.pool, `select text from messages where trip_id = 't_goa' and author_kind = 'system' and text like '%Tara Temp%' order by seq`);
    expect(pillsNow.map((r) => r.text)).toEqual([
      'Tara Temp joined', 'Tara Temple joined', 'Tara Temp added Dinner · ₹2,000 · split 2 ways', 'Rahul added Cab · ₹1,000 · paid by Tara Temp · split 2 ways', 'Rahul paid Tara Temp ₹500',
    ]);
    await h.flush();
    const seqBefore = (await rows(h.pool, `select seq from trips where trip_id = 't_goa'`))[0].seq as number;
    const mark = h.go.events.length;

    expect((await t.api(tara, 'DELETE', v1('/me'), { confirm: true })).status).toBe(202);
    await h.flush();

    const page = (await t.api(t.as('p_rahul'), 'GET', `${trip}/messages?after_seq=${seqBefore}`)).body.messages;
    expect(page.filter((m: any) => m.author.kind === 'system').map((m: any) => m.text)).toEqual([
      'Former member joined', 'Former member added Dinner · ₹2,000 · split 2 ways', 'Rahul added Cab · ₹1,000 · paid by Former member · split 2 ways', 'Rahul paid Former member ₹500', 'Former member left',
    ]);
    const all = (await t.api(t.as('p_rahul'), 'GET', `${trip}/messages?after_seq=0&limit=200`)).body.messages;
    expect(all.filter((m: any) => m.author.kind === 'system' && /Tara Temp(?!le)/.test(m.text ?? ''))).toEqual([]);
    expect(all.find((m: any) => m.message_id === said.body.message_id).text).toBe('Tara Temp is driving');
    expect(all.some((m: any) => m.text === 'Tara Temple joined' && !m.edited_at)).toBe(true);
    // Go: one message.edited per rewritten pill, by the system, before the leave.
    const toGo = h.go.events.slice(mark).map((e) => [e.type, e.data.message?.author?.kind ?? null, e.data.message?.text ?? null]);
    expect(toGo.filter(([type]) => type === 'message.edited')).toEqual([
      ['message.edited', 'system', 'Former member joined'],
      ['message.edited', 'system', 'Former member added Dinner · ₹2,000 · split 2 ways'],
      ['message.edited', 'system', 'Rahul added Cab · ₹1,000 · paid by Former member · split 2 ways'],
      ['message.edited', 'system', 'Rahul paid Former member ₹500'],
    ]);
    expect(page.filter((m: any) => m.author.kind === 'system').every((m: any) => !m.edited_at)).toBe(true);
  });
});

describe('logs', () => {
  const warned = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[go] '));

  it('Go asking about a trip this server does not have: one warn line saying so, the same not_found answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const read = await h.go.call('read_trip', { trip_id: 't_elsewhere' });
    const msgs = await h.go.call('read_messages', { trip_id: 't_elsewhere', after_seq: 0 });
    const other = await h.go.call('update_trip', { request_id: 'rq_pf_x', trip_id: 't_elsewhere', title: 'x' });
    expect([read.error, msgs.error].map((e) => [e.code, e.data?.code])).toEqual([[404, 'not_found'], [404, 'not_found']]);
    expect(warned(warn)).toEqual([
      '[go] read_trip for a trip this server does not have: t_elsewhere (not_found)',
      '[go] read_messages for a trip this server does not have: t_elsewhere (not_found)',
      `[go] update_trip answered 404 trip=t_elsewhere request=rq_pf_x: ${other.error.message}`,
    ]);
  });

  it('the socket to Go closing is logged with its code', async () => {
    const go = new MockGo();
    const base = await go.listen();
    const lines: string[] = [];
    const socket = new GoSocket({ url: `${base}/v1/socket?instance=log`, secret: go.secret, handlers: {}, log: (m) => lines.push(m) });
    try {
      socket.start();
      await go.untilConnected();
      go.dropSockets();
      const end = Date.now() + 3000;
      while (!lines.some((l) => l.startsWith('go socket closed')) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      expect(lines).toEqual(['go socket open', 'go socket closed 1006']);
    } finally {
      socket.stop();
      await go.close();
    }
  });
});
