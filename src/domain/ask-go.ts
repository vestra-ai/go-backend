// The Server's own requests to Go (guides: "Your requests"): taps on Go's cards, catch-up, what Go
// knows about a person, forget me and vault links. A person is waiting for each one, so none is
// sent again on its own: a failure is shown to them and they try again.
import { createHash } from 'node:crypto';
import type { VaultLinkBody } from '../api/bodies.js';
import type { Ctx } from '../context.js';
import { check, METHODS } from '../contract/index.js';
import { newId } from '../db/ids.js';
import { withTx } from '../db/pool.js';
import { change } from '../db/write-change.js';
import { SocketCallError, SocketTimeoutError } from '../go/go-socket.js';
import { Forbidden, requireMember } from './actions.js';
import { invalid, notFound } from './errors.js';
import { personForGo, visibleSql } from './mappers.js';
import { activePeople } from './snapshot.js';

export interface GoClient {
  request(method: string, params: object, opts?: { timeoutMs?: number }): Promise<object>;
}

/** What the app is told when Go cannot be asked, does not answer, or answers with an error. */
export class GoUnavailable extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
    readonly code = status === 429 ? 'rate_limited' : status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'go_unavailable',
  ) {
    super(message);
  }
}

/** Sends one request to Go: checks the params, waits for the answer within the method's limit, checks the answer. */
export async function askGo<T = Record<string, unknown>>(go: GoClient, method: string, params: Record<string, unknown>): Promise<T> {
  const info = METHODS[method]!;
  const sent = check(info.params, params);
  // The params come from what the app sent: a value the contract refuses is the app's mistake, not ours.
  if (!sent.ok) throw invalid(sent.message);
  let answer: object;
  try {
    // Wait a little longer than Go's limit, for the network.
    answer = await go.request(method, params, { timeoutMs: (info.answer_within_seconds ?? 2) * 1000 + 500 });
  } catch (err) {
    if (err instanceof SocketTimeoutError) throw new GoUnavailable(504, 'Go did not answer in time. Try again.');
    if (err instanceof SocketCallError) {
      if (err.code === 429) throw new GoUnavailable(429, 'Go is busy. Try again in a moment.', err.retryAfterSeconds);
      if (err.code === 404 || err.code === 409) throw new GoUnavailable(err.code, err.message);
      // Go found our params invalid: a contract mismatch between the two sides (seen on 10 Oct 2026 with vault_link
      // add_documents, which production Go did not have yet). Logged so it is not mistaken for Go being down.
      if (err.code === 422) {
        console.error(`[go] ${method} refused by Go as invalid: ${err.message}`);
        throw new GoUnavailable(502, 'Go could not do that. Try again later.');
      }
      throw new GoUnavailable(503, 'Go could not do that right now. Try again.');
    }
    throw err;
  }
  const result = check(info.result!, answer);
  if (!result.ok) throw new GoUnavailable(502, `Go's answer to ${method} does not match the contract: ${result.message}`);
  return answer as T;
}

/** The cards whose buttons are Go's to answer (the 1.1 `checklist` and `rooms` among them); vote, mandate and expense cards are the Server's. */
const GO_CARD_KINDS = new Set(['options', 'working', 'call', 'pay', 'notice', 'checklist', 'rooms']);

/**
 * The tap id sent to Go for the app's own press id. Go acts on each tap_id once and answers a repeat with its
 * first answer, so the id is tied to the person: someone replaying another person's press id gets a different
 * tap, never that person's answer (such as their vault link). The same press by the same person keeps its id.
 */
export const tapIdFor = (personId: string, appTapId: string) => `tap_${createHash('sha256').update(`${personId}:${appTapId}`).digest('hex').slice(0, 32)}`;

/** What the app shows when Go does not answer a tap (app contract §4.7: a refusal, not an HTTP error). */
export const TAP_UNANSWERED = { result: 'refused', toast: "Go didn't answer. Try again." } as const;

/**
 * Someone tapped a button on one of Go's cards. The press id comes from the app (so a double tap that gets through is
 * still one tap), or is made here. Go acts on each tap_id once. `payload` (GO-CHANGES 1.2: `{ trip: oneway | round }`)
 * goes through as it is. Buttons on record cards (votes, "Yes, book it", settle up) never reach Go: the Server handles
 * them. When Go cannot be asked, does not answer in time or answers badly, the person sees a refusal toast and taps
 * again; the failure is logged here.
 */
export async function cardTap(
  ctx: Ctx,
  go: GoClient,
  tripId: string,
  personId: string,
  input: { card_id: string; action_id: string; option_id?: string; press_id?: string; payload?: Record<string, unknown> },
  log: (msg: string, err?: unknown) => void = (m, e) => console.error(`[card_tap] ${m}`, e ?? ''),
) {
  await requireMember(ctx.pool, tripId, personId);
  // A card on a message that is not for this person is answered as an unknown card.
  const m = (await ctx.pool.query(`select card->>'kind' as kind, card, author_kind from messages where trip_id = $1 and card_id = $2 and author_kind in ('go', 'system') and ${visibleSql('$3')}`, [tripId, input.card_id, personId])).rows[0];
  if (!m) throw notFound(`card ${input.card_id} is not one of Go's cards in this trip`);
  // A record card (a vote, including a person-opened poll's card on a system message) is the Server's: 422, as §4.7 says.
  if (m.author_kind !== 'go' || !GO_CARD_KINDS.has(m.kind)) throw invalid(`${m.kind} cards are handled by the Server, not Go`, 'card_id');
  // The button must be on the card as it stands now: Go may have replaced it (paid, expired, declined) without buttons.
  // Seen on 10 Oct 2026: a tap on an expired pay card reached Go, which started a second payment for a paid stay.
  const card = m.card as { actions?: Array<{ action_id: string }> | null; suggestion?: { cta?: { action_id?: string } | null } | null };
  const buttons = new Set([...(card.actions ?? []).map((a) => a.action_id), ...(card.suggestion?.cta?.action_id ? [card.suggestion.cta.action_id] : [])]);
  if (!buttons.has(input.action_id)) throw invalid(`this card has no "${input.action_id}" button (now)`, 'action_id');
  try {
    return await askGo(go, 'card_tap', {
      tap_id: input.press_id ? tapIdFor(personId, input.press_id) : newId('tap'),
      trip_id: tripId,
      card_id: input.card_id,
      action_id: input.action_id,
      person_id: personId,
      ...(input.option_id ? { option_id: input.option_id } : {}),
      ...(input.payload ? { payload: input.payload } : {}),
    });
  } catch (err) {
    if (!(err instanceof GoUnavailable)) throw err; // a 422 about the params is the app's own mistake
    log(`${tripId} ${input.card_id} ${input.action_id} by ${personId}: ${err.status} ${err.message}`);
    return TAP_UNANSWERED;
  }
}

export const AWAY_HOURS = 3;
export const UNREAD_MESSAGES = 15;

/**
 * Catch-up for someone who comes back to the room after 3 hours or more, or with 15 or more unread
 * messages: a few lines of what they missed, shown above the room for them only, never posted.
 * Answers null (the route's 204) when they were not away long enough, and when Go did not answer in its 3 seconds:
 * the room itself never waits for a catch-up (app contract §4.6).
 */
export async function catchUp(ctx: Ctx, go: GoClient, tripId: string, personId: string, force = false) {
  const member = await requireMember(ctx.pool, tripId, personId);
  const since = new Date(member.last_seen_at ?? member.joined_at);
  const away = (Date.now() - since.getTime()) / 3_600_000;
  const unread = (await ctx.pool.query(
    // The room's own pills (joined, booked, money lines) are a record, not unread; a message that is not for them is not unread either.
    `select count(*)::int as n from messages where trip_id = $1 and sent_at > $2 and deleted = false and author_kind <> 'system' and (author_person_id is distinct from $3) and ${visibleSql('$3')}`,
    [tripId, since, personId],
  )).rows[0].n as number;
  if (!force && away < AWAY_HOURS && unread < UNREAD_MESSAGES) return null;
  try {
    const answer = await askGo<{ summary?: string | null; items?: unknown[] }>(go, 'catch_up', { trip_id: tripId, person_id: personId, since: since.toISOString() });
    // Go had nothing to say (no summary, no items): the app shows nothing, so answer as "not needed" (204).
    if (!answer.summary && !(answer.items?.length)) return null;
    return answer;
  } catch (err) {
    if (err instanceof GoUnavailable && err.status === 504) return null;
    throw err;
  }
}

// ---------------------------------------------------------------- the You screen

export const getPerson = (go: GoClient, personId: string) => askGo(go, 'get_person', { person_id: personId });
export const updateCarryOver = (go: GoClient, personId: string, carryOver: boolean) => askGo(go, 'update_person', { person_id: personId, carry_over: carryOver });
export const deleteFact = (go: GoClient, personId: string, factId: string) => askGo(go, 'delete_fact', { person_id: personId, fact_id: factId });

export type VaultStart = NonNullable<VaultLinkBody['start']>;
/** Why the vault page is opened (GO-CHANGES 2.2): the visa form for a trip. Passport data never touches the server. */
export type VaultContext = NonNullable<VaultLinkBody['context']>;

/** A short-lived link to the person's vault page, for the system browser sheet. Never kept, never put in a push. */
export const vaultLink = (go: GoClient, personId: string, start?: VaultStart, context?: VaultContext) =>
  askGo(go, 'vault_link', { kind: 'vault', person_id: personId, ...(start ? { start } : {}), ...(context ? { context } : {}) });

/**
 * "Forget me", in one trip or everywhere, including trips the person has left. Go deletes what it learned
 * and checks none is left. Then the Server clears the person's join answers in the same trips, so Go cannot
 * learn them again, and sends `person.updated` where they are still in the trip and something was cleared.
 * The room's messages stay: the rest of the group can still see them.
 */
export async function forgetPerson(ctx: Ctx, go: GoClient, personId: string, tripId?: string, afterGoForgot?: () => Promise<void>) {
  if (tripId) {
    const ever = await ctx.pool.query('select 1 from trip_people where trip_id = $1 and person_id = $2', [tripId, personId]);
    if (!ever.rowCount) throw new Forbidden(`${personId} was never in trip ${tripId}`);
  }
  const result = await askGo<{ deleted_facts: number; remaining_facts: number }>(go, 'forget_person', {
    person_id: personId,
    ...(tripId ? { trip_id: tripId } : {}),
  });
  if (result.remaining_facts !== 0) throw new GoUnavailable(502, 'Go says some facts are still left after forgetting');
  await afterGoForgot?.(); // before the person.updated events below, which carry the person as they are now
  const trips = tripId
    ? [tripId]
    : (await ctx.pool.query('select trip_id from trip_people where person_id = $1', [personId])).rows.map((r) => r.trip_id as string);
  for (const id of trips) {
    await withTx(ctx.pool, async (db) => {
      const cleared = await db.query(
        `update trip_people set from_city = null, earliest_leave = null, know = '[]'
          where trip_id = $1 and person_id = $2 and (from_city is not null or earliest_leave is not null or know <> '[]'::jsonb)
          returning left_at`,
        [id, personId],
      );
      // Nothing to clear, or they left the trip (Go no longer counts them in it): no event.
      if (!cleared.rowCount || cleared.rows[0].left_at !== null) return;
      const person = (await activePeople(db, id)).find((p) => p.person_id === personId)!;
      const seq = await change(db, id, 'person.updated', { person: personForGo(person), changed: ['from_city', 'earliest_leave', 'know'] });
      await ctx.live.publish(id, { kind: 'trip', seq, kinds: ['people'] });
    });
  }
  return { deleted_facts: result.deleted_facts, remaining_facts: 0 as const };
}

export { Forbidden };
