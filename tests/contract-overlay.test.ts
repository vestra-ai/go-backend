// The 1.1 overlay (contract/extensions-1.1.json) widens the 1.0 contract and never narrows it: a 1.0 frame still
// validates, a 1.1 frame validates, and anything outside both is still refused.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTRACT_EXTENSIONS_VERSION, METHODS, check, mergeAdditive, parseParams } from '../src/contract/index.js';

const options10 = {
  card_id: 'c_cab', kind: 'options', fallback_text: 'Cabs from the airport', title: 'Cabs', option_kind: 'flight', checked_at: '2026-10-05T06:49:30Z',
  options: [{ option_id: 'o1', title: 'IndiGo 6E 2134', price_minor: 592000, currency: 'INR', highlights: ['Non-stop'] }],
  actions: [{ action_id: 'pick', label: 'Pick', style: 'primary', per_option: true }],
};
const options11 = {
  ...options10,
  option_kind: 'cab',
  options: [{
    option_id: 'o1', title: 'Sedan', price_minor: 120000, currency: 'INR', highlights: ['4 seats'], price_oneway_minor: 120000, price_round_minor: 220000,
    details: { caption: 'Airport to Villa Sol', why: ['Fits the four of you'], costs: [{ label: 'One way', amount_minor: 120000, currency: 'INR' }], rating: 4.6, review_count: 88, go_note: 'Cheapest option.' },
  }],
};

describe('the 1.1 overlay', () => {
  it('is loaded, and the overlay file itself only adds', () => {
    expect(CONTRACT_EXTENSIONS_VERSION).toBe('1.1.0-draft');
    const overlay = JSON.parse(readFileSync(new URL('../contract/extensions-1.1.json', import.meta.url), 'utf8'));
    const base = JSON.parse(readFileSync(new URL('../contract/go.json', import.meta.url), 'utf8')).components.schemas;
    // A patch to an existing schema never names `required` (nothing new is required of Go) and only touches properties, enums and oneOf.
    for (const [name, patch] of Object.entries<any>(overlay.schemas)) {
      if (!(name in base)) continue;
      expect(Object.keys(patch).every((k) => ['properties', 'oneOf'].includes(k)), `${name} patch keys`).toBe(true);
    }
  });

  it('an options card with option_kind cab and details validates (1.1); the same card as 1.0 still validates; an unknown kind is still refused', () => {
    expect(check('Card', options11)).toMatchObject({ ok: true });
    expect(check('Card', options10)).toMatchObject({ ok: true });
    expect(check('Card', { ...options10, option_kind: 'rocket' })).toMatchObject({ ok: false });
    expect(check('Card', { ...options11, options: [{ ...options11.options[0], details: { rating: 7 } }] })).toMatchObject({ ok: false }); // a 1.1 rule is a rule
  });

  it('the new card, attachment, event and request shapes validate; the enum additions apply', () => {
    expect(check('Card', { card_id: 'c_visa', kind: 'checklist', fallback_text: 'Visa', title: 'Indonesia e-VOA', rows: [{ person_id: 'p_a', status: 'todo', label: 'Not yet' }] })).toMatchObject({ ok: true });
    expect(check('Attachment', { kind: 'location', lat: 15.5, lng: 73.8, name: 'Anjuna' })).toMatchObject({ ok: true });
    expect(check('Attachment', { kind: 'file', url: 'https://x.example/v.m4a', name: 'v.m4a', mime: 'audio/mp4', size_bytes: 10, duration_s: 12 })).toMatchObject({ ok: true });
    const settlement = { settlement_id: 'st_1', from_person_id: 'p_a', to_person_id: 'p_b', amount_minor: 580000, currency: 'INR', method: 'upi', status: 'confirmed', recorded_at: '2026-10-05T06:49:30Z', confirmed_at: '2026-10-05T06:50:30Z' };
    expect(check('Event', { event_id: 'e_1', trip_id: 't', seq: 9, occurred_at: '2026-10-05T06:50:30Z', type: 'settlement.recorded', data: settlement })).toMatchObject({ ok: true });
    expect(parseParams('card_tap', { tap_id: 't', trip_id: 't', card_id: 'c', action_id: 'pick', person_id: 'p', payload: { trip: 'round' } })).toMatchObject({ ok: true });
    expect(parseParams('vault_link', { kind: 'vault', person_id: 'p', start: 'add_documents', context: { trip_id: 't', purpose: 'visa' } })).toMatchObject({ ok: true });
    expect(parseParams('post_message', { request_id: 'r', trip_id: 't', text: 'Beach or mountains?', quick_replies: [{ label: '🏖️ Beach', text: 'Beach' }, { label: 'Not sure' }] })).toMatchObject({ ok: true });
    expect(check('ExpenseChangedData', { change: 'disputed', by: { kind: 'person', person_id: 'p' }, expense: { expense_id: 'e', paid_by_person_id: 'p', amount_minor: 1, currency: 'INR', note: 'n', category: 'food', split_person_ids: ['p'], created_at: '2026-10-05T06:49:30Z', status: 'disputed', confirmations: [{ person_id: 'q', state: 'disputed', at: '2026-10-05T06:49:30Z', reason: 'not mine' }] } })).toMatchObject({ ok: true });
    expect(check('DecisionVotedData', { decision_id: 'd', person_id: 'p', voted: 1, of: 3, tally: [0, 0], flexible: true })).toMatchObject({ ok: true });
    expect(METHODS.get_checkin).toMatchObject({ direction: 'to_go', params: 'GetCheckin', result: 'CheckinState' });
    expect(parseParams('submit_checkin', { trip_id: 't', booking_id: 'b', person_id: 'p', digi_yatra: true, declaration: true, seat: '14A' })).toMatchObject({ ok: true });
    expect(check('CheckinState', { status: 'open', seat: '14A', seat_map: { rows: [] } })).toMatchObject({ ok: true });
  });

  it('mergeAdditive adds properties, enum values and oneOf branches, and leaves types, limits and required alone', () => {
    const base = { type: 'object', required: ['a'], properties: { a: { type: 'string', maxLength: 5 }, k: { type: 'string', enum: ['x'] } } };
    const merged = mergeAdditive(base, { type: 'array', required: ['b'], properties: { a: { type: 'integer', maxLength: 99 }, b: { type: 'boolean' }, k: { enum: ['y', 'x'] } } });
    expect(merged).toEqual({ type: 'object', required: ['a'], properties: { a: { type: 'string', maxLength: 5 }, b: { type: 'boolean' }, k: { type: 'string', enum: ['x', 'y'] } } });
    expect(mergeAdditive({ oneOf: [{ $ref: 'A' }] }, { oneOf: [{ $ref: 'B' }, { $ref: 'A' }] })).toEqual({ oneOf: [{ $ref: 'A' }, { $ref: 'B' }] });
  });
});
