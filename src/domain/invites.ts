// §4.3 Invites: the public preview behind a link, accepting, "Not now" and "Decline" marks, and the organizer's rotation.
// A link is a row of `invites`; the trip's `invite_code` mirrors the one that works, so Go's read of `invite_url` is
// unchanged. A rotated link stays in the table and answers `state: "revoked"`.
import type { Ctx } from '../context.js';
import type { Db } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { Forbidden, joinTrip, newInviteCode, type JoinAnswers } from './actions.js';
import { conflict, notFound } from './errors.js';
import { compact, type PersonRow } from './mappers.js';
import { sendPush } from '../push/send.js';
import { activePeople, inviteUrl } from './snapshot.js';
import type { Place } from './types.js';

export type InviteState = 'pending' | 'already_member' | 'declined' | 'expired' | 'revoked';
export type InviteMark = 'later' | 'declined';

/** The contract's PersonLite: a name and a face, nothing else. */
export interface PersonLite { person_id: string; name: string; photo_url?: string }
export const personLite = (p: { person_id: string; name: string; photo_url: string | null }): PersonLite => compact({ person_id: p.person_id, name: p.name, photo_url: p.photo_url ?? undefined });

/** Up to four faces, the organizer first, then in joining order (the invite card's order). */
export function peoplePreview(people: PersonRow[], limit = 4): PersonLite[] {
  const organizer = people.filter((p) => p.role === 'organizer');
  const rest = people.filter((p) => p.role !== 'organizer');
  return [...organizer, ...rest].slice(0, limit).map(personLite);
}

export interface InvitePreview {
  code: string;
  state: InviteState;
  trip: { trip_id: string; title: string; destination?: Place; dates?: { start: string; end: string }; photo_url?: string };
  inviter: PersonLite;
  people_preview: PersonLite[];
  joined_count: number;
}

interface InviteRow {
  code: string; revoked_at: Date | null; trip_id: string; title: string; status: string; destination: Place | null; dates_start: string | null; dates_end: string | null;
}

const loadInvite = async (db: Db, code: string): Promise<InviteRow> => {
  const row = (await db.query<InviteRow>(
    'select i.code, i.revoked_at, t.trip_id, t.title, t.status, t.destination, t.dates_start, t.dates_end from invites i join trips t using (trip_id) where i.code = $1',
    [code],
  )).rows[0];
  if (!row) throw notFound('no trip for this invite link');
  return row;
};

/**
 * The preview behind a link (GET /invites/:code): the trip's name, picture and dates, who invited (the organizer) and who is in.
 * Read-only, and the same for everyone except `state`, which is personal when a viewer is signed in: `already_member` or
 * `declined` instead of `pending`. A rotated link is `revoked`, a trip that is over `expired`. Never a contact detail.
 */
export async function invitePreview(ctx: Ctx, code: string, viewerId?: string): Promise<InvitePreview> {
  const invite = await loadInvite(ctx.pool, code);
  const people = await activePeople(ctx.pool, invite.trip_id);
  const organizer = people.find((p) => p.role === 'organizer') ?? people[0];
  let state: InviteState = 'pending';
  if (invite.revoked_at) state = 'revoked';
  else if (invite.status === 'over') state = 'expired';
  else if (viewerId && people.some((p) => p.person_id === viewerId)) state = 'already_member';
  else if (viewerId) {
    const mark = (await ctx.pool.query('select state from invite_marks where person_id = $1 and code = $2', [viewerId, code])).rows[0];
    if (mark?.state === 'declined') state = 'declined';
  }
  return {
    code,
    state,
    trip: compact({
      trip_id: invite.trip_id,
      title: invite.title,
      destination: invite.destination ?? undefined,
      dates: invite.dates_start && invite.dates_end ? { start: invite.dates_start, end: invite.dates_end } : undefined,
      photo_url: invite.destination?.photo_url ?? undefined,
    }),
    inviter: organizer ? personLite(organizer) : { person_id: '', name: 'Former member' },
    people_preview: peoplePreview(people),
    joined_count: people.length,
  };
}

export type Landing = 'chat' | 'trip_home';

/**
 * "Accept & join" (POST /invites/:code/accept): joins with the answers, then says where to land: the room when it already
 * has a running thread (any message from Go or a person), else the Trip home. Already a member: the trip's current change
 * number and the landing, nothing else happens.
 */
export async function acceptInvite(ctx: Ctx, code: string, personId: string, answers: JoinAnswers = {}): Promise<{ trip_id: string; seq: number; landing: Landing }> {
  const joined = await joinTrip(ctx, code, personId, answers);
  const talking = await ctx.pool.query(`select 1 from messages where trip_id = $1 and deleted = false and author_kind in ('go', 'person') limit 1`, [joined.trip_id]);
  if (!joined.already) await pushJoined(ctx, joined.trip_id, personId);
  return { trip_id: joined.trip_id, seq: joined.seq, landing: talking.rowCount ? 'chat' : 'trip_home' };
}

/** "Priya joined Goa 🌴" to the organizer (app contract §8, `joined`), unless the joiner is the organizer. Best effort. */
async function pushJoined(ctx: Ctx, tripId: string, joinerId: string): Promise<void> {
  const t = (await ctx.pool.query('select t.title, t.organizer_person_id, p.name from trips t join people p on p.person_id = $2 where t.trip_id = $1', [tripId, joinerId])).rows[0];
  if (!t || t.organizer_person_id === joinerId) return;
  await sendPush(ctx, tripId, [t.organizer_person_id], { type: 'joined', body: `${t.name} joined ${t.title}`, id: joinerId }).catch((err) => console.error('joined push failed:', err instanceof Error ? err.name : 'error'));
}

/**
 * "Not now" keeps the invite on my home screen (`later`); "Decline" takes it off and tells nobody (`declined`). One mark per
 * person and link, the last one wins; both are safe to repeat. The link must still work (404 unknown, 409 rotated or over).
 */
export async function markInvite(ctx: Ctx, code: string, personId: string, state: InviteMark): Promise<void> {
  return withTx(ctx.pool, async (db, after) => {
    const invite = await loadInvite(db, code);
    if (invite.revoked_at) throw conflict('this invite link was replaced by a new one: ask for the new link');
    if (invite.status === 'over') throw conflict('this trip is over');
    await db.query(
      `insert into invite_marks (person_id, code, state) values ($1, $2, $3)
       on conflict (person_id, code) do update set state = excluded.state, at = now()`,
      [personId, code, state],
    );
    after(() => ctx.live.publish(invite.trip_id, { kind: 'home', person_id: personId }));
  });
}

/** The link and code for the Share sheet (GET /trips/:trip/invite): the trip's current, working link. */
export async function inviteOf(ctx: Ctx, tripId: string): Promise<{ invite_url: string; code: string }> {
  const t = (await ctx.pool.query('select invite_code from trips where trip_id = $1', [tripId])).rows[0];
  if (!t) throw notFound(`trip ${tripId} does not exist`);
  return { invite_url: inviteUrl(ctx.publicBaseUrl, t.invite_code), code: t.invite_code };
}

/**
 * The organizer invalidates the old link and gets a new one (POST /trips/:trip/invite/rotate). The old row stays and
 * answers `revoked`; the trip's `invite_code` moves to the new one. No event: `invite_url` is not among the fields
 * `trip.updated` can name, and Go reads the link whenever it reads the trip.
 */
export async function rotateInvite(ctx: Ctx, tripId: string, personId: string): Promise<{ invite_url: string; code: string }> {
  return withTx(ctx.pool, async (db) => {
    const t = (await db.query('select organizer_person_id from trips where trip_id = $1 for no key update', [tripId])).rows[0];
    if (!t) throw notFound(`trip ${tripId} does not exist`);
    if (t.organizer_person_id !== personId) throw new Forbidden('only the organizer can change the invite link');
    const code = newInviteCode();
    await db.query('update invites set revoked_at = now() where trip_id = $1 and revoked_at is null', [tripId]);
    await db.query('insert into invites (code, trip_id, created_by) values ($1, $2, $3)', [code, tripId, personId]);
    await db.query('update trips set invite_code = $2 where trip_id = $1', [tripId, code]);
    return { invite_url: inviteUrl(ctx.publicBaseUrl, code), code };
  });
}
