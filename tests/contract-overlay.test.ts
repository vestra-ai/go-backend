// The contract is Go's official 1.3.0 (contract/go.json, socket.json, methods.json, from vestra-ai/go-brain
// packages/contract). The Server's overlay (contract/extensions-1.1.json) holds only its web check-in additions, laid over
// the official files additively: every official schema and method is exactly as Go wrote it, and anything outside the
// contract is still refused. `visible_to_person_ids` on PostMessage and Message is official since 1.2.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTRACT_EXTENSIONS_VERSION, METHODS, check, mergeAdditive, parseParams, validator } from '../src/contract/index.js';
import { hasOfficial, officialGoJson, officialMethods, simplifyNullable, validOfficial } from './helpers/official-contract.js';

const overlay = JSON.parse(readFileSync(new URL('../contract/extensions-1.1.json', import.meta.url), 'utf8'));
const socket = JSON.parse(readFileSync(new URL('../contract/socket.json', import.meta.url), 'utf8'));
const CHECKIN_SCHEMAS = ['CheckinState', 'GetCheckin', 'SubmitCheckin', 'SubmitCheckinResult'];
const DEMO_SCHEMAS = ['PaymentCompleted', 'PaymentCompletedData'];

/** Valid against the official files alone, and against the Server's own check (official + overlay): the two must agree. */
const passes = (schema: string, value: unknown) => [validOfficial(schema, value), check(schema, value).ok];

const options10 = {
  card_id: 'c_fl', kind: 'options', fallback_text: 'Flights to Goa', title: 'Flights', option_kind: 'flight', checked_at: '2026-10-05T06:49:30Z',
  options: [{ option_id: 'o1', title: 'IndiGo 6E 2134', price_minor: 592000, currency: 'INR', highlights: ['Non-stop'] }],
  actions: [{ action_id: 'pick', label: 'Pick', style: 'primary', per_option: true }],
};
const cabOptions = {
  ...options10,
  card_id: 'c_cab', fallback_text: 'Cabs from the airport', title: 'Cabs', option_kind: 'cab',
  options: [{
    option_id: 'o1', title: 'Sedan', price_minor: 120000, currency: 'INR', highlights: ['4 seats'], price_oneway_minor: 120000, price_round_minor: 220000,
    details: { caption: 'Airport to Villa Sol', why: ['Fits the four of you'], costs: [{ label: 'One way', amount_minor: 120000, currency: 'INR' }], rating: 4.6, review_count: 88, go_note: 'Cheapest option.' },
  }],
};
const checklist = { card_id: 'c_visa', kind: 'checklist', fallback_text: 'Visa', title: 'Indonesia e-VOA', rows: [{ person_id: 'p_a', status: 'todo', label: 'Not yet' }] };
const rooms = {
  card_id: 'c_rooms', kind: 'rooms', fallback_text: 'Pick how you split the rooms at Villa Sol', title: 'Rooms at Villa Sol', option_id: 'opt_villa',
  arrangements: [{
    arrangement_id: 'ar_1', label: 'Two doubles', total_minor: 4200000,
    rooms: [{ room_type_id: 'rt_deluxe', label: 'Deluxe room', person_ids: ['p_a', 'p_b'], price_minor: 2400000 }, { room_type_id: 'rt_std', label: 'Standard room', person_ids: ['p_c', 'p_d'], price_minor: 1800000 }],
    per_person: [{ person_id: 'p_a', amount_minor: 1200000 }, { person_id: 'p_b', amount_minor: 1200000 }, { person_id: 'p_c', amount_minor: 900000 }, { person_id: 'p_d', amount_minor: 900000 }],
  }],
};
const settlement = { settlement_id: 'st_1', from_person_id: 'p_a', to_person_id: 'p_b', amount_minor: 580000, currency: 'INR', method: 'upi', status: 'confirmed', recorded_at: '2026-10-05T06:49:30Z', confirmed_at: '2026-10-05T06:49:30Z' };
const event = (type: string, data: unknown) => ({ event_id: 'e_1', trip_id: 't', seq: 9, occurred_at: '2026-10-05T06:50:30Z', type, data });

describe('the official contract and the Server\'s overlay', () => {
  it('the official contract is 1.3.0, in all three files', () => {
    expect(officialMethods.contract).toBe('1.3.0');
    expect(officialGoJson.info.version).toBe('1.3.0');
    expect(socket.info.version).toBe('1.3.0');
  });

  it('the overlay holds only the check-in schemas and methods and the demo\'s payment.completed event, none of them already in the official files', () => {
    expect(CONTRACT_EXTENSIONS_VERSION).toBe('1.3.0+server-checkin');
    // `Event` is the one official name in the overlay: it only gains the payment.completed branch (docs/GO-TEAM-DEMO-PAYMENT.md).
    expect(Object.keys(overlay.schemas).sort()).toEqual([...CHECKIN_SCHEMAS, ...DEMO_SCHEMAS, 'Event'].sort());
    expect(overlay.schemas.Event).toEqual({ oneOf: [{ $ref: '#/components/schemas/PaymentCompleted' }] });
    expect(overlay.methods.map((m: any) => m.name)).toEqual(['get_checkin', 'submit_checkin']);
    expect([...CHECKIN_SCHEMAS, ...DEMO_SCHEMAS].filter(hasOfficial)).toEqual([]);
    expect(overlay.methods.filter((m: any) => officialMethods.methods.some((o: any) => o.name === m.name))).toEqual([]);
  });

  it('the overlay only adds: every official schema and method is exactly as Go wrote it in the Server\'s checker', () => {
    for (const [name, schema] of Object.entries(officialGoJson.components.schemas)) {
      if (name === 'Event') continue; // checked below: the official branches, then the demo's one
      expect(validator(name).schema, name).toEqual(simplifyNullable(schema));
    }
    const official = simplifyNullable(officialGoJson.components.schemas.Event) as { oneOf: unknown[] };
    expect(validator('Event').schema).toEqual({ ...official, oneOf: [...official.oneOf, { $ref: '#/components/schemas/PaymentCompleted' }] });
    for (const m of officialMethods.methods) expect(METHODS[m.name], m.name).toEqual(m);
    expect(Object.keys(METHODS).sort()).toEqual([...officialMethods.methods.map((m: any) => m.name), 'get_checkin', 'submit_checkin'].sort());
  });

  it('the check-in requests are known to the Server and not to the official files', () => {
    expect(METHODS.get_checkin).toMatchObject({ direction: 'to_go', params: 'GetCheckin', result: 'CheckinState' });
    expect(METHODS.submit_checkin).toMatchObject({ direction: 'to_go', params: 'SubmitCheckin', result: 'SubmitCheckinResult' });
    expect(parseParams('get_checkin', { trip_id: 't', booking_id: 'b', person_id: 'p' })).toMatchObject({ ok: true });
    expect(parseParams('submit_checkin', { trip_id: 't', booking_id: 'b', person_id: 'p', digi_yatra: true, declaration: true, seat: '14A' })).toMatchObject({ ok: true });
    expect(parseParams('submit_checkin', { trip_id: 't', booking_id: 'b', person_id: 'p', digi_yatra: true })).toMatchObject({ ok: false, message: expect.stringContaining('declaration') });
    expect(check('CheckinState', { status: 'open', seat: '14A', seat_map: { rows: [] } })).toMatchObject({ ok: true });
    expect(check('CheckinState', { status: 'boarding' })).toMatchObject({ ok: false });
    expect(() => validOfficial('CheckinState', { status: 'open' })).toThrow(/no schema CheckinState/);
  });
});

describe('1.1 shapes against the official files', () => {
  it('an options card with option_kind cab and details validates; the flight card too; an unknown option_kind and a details rating over 10 are refused', () => {
    expect(passes('Card', cabOptions)).toEqual([true, true]);
    expect(passes('Card', options10)).toEqual([true, true]);
    expect(passes('Card', { ...options10, option_kind: 'rocket' })).toEqual([false, false]);
    expect(passes('Card', { ...cabOptions, options: [{ ...cabOptions.options[0], details: { rating: 11 } }] })).toEqual([false, false]);
  });

  it('the checklist and rooms cards validate; a rooms card with no arrangement, a checklist row with an unknown status and an unknown card kind are refused', () => {
    expect(passes('Card', checklist)).toEqual([true, true]);
    expect(passes('Card', rooms)).toEqual([true, true]);
    expect(passes('Card', { ...rooms, arrangements: [] })).toEqual([false, false]);
    expect(passes('Card', { ...checklist, rows: [{ person_id: 'p_a', status: 'maybe', label: 'x' }] })).toEqual([false, false]);
    expect(passes('Card', { card_id: 'c_x', kind: 'hologram', fallback_text: 'A hologram' })).toEqual([false, false]);
  });

  it('a location attachment validates; one off the globe is refused', () => {
    expect(passes('Attachment', { kind: 'location', lat: 15.5, lng: 73.8, name: 'Anjuna' })).toEqual([true, true]);
    expect(passes('Attachment', { kind: 'location', lat: 95, lng: 73.8 })).toEqual([false, false]);
  });

  it('settlement.recorded validates in its official shape { settlement, by }; the old flat shape and a status other than confirmed are refused', () => {
    expect(passes('Event', event('settlement.recorded', { settlement, by: { kind: 'person', person_id: 'p_a' } }))).toEqual([true, true]);
    expect(passes('Event', event('settlement.recorded', settlement))).toEqual([false, false]);
    expect(passes('Event', event('settlement.recorded', { settlement: { ...settlement, status: 'pending' }, by: { kind: 'person', person_id: 'p_a' } }))).toEqual([false, false]);
  });

  it('message.created from the system validates: the pill the Server posts, with the vote card of a person-opened poll', () => {
    const message = { message_id: 'm_1', seq: 9, updated_seq: 9, author: { kind: 'system' }, text: 'Where do we stay?', attachments: [], mentions_go: false, mentions: [], reactions: [], withheld: false, deleted: false, sent_at: '2026-10-05T06:50:30Z' };
    expect(passes('Event', event('message.created', { message }))).toEqual([true, true]);
    expect(passes('Event', event('message.created', { message: { ...message, card: { card_id: 'c_v', kind: 'vote', decision_id: 'd_1', fallback_text: 'Where do we stay?' } } }))).toEqual([true, true]);
    expect(passes('Event', event('message.created', { message: { ...message, author: { kind: 'robot' } } }))).toEqual([false, false]);
  });

  it('a card_tap with its payload, and a vault link that starts at add_documents with a trip context, validate; an unknown payload trip and start are refused', () => {
    const tap = { tap_id: 't', trip_id: 't', card_id: 'c', action_id: 'pick', person_id: 'p', payload: { trip: 'round' } };
    expect([validOfficial(METHODS.card_tap!.params, tap), parseParams('card_tap', tap).ok]).toEqual([true, true]);
    expect(parseParams('card_tap', { ...tap, payload: { trip: 'circle' } })).toMatchObject({ ok: false });
    const link = { kind: 'vault', person_id: 'p', start: 'add_documents', context: { trip_id: 't', purpose: 'visa' } };
    expect([validOfficial(METHODS.vault_link!.params, link), parseParams('vault_link', link).ok]).toEqual([true, true]);
    expect(parseParams('vault_link', { ...link, start: 'add_passport' })).toMatchObject({ ok: false });
  });
});

describe('1.3 shapes against the official files', () => {
  it('an options card holds up to 10 options (5 before 1.3), with a vote, an https link and a live view', () => {
    const option = (i: number) => ({ option_id: `o${i}`, title: `Stay ${i}`, highlights: [], url: 'https://www.ixigo.com/hotels/x' });
    const post = (count: number, over: Record<string, unknown> = {}) => parseParams('post_message', {
      request_id: 'r', trip_id: 't', text: 'Stays',
      card: { card_id: 'c_1', kind: 'options', fallback_text: 'Stays', title: 'Stays', option_kind: 'stay', checked_at: '2026-10-11T06:00:00Z', decision_id: 'd_1', options: Array.from({ length: count }, (_, i) => option(i)), ...over },
    });
    expect(post(10)).toMatchObject({ ok: true });
    expect(post(11)).toMatchObject({ ok: false });
    expect(parseParams('post_message', { request_id: 'r', trip_id: 't', text: 'Searching', card: { card_id: 'c_w', kind: 'working', fallback_text: 'Searching', task_id: 'tk_1', title: 'Searching ixigo', state: 'running', steps: [], updated_at: '2026-10-11T06:00:00Z', live_url: 'https://go.example/live#t' } })).toMatchObject({ ok: true });
  });
});

describe('1.2 shapes against the official files', () => {
  it('post_message with visible_to_person_ids validates; an empty list is refused', () => {
    const post = { request_id: 'r', trip_id: 't', text: 'Only for you', visible_to_person_ids: ['p_a'] };
    expect([validOfficial(METHODS.post_message!.params, post), parseParams('post_message', post).ok]).toEqual([true, true]);
    expect(parseParams('post_message', { ...post, visible_to_person_ids: [] })).toMatchObject({ ok: false });
  });

  it('request_spend_approval has two forms, the group vote and 1.3\'s personal pick; 1.2\'s ticket form is gone', () => {
    const base = { request_id: 'r', trip_id: 't', amount_minor: 592000, currency: 'INR', merchant: 'IndiGo', purpose: 'Flight' };
    const group = { ...base, decision_id: 'd_1' };
    const personal = { ...base, personal: { person_id: 'p_a', card_id: 'c_1', option_id: 'o1' } };
    for (const p of [group, personal]) expect([validOfficial('RequestSpendApproval', p), parseParams('request_spend_approval', p).ok]).toEqual([true, true]);
    expect(parseParams('request_spend_approval', { ...base, kind: 'ticket', for_person_id: 'p_a' })).toMatchObject({ ok: false });
    expect(parseParams('request_spend_approval', base)).toMatchObject({ ok: false });
  });

  it('the denial reasons gain not_in_trip and already_booked, and 1.3\'s no_pick', () => {
    for (const reason of ['not_in_trip', 'already_booked', 'no_pick']) expect(passes('SpendDenied', { status: 'denied', reason })).toEqual([true, true]);
  });
});

describe('mergeAdditive', () => {
  it('adds properties, enum values and oneOf branches, and leaves types, limits and required alone', () => {
    const base = { type: 'object', required: ['a'], properties: { a: { type: 'string', maxLength: 5 }, k: { type: 'string', enum: ['x'] } } };
    const merged = mergeAdditive(base, { type: 'array', required: ['b'], properties: { a: { type: 'integer', maxLength: 99 }, b: { type: 'boolean' }, k: { enum: ['y', 'x'] } } });
    expect(merged).toEqual({ type: 'object', required: ['a'], properties: { a: { type: 'string', maxLength: 5 }, b: { type: 'boolean' }, k: { type: 'string', enum: ['x', 'y'] } } });
    expect(mergeAdditive({ oneOf: [{ $ref: 'A' }] }, { oneOf: [{ $ref: 'B' }, { $ref: 'A' }] })).toEqual({ oneOf: [{ $ref: 'A' }, { $ref: 'B' }] });
  });
});
