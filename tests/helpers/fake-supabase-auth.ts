import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

/**
 * A stand-in for Supabase Auth, for tests and local runs: it publishes signing keys at the same address Supabase does
 * (`/auth/v1/.well-known/jwks.json`) and issues access tokens shaped like Supabase's, for a user who signed in with
 * Google. The server cannot tell it from the real thing: only the URL changes.
 *
 * It is not a full Supabase: no Google, no passwords, no refresh. It only does what our server relies on.
 */
export interface FakeUser {
  /** Supabase user id (uuid). Stable for one fake user, so a second sign-in is the same person. */
  id?: string;
  name?: string;
  email?: string;
  picture?: string;
}

export interface MintOptions {
  /** Seconds until it expires (negative: already expired). Supabase's default is 3600. */
  expiresIn?: number;
  issuer?: string;
  audience?: string;
  role?: string;
  isAnonymous?: boolean;
  /** Signs with a key that is not published (a forged token). */
  unpublishedKey?: boolean;
}

export class FakeSupabaseAuth {
  url = '';
  private http!: Server;
  private key!: { privateKey: CryptoKey; publicJwk: JWK };
  private other!: { privateKey: CryptoKey };
  private readonly users = new Map<string, string>();

  /** Starts on `port` (0: any free port). With `mint`, it also answers GET /mint?name=&email= with a token (dev only). */
  async start(port = 0, opts: { mint?: boolean; host?: string } = {}): Promise<string> {
    const pair = await generateKeyPair('ES256', { extractable: true });
    this.key = { privateKey: pair.privateKey, publicJwk: { ...(await exportJWK(pair.publicKey)), alg: 'ES256', use: 'sig', kid: randomUUID(), key_ops: ['verify'] } };
    this.other = { privateKey: (await generateKeyPair('ES256')).privateKey };
    this.http = createServer(async (req, res) => {
      const path = new URL(req.url ?? '/', 'http://x');
      if (path.pathname === '/auth/v1/.well-known/jwks.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ keys: [this.key.publicJwk] }));
      }
      if (opts.mint && path.pathname === '/mint') {
        const token = await this.mint({ name: path.searchParams.get('name') ?? 'Test Person', email: path.searchParams.get('email') ?? undefined });
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ access_token: token, token_type: 'bearer', expires_in: 3600 }));
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise<void>((r) => this.http.listen(port, opts.host ?? '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`;
    return this.url;
  }

  /** The Supabase user id this fake hands out for an email (or name): the same person on every sign-in. */
  userId(user: FakeUser): string {
    if (user.id) return user.id;
    const key = (user.email ?? user.name ?? 'someone').toLowerCase();
    if (!this.users.has(key)) this.users.set(key, randomUUID());
    return this.users.get(key)!;
  }

  /** An access token like the one Supabase gives the app after "Sign in with Google". */
  async mint(user: FakeUser = {}, o: MintOptions = {}): Promise<string> {
    const sub = this.userId(user);
    const name = user.name ?? 'Test Person';
    const email = user.email ?? `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@gmail.com`;
    const picture = user.picture ?? 'https://lh3.googleusercontent.com/a/test-photo';
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      email,
      phone: '',
      app_metadata: { provider: 'google', providers: ['google'] },
      user_metadata: { avatar_url: picture, email, email_verified: true, full_name: name, iss: 'https://accounts.google.com', name, picture, provider_id: '1043', sub: '1043' },
      role: o.role ?? 'authenticated',
      aal: 'aal1',
      amr: [{ method: 'oauth', timestamp: now }],
      session_id: randomUUID(),
      is_anonymous: o.isAnonymous ?? false,
    })
      .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: this.key.publicJwk.kid! })
      .setIssuer(o.issuer ?? `${this.url}/auth/v1`)
      .setAudience(o.audience ?? 'authenticated')
      .setSubject(sub)
      .setIssuedAt(now)
      .setExpirationTime(now + (o.expiresIn ?? 3600))
      .sign(o.unpublishedKey ? this.other.privateKey : this.key.privateKey);
  }

  /** The project's anon/publishable key in its legacy JWT form: an app key, never a signed-in person. */
  async anonKey(): Promise<string> {
    return new SignJWT({ role: 'anon', ref: 'local' })
      .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: this.key.publicJwk.kid! })
      .setIssuer('supabase')
      .setIssuedAt()
      .setExpirationTime('10y')
      .sign(this.key.privateKey);
  }

  /** A token signed with a legacy shared secret (HS256), as older Supabase projects issue. */
  async mintLegacy(secret: string, user: FakeUser = {}, o: MintOptions = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const name = user.name ?? 'Legacy Person';
    return new SignJWT({ role: o.role ?? 'authenticated', email: user.email, user_metadata: { full_name: name } })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(o.issuer ?? `${this.url}/auth/v1`)
      .setAudience(o.audience ?? 'authenticated')
      .setSubject(this.userId(user))
      .setIssuedAt(now)
      .setExpirationTime(now + (o.expiresIn ?? 3600))
      .sign(new TextEncoder().encode(secret));
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => this.http.close(() => r()));
  }
}
