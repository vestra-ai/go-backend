import type { Ctx } from '../context.js';
import { newId } from '../db/ids.js';
import { once } from '../db/once.js';
import { change } from '../db/write-change.js';
import { publishHome } from '../domain/actions.js';
import { conflict, invalid, notFound } from '../domain/errors.js';
import { recordLineOf } from '../domain/mappers.js';
import type { RecordLineRow } from '../domain/mappers.js';
import { assertMessagesInTrip, assertPeopleInTrip, requireSomething, tripOf } from './guards.js';

type Proof = { message_id: string; person_id?: string };

async function checkProof(db: import('pg').PoolClient, tripId: string, proof: Proof[], personIds: string[]) {
  await assertMessagesInTrip(db, tripId, proof.map((x) => x.message_id), 'proof.message_id');
  await assertPeopleInTrip(db, tripId, [...proof.map((x) => x.person_id), ...personIds], 'person_ids');
}

export const addRecordLine = (ctx: Ctx) => async (p: any) =>
  once(ctx.pool, p.trip_id, p.request_id, async (db) => {
    await tripOf(db, p.trip_id);
    // Decided and booked lines come only from votes and bookings.
    if (!['agreed', 'open', 'doing'].includes(p.kind)) throw invalid('kind must be agreed, open or doing');
    if (p.kind === 'agreed' && p.proof.length === 0) throw invalid('an agreed line needs at least one proof');
    await checkProof(db, p.trip_id, p.proof, p.person_ids);
    const line = (await db.query<RecordLineRow>(
      `insert into record_lines (line_id, trip_id, kind, text, proof, person_ids, due_at, source)
       values ($1, $2, $3, $4, $5, $6, $7, 'go') returning *`,
      [newId('r'), p.trip_id, p.kind, p.text, JSON.stringify(p.proof), JSON.stringify(p.person_ids), p.due_at ?? null],
    )).rows[0]!;
    const seq = await change(db, p.trip_id, 'record.changed', { line: recordLineOf(line), change: 'added', by: { kind: 'go' } });
    await ctx.live.publish(p.trip_id, { kind: 'trip', seq, kinds: ['record'] });
    await publishHome(ctx, p.trip_id, line.person_ids); // an open line naming them is one of their open items
    return { line_id: line.line_id, seq };
  });

export const updateRecordLine = (ctx: Ctx) => async (p: any) =>
  once(ctx.pool, p.trip_id, p.request_id, async (db) => {
    await tripOf(db, p.trip_id);
    const current = (await db.query<RecordLineRow>('select * from record_lines where trip_id = $1 and line_id = $2 for update', [p.trip_id, p.line_id])).rows[0];
    if (!current) throw notFound(`line ${p.line_id} does not exist in trip ${p.trip_id}`);
    requireSomething(p, ['kind', 'text', 'status', 'proof', 'person_ids', 'due_at']);
    if (p.status && !['active', 'done'].includes(p.status)) throw invalid('status must be active or done: Go cannot undo a line');
    if (p.proof || p.person_ids) await checkProof(db, p.trip_id, p.proof ?? [], p.person_ids ?? []);
    if (current.source !== 'go') throw conflict(`line ${p.line_id} is not Go's to change`);
    if (current.status === 'undone') throw conflict(`line ${p.line_id} was undone by a person and stays undone`);
    const kind = p.kind ?? current.kind;
    const proof = p.proof ?? current.proof;
    if (kind === 'agreed' && proof.length === 0) throw invalid('an agreed line needs at least one proof');
    const updated = (await db.query<RecordLineRow>(
      `update record_lines set kind = $2, text = $3, status = $4, proof = $5, person_ids = $6, due_at = $7, updated_at = now()
        where line_id = $1 returning *`,
      [p.line_id, kind, p.text ?? current.text, p.status ?? current.status, JSON.stringify(proof), JSON.stringify(p.person_ids ?? current.person_ids), p.due_at ?? current.due_at],
    )).rows[0]!;
    const seq = await change(db, p.trip_id, 'record.changed', {
      line: recordLineOf(updated),
      change: p.status === 'done' && current.status !== 'done' ? 'done' : 'updated',
      by: { kind: 'go' },
    });
    await ctx.live.publish(p.trip_id, { kind: 'trip', seq, kinds: ['record'] });
    await publishHome(ctx, p.trip_id, [...current.person_ids, ...updated.person_ids]); // named before or after
    return { seq };
  });
