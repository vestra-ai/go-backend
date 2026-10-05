// The Server's own requests to Go (guides: "Your requests"): taps on Go's cards, catch-up, what Go
// knows about a person, forget me and vault links. A person is waiting for each one, so none is
// sent again on its own: a failure is shown to them and they try again.
import type { Ctx } from '../context.js';
import { check, METHODS } from '../contract/index.js';
import { newId } from '../db/ids.js';
import { withTx } from '../db/pool.js';
import { change } from '../db/write-change.js';
import { SocketCallError, SocketTimeoutError } from '../go/go-socket.js';
import { Forbidden, requireMember } from './actions.js';
import { invalid } from './errors.js';
import { personForGo } from './mappers.js';
import { activePeople } from './snapshot.js';

export interface GoClient {
  request(method: string, params: object, opts?: { timeoutMs?: number }): Promise<object>;
}

/** What the app is told when Go cannot be asked or does not answer. */
export class GoUnavailable extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/** Sends one request to Go: checks the params, waits for the answer within the method's limit, checks the answer. */
export async function askGo<T = Record<string, unknown>>(go: GoClient, method: string, params: Record<string, unknown>): Promise<T> {
  const info = METHODS[method]!;
  const sent = check(info.params, params);
  if (!sent.ok) throw new Error(`our ${method} request does not match the contract: ${sent.message}`);
  let answer: object;
  try {
    // Wait a little longer than Go's limit, for the network.
    answer = await go.request(method, params, { timeoutMs: (info.answer_within_seconds ?? 2) * 1000 + 500 });
  } catch (err) {
    if (err instanceof SocketTimeoutError) throw new GoUnavailable(504, 'Go did not answer in time. Try again.');
    if (err instanceof SocketCallError) {
      if (err.code === 429) throw new GoUnavailable(429, 'Go is busy. Try again in a moment.', err.retryAfterSeconds);
      if (err.code === 404) throw new GoUnavailable(404, err.message);
      if (err.code === 409) throw new GoUnavailable(409, err.message);
      throw new GoUnavailable(503, 'Go could not do that right now. Try again.');
    }
    throw err;
  }
  const result = check(info.result!, answer);
  if (!result.ok) throw new GoUnavailable(502, `Go's answer to ${method} does not match the contract: ${result.message}`);
  return answer as T;
}

const GO_CARD_KINDS = new Set(['options', 'working', 'call', 'pay', 'notice']);

/**
 * Someone tapped a button on one of Go's cards. The tap id comes from the app (so a double tap that
 * gets through is still one tap), or is made here. Go acts on each tap_id once.
 * Buttons on record cards (votes, "Yes, book it", settle up) never reach Go: the Server handles them.
 */
export async function cardTap(
  ctx: Ctx,
  go: GoClient,
  tripId: string,
  personId: string,
  input: { card_id: string; action_id: string; option_id?: string; tap_id?: string },
) {
  await requireMember(ctx.pool, tripId, personId);
  const m = (await ctx.pool.query(`select card->>'kind' as kind from messages where trip_id = $1 and card_id = $2 and author_kind = 'go'`, [tripId, input.card_id])).rows[0];
  if (!m) throw new GoUnavailable(404, `card ${input.card_id} is not one of Go's cards in this trip`);
  if (!GO_CARD_KINDS.has(m.kind)) throw invalid(`${m.kind} cards are handled by the Server, not Go`);
  return askGo(go, 'card_tap', {
    tap_id: input.tap_id ?? newId('tap'),
    trip_id: tripId,
    card_id: input.card_id,
    action_id: input.action_id,
    person_id: personId,
    ...(input.option_id ? { option_id: input.option_id } : {}),
  });
}

export const AWAY_HOURS = 3;
export const UNREAD_MESSAGES = 15;

/**
 * Catch-up for someone who comes back to the room after 3 hours or more, or with 15 or more unread
 * messages: a few lines of what they missed, shown above the room for them only, never posted.
 */
export async function catchUp(ctx: Ctx, go: GoClient, tripId: string, personId: string, force = false) {
  const member = await requireMember(ctx.pool, tripId, personId);
  const since = new Date(member.last_seen_at ?? member.joined_at);
  const away = (Date.now() - since.getTime()) / 3_600_000;
  const unread = (await ctx.pool.query(
    `select count(*)::int as n from messages where trip_id = $1 and sent_at > $2 and deleted = false and (author_person_id is distinct from $3)`,
    [tripId, since, personId],
  )).rows[0].n as number;
  if (!force && away < AWAY_HOURS && unread < UNREAD_MESSAGES) return { needed: false as const };
  const answer = await askGo(go, 'catch_up', { trip_id: tripId, person_id: personId, since: since.toISOString() });
  return { needed: true as const, ...answer };
}

// ---------------------------------------------------------------- the You screen

export const getPerson = (go: GoClient, personId: string) => askGo(go, 'get_person', { person_id: personId });
export const updateCarryOver = (go: GoClient, personId: string, carryOver: boolean) => askGo(go, 'update_person', { person_id: personId, carry_over: carryOver });
export const deleteFact = (go: GoClient, personId: string, factId: string) => askGo(go, 'delete_fact', { person_id: personId, fact_id: factId });

/** A short-lived link to the person's vault page, for the system browser sheet. Never kept, never put in a push. */
export const vaultLink = (go: GoClient, personId: string, start?: 'home' | 'add_card' | 'add_login') =>
  askGo(go, 'vault_link', { kind: 'vault', person_id: personId, ...(start ? { start } : {}) });

/**
 * "Forget me", in one trip or everywhere. Go deletes what it learned and checks none is left. Then the
 * Server clears the person's join answers in the same trips and sends `person.updated`, so Go cannot
 * learn them again. The room's messages stay: the rest of the group can still see them.
 */
export async function forgetPerson(ctx: Ctx, go: GoClient, personId: string, tripId?: string) {
  if (tripId) await requireMember(ctx.pool, tripId, personId);
  const result = await askGo<{ deleted_facts: number; remaining_facts: number }>(go, 'forget_person', {
    person_id: personId,
    ...(tripId ? { trip_id: tripId } : {}),
  });
  if (result.remaining_facts !== 0) throw new GoUnavailable(502, 'Go says some facts are still left after forgetting');
  const trips = tripId
    ? [tripId]
    : (await ctx.pool.query('select trip_id from trip_people where person_id = $1 and left_at is null', [personId])).rows.map((r) => r.trip_id as string);
  for (const id of trips) {
    await withTx(ctx.pool, async (db, after) => {
      await db.query(`update trip_people set from_city = null, earliest_leave = null, know = '[]' where trip_id = $1 and person_id = $2`, [id, personId]);
      const person = (await activePeople(db, id)).find((p) => p.person_id === personId)!;
      const seq = await change(db, id, 'person.updated', { person: personForGo(person), changed: ['from_city', 'earliest_leave', 'know'] });
      after(() => ctx.live.publish(id, { kind: 'trip', seq }));
    });
  }
  return { deleted_facts: result.deleted_facts, remaining_facts: 0 as const };
}

export { Forbidden };
