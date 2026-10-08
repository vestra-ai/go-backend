// §4.2 Home: one read for the whole home screen. My trips with the status line the Server works out (`stage`,
// `attention`), the invites I kept for later, my trips that are over, and the ideas carousel for the first run.
import type { Ctx } from '../context.js';
import { needsYouIn } from './actions.js';
import { peoplePreview, personLite, type PersonLite } from './invites.js';
import type { BookingRow, ExpenseRow } from './mappers.js';
import { compact } from './mappers.js';
import { moneyOf } from './money.js';
import { activePeople } from './snapshot.js';
import { attentionOf, stageOf, type Attention, type Stage } from './stage.js';
import type { Place } from './types.js';

export interface TripSummary {
  trip_id: string;
  title: string;
  status: 'planning' | 'booked' | 'on_trip' | 'over';
  stage: Stage;
  destination?: Place;
  dates?: { start: string; end: string };
  /** The destination photo Go set: the one image the server has (our change to the contract's three fields). */
  photo_url?: string;
  people_preview: PersonLite[];
  people_count: number;
  attention: Attention;
  last_activity_at: string;
}

export interface InviteSummary {
  code: string;
  trip: { trip_id: string; title: string; photo_url?: string; dates?: { start: string; end: string } };
  inviter: PersonLite;
  people_preview: PersonLite[];
  joined_count: number;
  received_at: string;
}

export interface PastTripSummary {
  trip_id: string;
  title: string;
  photo_url?: string;
  dates?: { start: string; end: string };
  people_count: number;
  all_settled: boolean;
}

export interface Home {
  me: PersonLite;
  trips: TripSummary[];
  invites: InviteSummary[];
  past_trips: PastTripSummary[];
  /** The highest change number among my trips: a hint for the live layer, nothing the app must act on. */
  seq_hint: number;
}

interface TripRow {
  trip_id: string; title: string; status: TripSummary['status']; destination: Place | null; dates_start: string | null; dates_end: string | null;
  currency: string; plan_minor: number | null; seq: number; last_activity_at: Date;
}

const datesOf = (t: { dates_start: string | null; dates_end: string | null }) => (t.dates_start && t.dates_end ? { start: t.dates_start, end: t.dates_end } : undefined);

/**
 * Everything the home screen shows, for one person. `trips` are the trips I am in that are not over, latest activity first
 * (the time of the trip's last change, or its creation). `invites` are "later" marks on links that still work, for trips I am
 * not in. `past_trips` are over; `all_settled` when nobody owes anybody.
 */
export async function homeFor(ctx: Ctx, personId: string): Promise<Home> {
  const db = ctx.pool;
  const me = (await db.query('select person_id, name, photo_url from people where person_id = $1', [personId])).rows[0];
  const trips = (await db.query<TripRow>(
    `select t.trip_id, t.title, t.status, t.destination, t.dates_start, t.dates_end, t.currency, t.plan_minor, t.seq,
            coalesce((select max(o.created_at) from outbox o where o.trip_id = t.trip_id), t.created_at) as last_activity_at
       from trips t join trip_people tp using (trip_id)
      where tp.person_id = $1 and tp.left_at is null
      order by last_activity_at desc, t.trip_id`,
    [personId],
  )).rows;

  const active: TripSummary[] = [];
  const past: PastTripSummary[] = [];
  for (const t of trips) {
    const people = await activePeople(db, t.trip_id);
    if (t.status === 'over') {
      const expenses = (await db.query<ExpenseRow>('select * from expenses where trip_id = $1 and removed_at is null order by created_at, expense_id', [t.trip_id])).rows;
      const money = moneyOf(expenses, people.map((p) => p.person_id), t.currency, t.plan_minor);
      past.push(compact({ trip_id: t.trip_id, title: t.title, photo_url: t.destination?.photo_url ?? undefined, dates: datesOf(t), people_count: people.length, all_settled: money.transfers.length === 0 }));
      continue;
    }
    const bookings = (await db.query<Pick<BookingRow, 'kind' | 'status'>>('select kind, status from bookings where trip_id = $1', [t.trip_id])).rows;
    const stage = stageOf({ destination: t.destination, dates: datesOf(t), bookings });
    const needs = (await needsYouIn(db, t.trip_id, personId)).length;
    active.push(compact({
      trip_id: t.trip_id,
      title: t.title,
      status: t.status,
      stage,
      destination: t.destination ?? undefined,
      dates: datesOf(t),
      photo_url: t.destination?.photo_url ?? undefined,
      people_preview: peoplePreview(people),
      people_count: people.length,
      attention: attentionOf(stage, needs),
      last_activity_at: new Date(t.last_activity_at).toISOString(),
    }));
  }

  const marks = (await db.query(
    `select m.code, m.at, t.trip_id, t.title, t.destination, t.dates_start, t.dates_end
       from invite_marks m join invites i using (code) join trips t using (trip_id)
      where m.person_id = $1 and m.state = 'later' and i.revoked_at is null and t.status <> 'over'
        and not exists (select 1 from trip_people tp where tp.trip_id = t.trip_id and tp.person_id = $1 and tp.left_at is null)
      order by m.at desc`,
    [personId],
  )).rows;
  const invites: InviteSummary[] = [];
  for (const m of marks) {
    const people = await activePeople(db, m.trip_id);
    const organizer = people.find((p) => p.role === 'organizer') ?? people[0];
    invites.push({
      code: m.code,
      trip: compact({ trip_id: m.trip_id, title: m.title, photo_url: m.destination?.photo_url ?? undefined, dates: datesOf(m) }),
      inviter: organizer ? personLite(organizer) : { person_id: '', name: 'Former member' },
      people_preview: peoplePreview(people),
      joined_count: people.length,
      received_at: new Date(m.at).toISOString(),
    });
  }

  return {
    me: personLite(me),
    trips: active,
    invites,
    past_trips: past,
    seq_hint: trips.reduce((max, t) => Math.max(max, t.seq), 0),
  };
}

// ---------------------------------------------------------------- ideas

export interface Idea {
  idea_id: string;
  name: string;
  tag: string;
  travel: { mode: 'flight' | 'car' | 'train' | 'bus'; duration_minutes: number };
  image_url?: string;
  /** What to send POST /trips as `destination_hint` when the idea is tapped. */
  destination_hint: string;
}

/**
 * "Ideas for your crew · From <city>" (GET /discover/ideas): the curated rows for the origin city, or the general set when
 * the city has none. The origin is the one asked for, else the person's default city.
 */
export async function ideasFor(ctx: Ctx, personId: string, fromCity: string | undefined, limit = 8): Promise<{ items: Idea[]; from_city: string | null }> {
  let origin = fromCity?.trim() || null;
  if (!origin) origin = (await ctx.pool.query('select from_city_default from people where person_id = $1', [personId])).rows[0]?.from_city_default ?? null;
  const rowsOf = async (city: string | null) => (await ctx.pool.query(
    `select idea_id, name, tag, travel_mode, duration_minutes, image_url, destination_hint from ideas
      where ${city === null ? 'from_city is null' : 'lower(from_city) = lower($2)'} order by rank, idea_id limit $1`,
    city === null ? [limit] : [limit, city],
  )).rows;
  let rows = origin ? await rowsOf(origin) : [];
  if (rows.length === 0) rows = await rowsOf(null);
  return {
    items: rows.map((r) => compact({ idea_id: r.idea_id, name: r.name, tag: r.tag, travel: { mode: r.travel_mode, duration_minutes: r.duration_minutes }, image_url: r.image_url ?? undefined, destination_hint: r.destination_hint })),
    from_city: origin,
  };
}
