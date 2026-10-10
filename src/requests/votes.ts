import type { Ctx } from '../context.js';
import { newId } from '../db/ids.js';
import { once } from '../db/once.js';
import { change } from '../db/write-change.js';
import { conflict, invalid } from '../domain/errors.js';
import { decisionOf } from '../domain/mappers.js';
import type { DecisionRow } from '../domain/mappers.js';
import { closeDecision, lockDecision } from '../domain/voting.js';
import { assertCurrency, assertPeopleInTrip, tripOf } from './guards.js';

export const openVote = (ctx: Ctx) => async (p: any, raw: Record<string, unknown>) =>
  once(ctx.pool, p.trip_id, p.request_id, async (db) => {
    const trip = await tripOf(db, p.trip_id);
    for (const [i, o] of (p.options as Array<{ currency?: string }>).entries()) assertCurrency(trip, o.currency, `options.${i}.currency`);
    if (p.options.length < 2 || p.options.length > 10) throw invalid('options must have 2 to 10 options');
    if (p.closes_at && new Date(p.closes_at).getTime() <= Date.now()) throw invalid('closes_at must be in the future');
    const people = await db.query('select count(*)::int as n from trip_people where trip_id = $1 and left_at is null', [p.trip_id]);
    // Options are kept as Go sent them (raw), so `option_ref` and anything added later comes back unchanged.
    const row = (await db.query<DecisionRow>(
      `insert into decisions (decision_id, trip_id, question, kind, anonymous, options, of_count, closes_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [newId('d'), p.trip_id, p.question, p.kind, p.anonymous, JSON.stringify(raw.options), people.rows[0].n, p.closes_at ?? null],
    )).rows[0]!;
    // The vote is not in the room yet: Go posts the message with the vote card next.
    const seq = await change(db, p.trip_id, 'decision.opened', { decision: decisionOf(row, []), by: { kind: 'go' } });
    await ctx.live.publish(p.trip_id, { kind: 'trip', seq, kinds: ['decision'] });
    return { decision_id: row.decision_id, seq };
  });

export const closeVote = (ctx: Ctx) => async (p: { request_id: string; trip_id: string; decision_id: string }) =>
  once(ctx.pool, p.trip_id, p.request_id, async (db) => {
    await tripOf(db, p.trip_id);
    return closeDecision(ctx, db, p.trip_id, p.decision_id, 'closed_by_go');
  });

export const setMandate = (ctx: Ctx) => async (p: any) =>
  once(ctx.pool, p.trip_id, p.request_id, async (db) => {
    const trip = await tripOf(db, p.trip_id);
    const decision = await lockDecision(db, p.trip_id, p.decision_id); // 404 when it is not this trip's
    await assertPeopleInTrip(db, p.trip_id, [p.payer_person_id], 'payer_person_id');
    if (p.choice_index < 0 || p.choice_index >= decision.options.length) throw invalid(`choice_index must be from 0 to ${decision.options.length - 1}`);
    if (p.cap_minor <= 0) throw invalid('cap_minor must be more than zero');
    assertCurrency(trip, p.currency);
    if (decision.kind !== 'choice') throw conflict('only a choice vote can have a mandate');
    if (decision.status !== 'closed') throw conflict(`decision ${p.decision_id} is ${decision.status}, not closed`);
    // A new mandate replaces the old one and clears the payer's earlier yes or no: they must answer again.
    const mandate = {
      choice_index: p.choice_index,
      cap_minor: p.cap_minor,
      currency: p.currency,
      refundable_only: p.refundable_only,
      payer_person_id: p.payer_person_id,
      set_at: new Date().toISOString(),
    };
    await db.query('update decisions set mandate = $2 where decision_id = $1', [p.decision_id, JSON.stringify(mandate)]);
    const seq = await change(db, p.trip_id, 'mandate.set', { decision_id: p.decision_id, mandate });
    await ctx.live.publish(p.trip_id, { kind: 'trip', seq, kinds: ['mandate'] });
    return { seq };
  });
