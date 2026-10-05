import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { components } from './schema.js';

export type SpendApprovalClaims = components['schemas']['SpendApprovalClaims'];

/** The one header every spend approval has: {"alg":"EdDSA","typ":"go-spend+jws"} */
const HEADER = Buffer.from('{"alg":"EdDSA","typ":"go-spend+jws"}').toString('base64url');

/** Claims are signed in this exact key order (guides/money.md, "Signing the spend approval"). */
const CLAIM_ORDER = [
  'iss', 'aud', 'jti', 'trip_id', 'decision_id', 'payer_person_id', 'amount_minor', 'currency',
  'merchant', 'purpose', 'refundable_until', 'iat', 'exp',
] as const;

function canonical(claims: SpendApprovalClaims): string {
  const ordered: Record<string, unknown> = {};
  for (const key of CLAIM_ORDER) {
    const v = (claims as Record<string, unknown>)[key];
    if (v !== undefined && v !== null) ordered[key] = v;
  }
  return JSON.stringify(ordered);
}

/** A compact JWS: base64url(header).base64url(claims).base64url(Ed25519 signature). */
export function signSpendApproval(claims: SpendApprovalClaims, privateKeyPem: string): string {
  const signingInput = `${HEADER}.${Buffer.from(canonical(claims), 'utf8').toString('base64url')}`;
  const signature = sign(null, Buffer.from(signingInput, 'ascii'), createPrivateKey(privateKeyPem));
  return `${signingInput}.${signature.toString('base64url')}`;
}

export type VerifyResult =
  | { ok: true; claims: SpendApprovalClaims }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'bad_issuer' | 'bad_audience' | 'expired' };

/** What the vault does. The Server only needs it in tests, to prove its tokens verify against the public key. */
export function verifySpendApproval(
  token: string,
  publicKeyPem: string,
  now: number = Math.floor(Date.now() / 1000),
): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== HEADER) return { ok: false, reason: 'malformed' };
  const ok = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), createPublicKey(publicKeyPem), Buffer.from(parts[2]!, 'base64url'));
  if (!ok) return { ok: false, reason: 'bad_signature' };
  let claims: SpendApprovalClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (claims.iss !== 'server') return { ok: false, reason: 'bad_issuer' };
  if (claims.aud !== 'go-vault') return { ok: false, reason: 'bad_audience' };
  if (claims.exp <= now) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}
