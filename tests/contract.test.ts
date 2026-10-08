import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { METHODS, check, parseParams, signRequest, signSpendApproval, verifyRequest, verifySpendApproval } from '../src/contract/index.js';

const vec = (name: string) => JSON.parse(readFileSync(new URL(`../contract/test-vectors/${name}`, import.meta.url), 'utf8'));

describe('signing test vectors', () => {
  const v = vec('signing.json');
  for (const c of v.cases) {
    it(c.name, () => {
      expect(signRequest(c, v.secret, v.t)).toBe(c.header);
      expect(verifyRequest(c.header, c, v.secret, v.t)).toBe(true);
    });
  }
  it('refuses a stale signature', () => {
    const c = v.cases[0];
    expect(verifyRequest(c.header, c, v.secret, v.t + 301)).toBe(false);
  });
});

describe('spend approval test vector', () => {
  const v = vec('spend-approval.json');
  it('reproduces the token character for character', () => {
    expect(signSpendApproval(v.claims, v.private_key_pem)).toBe(v.token);
  });
  it('verifies against the public key', () => {
    expect(verifySpendApproval(v.token, v.public_key_pem, v.verify_at)).toEqual({ ok: true, claims: v.claims });
  });
  it('rejects an expired token and a tampered one', () => {
    expect(verifySpendApproval(v.token, v.public_key_pem, v.claims.exp + 1)).toEqual({ ok: false, reason: 'expired' });
    const [h, , s] = v.token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...v.claims, amount_minor: 1 })).toString('base64url');
    expect(verifySpendApproval(`${h}.${forged}.${s}`, v.public_key_pem, v.verify_at)).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('method table and params checks', () => {
  it('has Go\'s 18 requests and the server\'s 8, plus the two 1.1 check-in requests from the overlay', () => {
    const all = Object.values(METHODS);
    expect(all.filter((m) => m.direction === 'to_server')).toHaveLength(18);
    expect(all.filter((m) => m.direction === 'to_go').map((m) => m.name)).toEqual(['send_event', 'card_tap', 'catch_up', 'get_person', 'update_person', 'delete_fact', 'forget_person', 'vault_link', 'get_checkin', 'submit_checkin']);
  });
  it('accepts the documented post_message example', () => {
    const r = parseParams('post_message', {
      request_id: 'rq_7e3b44', trip_id: 't_goa', text: 'Villa Sol wins, 4 to 1!', mentions: ['p_rahul'],
      card: { card_id: 'c_villa_mandate', kind: 'mandate', decision_id: 'd_villa', fallback_text: 'Ready to book Villa Sol' },
    });
    expect(r).toMatchObject({ ok: true });
  });
  it('treats null like a missing field', () => {
    expect(parseParams('post_message', { request_id: 'r', trip_id: 't', text: 'hi', card: null, reply_to: null })).toMatchObject({ ok: true });
  });
  it('names the field that is wrong', () => {
    const r = parseParams('add_reaction', { request_id: 'r', trip_id: 't', message_id: 'm', emoji: '' });
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toContain('emoji');
  });
  it('names a missing field', () => {
    const r = parseParams('read_trip', {});
    expect((r as { message: string }).message).toBe('trip_id is required');
  });
  it('checks a whole card by its kind', () => {
    expect(check('Card', { card_id: 'c1', kind: 'vote', fallback_text: 'x' })).toMatchObject({ ok: false });
  });
});
