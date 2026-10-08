import type pg from 'pg';
import type { Features } from './config.js';
import type { Live } from './live/live.js';
import type { Push } from './push/push.js';

/** What every handler needs. Instances hold no trip state: it all lives in the database. */
export interface Ctx {
  pool: pg.Pool;
  live: Live;
  push: Push;
  /** The app's public address, for invite links: <base>/j/<code> */
  publicBaseUrl: string;
  /** GO_SPEND_PRIVATE_KEY (PEM) */
  spendPrivateKey: string;
  now?: () => Date;
  /** The feature flags the environment set (the rest take their defaults): the domain reads the ones that change a rule, such as `expense_approval`. */
  features?: Partial<Features>;
}

export const nowOf = (ctx: Ctx): Date => (ctx.now ? ctx.now() : new Date());
