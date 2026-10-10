// §4.1 DELETE /me: the account deletion sequence the app contract fixes. In order: Go forgets the person everywhere
// (nothing else happens if Go does not), their join answers are cleared, they leave every trip they are in (`person.left`
// each, with everything a leave does), their messages stay but read as "Former member" with no photo, and the email,
// UPI id, phone and photo go. The row stays (messages, votes and expenses point at it) with `deleted_at` set, and the
// person's tokens are refused from then on (src/api/app.ts).
import type { Ctx } from '../context.js';
import { leaveTrip } from './actions.js';
import { forgetPerson, GoUnavailable, type GoClient } from './ask-go.js';
import { notFound } from './errors.js';

export const FORMER_MEMBER = 'Former member';

export async function deleteAccount(ctx: Ctx, go: GoClient, personId: string): Promise<void> {
  const exists = await ctx.pool.query('select 1 from people where person_id = $1 and deleted_at is null', [personId]);
  if (!exists.rowCount) throw notFound(`person ${personId} does not exist`);
  // 1 and 2. Go forgets, then the join answers are cleared (with `person.updated` where the person is still in a trip).
  try {
    await forgetPerson(ctx, go, personId);
  } catch (err) {
    if (err instanceof GoUnavailable) throw new GoUnavailable(502, 'Go could not forget you just now; nothing was deleted. Try again.');
    throw err;
  }
  // 3. Leave every trip, in a fixed order: `person.left`, votes that now have everyone's answer.
  const trips = await ctx.pool.query('select trip_id from trip_people where person_id = $1 and left_at is null order by trip_id', [personId]);
  for (const { trip_id } of trips.rows) await leaveTrip(ctx, trip_id, personId);
  // 4 and 5. The person as the rooms will show them from now on, and nothing that could reach them or identify them.
  await ctx.pool.query(
    `update people set name = $2, photo_url = null, email = null, phone = null, upi_id = null, from_city_default = null,
       deleted_at = now() where person_id = $1`,
    [personId, FORMER_MEMBER],
  );
  await ctx.pool.query('delete from invite_marks where person_id = $1', [personId]);
  await ctx.pool.query('delete from live_tickets where person_id = $1', [personId]);
}
