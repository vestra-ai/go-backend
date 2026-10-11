// Found by the final server-to-app sweep (10 Oct 2026): a stranger learning a route's body rules before the 403, the
// transactions page without its no-store header, and 422s that did not name a field the Server knew.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appApi } from './helpers/app-api.js';
import { startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness({ features: { vote_retract: false } }); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
});
afterAll(() => h.stop());

const trip = '/app/v1/trips/t_goa';

describe('a stranger', () => {
  it('gets 403 before any body rule, feature flag or rate limit on the routes that check the body', async () => {
    const x = t.as('p_stranger');
    const answers = await Promise.all([
      t.api(x, 'POST', `${trip}/messages`, {}),
      t.api(x, 'PATCH', `${trip}/messages/m_any`, {}),
      t.api(x, 'PUT', `${trip}/messages/m_any/reaction`, {}),
      t.api(x, 'PUT', `${trip}/decisions/d_any/vote`, {}),
      t.api(x, 'DELETE', `${trip}/decisions/d_any/vote`),
    ]);
    expect(answers.map((r) => [r.status, r.body.error?.code])).toEqual(Array(5).fill([403, 'forbidden']));
  });
});

describe('answers', () => {
  it('the transactions page is private, no-store, like the money page', async () => {
    const r = await t.api(t.as('p_rahul'), 'GET', `${trip}/transactions`);
    expect([r.status, r.headers['cache-control']]).toEqual([200, 'private, no-store']);
  });

  it('a 422 names the field: a past closes_at, a booking against a vote that is not closed, a bad itinerary day', async () => {
    const rahul = t.as('p_rahul');
    const past = await t.api(rahul, 'POST', `${trip}/decisions`, { client_id: 'sweep-past', question: 'When?', kind: 'choice', anonymous: false, closes_at: '2020-01-01T00:00:00Z', options: [{ label: 'A' }, { label: 'B' }] });
    const open = (await t.api(rahul, 'POST', `${trip}/decisions`, { client_id: 'sweep-open', question: 'Where?', kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }] })).body.decision.decision_id;
    const booking = await t.api(rahul, 'POST', `${trip}/bookings`, { kind: 'stay', title: 'Villa', vendor: 'ixigo', ref: 'X1', amount_minor: 100, payer_person_id: 'p_rahul', for_person_ids: ['p_rahul'], decision_id: open });
    const day = await t.api(rahul, 'PATCH', trip, { itinerary: [{ date: '2026-11-06', items: [{ title: 'x' }] }] });
    expect([past, booking, day].map((r) => [r.status, r.body.error?.field])).toEqual([[422, 'closes_at'], [422, 'decision_id'], [422, 'itinerary[0].items[0].category']]);
  });
});
