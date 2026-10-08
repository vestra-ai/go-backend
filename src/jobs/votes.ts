import type { Ctx } from '../context.js';
import { withTx } from '../db/pool.js';
import { SocketCallError } from '../go/go-socket.js';
import { closeDecision } from '../domain/voting.js';
import { sweepUploads } from '../api/v1/uploads.js';
import { sweepLiveTickets } from '../live/ws.js';
import { sendPush } from '../push/send.js';
import { sweepIdempotency } from './idempotency.js';

/** Closes every open vote whose time has run out (reason `time`). Safe to run on every instance at once. */
export async function closeDueVotes(ctx: Ctx): Promise<number> {
  const { rows } = await ctx.pool.query(`select decision_id, trip_id from decisions where status = 'open' and closes_at <= now() order by closes_at limit 50`);
  let closed = 0;
  for (const r of rows) {
    try {
      await withTx(ctx.pool, (db, after) => closeDecision(ctx, db, after, r.trip_id, r.decision_id, 'time'));
      closed++;
    } catch (err) {
      // Another instance closed it first (409), or it is gone: nothing to do.
      if (!(err instanceof SocketCallError && (err.code === 409 || err.code === 404))) throw err;
    }
  }
  return closed;
}

export const CLOSING_SOON_MINUTES = 60;

/** Pushes the people who have not voted when a vote is about to close, once per vote: "Where do we stay? closes in 1 hour". */
export async function pushClosingSoon(ctx: Ctx): Promise<number> {
  // Claiming the vote and marking it pushed is one statement, so only one instance sends it.
  const { rows } = await ctx.pool.query(
    `update decisions set closing_push_sent_at = now()
      where status = 'open' and closing_push_sent_at is null and closes_at is not null
        and closes_at > now() and closes_at <= now() + make_interval(mins => $1)
      returning decision_id, trip_id, question, closes_at`,
    [CLOSING_SOON_MINUTES],
  );
  for (const d of rows) {
    const waiting = await ctx.pool.query(
      `select tp.person_id from trip_people tp
        where tp.trip_id = $1 and tp.left_at is null
          and not exists (select 1 from votes v where v.decision_id = $2 and v.person_id = tp.person_id)`,
      [d.trip_id, d.decision_id],
    );
    const minutes = Math.max(1, Math.round((new Date(d.closes_at).getTime() - Date.now()) / 60_000));
    const when = minutes >= 60 ? 'in 1 hour' : `in ${minutes} minutes`;
    await sendPush(ctx, d.trip_id, waiting.rows.map((r) => r.person_id), { type: 'vote_closing', body: `${d.question} closes ${when}`, id: d.decision_id });
  }
  return rows.length;
}

export function startJobs(ctx: Ctx, log: (m: string, e?: unknown) => void = console.error, everyMs = 15_000): () => void {
  const run = async () => {
    try {
      await closeDueVotes(ctx);
      await pushClosingSoon(ctx);
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
