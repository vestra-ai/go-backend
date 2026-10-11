// What people change about themselves and their trips. Each edit is one transaction: lock the row compared against,
// compare, write only what differs, and tell Go through the usual change number and event. Nothing that did not change
// is written or sent: an edit that changes nothing answers `seq: null`.
import type { ChangeKind } from '../live/live.js';
import type pg from 'pg';
import type { Ctx } from '../context.js';
import { withTx } from '../db/pool.js';
import { change } from '../db/write-change.js';
import { check } from '../contract/index.js';
import type { PatchMeBody, PatchTripBody, PatchTripMeBody } from '../api/bodies.js';
import { Forbidden, publishHomeAll, requireMember as requireMemberTx } from './actions.js';
import { resolveUploadUrl } from './attachments.js';
import { invalid, notFound } from './errors.js';
import { knowWithVibe } from './join-answers.js';
import { assertDate, assertItinerarySize } from './limits.js';
import { personForGo } from './mappers.js';
import { activePeople } from './snapshot.js';

interface PersonRecord {
  person_id: string; name: string; photo_url: string | null; upi_id: string | null;
  email: string | null; auth_provider: string | null; from_city_default: string | null; created_at: Date;
}
const PERSON_COLUMNS = 'person_id, name, photo_url, upi_id, email, auth_provider, from_city_default, created_at';

/** The app's `Me.counts`: trips I am in now that are not over, and trips that are over. */
export interface MeCounts { active_trips: number; past_trips: number }

/** The app's `Me` (contract §2). The UPI id is masked; the full id and the email go nowhere else. */
export interface Me {
  person_id: string; name: string; email: string | null; photo_url: string | null; auth_provider: string | null; from_city: string | null;
  has_upi: boolean; upi_id_masked: string | null; counts: MeCounts; created_at: string;
}

/** "aarav@okhdfc" → "aar••••@okhdfc": the first three characters of the local part and the bank suffix. */
export function maskUpi(upiId: string): string {
  const at = upiId.lastIndexOf('@');
  const local = at < 0 ? upiId : upiId.slice(0, at);
  const suffix = at < 0 ? '' : upiId.slice(at);
  return `${local.slice(0, 3)}••••${suffix}`;
}

// Me keeps its empty members as null (contract §2 says so), unlike the other answers.
const own = (r: PersonRecord, counts: MeCounts): Me => ({
  person_id: r.person_id, name: r.name, email: r.email, photo_url: r.photo_url, auth_provider: r.auth_provider, from_city: r.from_city_default,
  has_upi: !!r.upi_id, upi_id_masked: r.upi_id ? maskUpi(r.upi_id) : null,
  counts, created_at: r.created_at.toISOString(),
});

export async function meCounts(db: pg.Pool | pg.PoolClient, personId: string): Promise<MeCounts> {
  const { rows } = await db.query(
    `select
       (select count(*)::int from trip_people tp join trips t using (trip_id) where tp.person_id = $1 and tp.left_at is null and t.status <> 'over') as active_trips,
       (select count(*)::int from trip_people tp join trips t using (trip_id) where tp.person_id = $1 and tp.left_at is null and t.status = 'over') as past_trips`,
    [personId],
  );
  return rows[0] as MeCounts;
}

export async function getMyProfile(ctx: Ctx, personId: string): Promise<Me> {
  const { rows } = await ctx.pool.query<PersonRecord>(`select ${PERSON_COLUMNS} from people where person_id = $1`, [personId]);
  if (!rows[0]) throw notFound(`person ${personId} does not exist`);
  return own(rows[0], await meCounts(ctx.pool, personId));
}

/** What a profile edit may change: the app's PATCH /me fields, and the UPI id for PUT/DELETE /me/upi. */
type ProfileEdit = PatchMeBody & { upi_id?: string | null };

/**
 * Edits the person's name, photo, UPI id and default "travelling from". One transaction locks the
 * person's row first, writes, and then tells every trip the person is in now (in ascending trip id, so two edits by people who
 * share trips cannot cross): one `person.updated` each, with `changed` drawn from name, photo_url and has_upi (has_upi only when
 * it flips). A new UPI id that replaces another, the default city and the switch change nothing Go can see, so they send
 * nothing. Go never receives the UPI text or the email. `seq` is the last change number written, or null when nothing was sent.
 * A `photo_upload_id` (a `profile_photo` upload of the person's, taken once: 422 when it is not theirs, used or expired) becomes
 * the stored photo link, inside the same transaction, so a refused upload writes nothing.
 */
async function editProfile(ctx: Ctx, personId: string, input: ProfileEdit): Promise<Me & { seq: number | null }> {
  if (input.photo_upload_id !== undefined && input.photo_url !== undefined) throw invalid('send photo_upload_id or photo_url, not both', 'photo_upload_id');
  return withTx(ctx.pool, async (db) => {
    const cur = (await db.query<PersonRecord>(`select ${PERSON_COLUMNS} from people where person_id = $1 for no key update`, [personId])).rows[0];
    if (!cur) throw notFound(`person ${personId} does not exist`);
    const photoUrl = input.photo_upload_id !== undefined ? await resolveUploadUrl(ctx, db, personId, input.photo_upload_id) : input.photo_url;
    const next: PersonRecord = {
      ...cur,
      name: input.name ?? cur.name,
      photo_url: photoUrl === undefined ? cur.photo_url : photoUrl,
      upi_id: input.upi_id === undefined ? cur.upi_id : input.upi_id,
      from_city_default: input.from_city === undefined ? cur.from_city_default : input.from_city,
    };
    const counts = await meCounts(db, personId);
    const same = (['name', 'photo_url', 'upi_id', 'from_city_default'] as const).every((f) => next[f] === cur[f]);
    if (same) return { ...own(cur, counts), seq: null };
    await db.query('update people set name = $2, photo_url = $3, upi_id = $4, from_city_default = $5 where person_id = $1', [
      personId, next.name, next.photo_url, next.upi_id, next.from_city_default,
    ]);
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
        await ctx.live.publish(trip_id, { kind: 'trip', seq: written, kinds: ['people'] });
      }
    }
    return { ...own(next, counts), seq };
  });
}

/** PATCH /me: name, photo (an upload of mine, or a link), default city. */
export const updateMyProfile = (ctx: Ctx, personId: string, input: PatchMeBody) => editProfile(ctx, personId, input);

/** PUT /me/upi (a validated id) and DELETE /me/upi (null). Go hears `has_upi` only when it flips. */
export const setMyUpi = (ctx: Ctx, personId: string, upiId: string | null) => editProfile(ctx, personId, { upi_id: upiId });

// ---------------------------------------------------------------- a person's answers in one trip

interface MembershipRecord {
  role: 'organizer' | 'member'; go_paused: boolean; from_city: string | null; earliest_leave: string | null; know: string[];
}

/** Locks the person's membership row for the rest of the transaction. The person must be in the trip now. */
async function lockMembership(db: pg.PoolClient, tripId: string, personId: string): Promise<MembershipRecord> {
  const row = (await db.query<MembershipRecord>('select * from trip_people where trip_id = $1 and person_id = $2 and left_at is null for no key update', [tripId, personId])).rows[0];
  if (!row) throw new Forbidden(`${personId} is not in trip ${tripId}`);
  return row;
}

/** The caller's own join answers, role and pause. */
export async function getMyTripAnswers(ctx: Ctx, tripId: string, personId: string) {
  const { rows } = await ctx.pool.query<MembershipRecord>('select * from trip_people where trip_id = $1 and person_id = $2 and left_at is null', [tripId, personId]);
  const m = rows[0];
  if (!m) throw new Forbidden(`${personId} is not in trip ${tripId}`);
  return { from_city: m.from_city, earliest_leave: m.earliest_leave, know: m.know, role: m.role, go_paused: m.go_paused };
}

/**
 * Edits the join answers in this trip (PUT …/me/join-answers): one `person.updated` here only, listing what differs. Nothing
 * differs: `seq: null`. Answers the caller's own Person, in full. The vibe lands in `know` as "Vibe: beach" (see join-answers.ts).
 */
export async function updateMyTripAnswers(ctx: Ctx, tripId: string, personId: string, input: PatchTripMeBody) {
  return withTx(ctx.pool, async (db) => {
    const cur = await lockMembership(db, tripId, personId);
    const next = {
      from_city: input.from_city === undefined ? cur.from_city : input.from_city,
      earliest_leave: input.earliest_leave === undefined ? cur.earliest_leave : input.earliest_leave,
      know: knowWithVibe(input.know === undefined ? cur.know : input.know, input.vibe),
    };
    const changed = (['from_city', 'earliest_leave', 'know'] as const).filter((f) => JSON.stringify(next[f]) !== JSON.stringify(cur[f]));
    let seq: number | null = null;
    if (changed.length > 0) {
      await db.query(
        `update trip_people set ${changed.map((f, i) => `${f} = $${i + 3}`).join(', ')} where trip_id = $1 and person_id = $2`,
        [tripId, personId, ...changed.map((f) => (f === 'know' ? JSON.stringify(next.know) : next[f]))],
      );
      const person = (await activePeople(db, tripId)).find((p) => p.person_id === personId)!;
      seq = await change(db, tripId, 'person.updated', { person: personForGo(person), changed });
    }
    if (seq !== null) {
      const last = seq;
      await ctx.live.publish(tripId, { kind: 'trip', seq: last, kinds: ['people'] });
    }
    const mine = (await activePeople(db, tripId)).find((p) => p.person_id === personId)!;
    return { ...personForGo(mine), seq };
  });
}

// ---------------------------------------------------------------- the trip's details and status

/**
 * Any member edits the trip's title, dates, itinerary, status (status may move in any direction) or the group's budget per
 * person (null clears it; it is the only field that can be cleared). Locks the trip row, compares,
 * writes only what differs, and sends one `trip.updated` by the person listing only those fields; nothing differs: `seq: null`.
 * The itinerary replaces the whole itinerary: each day is checked against the contract's own Day and item definitions and stored
 * exactly as sent (fields the server does not know survive); "differs" means differs by value, ignoring the order of keys inside
 * objects (the order of days and items counts). The last of two whole-itinerary saves wins, as with Go's `update_trip`.
 */
export async function updateTripDetails(ctx: Ctx, tripId: string, personId: string, input: PatchTripBody) {
  if (input.dates) {
    assertDate(input.dates.start, 'dates.start');
    assertDate(input.dates.end, 'dates.end');
    if (input.dates.start > input.dates.end) throw invalid('dates.start must be on or before dates.end');
  }
  if (input.itinerary) {
    assertItinerarySize(input.itinerary);
    input.itinerary.forEach((day, i) => {
      const checked = check('Day', day);
      if (!checked.ok) throw invalid(`itinerary[${i}] ${checked.message}`, checked.path.reduce((at, s) => (/^\d+$/.test(s) ? `${at}[${s}]` : `${at}.${s}`), `itinerary[${i}]`));
    });
  }
  return withTx(ctx.pool, async (db) => {
    // The trip row, locked: the same lock the change number takes, held from here so nothing else changes the trip between compare and write.
    const cur = (await db.query('select title, status, dates_start, dates_end, budget_per_person_minor from trips where trip_id = $1 for no key update', [tripId])).rows[0];
    if (!cur) throw notFound(`trip ${tripId} does not exist`);
    // Membership is checked after the trip lock, so a leave that is ahead of this edit has committed and is seen (403), and one that is
    // behind it numbers its `person.left` after this edit. (Locking the membership row here would invert the order a leave takes.)
    await requireMemberTx(db, tripId, personId);
    if (input.itinerary) {
      const ids = new Set<string>();
      for (const day of input.itinerary) for (const item of (day.items as Array<{ booking_id?: string }>) ?? []) if (item.booking_id) ids.add(item.booking_id);
      if (ids.size) {
        const found = await db.query('select booking_id from bookings where trip_id = $1 and booking_id = any($2)', [tripId, [...ids]]);
        const have = new Set(found.rows.map((r) => r.booking_id as string));
        const missing = [...ids].find((id) => !have.has(id));
        if (missing) throw invalid(`itinerary: booking ${missing} is not in this trip`);
      }
    }
    const sets: string[] = [];
    const values: unknown[] = [tripId];
    const set = (column: string, value: unknown) => (values.push(value), sets.push(`${column} = $${values.length}`));
    const changed: string[] = [];
    if (input.title !== undefined && input.title !== cur.title) (set('title', input.title), changed.push('title'));
    if (input.dates && (input.dates.start !== cur.dates_start || input.dates.end !== cur.dates_end)) (set('dates_start', input.dates.start), set('dates_end', input.dates.end), changed.push('dates'));
    if (input.itinerary) {
      const same = (await db.query('select itinerary = $2::jsonb as same from trips where trip_id = $1', [tripId, JSON.stringify(input.itinerary)])).rows[0].same as boolean;
      if (!same) (set('itinerary', JSON.stringify(input.itinerary)), changed.push('itinerary'));
    }
    if (input.status !== undefined && input.status !== cur.status) (set('status', input.status), changed.push('status'));
    if (input.budget_per_person_minor !== undefined && input.budget_per_person_minor !== cur.budget_per_person_minor) (set('budget_per_person_minor', input.budget_per_person_minor), changed.push('budget'));
    if (changed.length === 0) return { seq: null };
    await db.query(`update trips set ${sets.join(', ')} where trip_id = $1`, values);
    const seq = await change(db, tripId, 'trip.updated', { by: { kind: 'person', person_id: personId }, changed });
    const kinds: ChangeKind[] = ['trip', ...(changed.includes('budget') ? ['budget' as const] : []), ...(changed.includes('itinerary') ? ['itinerary' as const] : [])];
    await ctx.live.publish(tripId, { kind: 'trip', seq, kinds });
    // The home cards show the name and the dates, and a trip that is over moves to past_trips (or back).
    if (['title', 'dates', 'status'].some((f) => changed.includes(f))) await publishHomeAll(ctx, tripId, db);
    return { seq };
  });
}
