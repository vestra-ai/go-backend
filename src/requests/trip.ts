import type { Ctx } from '../context.js';
import { once } from '../db/once.js';
import { change } from '../db/write-change.js';
import { publishHomeAll } from '../domain/actions.js';
import { invalid } from '../domain/errors.js';
import type { ChangeKind } from '../live/live.js';
import { assertDate, assertItinerarySize } from '../domain/limits.js';
import { requireSomething, tripOf } from './guards.js';

const FIELDS = ['title', 'destination', 'dates', 'vibe', 'stay', 'itinerary'] as const;
/** What a request may carry: the contract's six fields, and the group's budget per person (1.1, GO-CHANGES 6.1). */
const SENDABLE = [...FIELDS, 'budget_per_person_minor'] as const;

export const updateTrip = (ctx: Ctx) => async (p: any, raw: Record<string, unknown>) =>
  once(ctx.pool, p.trip_id, p.request_id, async (db) => {
    await tripOf(db, p.trip_id);
    requireSomething(p, SENDABLE);
    // The trip row, held from here: the budget is compared with what is stored, so nothing may change it in between.
    const trip = (await db.query('select seq, budget_per_person_minor from trips where trip_id = $1 for no key update', [p.trip_id])).rows[0];
    if (p.dates) {
      assertDate(p.dates.start, 'dates.start');
      assertDate(p.dates.end, 'dates.end');
      if (p.dates.start > p.dates.end) throw invalid('dates.start must be on or before dates.end');
    }
    if (p.itinerary) assertItinerarySize(raw.itinerary);
    if (p.itinerary) {
      const ids = new Set<string>();
      for (const day of p.itinerary) for (const item of day.items ?? []) if (item.booking_id) ids.add(item.booking_id);
      if (ids.size) {
        const found = await db.query('select booking_id from bookings where trip_id = $1 and booking_id = any($2)', [p.trip_id, [...ids]]);
        const have = new Set(found.rows.map((r) => r.booking_id));
        const missing = [...ids].find((id) => !have.has(id));
        if (missing) throw invalid(`itinerary: booking ${missing} is not in trip ${p.trip_id}`);
      }
    }
    // Only the fields sent change. The itinerary replaces the whole itinerary. Stored as sent (raw), so new fields survive.
    const sets: string[] = [];
    const values: unknown[] = [p.trip_id];
    const set = (column: string, value: unknown) => (values.push(value), sets.push(`${column} = $${values.length}`));
    if (p.title !== undefined) set('title', p.title);
    if (p.destination !== undefined) set('destination', JSON.stringify(raw.destination));
    if (p.dates !== undefined) (set('dates_start', p.dates.start), set('dates_end', p.dates.end));
    if (p.vibe !== undefined) set('vibe', JSON.stringify(p.vibe));
    if (p.stay !== undefined) set('stay', p.stay);
    if (p.itinerary !== undefined) set('itinerary', JSON.stringify(raw.itinerary));
    // The group's budget: Go sets a value (a missing or null field means unchanged, so Go cannot clear it; a person clears it in
    // the app). The same value again is not a change.
    const budgetMoved = p.budget_per_person_minor !== undefined && p.budget_per_person_minor !== trip.budget_per_person_minor;
    if (budgetMoved) set('budget_per_person_minor', p.budget_per_person_minor);
    const changed: string[] = [...FIELDS.filter((f) => p[f] !== undefined), ...(budgetMoved ? ['budget'] : [])];
    if (changed.length === 0) return { seq: trip.seq as number }; // only a budget that did not move: nothing to write, nothing to tell
    await db.query(`update trips set ${sets.join(', ')} where trip_id = $1`, values);
    const seq = await change(db, p.trip_id, 'trip.updated', { by: { kind: 'go' }, changed });
    const kinds: ChangeKind[] = ['trip', ...(changed.includes('itinerary') ? (['itinerary'] as const) : []), ...(budgetMoved ? (['budget'] as const) : [])];
    await ctx.live.publish(p.trip_id, { kind: 'trip', seq, kinds });
    // The home cards show the name (the automatic one follows the destination and the dates), the place and the dates.
    if (['title', 'destination', 'dates'].some((f) => changed.includes(f))) await publishHomeAll(ctx, p.trip_id, db);
    return { seq };
  });
