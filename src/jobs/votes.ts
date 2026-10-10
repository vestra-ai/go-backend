import type { Ctx } from '../context.js';
import { withTx } from '../db/pool.js';
import { SocketCallError } from '../go/go-socket.js';
import { closeDecision } from '../domain/voting.js';
import { sweepUploads } from '../api/v1/uploads.js';
import { sweepLiveTickets } from '../live/ws.js';
import { sweepIdempotency } from './idempotency.js';

/** Closes every open vote whose time has run out (reason `time`). Safe to run on every instance at once. */
export async function closeDueVotes(ctx: Ctx): Promise<number> {
  const { rows } = await ctx.pool.query(`select decision_id, trip_id from decisions where status = 'open' and closes_at <= now() order by closes_at limit 50`);
  let closed = 0;
  for (const r of rows) {
    try {
      await withTx(ctx.pool, (db) => closeDecision(ctx, db, r.trip_id, r.decision_id, 'time'));
      closed++;
    } catch (err) {
      // Another instance closed it first (409), or it is gone: nothing to do.
      if (!(err instanceof SocketCallError && (err.code === 409 || err.code === 404))) throw err;
    }
  }
  return closed;
}

export function startJobs(ctx: Ctx, log: (m: string, e?: unknown) => void = console.error, everyMs = 15_000): () => void {
  const run = async () => {
    try {
      await closeDueVotes(ctx);
    } catch (err) {
      log('vote job failed', err);
    }
    await sweepIdempotency(ctx).catch((err) => log('idempotency sweep failed', err));
    await sweepUploads(ctx).catch((err) => log('uploads sweep failed', err));
    await sweepLiveTickets(ctx).catch((err) => log('live tickets sweep failed', err));
  };
  const timer = setInterval(run, everyMs);
  return () => clearInterval(timer);
}
