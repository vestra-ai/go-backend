// §4.1 DELETE /me: the account deletion sequence the app contract fixes. In order: Go forgets the person everywhere
// (nothing else happens if Go does not), their join answers are cleared, they leave every trip they are in (`person.left`
// each, with everything a leave does), their messages stay but read as "Former member" with no photo, the room's pills
// that named them ("Priya joined", "Aarav paid Priya ₹5,800") say "Former member" instead, and the email, UPI id, phone
// and photo go. The row stays (messages, votes and expenses point at it) with `deleted_at` set, and the
// person's tokens are refused from then on (src/api/app.ts).
import type pg from 'pg';
import type { Ctx } from '../context.js';
import { withTx } from '../db/pool.js';
import { emit, nextSeq } from '../db/write-change.js';
import { leaveTrip } from './actions.js';
import { forgetPerson, GoUnavailable, type GoClient } from './ask-go.js';
import { notFound } from './errors.js';
import { messageForGo, type MessageRow } from './mappers.js';

export const FORMER_MEMBER = 'Former member';

export async function deleteAccount(ctx: Ctx, go: GoClient, personId: string): Promise<void> {
  const exists = await ctx.pool.query('select name from people where person_id = $1 and deleted_at is null', [personId]);
  if (!exists.rowCount) throw notFound(`person ${personId} does not exist`);
  const oldName = exists.rows[0].name as string; // read before the rename, for the pills below
  // 1 and 2. Go forgets, then the join answers are cleared (with `person.updated` where the person is still in a trip).
  try {
    // The name and photo go as soon as Go has forgotten, before the join answers are cleared: the person.updated and
    // "… left" events that follow (both reach Go) then say "Former member", and Go is not told the name again.
    await forgetPerson(ctx, go, personId, undefined, async () => {
      await ctx.pool.query('update people set name = $2, photo_url = null where person_id = $1', [personId, FORMER_MEMBER]);
    });
  } catch (err) {
    if (err instanceof GoUnavailable) throw new GoUnavailable(502, 'Go could not forget you just now; nothing was deleted. Try again.');
    throw err;
  }
  // 2b. The room's pills that named them, in every trip they are or were in.
  const everTrips = await ctx.pool.query('select trip_id from trip_people where person_id = $1 order by trip_id', [personId]);
  for (const { trip_id } of everTrips.rows) await renameInPills(ctx, trip_id, personId, oldName);
  // 3. Leave every trip, in a fixed order: `person.left`, votes that now have everyone's answer.
  const trips = await ctx.pool.query('select trip_id from trip_people where person_id = $1 and left_at is null order by trip_id', [personId]);
  for (const { trip_id } of trips.rows) await leaveTrip(ctx, trip_id, personId);
  // 4. Nothing that could reach them or identify them.
  await ctx.pool.query(
    `update people set email = null, phone = null, upi_id = null, from_city_default = null, deleted_at = now() where person_id = $1`,
    [personId],
  );
  await ctx.pool.query('delete from live_tickets where person_id = $1', [personId]);
}

/** The name as a whole word: "Priya" in "Priya joined" or "Aarav paid Priya ₹5,800", never in "Priyanka joined". */
const wholeName = (name: string) => new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'gu');

/**
 * Rewrites the server's own pills in one trip that name the deleted person ("Priya joined", "Priya added Dinner · …",
 * "Aarav paid Priya ₹5,800") to say "Former member". Only system messages: what people and Go wrote stays as written.
 * Each changed pill is a change like an edit: the trip's next number as its `updated_seq` (so `?after_seq=` and the
 * `message` frame bring it to the app) and `message.edited` to Go carrying the new text (Go's 1.3 Message allows a
 * system author), so Go's copy loses the name too. No `edited_at`: a pill shows no "edited". When someone else who
 * is or was in the trip has the same name, the text cannot say whose it is, so that trip's pills are left as they are.
 */
async function renameInPills(ctx: Ctx, tripId: string, personId: string, oldName: string): Promise<void> {
  if (!oldName.trim() || oldName === FORMER_MEMBER) return;
  await withTx(ctx.pool, async (db: pg.PoolClient) => {
    const namesake = await db.query('select 1 from trip_people tp join people p using (person_id) where tp.trip_id = $1 and tp.person_id <> $2 and p.name = $3 limit 1', [tripId, personId, oldName]);
    if (namesake.rowCount) return;
    const pills = await db.query<MessageRow>(
      `select * from messages where trip_id = $1 and author_kind = 'system' and not deleted and strpos(text, $2) > 0 order by seq for update`,
      [tripId, oldName],
    );
    for (const pill of pills.rows) {
      const text = pill.text!.replace(wholeName(oldName), FORMER_MEMBER);
      if (text === pill.text) continue; // the name only inside a longer word
      const seq = await nextSeq(db, tripId);
      const row = (await db.query<MessageRow>('update messages set text = $2, updated_seq = $3 where message_id = $1 returning *', [pill.message_id, text, seq])).rows[0]!;
      const reactions = (await db.query('select message_id, person_id, emoji from reactions where message_id = $1 order by created_at', [pill.message_id])).rows;
      await emit(db, tripId, seq, 'message.edited', { message: messageForGo(row, reactions) });
      await ctx.live.publish(tripId, { kind: 'message', message_id: pill.message_id, updated_seq: seq });
    }
  });
}
