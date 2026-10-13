import { createHmac, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, decodeProtectedHeader, errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';
import type pg from 'pg';
import { alertSignup, type Alerts } from '../alerts.js';
import { newId } from '../db/ids.js';

// How the app signs people in. The contract leaves sign-in to us ("yours to design").
//
// - `supabase` (production): the app signs in with Supabase Auth (Google) and sends Supabase's access token on every
//   call. This server never issues tokens and never sees Google's: it only checks Supabase's signature, the issuer, the
//   audience and the expiry, then finds (or, the first time, creates) the person linked to that Supabase user.
// - `dev` (local runs only): our own small signed tokens from POST /app/v1/dev/sign-in.

export type AuthResult = { personId: string } | { error: 'missing' | 'expired' | 'invalid' };

export interface Authenticator {
  readonly mode: 'dev' | 'supabase';
  personFor(token: string): Promise<AuthResult>;
}

// ---------------------------------------------------------------- dev tokens

const DAY = 24 * 60 * 60;

export function signSession(personId: string, secret: string, nowSec = Math.floor(Date.now() / 1000), ttlSec = 90 * DAY): string {
  const payload = Buffer.from(JSON.stringify({ sub: personId, exp: nowSec + ttlSec })).toString('base64url');
  const mac = createHmac('sha256', secret).update(payload).digest('base64url');
  return `s1.${payload}.${mac}`;
}

export function verifySession(token: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): string | null {
  const [v, payload, mac] = token.split('.');
  if (v !== 's1' || !payload || !mac) return null;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { sub, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof sub === 'string' && exp > nowSec ? sub : null;
  } catch {
    return null;
  }
}

export class DevAuth implements Authenticator {
  readonly mode = 'dev' as const;
  constructor(private readonly secret: string) {}
  async personFor(token: string): Promise<AuthResult> {
    const personId = verifySession(token, this.secret);
    return personId ? { personId } : { error: 'invalid' };
  }
}

// ---------------------------------------------------------------- Supabase access tokens

export interface SupabaseAuthOptions {
  /** The project's URL, such as https://abcd.supabase.co (no trailing slash). The issuer is `${url}/auth/v1`. */
  supabaseUrl: string;
  pool: pg.Pool;
  /**
   * Only for projects still on the legacy shared secret (HS256). Projects on signing keys (ES256/RS256, the default
   * for new projects) are checked against the public keys at `${url}/auth/v1/.well-known/jwks.json` instead.
   */
  jwtSecret?: string;
  /** The team's Slack channel: told when a person signs in for the first time. */
  alerts?: Alerts;
  /** Override for the public-key address (tests). */
  jwksUrl?: string;
}

/** The claims Supabase puts in an access token that this server uses. */
interface SupabaseClaims extends JWTPayload {
  role?: string;
  email?: string;
  is_anonymous?: boolean;
  /** `provider` is how the user signed in: `google`, or `email` for the project's test users. */
  app_metadata?: { provider?: string; [k: string]: unknown };
  user_metadata?: { full_name?: string; name?: string; avatar_url?: string; picture?: string; [k: string]: unknown };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASYMMETRIC = ['ES256', 'RS256', 'EdDSA'];

export class SupabaseAuth implements Authenticator {
  readonly mode = 'supabase' as const;
  private readonly issuer: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly secret?: Uint8Array;
  /** Supabase user id → person id. A small cache: the link never changes once made, and the database is the source of truth. */
  private readonly people = new Map<string, string>();

  constructor(private readonly opts: SupabaseAuthOptions) {
    const base = opts.supabaseUrl.replace(/\/+$/, '');
    this.issuer = `${base}/auth/v1`;
    // jose caches the keys and fetches again (at most every 30 s) when a token names a key it does not hold, which is
    // how a key rotation in Supabase reaches us without a restart.
    this.jwks = createRemoteJWKSet(new URL(opts.jwksUrl ?? `${this.issuer}/.well-known/jwks.json`));
    if (opts.jwtSecret) this.secret = new TextEncoder().encode(opts.jwtSecret);
  }

  async personFor(token: string): Promise<AuthResult> {
    let claims: SupabaseClaims;
    try {
      const { alg } = decodeProtectedHeader(token);
      const checks = { issuer: this.issuer, audience: 'authenticated', clockTolerance: 30 };
      if (alg === 'HS256') {
        if (!this.secret) return { error: 'invalid' };
        claims = (await jwtVerify(token, this.secret, { ...checks, algorithms: ['HS256'] })).payload;
      } else {
        claims = (await jwtVerify(token, this.jwks, { ...checks, algorithms: ASYMMETRIC })).payload;
      }
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) return { error: 'expired' };
      return { error: 'invalid' };
    }
    // The publishable/anon key is also a Supabase JWT (role "anon"): it is an app key, not a signed-in person.
    if (claims.role !== 'authenticated' || claims.is_anonymous === true || typeof claims.sub !== 'string' || !UUID.test(claims.sub)) {
      return { error: 'invalid' };
    }
    return { personId: await this.personForUser(claims) };
  }

  /** Finds the person linked to this Supabase user, or creates one from the profile Google gave Supabase. */
  private async personForUser(claims: SupabaseClaims): Promise<string> {
    const userId = claims.sub!.toLowerCase();
    const cached = this.people.get(userId);
    if (cached) return cached;
    const found = await this.opts.pool.query('select person_id from people where auth_user_id = $1', [userId]);
    let personId: string | undefined = found.rows[0]?.person_id;
    if (!personId) {
      const meta = claims.user_metadata ?? {};
      const email = typeof claims.email === 'string' && claims.email.length <= 320 ? claims.email : null;
      const name = firstText(meta.full_name, meta.name, email?.split('@')[0]) ?? 'Traveller';
      const photo = httpsUrl(meta.avatar_url) ?? httpsUrl(meta.picture);
      const provider = firstText(claims.app_metadata?.provider)?.slice(0, 40) ?? 'email';
      // Two first requests at the same moment create one person: the second insert does nothing and reads the first.
      const created = await this.opts.pool.query(
        `insert into people (person_id, name, photo_url, email, auth_user_id, auth_provider) values ($1, $2, $3, $4, $5, $6)
         on conflict (auth_user_id) do nothing returning person_id`,
        [newId('p'), name.slice(0, 80), photo, email, userId, provider],
      );
      personId = created.rows[0]?.person_id ?? (await this.opts.pool.query('select person_id from people where auth_user_id = $1', [userId])).rows[0].person_id;
      if (created.rows[0] && this.opts.alerts) {
        void alertSignup(this.opts.alerts, this.opts.pool, { person_id: personId!, name: name.slice(0, 80), email, provider }).catch((err) => console.error('[alerts] sign-up', err));
      }
    }
    if (this.people.size > 10_000) this.people.clear();
    this.people.set(userId, personId!);
    return personId!;
  }
}

const firstText = (...values: unknown[]): string | undefined => {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim();
  return undefined;
};

const httpsUrl = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.length > 2000) return null;
  try {
    return new URL(v).protocol === 'https:' ? v : null;
  } catch {
    return null;
  }
};
