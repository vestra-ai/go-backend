// GET /home needs_you (rev 5 L): every open item of mine across my trips that are not over, one home card each, in the
// home order (votes closing soonest, mandates, cards, settle_up, record lines by due date), each with its trip and what
// its popup needs; the home_changed notices that keep it fresh.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { homeOrder, type HomeNeedsYouItem } from '../src/domain/home.js';
import { appApi } from './helpers/app-api.js';
import { startHarness, type Harness } from './helpers/harness.js';
import { seedTrip } from './helpers/seed.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness(); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
  // A second trip, still called "New trip", with a destination and dates in 2027; and one that is over.
  await seedTrip(h.pool, 't_hampi', [{ id: 'p_priya', name: 'Priya', role: 'organizer' }, { id: 'p_rahul', name: 'Rahul' }]);
  await h.pool.query(`update trips set title = 'New trip', destination = '{"name":"Hampi"}', dates_start = '2027-01-10', dates_end = '2027-01-12' where trip_id = 't_hampi'`);
  await seedTrip(h.pool, 't_over', [{ id: 'p_priya', name: 'Priya', role: 'organizer' }]);
});
afterAll(() => h.stop());

let n = 0;
const go = async (method: string, params: Record<string, unknown>) => {
  const f = await h.go.call(method, { request_id: `rq_hny_${++n}`, ...params });
  if (f.error) throw new Error(`${method}: ${JSON.stringify(f.error)}`);
  return f.result;
};
const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const homeOf = async (who: string) => (await t.api(t.as(who), 'GET', '/app/v1/home')).body;
const homeNotices = (personId: string) => h.live.events.filter((e) => e.event.kind === 'home' && e.event.person_id === personId).length;
const ISO = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/);

describe('needs_you on the home screen', () => {
  const ids: Record<string, string> = {};

  it('lists every open item across my active trips in the home order, each with trip_id, trip_title and what its popup needs; an over trip is left out', async () => {
    // t_goa: a vote closing in 3 hours, with its card in the room.
    ids.goaVote = (await go('open_vote', { trip_id: 't_goa', question: 'Pick dates', kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }], closes_at: inHours(3) })).decision_id;
    ids.goaVoteMsg = (await go('post_message', { trip_id: 't_goa', text: 'Vote!', card: { card_id: 'c_hny_vote', kind: 'vote', decision_id: ids.goaVote, fallback_text: 'Pick dates' } })).message_id;
    // t_hampi: a vote with no closing time, then one closing in an hour.
    ids.hampiOpen = (await go('open_vote', { trip_id: 't_hampi', question: 'Bikes or a car?', kind: 'choice', anonymous: false, options: [{ label: 'Bikes' }, { label: 'Car' }] })).decision_id;
    ids.hampiSoon = (await go('open_vote', { trip_id: 't_hampi', question: 'Sunrise at Matanga?', kind: 'yesno', anonymous: false, options: [{ label: 'Yes' }, { label: 'No' }], closes_at: inHours(1) })).decision_id;
    // t_goa: a closed vote with a mandate for Priya, and its card.
    ids.stay = (await go('open_vote', { trip_id: 't_goa', question: 'Where do we stay?', kind: 'choice', anonymous: false, options: [{ label: 'Villa Sol' }, { label: 'Casa Azul' }] })).decision_id;
    for (const p of ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir']) await t.api(t.as(p), 'PUT', `/app/v1/trips/t_goa/decisions/${ids.stay}/vote`, { option_index: 0 });
    await go('set_mandate', { trip_id: 't_goa', decision_id: ids.stay, choice_index: 0, cap_minor: 5500000, currency: 'INR', refundable_only: true, payer_person_id: 'p_priya' });
    ids.mandateMsg = (await go('post_message', { trip_id: 't_goa', text: 'Priya?', card: { card_id: 'c_hny_mandate', kind: 'mandate', decision_id: ids.stay, fallback_text: 'Yes, book Villa Sol?' } })).message_id;
    // t_hampi: a card for Priya.
    ids.cardMsg = (await go('post_message', { trip_id: 't_hampi', text: 'Bus?', card: { card_id: 'c_hny_bus', kind: 'notice', fallback_text: 'Bus from Bengaluru', title: 'Fri night', body: 'x', tone: 'heads_up', for_person_ids: ['p_priya'], actions: [{ action_id: 'book', label: 'Book', style: 'primary' }] } })).message_id;
    // t_goa: Priya owes Rahul half a dinner.
    await t.api(t.as('p_rahul'), 'POST', '/app/v1/trips/t_goa/expenses', { paid_by_person_id: 'p_rahul', amount_minor: 200000, note: 'Dinner', category: 'food', split_person_ids: ['p_rahul', 'p_priya'] });
    // Record lines: due 8 Nov (Goa), due 7 Nov (Hampi), and one with no due date.
    ids.lineGoa = (await go('add_record_line', { trip_id: 't_goa', kind: 'open', text: 'Passport copies', proof: [], person_ids: ['p_priya'], due_at: '2026-11-08T10:00:00Z' })).line_id;
    ids.lineHampi = (await go('add_record_line', { trip_id: 't_hampi', kind: 'open', text: 'Book the bus', proof: [], person_ids: ['p_priya'], due_at: '2026-11-07T10:00:00Z' })).line_id;
    ids.lineNoDue = (await go('add_record_line', { trip_id: 't_goa', kind: 'open', text: 'Sunscreen', proof: [], person_ids: ['p_priya'] })).line_id;
    // The trip that is over: its vote is not on home.
    await go('open_vote', { trip_id: 't_over', question: 'Photos album?', kind: 'yesno', anonymous: false, options: [{ label: 'Yes' }, { label: 'No' }] });
    await h.pool.query(`update trips set status = 'over' where trip_id = 't_over'`);

    const home = await homeOf('p_priya');
    expect(home.needs_you.items.map((i: any) => [i.kind, i.trip_id, i.trip_title, i.title])).toEqual([
      ['vote', 't_hampi', 'Hampi - 2027', 'Sunrise at Matanga?'], // closes in an hour
      ['vote', 't_goa', 'Goa 🌴', 'Pick dates'], // in three
      ['vote', 't_hampi', 'Hampi - 2027', 'Bikes or a car?'], // no closing time: after the timed ones
      ['mandate', 't_goa', 'Goa 🌴', 'Yes, book it? Villa Sol, up to ₹55,000'],
      ['card', 't_hampi', 'Hampi - 2027', 'Bus from Bengaluru'],
      ['settle_up', 't_goa', 'Goa 🌴', 'Settle up with Rahul'],
      ['record_line', 't_hampi', 'Hampi - 2027', 'Book the bus'], // due 7 Nov
      ['record_line', 't_goa', 'Goa 🌴', 'Passport copies'], // due 8 Nov
      ['record_line', 't_goa', 'Goa 🌴', 'Sunscreen'], // no due date
    ]);
    expect(home.needs_you.total).toBe(9);
    // What each popup needs, in `target`.
    const byKind = (kind: string) => home.needs_you.items.filter((i: any) => i.kind === kind);
    expect(byKind('vote')[1]).toEqual({ item_id: `vote:${ids.goaVote}:p_priya`, kind: 'vote', title: 'Pick dates', subtitle: 'closes in 3 hours', cta_label: 'Vote', since: ISO, target: { decision_id: ids.goaVote, message_id: ids.goaVoteMsg }, trip_id: 't_goa', trip_title: 'Goa 🌴' });
    expect(byKind('mandate')[0].target).toEqual({ decision_id: ids.stay, card_id: 'c_hny_mandate', message_id: ids.mandateMsg });
    expect(byKind('card')[0].target).toEqual({ card_id: 'c_hny_bus', message_id: ids.cardMsg });
    expect(byKind('settle_up')[0].target).toEqual({ transfer: { to_person_id: 'p_rahul', amount_minor: 100000, currency: 'INR' } });
    expect(byKind('record_line').map((i: any) => i.target)).toEqual([{ line_id: ids.lineHampi }, { line_id: ids.lineGoa }, { line_id: ids.lineNoDue }]);
    // The trip cards' own count agrees, trip by trip; the over trip is in past_trips with its automatic-name rule untouched.
    expect(home.trips.map((x: any) => [x.trip_id, x.title, x.attention])).toEqual(expect.arrayContaining([
      ['t_hampi', 'Hampi - 2027', { kind: 'needs_you', count: 4 }],
      ['t_goa', 'Goa 🌴', { kind: 'needs_you', count: 5 }],
    ]));
    expect(home.past_trips.map((x: any) => x.trip_id)).toEqual(['t_over']);
    // Someone else's home has only their own items.
    expect((await homeOf('p_kabir')).needs_you.items.map((i: any) => i.item_id)).toEqual([`vote:${ids.goaVote}:p_kabir`]);
  });

  it('a vote cast leaves the list at once, the total follows, and the voter gets home_changed', async () => {
    const before = homeNotices('p_priya');
    await t.api(t.as('p_priya'), 'PUT', `/app/v1/trips/t_hampi/decisions/${ids.hampiSoon}/vote`, { option_index: 0 });
    expect(homeNotices('p_priya')).toBeGreaterThan(before);
    const home = await homeOf('p_priya');
    expect([home.needs_you.items[0].title, home.needs_you.total, home.needs_you.items.some((i: any) => i.target.decision_id === ids.hampiSoon)]).toEqual(['Pick dates', 8, false]);
  });

  it('home_changed reaches the people concerned: a vote opened (everyone), a card naming them, a mandate answered, money moving', async () => {
    const count = () => ({ priya: homeNotices('p_priya'), kabir: homeNotices('p_kabir'), rahul: homeNotices('p_rahul') });
    let before = count();
    await go('open_vote', { trip_id: 't_goa', question: 'Lunch?', kind: 'yesno', anonymous: false, options: [{ label: 'Yes' }, { label: 'No' }] });
    let after = count();
    expect([after.priya > before.priya, after.kabir > before.kabir]).toEqual([true, true]);
    before = count();
    await go('post_message', { trip_id: 't_goa', text: 'Cab?', card: { card_id: 'c_hny_cab', kind: 'notice', fallback_text: 'Cab', title: 'Cab', body: 'x', tone: 'heads_up', for_person_ids: ['p_kabir'] } });
    after = count();
    expect([after.kabir - before.kabir, after.priya - before.priya]).toEqual([1, 0]);
    before = count();
    await t.api(t.as('p_priya'), 'POST', `/app/v1/trips/t_goa/decisions/${ids.stay}/mandate/confirm`);
    expect(count().priya - before.priya).toBe(1);
    before = count();
    await t.api(t.as('p_priya'), 'POST', '/app/v1/trips/t_goa/settlements', { to_person_id: 'p_rahul', amount_minor: 100000, currency: 'INR', method: 'upi' });
    after = count();
    expect([after.priya > before.priya, after.rahul > before.rahul]).toEqual([true, true]);
    expect((await homeOf('p_priya')).needs_you.items.filter((i: any) => i.kind === 'settle_up' || i.kind === 'mandate')).toEqual([]);
  });
});

describe('the home order', () => {
  const item = (kind: HomeNeedsYouItem['kind'], id: string, since: string, target: HomeNeedsYouItem['target'] = {}): HomeNeedsYouItem =>
    ({ item_id: id, kind, title: id, since, target, trip_id: 't', trip_title: 'T' });

  it('kinds in order; votes by closing time (untimed last), lines by due date (none last), the rest oldest first; capped lists keep the real total elsewhere', () => {
    const items = [
      item('checkin', 'ci', '2026-01-01T00:00:00Z'),
      item('record_line', 'l-none', '2026-01-01T00:00:00Z', { line_id: 'l0' }),
      item('record_line', 'l-late', '2026-01-01T00:00:00Z', { line_id: 'l2' }),
      item('record_line', 'l-early', '2026-01-02T00:00:00Z', { line_id: 'l1' }),
      item('settle_up', 's', '2026-01-01T00:00:00Z'),
      item('card', 'c-new', '2026-01-03T00:00:00Z'),
      item('card', 'c-old', '2026-01-01T00:00:00Z'),
      item('mandate', 'm', '2026-01-05T00:00:00Z'),
      item('vote', 'v-untimed-old', '2026-01-01T00:00:00Z', { decision_id: 'd0' }),
      item('vote', 'v-late', '2026-01-01T00:00:00Z', { decision_id: 'd2' }),
      item('vote', 'v-soon', '2026-01-04T00:00:00Z', { decision_id: 'd1' }),
    ];
    const order = homeOrder(items, new Map([['d1', 1000], ['d2', 2000]]), new Map([['l1', 10], ['l2', 20]])).map((i) => i.item_id);
    expect(order).toEqual(['v-soon', 'v-late', 'v-untimed-old', 'm', 'c-old', 'c-new', 's', 'l-early', 'l-late', 'l-none', 'ci']);
  });
});
