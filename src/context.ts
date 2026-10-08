import type pg from 'pg';
import type { Live } from './live/live.js';
import type { Push } from './push/push.js';
import type { Storage } from './storage/storage.js';

/** What every handler needs. Instances hold no trip state: it all lives in the database. */
export interface Ctx {
  pool: pg.Pool;
  live: Live;
  push: Push;
  /** Where uploaded files live (Supabase Storage, or the in-process fake). */
  storage: Storage;
  /** The app's public address, for invite links: <base>/j/<code> */
  publicBaseUrl: string;
  /** GO_SPEND_PRIVATE_KEY (PEM) */
  spendPrivateKey: string;
  now?: () => Date;
  /** Rate limits a test may loosen; the defaults are the app contract's. */
  limits?: { messagesPerMinute?: number };
}

export const nowOf = (ctx: Ctx): Date => (ctx.now ? ctx.now() : new Date());
