import type pg from 'pg';
import type { Features, GoContract } from './config.js';
import type { Live } from './live/live.js';
import type { Storage } from './storage/storage.js';

/** What every handler needs. Instances hold no trip state: it all lives in the database. */
export interface Ctx {
  pool: pg.Pool;
  live: Live;
  /** Where uploaded files live (Supabase Storage, or the in-process fake). */
  storage: Storage;
  /** The app's public address, for invite links: <base>/invite/<code> */
  publicBaseUrl: string;
  /** GO_SPEND_PRIVATE_KEY (PEM) */
  spendPrivateKey: string;
  now?: () => Date;
  /** Rate limits a test may loosen or tighten; the defaults are the app contract's (Appendix A). */
  limits?: { messagesPerMinute?: number; reactionsPerMinute?: number; cardTapsPerMinute?: number; votesPerMinute?: number; vaultLinksPerMinute?: number; uploadsPerMinute?: number };
  /** The feature flags the environment set (the rest take their defaults): the domain reads the ones that change a rule, such as `checkin`. */
  features?: Partial<Features>;
  /** What Go's side accepts (GO_CONTRACT). Absent means 1.0: the events Go 1.0 refuses are kept to ourselves. */
  goContract?: GoContract;
}

export const goContractOf = (ctx: Ctx): GoContract => ctx.goContract ?? '1.0';

export const nowOf = (ctx: Ctx): Date => (ctx.now ? ctx.now() : new Date());
