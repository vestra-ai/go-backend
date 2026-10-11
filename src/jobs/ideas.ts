// Rev 5 B: the ideas carousel's photos come from Go (1.3 place_info). A background job asks about each idea at most
// once a day and keeps what Go says. Nobody waits on it: GET /discover/ideas only reads what is kept.
import type { Ctx } from '../context.js';
import type { components } from '../contract/schema.js';
import { askGo, GoUnavailable, type GoClient } from '../domain/ask-go.js';

type PlaceInfo = components['schemas']['PlaceInfo'];

/** How long before an idea Go has answered about in full is asked about again. */
export const IDEA_REFRESH_HOURS = 24;
/**
 * How long before an idea Go has not yet answered about in full is asked about again. Go learns places as it goes
 * (and may be deployed after this Server): an idea must not wait a day for photos Go has an hour later.
 */
export const IDEA_RETRY_HOURS = 1;
/** Go says how one gets there in its own words; the ideas table has four. */
/** A week: anything longer is not a way to get to a holiday, and the column is an int. */
const MAX_MINUTES = 7 * 24 * 60;
const TRAVEL_MODE: Record<string, 'flight' | 'car' | 'train' | 'bus'> = { flight: 'flight', train: 'train', bus: 'bus', cab: 'car', drive: 'car' };

/**
 * Asks Go about up to `max` ideas that are due (not asked about in the last day, or hour: see above), the longest-waiting first, and keeps
 * each whole answer; an idea Go has not answered about in full is asked about again after an hour, not a day. Claiming
 * an idea marks it tried first, so two instances never ask about the same one. A whole answer is Go's newest word on the place and replaces what
 * is kept, field by field, for the fields it has: a refusal, or an answer with no photo, leaves the idea's photos as they were,
 * and a partial answer (`complete: false`) only gives its photos to an idea that has none. Go is not asked while the socket is down, and an ask that times out with
 * the socket still down is handed back, so an outage does not use up the idea's try (a brief drop the socket recovers
 * from resends the ask, which then counts). Answers the number of ideas updated.
 */
export async function refreshIdeas(ctx: Ctx, go: GoClient & { connected?: boolean }, max = 1): Promise<number> {
  if (go.connected === false) return 0;
  // The due ideas are picked once (materialized), then marked: exactly `max` at most, whatever plan the update takes.
  const due = (await ctx.pool.query<{ idea_id: string; name: string; from_city: string | null }>(
    `with due as materialized (
       select idea_id from ideas where refresh_tried_at is null
          or refresh_tried_at < now() - make_interval(hours => case when refreshed_at is null then $3::int else $2::int end)
        order by refresh_tried_at nulls first, idea_id limit $1 for update skip locked)
     update ideas set refresh_tried_at = now() from due where ideas.idea_id = due.idea_id
     returning ideas.idea_id, ideas.name, ideas.from_city`,
    [max, IDEA_REFRESH_HOURS, IDEA_RETRY_HOURS],
  )).rows;
  let updated = 0;
  let failed: unknown;
  for (const idea of due) {
    try {
      const info = await askGo<PlaceInfo>(go, 'place_info', { name: idea.name, ...(idea.from_city ? { from_city: idea.from_city } : {}) });
      // Up to 12 photos; a place Go knows by one picture alone (photo_url) shows that one.
      // A label Go left empty (null) is left out: the app's photo has a label or none.
      const photos = info.place.photos?.length
        ? info.place.photos.slice(0, 12).map((p) => ({ url: p.url, ...(p.label ? { label: p.label } : {}) }))
        : info.place.photo_url ? [{ url: info.place.photo_url }] : [];
      if (info.complete === false) {
        // A partial answer is not kept as the idea's answer (it is asked about again within the hour), but an idea with
        // no photo at all takes the ones it brings: Go marks a place partial while it lacks only its best months.
        if (photos.length) await ctx.pool.query('update ideas set photos = $2::jsonb where idea_id = $1 and photos is null', [idea.idea_id, JSON.stringify(photos)]);
        continue;
      }
      // The way there is from a city: an idea for "anywhere" keeps its curated one. A time the column cannot hold is not taken.
      const travel = idea.from_city && info.travel && info.travel.duration_minutes <= MAX_MINUTES ? { mode: TRAVEL_MODE[info.travel.mode], minutes: info.travel.duration_minutes } : null;
      await ctx.pool.query(
        `update ideas set refreshed_at = now(),
                photos = coalesce($2::jsonb, photos), tag = coalesce($3, tag), best_months = coalesce($4::jsonb, best_months),
                travel_mode = coalesce($5, travel_mode), duration_minutes = coalesce($6, duration_minutes)
          where idea_id = $1`,
        [idea.idea_id, photos.length ? JSON.stringify(photos) : null, info.tag ?? null, info.best_months?.length ? JSON.stringify(info.best_months) : null, travel?.mode ?? null, travel?.minutes ?? null],
      );
      updated++;
    } catch (err) {
      if (!(err instanceof GoUnavailable)) {
        failed ??= err; // this idea waits for its next turn; the others claimed with it are still asked about
        continue;
      }
      // Go did not answer. If the socket is down now, the ask very likely never arrived: due again at once.
      if ((go.connected as boolean | undefined) === false) await ctx.pool.query('update ideas set refresh_tried_at = null where idea_id = $1', [idea.idea_id]);
    }
  }
  if (failed) throw failed;
  return updated;
}
