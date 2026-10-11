// Rev 5 E: an option's Details page (Go's 1.3 get_option_details). The card carries a little about each option; the
// rest (address, rooms, policies, reviews, what is nearby) is asked of Go when a person opens Details, and kept an hour.
import type { Ctx } from '../context.js';
import type { components } from '../contract/schema.js';
import { requireMember } from './actions.js';
import { askGo, GoUnavailable, type GoClient } from './ask-go.js';
import { notFound } from './errors.js';
import { visibleSql } from './mappers.js';

export type OptionFullDetails = components['schemas']['OptionFullDetails'];

/** How long a whole answer from Go is served before Go is asked again. */
export const OPTION_DETAILS_MINUTES = 60;

/**
 * Everything Go has on one option of one of its options cards, for a member who can see the card. A whole answer kept
 * in the last hour is served without asking Go (`beforeAsking` is not called: the rate limit counts only real asks).
 * Go's answer is kept unless Go marks it partial (`complete: false`), which is shown and asked again next time. When Go
 * cannot be asked (the person is over the limit) or cannot answer, the person still gets something: the last kept
 * answer however old, else what the card itself carries, both marked `complete: false`; with neither, the refusal goes
 * back to the app. If Go says it has no such option (404), what was kept is dropped and only the card's own details
 * are shown. A kept answer is dropped when Go replaces the card (replace_card).
 */
export async function optionDetails(
  ctx: Ctx, go: GoClient, tripId: string, personId: string, cardId: string, optionId: string, beforeAsking: () => void = () => {},
): Promise<OptionFullDetails> {
  await requireMember(ctx.pool, tripId, personId);
  // A card on a message that is not for this person is answered as an unknown card, as a tap on it is.
  const m = (await ctx.pool.query<{ updated_seq: string; card: { options?: Array<{ option_id: string; details?: OptionFullDetails | null }> } }>(
    `select updated_seq, card from messages where trip_id = $1 and card_id = $2 and author_kind = 'go' and card->>'kind' = 'options' and not deleted and ${visibleSql('$3')}`,
    [tripId, cardId, personId],
  )).rows[0];
  const option = m?.card.options?.find((o) => o.option_id === optionId);
  if (!option) throw notFound(`option ${optionId} is not on one of Go's options cards (${cardId}) in this trip`);

  const kept = (await ctx.pool.query<{ details: OptionFullDetails; fresh: boolean }>(
    `select details, fetched_at > now() - make_interval(mins => $4) as fresh from option_details where trip_id = $1 and card_id = $2 and option_id = $3`,
    [tripId, cardId, optionId, OPTION_DETAILS_MINUTES],
  )).rows[0];
  if (kept?.fresh) return kept.details;

  // Something to show when Go is not asked or does not answer, or the refusal itself when there is nothing.
  const instead = (err: unknown, fallback: OptionFullDetails | null | undefined): OptionFullDetails => {
    if (!fallback) throw err;
    return { ...fallback, complete: false };
  };
  try {
    beforeAsking();
  } catch (err) {
    return instead(err, kept?.details ?? option.details);
  }
  let answer: OptionFullDetails;
  try {
    answer = await askGo<OptionFullDetails>(go, 'get_option_details', { trip_id: tripId, card_id: cardId, option_id: optionId, person_id: personId });
  } catch (err) {
    if (!(err instanceof GoUnavailable)) throw err;
    if (err.status !== 404) return instead(err, kept?.details ?? option.details);
    // Go has no such option any more: what was kept is about something gone.
    await ctx.pool.query('delete from option_details where trip_id = $1 and card_id = $2 and option_id = $3', [tripId, cardId, optionId]);
    return instead(err, option.details);
  }
  if (answer.complete !== false) {
    // Kept only if the card is still as it was when this began: an answer that crossed a replace_card is about the old
    // card. The card's row is locked for the check, so a replace_card in flight (it holds the row for update, and deletes
    // what is kept before it commits) is waited for and then seen.
    await ctx.pool.query(
      `with card as (select updated_seq from messages where trip_id = $1 and card_id = $2 for share)
       insert into option_details (trip_id, card_id, option_id, details)
       select $1, $2, $3, $4 from card where card.updated_seq = $5
       on conflict (trip_id, card_id, option_id) do update set details = excluded.details, fetched_at = now()`,
      [tripId, cardId, optionId, JSON.stringify(answer), m!.updated_seq],
    );
  }
  return answer;
}
