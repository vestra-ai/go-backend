// Rev 4 as a whole (block B8, criteria A12 and A13). One walk through every Part 1 change, twice: against a Go that speaks
// contract 1.0 (today's), where everything the Server sends or answers must be valid against contract/go.json ALONE, and
// against a Go on 1.1. And the route list the contract document is written from.
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sections } from '../src/api/v1/index.js';
import { check } from '../src/contract/index.js';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';

// A checker built from go.json only: no overlay, so nothing from the 1.1 proposals is known to it. (go.json writes "may
// be empty" as anyOf [X, null] and the Server leaves empty members out, so those are read as X, as the Server's own check does.)
const simplify = (node: any): any => {
  if (Array.isArray(node)) return node.map(simplify);
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node.anyOf) && node.anyOf.length === 2) {
    const nonNull = node.anyOf.filter((b: any) => b?.type !== 'null');
    if (nonNull.length === 1) {
      const { anyOf: _drop, ...rest } = node;
      return simplify({ ...nonNull[0], ...rest });
    }
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, simplify(v)]));
};
const goJson = JSON.parse(readFileSync(new URL('../contract/go.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: false, discriminator: true });
addFormats.default(ajv);
ajv.addSchema({ $id: 'go10', components: { schemas: simplify(goJson.components.schemas) } });
const valid10 = (schema: string, value: unknown): boolean => ajv.getSchema(`go10#/components/schemas/${schema}`)!(value) as boolean;

const trip = '/app/v1/trips/t_goa';
/** Every Part 1 change, once: budget set and cleared, expenses added, re-split and removed, a payback, a join with no answers, a leave, Go adding an expense. */
async function walk(h: Harness) {
  const t = appApi(h);
  const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) => t.api(t.as(who), method, url, body);
  const statuses: number[] = [];
  const ok = async (p: ReturnType<typeof call>) => { const r = await p; statuses.push(r.status); return r; };
  const unset = (await h.go.call('read_trip', { trip_id: 't_goa' })).result;
  await ok(call('p_priya', 'PATCH', trip, { budget_per_person_minor: 2000000 }));
  const cab = await ok(call('p_priya', 'POST', `${trip}/expenses`, { amount_minor: 170000, note: 'Airport cab', category: 'getting_around', split_person_ids: ['p_priya', 'p_arjun', 'p_kabir'] }));
  await ok(call('p_priya', 'PATCH', `${trip}/expenses/${cab.body.expense_id}`, { split_person_ids: ['p_priya', 'p_arjun'] }));
  const tea = await ok(call('p_kabir', 'POST', `${trip}/expenses`, { amount_minor: 30000, note: 'Tea', category: 'food', split_person_ids: ['p_kabir', 'p_meher'] }));
  await ok(call('p_kabir', 'DELETE', `${trip}/expenses/${tea.body.expense_id}`));
  await ok(call('p_arjun', 'POST', `${trip}/settlements`, { to_person_id: 'p_priya', amount_minor: 50000, currency: 'INR', method: 'upi' }));
  await h.go.call('add_expense', { request_id: 'rq_whole_1', trip_id: 't_goa', paid_by_person_id: 'p_rahul', amount_minor: 5420000, currency: 'INR', note: 'Villa Sol', category: 'stay', split_person_ids: ['p_rahul', 'p_priya'] });
  const sam = await h.signIn('Sam');
  statuses.push((await t.api(sam, 'POST', '/app/v1/invites/inv_t_goa/accept')).status);
  await ok(call('p_meher', 'POST', `${trip}/leave`));
  const set = (await h.go.call('read_trip', { trip_id: 't_goa' })).result;
  await ok(call('p_rahul', 'PATCH', trip, { budget_per_person_minor: null }));
  await h.flush();
  const events = (await rows(h.pool, `select body from outbox where trip_id = 't_goa' order by seq`)).map((r) => r.body as any);
  const failed = (await rows(h.pool, `select count(*)::int as n from outbox where trip_id = 't_goa' and status <> 'sent'`))[0].n as number;
  const messages = (await h.go.call('read_messages', { trip_id: 't_goa', after_seq: 0 })).result.messages as any[];
  const home = (await call('p_arjun', 'GET', '/app/v1/home')).body;
  return { statuses, unset, set, events, failed, messages, home };
}

describe('against a Go on contract 1.0', () => {
  let h: Harness;
  beforeAll(async () => void (h = await startHarness({ goContract: '1.0' })));
  afterAll(() => h.stop());

  it('every event and every answer to Go\'s reads is valid against go.json alone; the one event type outside it is settlement.recorded (valid in its 1.1 shape); the budget, expenses and messages carry no field beyond the ones the design names', async () => {
    const w = await walk(h);
    expect([w.statuses.every((s) => s >= 200 && s < 300), w.failed]).toEqual([true, 0]); // every step worked and Go accepted every event
    const outside = [...new Set(w.events.filter((e) => !valid10('Event', e)).map((e) => e.type))];
    expect(outside).toEqual(['settlement.recorded']);
    expect(w.events.filter((e) => e.type === 'settlement.recorded').map((e) => [check('Event', e).ok, e.data.status, e.data.confirmed_at === e.data.recorded_at])).toEqual([[true, 'confirmed', true]]);
    expect(w.events.map((e) => e.type + (e.data.change ? `:${e.data.change}` : '') + (e.type === 'trip.updated' ? `:${e.data.by.kind}:${e.data.changed}` : ''))).toEqual([
      'trip.updated:person:budget', 'expense.changed:added', 'expense.changed:added', 'expense.changed:removed', // no event for the re-split on 1.0
      'settlement.recorded', 'expense.changed:added', 'person.joined', 'person.left', 'trip.updated:person:budget',
    ]);
    expect([valid10('TripSnapshot', w.unset), valid10('TripSnapshot', w.set), w.messages.every((m) => valid10('Message', m))]).toEqual([true, true, true]);
    // Checked by name, because go.json's objects accept extra fields: the budget carries per_person_minor and nothing else, an
    // expense has no standing, a message has no ledger. (Not checked here: every other object for an unlisted extra field, and
    // `photos` entered by a person, which tests/rev4-go-shapes.test.ts covers.) Go also still receives everyone's starting city.
    expect([w.unset.budget, Object.keys(w.set.budget).sort(), w.set.budget.per_person_minor]).toEqual([{ answered: 0, of: 5 }, ['answered', 'lowest', 'of', 'per_person_minor'], 2000000]);
    expect([w.set.expenses.some((e: any) => 'status' in e || 'confirmations' in e), w.messages.some((m) => 'ledger' in m), w.messages.filter((m) => m.author.kind === 'system' && / · ₹|paid /.test(m.text ?? '')).length, w.set.people.every((p: any) => 'know' in p)]).toEqual([false, false, 6, true]); // cab added, re-split, tea added, tea removed, the payback, Go's villa
  });
});

describe('against a Go on contract 1.1', () => {
  let h: Harness;
  beforeAll(async () => void (h = await startHarness()));
  afterAll(() => h.stop());

  it('the same walk also sends the re-split, every event passes the contract with the 1.1 additions, and the home screen shows what is owed', async () => {
    const w = await walk(h);
    expect([w.statuses.every((s) => s >= 200 && s < 300), w.failed, w.events.every((e) => check('Event', e).ok)]).toEqual([true, 0, true]);
    expect(w.events.filter((e) => e.type === 'expense.changed').map((e) => e.data.change)).toEqual(['added', 'updated', 'added', 'removed', 'added']);
    // Arjun owes 350 net (half the cab, 850, less the 500 he paid back). The fewest-payments list sends it to Rahul, whom Priya owes far more for the villa.
    expect(w.home.owes.filter((o: any) => o.trip_id === 't_goa')).toEqual([{ trip_id: 't_goa', trip_title: 'Goa 🌴', to: { person_id: 'p_rahul', name: 'Rahul' }, amount_minor: 35000, currency: 'INR' }]);
  });
});

describe('the route list', () => {
  it('has 70 app routes, and none of the eleven that rev 4 removed', () => {
    const routes = sections.flatMap((s) => s.routes).filter((r) => !r.dev).map((r) => `${r.method} ${r.path.replace('/app/v1', '')}`);
    const removed = ['POST /me/devices', 'DELETE /me/devices/:device_id', 'POST /invites/:code/later', 'POST /invites/:code/decline', 'PUT /trips/:trip/me/budget', 'DELETE /trips/:trip/me/budget',
      'POST /trips/:trip/expenses/:id/approve', 'POST /trips/:trip/expenses/:id/dispute', 'POST /trips/:trip/settlements/:id/confirm', 'POST /trips/:trip/settlements/:id/dispute', 'POST /trips/:trip/transfers/nudge'];
    expect([routes.length, new Set(routes).size, removed.filter((r) => routes.includes(r))]).toEqual([70, 70, []]);
  });
});
