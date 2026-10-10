// The contract is Go's official 1.1.0 (contract/go.json, socket.json, methods.json, from vestra-ai/go-brain
// packages/contract). The Server's overlay (contract/extensions-1.1.json) holds its web check-in additions and visible_to_person_ids, laid over
// the official files additively: every official schema and method is exactly as Go wrote it (PostMessage and Message gain
// one optional member, `visible_to_person_ids`, and nothing else), and anything outside the contract is still refused.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTRACT_EXTENSIONS_VERSION, METHODS, check, mergeAdditive, parseParams, validator } from '../src/contract/index.js';
import { hasOfficial, officialGoJson, officialMethods, simplifyNullable, validOfficial } from './helpers/official-contract.js';

const overlay = JSON.parse(readFileSync(new URL('../contract/extensions-1.1.json', import.meta.url), 'utf8'));
const socket = JSON.parse(readFileSync(new URL('../contract/socket.json', import.meta.url), 'utf8'));
const CHECKIN_SCHEMAS = ['CheckinState', 'GetCheckin', 'SubmitCheckin', 'SubmitCheckinResult'];
/** Official schemas the overlay widens with `visible_to_person_ids` (a message only some people see in the app). */
const WIDENED = ['Message', 'PostMessage'];

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
  it('the official contract is 1.1.0, in all three files', () => {
    expect(officialMethods.contract).toBe('1.1.0');
    expect(officialGoJson.info.version).toBe('1.1.0');
    expect(socket.info.version).toBe('1.1.0');
  });

  it('the overlay holds the check-in schemas and methods, none of them already in the official files, and widens Message and PostMessage', () => {
    expect(CONTRACT_EXTENSIONS_VERSION).toBe('1.1.0+server-checkin');
    expect(Object.keys(overlay.schemas).sort()).toEqual([...CHECKIN_SCHEMAS, ...WIDENED].sort());
    for (const name of WIDENED) expect(Object.keys(overlay.schemas[name].properties), name).toEqual(['visible_to_person_ids']);
    expect(overlay.methods.map((m: any) => m.name)).toEqual(['get_checkin', 'submit_checkin']);
    expect(CHECKIN_SCHEMAS.filter(hasOfficial)).toEqual([]);
    expect(overlay.methods.filter((m: any) => officialMethods.methods.some((o: any) => o.name === m.name))).toEqual([]);
  });

  it('the overlay only adds: every official schema and method is exactly as Go wrote it in the Server\'s checker', () => {
    for (const [name, schema] of Object.entries(officialGoJson.components.schemas)) {
      const official = simplifyNullable(schema) as any;
      if (!WIDENED.includes(name)) {
        expect(validator(name).schema, name).toEqual(official);
        continue;
      }
      const ours = validator(name).schema as any;
      const { visible_to_person_ids, ...rest } = ours.properties;
      expect({ ...ours, properties: rest }, name).toEqual(official);
      expect(visible_to_person_ids, name).toMatchObject({ type: 'array', minItems: 1, maxItems: 30, uniqueItems: true });
    }
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

describe('mergeAdditive', () => {
  it('adds properties, enum values and oneOf branches, and leaves types, limits and required alone', () => {
    const base = { type: 'object', required: ['a'], properties: { a: { type: 'string', maxLength: 5 }, k: { type: 'string', enum: ['x'] } } };
    const merged = mergeAdditive(base, { type: 'array', required: ['b'], properties: { a: { type: 'integer', maxLength: 99 }, b: { type: 'boolean' }, k: { enum: ['y', 'x'] } } });
    expect(merged).toEqual({ type: 'object', required: ['a'], properties: { a: { type: 'string', maxLength: 5 }, b: { type: 'boolean' }, k: { type: 'string', enum: ['x', 'y'] } } });
    expect(mergeAdditive({ oneOf: [{ $ref: 'A' }] }, { oneOf: [{ $ref: 'B' }, { $ref: 'A' }] })).toEqual({ oneOf: [{ $ref: 'A' }, { $ref: 'B' }] });
  });
});
