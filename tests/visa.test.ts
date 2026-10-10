// Visa (app contract §4.2, GO-CHANGES 2.2), behind features.visa: the vault link that opens Go's documents form
// (start add_documents + context, passport data never through the server), the `checklist` card passed through as it is,
// and the home card's task for a row of mine still to do.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { SupabaseAuth } from '../src/api/auth.js';
import { check } from '../src/contract/index.js';
import { appApi } from './helpers/app-api.js';
import { startHarness, type Harness } from './helpers/harness.js';
import { fakeChecklist } from './helpers/mock-go.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness({ features: { visa: true } }); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
});
afterAll(() => h.stop());

const link = (who: string, body: unknown) => t.api(t.as(who), 'POST', '/app/v1/me/vault-link', body);
const attention = async (who: string) => (await t.api(t.as(who), 'GET', '/app/v1/home')).body.trips.find((x: any) => x.trip_id === 't_goa').attention;
const vaultRequests = () => h.go.requests.filter((r) => r.method === 'vault_link').map((r) => r.params);

describe('POST /me/vault-link with start: add_documents', () => {
  it('passes start and context to Go\'s vault_link as they are (the 1.1 overlay allows them) and answers the link; a bad context is 422; the old starts still work', async () => {
    const r = await link('p_priya', { start: 'add_documents', context: { trip_id: 't_goa', purpose: 'visa' } });
    expect([r.status, r.body]).toEqual([200, { url: 'https://brain.go.example/vault/add-card?link=lk_1', expires_at: '2099-01-01T00:00:00Z' }]);
    expect(vaultRequests().at(-1)).toEqual({ kind: 'vault', person_id: 'p_priya', start: 'add_documents', context: { trip_id: 't_goa', purpose: 'visa' } });
    expect((await link('p_priya', { start: 'add_documents' })).status).toBe(200); // the context is optional
    expect(vaultRequests().at(-1)).toEqual({ kind: 'vault', person_id: 'p_priya', start: 'add_documents' });
    for (const body of [{ start: 'add_documents', context: { trip_id: 't_goa', purpose: 'passport' } }, { start: 'add_documents', context: { purpose: 'visa' } }, { start: 'documents' }]) {
      expect((await link('p_priya', body)).status, JSON.stringify(body)).toBe(422);
    }
    expect((await link('p_priya', { start: 'add_card' })).status).toBe(200);
    expect(vaultRequests().at(-1)).toEqual({ kind: 'vault', person_id: 'p_priya', start: 'add_card' });
    expect((await link('p_priya', {})).status).toBe(200);
    expect(vaultRequests().at(-1)).toEqual({ kind: 'vault', person_id: 'p_priya' });
  });

  it('422 start when features.visa is off; the other starts still open the vault; Go is not asked', async () => {
    const off = buildApp({ ctx: h.ctx, go: h.socket, sessionSecret: h.sessionSecret, auth: new SupabaseAuth({ supabaseUrl: h.fakeAuth!.url, pool: h.pool }), features: { visa: false } });
    await off.ready();
    try {
      const headers = { authorization: `Bearer ${await h.token('p_priya')}` };
      const n = vaultRequests().length;
      const r = await off.inject({ method: 'POST', url: '/app/v1/me/vault-link', payload: { start: 'add_documents', context: { trip_id: 't_goa', purpose: 'visa' } }, headers });
      expect([r.statusCode, r.json().error]).toEqual([422, { code: 'invalid', message: 'add_documents is not on yet (features.visa)', field: 'start', retry_after_seconds: null, request_id: expect.any(String) }]);
      expect(vaultRequests().length).toBe(n);
      expect((await off.inject({ method: 'POST', url: '/app/v1/me/vault-link', payload: { start: 'home' }, headers })).statusCode).toBe(200);
      expect((await off.inject({ method: 'GET', url: '/app/v1/config' })).json().features.visa).toBe(false);
    } finally {
      await off.close();
    }
  });
});

describe('the checklist card', () => {
  const card = fakeChecklist('c_visa', [{ person_id: 'p_rahul', status: 'todo', label: 'Not yet', sub: 'Passport, photo' }, { person_id: 'p_priya', status: 'done', label: 'Sent' }, { person_id: 'p_arjun', status: 'started', label: 'Photo missing' }, { person_id: 'p_meher', status: 'info', label: 'No visa needed' }]);

  it('round-trips through post_message, GET …/messages, GET …/cards?kind=checklist and replace_card exactly as Go sent it; the home card says "<title> needed" for a row of mine still to do', async () => {
    expect(check('Card', card)).toMatchObject({ ok: true });
    const posted = await h.go.call('post_message', { request_id: 'rq_visa_1', trip_id: 't_goa', text: 'Bali needs an e-VOA. Add your documents in the vault; the group only sees "Sent".', card });
    expect(posted.error).toBeUndefined();
    const room = (await t.api(t.as('p_kabir'), 'GET', '/app/v1/trips/t_goa/messages')).body.messages.find((m: any) => m.message_id === posted.result.message_id);
    expect([room.author, room.card]).toEqual([{ kind: 'go' }, card]);
    const cards = await t.api(t.as('p_kabir'), 'GET', '/app/v1/trips/t_goa/cards?kind=checklist');
    expect([cards.status, cards.body.items]).toEqual([200, [{ message_id: posted.result.message_id, card, posted_at: expect.any(String) }]]);
    // Go hears message.created with the card as it was.
    await h.flush();
    expect(h.go.events.find((e) => e.type === 'message.created' && e.data.message.message_id === posted.result.message_id)?.data.message.card).toEqual(card);
    // A row of mine still to do (todo or started) is the home card's task; done and info are not; nobody in the card is nothing.
    expect([await attention('p_rahul'), await attention('p_arjun'), await attention('p_priya'), await attention('p_meher'), await attention('p_kabir')]).toEqual([
      { kind: 'task', label: 'Indonesia e-VOA needed' }, { kind: 'task', label: 'Indonesia e-VOA needed' }, { kind: 'collecting' }, { kind: 'collecting' }, { kind: 'collecting' },
    ]);
    // Rahul sends his documents in the vault; Go updates the rows in place.
    const updated = { ...card, rows: card.rows.map((r: any) => (r.person_id === 'p_rahul' ? { ...r, status: 'done', label: 'Sent', sub: undefined } : r)) };
    const replaced = await h.go.call('replace_card', { trip_id: 't_goa', card: updated });
    expect(replaced.result).toEqual({ message_id: posted.result.message_id });
    expect((await t.api(t.as('p_rahul'), 'GET', '/app/v1/trips/t_goa/cards?kind=checklist')).body.items[0].card.rows).toEqual(JSON.parse(JSON.stringify(updated.rows)));
    expect([await attention('p_rahul'), await attention('p_arjun')]).toEqual([{ kind: 'collecting' }, { kind: 'task', label: 'Indonesia e-VOA needed' }]);
    // A press on its button goes to Go like any card tap.
    const tap = await t.api(t.as('p_arjun'), 'POST', '/app/v1/trips/t_goa/cards/c_visa/actions', { action_id: 'add_documents', press_id: 'visa-press-1' });
    expect([tap.status, tap.body.result, h.go.requests.at(-1)?.method, h.go.requests.at(-1)?.params.action_id]).toEqual([200, 'done', 'card_tap', 'add_documents']);
  });

  it('the checklist task comes first; once the row is done the usual rule is back and no expense asks for approval', async () => {
    await t.api(t.as('p_priya'), 'POST', '/app/v1/trips/t_goa/expenses', { paid_by_person_id: 'p_priya', amount_minor: 170000, note: 'Airport cab', category: 'getting_around', split_person_ids: ['p_priya', 'p_arjun'] });
    expect(await attention('p_arjun')).toEqual({ kind: 'task', label: 'Indonesia e-VOA needed' });
    await h.go.call('replace_card', { trip_id: 't_goa', card: { ...card, rows: card.rows.map((r: any) => ({ ...r, status: 'done', label: 'Sent' })) } });
    expect(await attention('p_arjun')).toEqual({ kind: 'needs_you', count: 1 }); // what he owes Priya: the usual rule again
  });
});

describe('the rate limit (app contract Appendix A: 6 vault links a minute per person)', () => {
  it('the one over the limit is 429 rate_limited with retry_after_seconds and Retry-After, and Go is not asked; another person is not affected', async () => {
    h.ctx.limits = { vaultLinksPerMinute: 2 };
    try {
      for (let i = 0; i < 2; i++) expect((await link('p_kabir', { start: 'home' })).status).toBe(200);
      const asked = vaultRequests().length;
      const r = await link('p_kabir', { start: 'home' });
      expect([r.status, r.body.error.code, r.body.error.retry_after_seconds > 0, Number(r.headers['retry-after']) === r.body.error.retry_after_seconds, vaultRequests().length]).toEqual([429, 'rate_limited', true, true, asked]);
      expect((await link('p_meher', { start: 'home' })).status).toBe(200);
    } finally {
      delete h.ctx.limits;
    }
  });
});
