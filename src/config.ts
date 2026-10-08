import { hostname } from 'node:os';

export interface Config {
  databaseUrl: string;
  goUrl: string;
  goSigningSecret: string;
  goSpendPrivateKey: string;
  instance: string;
  port: number;
  appOrigins: string[];
  /** Web Push keys (VAPID). All three are needed; without them notifications are only written to the log. */
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  vapidSubject?: string;
  /** Postgres connections per instance. The outbox uses at most a third of them, so Go's requests always find one. */
  dbPoolMax: number;
  /** `supabase`: the app sends Supabase access tokens. `dev`: our own tokens from POST /app/v1/dev/sign-in (never in production). */
  authMode: 'supabase' | 'dev';
  /** The Supabase project URL, such as https://abcd.supabase.co. Needed for `supabase` sign-in. */
  supabaseUrl?: string;
  /** Only for a Supabase project still on the legacy shared JWT secret (HS256). */
  supabaseJwtSecret?: string;
  /** A PEM file with the CA that signed the database's certificate (Supabase: Database settings → SSL). */
  databaseCaCert?: string;
  /** Feature flags set in the environment (FEATURE_<NAME>=1|0). Anything not set takes its default (see FEATURE_DEFAULTS). */
  features: Partial<Features>;
}

/**
 * What `GET /app/v1/config` tells the app it may show. Each Go-dependent feature is built behind its flag and flips on the
 * day Go ships that item. `web_push` is on when the VAPID keys are set, unless the environment says otherwise.
 */
export interface Features {
  web_push: boolean;
  checkin: boolean;
  visa: boolean;
  calls: boolean;
  vote_retract: boolean;
  vote_flexible: boolean;
  claim: boolean;
  expense_approval: boolean;
}

export const FEATURE_DEFAULTS: Omit<Features, 'web_push'> = { checkin: false, visa: false, calls: false, vote_retract: false, vote_flexible: false, claim: false, expense_approval: true };

/** The flags the environment sets explicitly: FEATURE_CHECKIN=1, FEATURE_WEB_PUSH=0, ... Anything else is left to its default. */
export function featureOverrides(env: NodeJS.ProcessEnv = process.env): Partial<Features> {
  const out: Partial<Features> = {};
  for (const name of ['web_push', ...Object.keys(FEATURE_DEFAULTS)] as Array<keyof Features>) {
    const v = env[`FEATURE_${name.toUpperCase()}`];
    if (v === undefined || v === '') continue;
    if (v !== '1' && v !== '0') throw new Error(`FEATURE_${name.toUpperCase()} must be 1 or 0, not ${v}`);
    out[name] = v === '1';
  }
  return out;
}

/** The flags as served: the defaults, `web_push` from whether push keys exist, then the environment's overrides. */
export const resolveFeatures = (overrides: Partial<Features>, pushConfigured: boolean): Features => ({ ...FEATURE_DEFAULTS, web_push: pushConfigured, ...overrides });

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}

/** PEM keys are often stored in one line with literal \n in an env var. */
const pem = (s: string) => s.replace(/\\n/g, '\n');

export function loadConfig(): Config {
  return {
    databaseUrl: need('DATABASE_URL'),
    goUrl: need('GO_URL').replace(/\/+$/, ''),
    goSigningSecret: need('GO_SIGNING_SECRET'),
    goSpendPrivateKey: pem(need('GO_SPEND_PRIVATE_KEY')),
    // The host name too: in containers every process can be pid 1, and each instance needs its own name.
    instance: process.env.INSTANCE_NAME ?? `${hostname()}-${process.pid}`,
    port: Number(process.env.PORT ?? 8080),
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || undefined,
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || undefined,
    vapidSubject: process.env.VAPID_SUBJECT || undefined,
    appOrigins: (process.env.APP_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter((o) => o && o !== '*' && o !== 'null'),
    dbPoolMax: Math.max(4, Number(process.env.DB_POOL_MAX ?? 30)),
    ...authConfig(),
    databaseCaCert: process.env.DATABASE_CA_CERT || undefined,
    features: featureOverrides(),
  };
}

/** AUTH_MODE defaults to `supabase` when SUPABASE_URL is set, else `dev`. Dev tokens are refused in production. */
function authConfig(): Pick<Config, 'authMode' | 'supabaseUrl' | 'supabaseJwtSecret'> {
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, '') || undefined;
  const authMode = (process.env.AUTH_MODE || (supabaseUrl ? 'supabase' : 'dev')) as Config['authMode'];
  if (authMode !== 'supabase' && authMode !== 'dev') throw new Error(`AUTH_MODE must be supabase or dev, not ${authMode}`);
  if (authMode === 'supabase' && !supabaseUrl) throw new Error('AUTH_MODE=supabase needs SUPABASE_URL (see .env.example)');
  if (authMode === 'dev' && process.env.NODE_ENV === 'production') throw new Error('AUTH_MODE=dev is for local testing only: set SUPABASE_URL in production');
  return { authMode, supabaseUrl, supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET || undefined };
}

/** GO_URL is Go's https:// base URL; the socket is the same host with wss:// and /v1/socket?instance=<name>. */
export function socketUrl(goUrl: string, instance: string): string {
  return `${goUrl.replace(/^http/, 'ws')}/v1/socket?instance=${encodeURIComponent(instance)}`;
}
