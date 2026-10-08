import type { Ctx } from '../context.js';
import { sweepIdempotencyKeys } from '../api/idempotency.js';

/** Forgets Idempotency-Keys older than their 24-hour window (the app may not reuse a key after that). */
export const sweepIdempotency = (ctx: Ctx): Promise<number> => sweepIdempotencyKeys(ctx.pool);
