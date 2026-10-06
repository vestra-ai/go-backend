// What people change about themselves and their trips. Each edit is one transaction: lock the row compared against,
// compare, write only what differs, and tell Go through the usual change number and event. Nothing that did not change
// is written or sent: an edit that changes nothing answers `seq: null`.
import type pg from 'pg';
import type { Ctx } from '../context.js';
import { withTx } from '../db/pool.js';
import { change } from '../db/write-change.js';
import type { PatchMeBody, PatchTripMeBody, PutBudgetBody } from '../api/bodies.js';
import { Forbidden } from './actions.js';
import { invalid, notFound } from './errors.js';
import { personForGo } from './mappers.js';
import { activePeople } from './snapshot.js';

interface PersonRecord { person_id: string; name: string; photo_url: string | null; upi_id: string | null }

/** The person's own values. The UPI id goes only to its owner (and, in settle-up, to those who owe them). */
const own = (r: PersonRecord) => ({ person_id: r.person_id, name: r.name, photo_url: r.photo_url, upi_id: r.upi_id });

export async function getMyProfile(ctx: Ctx, personId: string) {
  const { rows } = await ctx.pool.query<PersonRecord>('select person_id, name, photo_url, upi_id from people where person_id = $1', [personId]);
  if (!rows[0]) throw notFound(`person ${personId} does not exist`);
  return own(rows[0]);
}

/**
 * Edits the person's name, photo link and UPI id. One transaction locks the person's row first, writes, and then tells
 * every trip the person is in now (in ascending trip id, so two edits by people who share trips cannot cross): one
 * `person.updated` each, with `changed` drawn from name, photo_url and has_upi (has_upi only when it flips). A new UPI id
 * that replaces another changes nothing Go can see, so it sends nothing. Go never receives the UPI text.
 * `seq` is the last change number written, or null when nothing was sent.
 */
export async function updateMyProfile(ctx: Ctx, personId: string, input: PatchMeBody) {
  return withTx(ctx.pool, async (db, after) => {
    const cur = (await db.query<PersonRecord>('select person_id, name, photo_url, upi_id from people where person_id = $1 for no key update', [personId])).rows[0];
    if (!cur) throw notFound(`person ${personId} does not exist`);
    const next: PersonRecord = {
      ...cur,
      name: input.name ?? cur.name,
      photo_url: input.photo_url === undefined ? cur.photo_url : input.photo_url,
      upi_id: input.upi_id === undefined ? cur.upi_id : input.upi_id,
    };
    if (next.name === cur.name && next.photo_url === cur.photo_url && next.upi_id === cur.upi_id) return { ...own(cur), seq: null };
    await db.query('update people set name = $2, photo_url = $3, upi_id = $4 where person_id = $1', [personId, next.name, next.photo_url, next.upi_id]);
    const changed = [
      ...(next.name !== cur.name ? ['name'] : []),
      ...(next.photo_url !== cur.photo_url ? ['photo_url'] : []),
      ...(!!next.upi_id !== !!cur.upi_id ? ['has_upi'] : []),
    ];
    let seq: number | null = null;
    if (changed.length > 0) {
      const trips = await db.query('select trip_id from trip_people where person_id = $1 and left_at is null order by trip_id', [personId]);
      for (const { trip_id } of trips.rows) {
        // Hold the person's membership row before the trip's change number (lock order: person row, membership row, change number),
        // so a leave, a pause or a "forget me" by the same person cannot slip in between. If they left meanwhile, say nothing there.
        const still = await db.query('select 1 from trip_people where trip_id = $1 and person_id = $2 and left_at is null for no key update', [trip_id, personId]);
        if (!still.rowCount) continue;
        const person = (await activePeople(db, trip_id)).find((p) => p.person_id === personId)!;
        const written = await change(db, trip_id, 'person.updated', { person: personForGo(person), changed });
        seq = written;
        after(() => ctx.live.publish(trip_id, { kind: 'trip', seq: written }));
      }
    }
    return { ...own(next), seq };
  });
}

// ---------------------------------------------------------------- a person's answers in one trip

interface MembershipRecord {
  role: 'organizer' | 'member'; go_paused: boolean; from_city: string | null; earliest_leave: string | null; know: string[];
  budget_min_minor: number | null; budget_max_minor: number | null;
}

/** Locks the person's membership row for the rest of the transaction. The person must be in the trip now. */
async function lockMembership(db: pg.PoolClient, tripId: string, personId: string): Promise<MembershipRecord> {
  const row = (await db.query<MembershipRecord>('select * from trip_people where trip_id = $1 and person_id = $2 and left_at is null for no key update', [tripId, personId])).rows[0];
  if (!row) throw new Forbidden(`${personId} is not in trip ${tripId}`);
  return row;
}

/** The caller's own join answers, with their own budget answer (which only they ever see). */
export async function getMyTripAnswers(ctx: Ctx, tripId: string, personId: string) {
  const { rows } = await ctx.pool.query<MembershipRecord>('select * from trip_people where trip_id = $1 and person_id = $2 and left_at is null', [tripId, personId]);
  const m = rows[0];
  if (!m) throw new Forbidden(`${personId} is not in trip ${tripId}`);
  const budget = m.budget_min_minor === null ? null : { min_minor: m.budget_min_minor, ...(m.budget_max_minor === null ? {} : { max_minor: m.budget_max_minor }) };
  return { from_city: m.from_city, earliest_leave: m.earliest_leave, know: m.know, budget, role: m.role, go_paused: m.go_paused };
}

/** Edits the join answers in this trip. One `person.updated` here only, listing what differs; nothing differs: `seq: null`. */
export async function updateMyTripAnswers(ctx: Ctx, tripId: string, personId: string, input: PatchTripMeBody) {
  return withTx(ctx.pool, async (db, after) => {
    const cur = await lockMembership(db, tripId, personId);
    const next = {
      from_city: input.from_city === undefined ? cur.from_city : input.from_city,
      earliest_leave: input.earliest_leave === undefined ? cur.earliest_leave : input.earliest_leave,
      know: input.know === undefined ? cur.know : input.know,
    };
    const changed = (['from_city', 'earliest_leave', 'know'] as const).filter((f) => JSON.stringify(next[f]) !== JSON.stringify(cur[f]));
    if (changed.length === 0) return { seq: null };
    await db.query(
      `update trip_people set ${changed.map((f, i) => `${f} = $${i + 3}`).join(', ')} where trip_id = $1 and person_id = $2`,
      [tripId, personId, ...changed.map((f) => (f === 'know' ? JSON.stringify(next.know) : next[f]))],
    );
    const person = (await activePeople(db, tripId)).find((p) => p.person_id === personId)!;
    const seq = await change(db, tripId, 'person.updated', { person: personForGo(person), changed });
    after(() => ctx.live.publish(tripId, { kind: 'trip', seq }));
    return { seq };
  });
}

/**
 * Sets the caller's whole budget answer (it cannot be withdrawn). When the stored answer changes Go hears `trip.updated`
 * by the system, `changed: ['budget']`, which names nobody and no amount: only the lowest band, which Go reads, can move.
 * The same answer again sends nothing.
 */
export async function setMyBudget(ctx: Ctx, tripId: string, personId: string, input: PutBudgetBody) {
  if (input.max_minor !== undefined && input.max_minor < input.min_minor) throw invalid('max_minor must not be below min_minor');
  return withTx(ctx.pool, async (db, after) => {
    const cur = await lockMembership(db, tripId, personId);
    const max = input.max_minor ?? null;
    if (cur.budget_min_minor === input.min_minor && cur.budget_max_minor === max) return { seq: null };
    await db.query('update trip_people set budget_min_minor = $3, budget_max_minor = $4 where trip_id = $1 and person_id = $2', [tripId, personId, input.min_minor, max]);
    const seq = await change(db, tripId, 'trip.updated', { by: { kind: 'system' }, changed: ['budget'] });
    after(() => ctx.live.publish(tripId, { kind: 'trip', seq }));
    return { seq };
  });
}
