// §4.12 Web check-in (app contract §4.12, GO-CHANGES 3), behind features.checkin: the state asked of Go and kept,
// the answers (seat rules, the paid seat as a payment), the submit (done, working, failed, silent), the companion, the
// strip's `checkin` item, the home card's task, and Go's "it's open" notice card.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { SupabaseAuth } from '../src/api/auth.js';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';
import { fakeCheckinState } from './helpers/mock-go.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness({ features: { checkin: true } }); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
});
afterAll(() => h.stop());

const JOURNEY = { mode: 'flight', origin: { name: 'Bengaluru', code: 'BLR' }, destination: { name: 'Mopa', code: 'GOX' }, depart_at: '2026-11-06T14:10:00Z', arrive_at: '2026-11-06T16:25:00Z', carrier_name: 'IndiGo', carrier_code: '6E', number: '5313' };
const ISO = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/);
/** The flight Rahul and Arjun share (Arjun already has 14B), a flight of Kabir's alone, a flight for Meher and Kabir, and a stay. */
let flight: string, kabirs: string, later: string, stay: string;
const addBooking = async (over: Record<string, unknown>) => {
  const r = await t.api(t.as('p_rahul'), 'POST', '/app/v1/trips/t_goa/bookings', { kind: 'flight', title: 'BLR → GOX · 6E 5313', vendor: 'ixigo', ref: 'K7QX2M', amount_minor: 1184000, payer_person_id: 'p_rahul', journey: JOURNEY, ...over });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.booking_id as string;
};
const url = (b: string, tail = '') => `/app/v1/trips/t_goa/bookings/${b}/checkin${tail}`;
const get = (who: string, b = flight) => t.api(t.as(who), 'GET', url(b));
const patch = (who: string, body: unknown, b = flight) => t.api(t.as(who), 'PATCH', url(b), body);
const complete = (who: string, b = flight) => t.api(t.as(who), 'POST', url(b, '/complete'), {});
const strip = async (who: string) => ((await t.api(t.as(who), 'GET', '/app/v1/trips/t_goa/needs-you')).body.items as any[]).filter((i) => i.kind === 'checkin');
const attention = async (who: string) => (await t.api(t.as(who), 'GET', '/app/v1/home')).body.trips.find((x: any) => x.trip_id === 't_goa').attention;
const refusal = (r: { status: number; body: any }) => [r.status, r.body.error.code];

beforeAll(async () => {
  flight = await addBooking({ for_person_ids: ['p_rahul', 'p_arjun'], passengers: [{ person_id: 'p_arjun', seat: '14B', pnr: 'K7QX2M' }] });
  kabirs = await addBooking({ for_person_ids: ['p_kabir'], ref: 'Q1' });
  later = await addBooking({ for_person_ids: ['p_meher', 'p_kabir'], ref: 'Q2', journey: { ...JOURNEY, number: '2134', depart_at: '2026-11-09T04:00:00Z', arrive_at: '2026-11-09T06:00:00Z' } });
  stay = await addBooking({ kind: 'stay', title: 'Villa Sol', journey: undefined, for_person_ids: ['p_rahul'] });
});

describe('the flag and who may look', () => {
  it('404 not_found on all three routes when features.checkin is off, member or not; the config says so', async () => {
    const off = buildApp({ ctx: h.ctx, go: h.socket, sessionSecret: h.sessionSecret, auth: new SupabaseAuth({ supabaseUrl: h.fakeAuth!.url, pool: h.pool }), features: { checkin: false } });
    await off.ready();
    try {
      for (const [who, method, path] of [['p_rahul', 'GET', url(flight)], ['p_rahul', 'PATCH', url(flight)], ['p_rahul', 'POST', url(flight, '/complete')], ['p_stranger', 'GET', url(flight)]] as const) {
        const r = await off.inject({ method, url: path, payload: method === 'GET' ? undefined : {}, headers: { authorization: `Bearer ${await h.token(who)}` } });
        expect([r.statusCode, r.json().error.code, r.json().error.message]).toEqual([404, 'not_found', 'web check-in is not available']);
      }
      expect((await off.inject({ method: 'GET', url: '/app/v1/config' })).json().features.checkin).toBe(false);
      expect(h.go.requests.filter((r) => r.method === 'get_checkin')).toEqual([]); // Go was never asked
    } finally {
      await off.close();
    }
  });

  it('with the flag on: 401 unsigned, 403 outside the trip, 404 for a booking not in the trip, 403 for a stay and for a flight that does not cover you', async () => {
    expect(refusal(await t.api(null, 'GET', url(flight)))).toEqual([401, 'unauthorized']);
    expect(refusal(await get('p_stranger'))).toEqual([403, 'forbidden']);
    expect(refusal(await get('p_rahul', 'b_nope'))).toEqual([404, 'not_found']);
    expect(refusal(await get('p_rahul', stay))).toEqual([403, 'forbidden']);
    expect(refusal(await get('p_priya'))).toEqual([403, 'forbidden']); // in the trip, not on the flight
    expect(h.go.requests.filter((r) => r.method === 'get_checkin')).toEqual([]);
  });
});

describe('GET: the state from Go, kept', () => {
  it('asks Go get_checkin and answers the CheckinState with the companion filled from the booking; the row is kept; everyone covered gets a row when it first opens', async () => {
    const r = await get('p_rahul');
    expect(r.status).toBe(200);
    expect(h.go.requests.filter((x) => x.method === 'get_checkin')).toEqual([{ method: 'get_checkin', params: { trip_id: 't_goa', booking_id: flight, person_id: 'p_rahul' } }]);
    expect(r.body).toEqual({ ...fakeCheckinState({ booking_id: flight, person_id: 'p_rahul' }), companion: { person_id: 'p_arjun', seat: '14B', next_to_seats: ['14A', '14C'] } });
    expect(Object.keys(r.body).sort()).toEqual(['boarding_pass', 'closes_at', 'companion', 'declaration', 'digi_yatra', 'flight', 'opens_at', 'passenger', 'seat_map', 'status'].sort()); // §4.12's keys (seat comes once chosen)
    const kept = await rows(h.pool, 'select person_id, status, state from checkins where booking_id = $1 order by person_id', [flight]);
    expect(kept.map((k) => [k.person_id, k.status])).toEqual([['p_arjun', 'open'], ['p_rahul', 'open']]);
    expect(kept[1].state).toEqual(r.body); // Rahul's, as answered
    expect(kept[0].state).toEqual({ status: 'open', opens_at: r.body.opens_at, closes_at: r.body.closes_at, flight: r.body.flight }); // Arjun's: the shared part, so his strip shows it too
    // Read again (by either of them): the same state.
    await get('p_rahul');
    const arjun = await get('p_arjun');
    expect([arjun.status, arjun.body.companion]).toEqual([200, { person_id: 'p_rahul' }]); // Rahul has no seat yet
  });

  it('the strip shows a checkin item for each covered person, the trip counts it, and the home card says it as a task', async () => {
    const item = { item_id: `checkin:${flight}`, kind: 'checkin', title: 'Web check-in is open', subtitle: '6E 5313 · Fri 6 Nov · closes 19:40', cta_label: 'Check in now', since: '2026-11-04T08:40:00+05:30', target: { booking_id: flight } };
    expect([await strip('p_rahul'), await strip('p_arjun'), await strip('p_priya')]).toEqual([[item], [item], []]);
    expect((await t.api(t.as('p_arjun'), 'GET', '/app/v1/trips/t_goa')).body.needs_you_count).toBe(1);
    expect(await attention('p_rahul')).toEqual({ kind: 'task', label: 'Web check-in is open' });
    expect(await attention('p_priya')).toEqual({ kind: 'all_set' }); // the flight booking gave the trip its place, so it is planned
  });

  it('when Go is away the cached state is answered; with nothing cached, 502 go_unavailable; Go\'s working answer keeps what is cached', async () => {
    const was = h.go.answers.get_checkin!;
    try {
      h.go.answers.get_checkin = () => ({ error: { code: 503, message: 'airline site down' } });
      const r = await get('p_rahul');
      expect([r.status, r.body.status, r.body.companion]).toEqual([200, 'open', { person_id: 'p_arjun', seat: '14B', next_to_seats: ['14A', '14C'] }]);
      expect(refusal(await get('p_kabir', kabirs))).toEqual([502, 'go_unavailable']);
      h.go.answers.get_checkin = (p) => ({ result: { status: 'working' } });
      expect((await get('p_rahul')).body.status).toBe('open'); // the cache stands while Go works
      const fresh = await get('p_kabir', kabirs);
      expect([fresh.status, fresh.body, (await rows(h.pool, 'select 1 from checkins where booking_id = $1', [kabirs])).length]).toEqual([200, { status: 'working', boarding_pass: null }, 0]); // nothing to keep yet
    } finally {
      h.go.answers.get_checkin = was;
    }
  });
});

describe('PATCH: the answers and the seat', () => {
  it('merges digi_yatra, declaration and a masked mobile; a free seat is set; taken is 409; a seat not on the map is 422; a paid seat answers payment_required and is not set; the companion seat may be picked', async () => {
    let r = await patch('p_rahul', { digi_yatra: true, mobile: '+91 98765 43210' });
    expect([r.status, r.body.digi_yatra, r.body.declaration, r.body.passenger.mobile_masked, 'mobile' in r.body]).toEqual([200, true, false, '+91 9•••• ••210', false]);
    r = await patch('p_rahul', { seat: '14A', declaration: true });
    expect([r.status, r.body.seat, r.body.declaration, r.body.payment_required]).toEqual([200, '14A', true, undefined]);
    expect(refusal(await patch('p_rahul', { seat: '14C' }))).toEqual([409, 'conflict']);
    const off = await patch('p_rahul', { seat: '99Z' });
    expect([off.status, off.body.error.code, off.body.error.field]).toEqual([422, 'invalid', 'seat']);
    const paid = await patch('p_rahul', { seat: '12A' });
    expect([paid.status, paid.body.payment_required, paid.body.seat_price, paid.body.seat]).toEqual([200, true, { amount_minor: 45000, currency: 'INR' }, '14A']); // the vault pays first; the seat stays as it was
    expect((await get('p_rahul')).body).toMatchObject({ seat: '14A', digi_yatra: true, declaration: true, passenger: { mobile_masked: '+91 9•••• ••210' } }); // nothing of the paid attempt stuck
    expect((await patch('p_rahul', { seat: '14B' })).body.seat).toBe('14B'); // next to Arjun
    expect((await patch('p_rahul', { seat: '14A' })).body.seat).toBe('14A');
    for (const [body, field] of [[{}, undefined], [{ seat: 'A' }, 'seat'], [{ mobile: 'call me' }, 'mobile'], [{ meal: 'veg' }, 'meal']] as const) {
      const bad = await patch('p_rahul', body);
      expect([bad.status, bad.body.error.field]).toEqual([422, field ?? null]);
    }
    expect(h.go.requests.filter((x) => x.method === 'submit_checkin')).toEqual([]); // nothing reaches Go before complete
  });

  it('a PATCH with nothing cached fetches the state from Go first (Kabir\'s flight)', async () => {
    const r = await patch('p_kabir', { declaration: true }, kabirs);
    expect([r.status, r.body.status, r.body.declaration, r.body.companion]).toEqual([200, 'open', true, undefined]);
    expect((await strip('p_kabir')).map((i) => i.item_id)).toEqual([`checkin:${kabirs}`]);
  });
});

describe('POST complete', () => {
  it('422 without the declaration or a seat; failed → 409 with Go\'s message and nothing changes; working → 202 and the item leaves; a refresh keeps my answers; done → the pass, the item gone, the home card moves on', async () => {
    // Arjun has not answered anything yet.
    let r = await complete('p_arjun');
    expect([r.status, r.body.error.field]).toEqual([422, 'declaration']);
    await patch('p_arjun', { declaration: true });
    r = await complete('p_arjun');
    expect([r.status, r.body.error.field]).toEqual([422, 'seat']);
    expect(h.go.requests.filter((x) => x.method === 'submit_checkin')).toEqual([]);

    // Rahul: 14A, DigiYatra, declaration, mobile. The airline refuses first.
    h.go.checkin.submit = 'failed';
    r = await complete('p_rahul');
    expect([r.status, r.body.error.code, r.body.error.message]).toEqual([409, 'conflict', 'The airline refused: the name does not match the PNR.']);
    expect(h.go.checkin.submitted).toEqual([{ trip_id: 't_goa', booking_id: flight, person_id: 'p_rahul', digi_yatra: true, declaration: true, seat: '14A', mobile: '+91 98765 43210' }]);
    expect((await get('p_rahul')).body).toMatchObject({ status: 'open', seat: '14A' });

    // Then Go needs longer than 2 seconds: working.
    h.go.checkin.submit = 'working';
    r = await complete('p_rahul');
    expect([r.status, r.body.status, r.body.seat, r.body.boarding_pass]).toEqual([202, 'working', '14A', null]);
    expect([await strip('p_rahul'), (await rows(h.pool, 'select status from checkins where booking_id = $1 and person_id = $2', [flight, 'p_rahul']))[0].status]).toEqual([[], 'not_open']);
    expect(refusal(await patch('p_rahul', { seat: '14D' }))).toEqual([409, 'conflict']); // Go is finishing it
    // A refresh from Go (which answers open again: the fake forgot nothing was submitted) keeps my own answers over Go's blanks.
    r = await get('p_rahul');
    expect(r.body).toMatchObject({ status: 'open', seat: '14A', digi_yatra: true, declaration: true, passenger: { mobile_masked: '+91 9•••• ••210' } });

    // Done: the boarding pass.
    h.go.checkin.submit = 'done';
    r = await complete('p_rahul');
    expect([r.status, r.body.status, r.body.seat, r.body.boarding_pass]).toEqual([200, 'done', '14A', { passenger: 'RAHUL', boarding: '20:00', departs: '20:40', gate: null, zone: '2', seq: '087', barcode: { format: 'qr', payload: 'M1RAHUL/GO…' } }]);
    expect((await get('p_rahul')).body).toMatchObject({ status: 'done', boarding_pass: { passenger: 'RAHUL' } }); // Go now answers done too
    expect([await strip('p_rahul'), (await strip('p_arjun')).length]).toEqual([[], 1]);
    expect(refusal(await patch('p_rahul', { seat: '14D' }))).toEqual([409, 'conflict']);
    expect(refusal(await complete('p_rahul'))).toEqual([409, 'conflict']);
    expect(await attention('p_rahul')).toEqual({ kind: 'all_set' }); // nothing else waits for him, and the booking made the trip planned
  });

  it('Go silent → 502 go_unavailable, and the state is left as it was', { timeout: 10_000 }, async () => {
    const seated = await patch('p_arjun', { seat: '14D' });
    expect([seated.status, seated.body.seat ?? seated.body.error]).toEqual([200, '14D']);
    const was = h.go.answers.submit_checkin!;
    try {
      h.go.answers.submit_checkin = () => null;
      const r = await complete('p_arjun');
      expect([r.status, r.body.error.code, r.body.error.message]).toEqual([502, 'go_unavailable', 'Go could not complete the check-in just now. Try again.']);
    } finally {
      h.go.answers.submit_checkin = was;
    }
    expect((await get('p_arjun')).body).toMatchObject({ status: 'open', seat: '14D' });
    expect(refusal(await complete('p_arjun', kabirs))).toEqual([403, 'forbidden']);
  });

  it('the task on the home card: web check-in comes first; once it is done the usual rule is back and no expense asks for approval', async () => {
    await t.api(t.as('p_priya'), 'POST', '/app/v1/trips/t_goa/expenses', { paid_by_person_id: 'p_priya', amount_minor: 170000, note: 'Airport cab', category: 'getting_around', split_person_ids: ['p_priya', 'p_arjun'] });
    expect(await attention('p_arjun')).toEqual({ kind: 'task', label: 'Web check-in is open' });
    await complete('p_arjun');
    expect(await attention('p_arjun')).toEqual({ kind: 'needs_you', count: 1 }); // he still owes Priya his share: the usual rule again
  });
});

describe("Go's own signal: a notice card linking go://trips/<trip>/checkin/<booking>", () => {
  let n = 0;
  const post = (card: Record<string, unknown>) => h.go.call('post_message', { request_id: `rq_ci_${++n}`, trip_id: 't_goa', text: 'Check-in is open', card });
  const notice = (cardId: string, over: Record<string, unknown>) => ({ card_id: cardId, kind: 'notice', tone: 'heads_up', title: 'Web check-in is open', body: 'IndiGo opened check-in for Monday.', fallback_text: 'Web check-in is open for 6E 2134', ...over });

  it('marks the cached state open for the people the card names (a minimal row), and the strip shows it from the booking\'s own journey', async () => {
    const r = await post(notice('c_ci_open', { for_person_ids: ['p_meher'], actions: [{ action_id: 'open', label: 'Check in now', style: 'primary', url: `go://trips/t_goa/checkin/${later}` }] }));
    expect(r.error).toBeUndefined();
    expect(await rows(h.pool, 'select person_id, status, state from checkins where booking_id = $1', [later])).toEqual([{ person_id: 'p_meher', status: 'open', state: { status: 'open' } }]);
    expect(await strip('p_meher')).toEqual([{ item_id: `checkin:${later}`, kind: 'checkin', title: 'Web check-in is open', subtitle: '6E 2134 · Mon 9 Nov', cta_label: 'Check in now', since: ISO, target: { booking_id: later } }]);
    expect((await strip('p_kabir')).map((i) => i.item_id)).toEqual([`checkin:${kabirs}`]); // not named: not yet
    expect(h.go.requests.filter((x) => x.method === 'get_checkin' && x.params.booking_id === later)).toEqual([]); // the strip never asks Go
    // replace_card into the signal counts too: source.url this time, nobody named, so everyone the flight covers; Meher is already open.
    await h.go.call('replace_card', { trip_id: 't_goa', card: notice('c_ci_open', { source: { name: 'IndiGo', url: `go://trips/t_goa/checkin/${later}` } }) });
    expect((await strip('p_kabir')).map((i) => i.item_id)).toEqual([`checkin:${kabirs}`, `checkin:${later}`]);
    // A GET then asks Go and keeps the full state over the minimal row.
    const full = await get('p_meher', later);
    expect([full.status, full.body.seat_map.seats.length, full.body.companion]).toEqual([200, 6, { person_id: 'p_kabir' }]);
  });

  it('a link to another trip, a stay, an unknown booking, or not a check-in link at all does nothing: those are ordinary cards', async () => {
    for (const link of [`go://trips/t_other/checkin/${later}`, `go://trips/t_goa/checkin/${stay}`, 'go://trips/t_goa/checkin/b_nope', `go://trips/t_goa/bookings/${later}`]) {
      await post(notice(`c_ci_${++n}`, { for_person_ids: ['p_priya'], actions: [{ action_id: 'open', label: 'Open', style: 'primary', url: link }] }));
    }
    expect(await rows(h.pool, `select count(*)::int as n from checkins where person_id = 'p_priya'`)).toEqual([{ n: 0 }]);
  });
});
