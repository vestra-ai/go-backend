// §4.4 GET /trips/:trip: the trip as the app may see it (contract §2 TripView). The snapshot Go reads, plus `stage`, the
// caller's own corner (`me`), the chat button's numbers, the "needs you" count and what the caller may do, all from one
// repeatable-read transaction so `seq` matches every number. Two app-only touches that Go never receives: a cancellation
// vote carries `cancels_booking_id`, and a booking's `passengers` and `documents` are there only for the people it covers
// (§1.7). Everyone in the trip sees where each person travels from and when they can leave (rev 4 §5.2).
import type pg from 'pg';
import type { Ctx } from '../context.js';
import { Forbidden, needsYouIn } from './actions.js';
import { bookingsForPerson } from './bookings.js';
import { invalid } from './errors.js';
import { actorOf, compact, visibleSql } from './mappers.js';
import { buildSnapshot } from './snapshot.js';
import { stageOf, type Stage } from './stage.js';
import type { Actor, Person, TripSnapshot } from './types.js';

export interface TripView extends TripSnapshot {
  stage: Stage;
  me: {
    person: Person;
    last_read_seq: number;
    unread_count: number;
  };
  chat: {
    unread_count: number;
    /** `author.former` when the author is no longer in the trip (left, or deleted their account), as on a Message. */
    last_message?: { message_id: string; author: Actor & { former?: true }; text_preview: string; sent_at: string };
    participants_preview: Array<{ kind: 'go' } | { kind: 'person'; person_id: string }>;
  };
  needs_you_count: number;
  can: { invite: boolean; manage_trip: boolean };
}

/** The parts `?include=` may trim (everything else always comes). */
export const INCLUDABLE = ['people', 'decisions', 'bookings', 'expenses', 'money', 'itinerary', 'record'] as const;
export type Includable = (typeof INCLUDABLE)[number];

/** `?include=people,decisions` → the set of parts to keep; 422 for a part that is not one of the seven. */
export function parseInclude(raw: string | undefined): Set<Includable> | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const p of parts) if (!(INCLUDABLE as readonly string[]).includes(p)) throw invalid(`include: ${p} is not one of ${INCLUDABLE.join(', ')}`, 'include');
  return new Set(parts as Includable[]);
}

const PREVIEW_CHARS = 80;

/** Messages posted after what the person has read, by others, still standing, that are for them. The server's own pills are not unread. */
export async function unreadCount(db: pg.Pool | pg.PoolClient, tripId: string, personId: string, lastReadSeq: number): Promise<number> {
  const { rows } = await db.query(
    `select count(*)::int as n from messages where trip_id = $1 and seq > $2 and deleted = false and author_kind <> 'system' and author_person_id is distinct from $3 and ${visibleSql('$3')}`,
    [tripId, lastReadSeq, personId],
  );
  return rows[0].n as number;
}

export async function readTripView(ctx: Ctx, tripId: string, personId: string, include?: Set<Includable>): Promise<TripView> {
  const db = await ctx.pool.connect();
  try {
    await db.query('begin transaction isolation level repeatable read read only');
    const membership = (await db.query('select role, last_read_seq from trip_people where trip_id = $1 and person_id = $2 and left_at is null', [tripId, personId])).rows[0];
    if (!membership) throw new Forbidden(`${personId} is not in trip ${tripId}`);
    const snap = await buildSnapshot(db, tripId, ctx.publicBaseUrl);
    const links = await db.query('select decision_id, cancels_booking_id from decisions where trip_id = $1 and cancels_booking_id is not null', [tripId]);
    const unread = await unreadCount(db, tripId, personId, membership.last_read_seq);
    const last = (await db.query(
      `select message_id, author_kind, author_person_id, text, card->>'fallback_text' as fallback, sent_at,
              author_person_id is not null and not exists (select 1 from trip_people tp join people p using (person_id)
                where tp.trip_id = messages.trip_id and tp.person_id = messages.author_person_id and tp.left_at is null and p.deleted_at is null) as former
         from messages
        where trip_id = $1 and deleted = false and author_kind <> 'system' and ${visibleSql('$2')} order by seq desc limit 1`,
      [tripId, personId],
    )).rows[0];
    // Who talks in the room: Go first when it ever posted, then people by their latest message. The server's pills are nobody.
    // Both read only the messages that are for this person, like the room itself.
    const talkers = await db.query(
      `select author_kind, author_person_id, max(seq) as last_seq from messages where trip_id = $1 and deleted = false and author_kind <> 'system' and ${visibleSql('$2')}
        group by author_kind, author_person_id order by (author_kind = 'go') desc, last_seq desc limit 4`,
      [tripId, personId],
    );
    const needs = (await needsYouIn(db, tripId, personId, ctx.features)).length;
    const bookings = await bookingsForPerson(db, snap.bookings, personId);
    await db.query('commit');

    const cancels = new Map(links.rows.map((r) => [r.decision_id as string, r.cancels_booking_id as string]));
    const mine = snap.people.find((p) => p.person_id === personId)!;
    const view: TripView = {
      ...snap,
      decisions: snap.decisions.map((d) => (cancels.has(d.decision_id) ? ({ ...d, cancels_booking_id: cancels.get(d.decision_id) } as typeof d) : d)),
      bookings,
      stage: stageOf({ destination: snap.destination, dates: snap.dates, bookings: snap.bookings }),
      me: {
        person: mine,
        last_read_seq: membership.last_read_seq,
        unread_count: unread,
      },
      chat: {
        unread_count: unread,
        ...(last
          ? { last_message: { message_id: last.message_id, author: last.former ? { ...actorOf(last), former: true } : actorOf(last), text_preview: String(last.text ?? last.fallback ?? '').slice(0, PREVIEW_CHARS), sent_at: new Date(last.sent_at).toISOString() } }
          : {}),
        participants_preview: talkers.rows.map((r) => (r.author_kind === 'go' ? { kind: 'go' as const } : { kind: 'person' as const, person_id: r.author_person_id as string })),
      },
      needs_you_count: needs,
      can: { invite: true, manage_trip: membership.role === 'organizer' },
    };
    if (!include) return view;
    const trimmed: Record<string, unknown> = { ...view };
    for (const part of INCLUDABLE) if (!include.has(part)) delete trimmed[part];
    return compact(trimmed) as unknown as TripView;
  } catch (err) {
    await db.query('rollback').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}
