// §4.12 Web check-in (app contract §4.12, APP-CONTRACT-CHANGES §4.12, GO-CHANGES 3), behind features.checkin. Go performs
// the check-in on the airline site; the server keeps a copy of what Go found for each covered person on a flight (the
// `checkins` table, migration 009) so the sheets, the "needs you" strip and the home card read it without asking Go
// every time, and still have it when Go is away. The person's own answers (DigiYatra, declaration, seat, mobile) are
// laid over that copy until POST …/complete sends them to Go in one submit_checkin. A paid seat is never taken here:
// the app is told `payment_required` and the vault flow pays first (Go then sets the seat and replaces its card).
import { FEATURE_DEFAULTS, type Features } from '../config.js';
import type { Ctx } from '../context.js';
import type { Db } from '../db/pool.js';
import { Forbidden, type NeedsYouItem } from './actions.js';
import { askGo, GoUnavailable, type GoClient } from './ask-go.js';
import { conflict, invalid, notFound } from './errors.js';
import type { JourneyLike, Passenger } from './mappers.js';

/** The flag as the domain reads it (the environment's override, else the default: off until Go's side is live). */
export const checkinOn = (features?: Partial<Features>): boolean => features?.checkin ?? FEATURE_DEFAULTS.checkin;

/** What the app is told when the flag is off: the route does not exist, so the app's flag and the server agree. */
export const checkinOff = () => notFound('web check-in is not available');

/** The contract's statuses (1.1 overlay): the app contract names not_open, open and done; Go may also say working, failed and closed. */
export type CheckinStatus = 'not_open' | 'open' | 'working' | 'done' | 'failed' | 'closed';

export interface Seat { id: string; row?: number; col?: string; state: 'free' | 'paid' | 'taken' | 'companion'; price_minor?: number; currency?: string }

/** The app contract's CheckinState (§4.12). The inner shapes are Go's draft: only what the server reads is typed. */
export interface CheckinState {
  status: CheckinStatus;
  opens_at?: string;
  closes_at?: string;
  flight?: { number?: string; carrier_name?: string; date?: string; [k: string]: unknown };
  passenger?: { name?: string; mobile_masked?: string; bags?: string; [k: string]: unknown };
  digi_yatra?: boolean;
  declaration?: boolean;
  seat?: string;
  companion?: { person_id: string; seat?: string; next_to_seats?: string[] };
  seat_map?: { front_label?: string; columns?: string[]; aisle_after?: string; rows?: number[]; seats?: Seat[]; [k: string]: unknown };
  boarding_pass?: Record<string, unknown> | null;
  /** The mobile the person typed (PATCH), kept for submit_checkin only; the app sees `passenger.mobile_masked`. */
  mobile?: string;
  [k: string]: unknown;
}

/** PATCH …/checkin's answer for a paid seat: the state as it was, and what the vault must collect first. */
export type PatchedCheckin = CheckinState & { payment_required?: true; seat_price?: { amount_minor: number; currency: string } };

export interface PatchCheckinInput { digi_yatra?: boolean; declaration?: boolean; seat?: string; mobile?: string }

/** The person's own answers: Go learns them at submit, so a refresh from Go must not wipe them meanwhile. */
const OWN_ANSWERS = ['digi_yatra', 'declaration', 'seat', 'mobile'] as const;

/** The row's `status` for the queries (migration 009): open while the person can act, done once checked in, not_open otherwise. */
export const rowStatusOf = (status: CheckinStatus): 'not_open' | 'open' | 'done' => (status === 'done' ? 'done' : status === 'open' || status === 'failed' ? 'open' : 'not_open');

interface FlightBooking { booking_id: string; status: string; title: string; currency: string; for_person_ids: string[]; journey: JourneyLike | null; passengers: Passenger[] | null }

/** The flight booking the check-in is about: 404 when it is not in the trip, 403 when it is not a flight or does not cover the person. */
async function flightFor(db: Db, tripId: string, bookingId: string, personId: string): Promise<FlightBooking> {
  const b = (await db.query<FlightBooking & { kind: string }>('select booking_id, kind, status, title, currency, for_person_ids, journey, passengers from bookings where trip_id = $1 and booking_id = $2', [tripId, bookingId])).rows[0];
  if (!b) throw notFound(`booking ${bookingId} does not exist in trip ${tripId}`);
  if (b.kind !== 'flight') throw new Forbidden(`web check-in is for flights; booking ${bookingId} is a ${b.kind}`);
  if (!b.for_person_ids.includes(personId)) throw new Forbidden('this flight does not cover you');
  return b;
}

async function cachedState(db: Db, bookingId: string, personId: string): Promise<CheckinState | null> {
  const r = (await db.query('select state from checkins where booking_id = $1 and person_id = $2', [bookingId, personId])).rows[0];
  return (r?.state as CheckinState | undefined) ?? null;
}

async function saveState(db: Db, bookingId: string, personId: string, state: CheckinState): Promise<void> {
  await db.query(
    `insert into checkins (booking_id, person_id, status, state) values ($1, $2, $3, $4)
     on conflict (booking_id, person_id) do update set status = excluded.status, state = excluded.state, updated_at = now()`,
    [bookingId, personId, rowStatusOf(state.status), JSON.stringify(state)],
  );
}

/** "6E 5313": from Go's state, else from the booking's journey, else the booking's title. */
export const flightNumberOf = (state: CheckinState | null, b: { journey: JourneyLike | null; title: string }): string =>
  state?.flight?.number ?? ([b.journey?.carrier_code, b.journey?.number].filter(Boolean).join(' ') || b.title);

/** Go's answer laid over what is cached: Go's state wins, except the person's own answers, which stand until they complete (then Go has them). */
function mergeFromGo(cached: CheckinState | null, fresh: CheckinState): CheckinState {
  if (!cached || fresh.status === 'done' || fresh.status === 'closed') return fresh;
  const own = Object.fromEntries(OWN_ANSWERS.filter((k) => cached[k] !== undefined).map((k) => [k, cached[k]]));
  const merged: CheckinState = { ...fresh, ...own };
  if (typeof cached.mobile === 'string') merged.passenger = { ...(fresh.passenger ?? {}), mobile_masked: maskMobile(cached.mobile) };
  return merged;
}

/** The seats beside one seat in the map's columns: "14B" → ["14A", "14C"], only those the map lists when it lists seats. */
function nextTo(seat: string, map: CheckinState['seat_map']): string[] | undefined {
  const m = /^(\d+)([A-Za-z]+)$/.exec(seat);
  if (!m || !map?.columns) return undefined;
  const i = map.columns.indexOf(m[2]!);
  if (i < 0) return undefined;
  const ids = [map.columns[i - 1], map.columns[i + 1]].filter((c): c is string => !!c).map((c) => `${m[1]}${c}`);
  return map.seats ? ids.filter((id) => map.seats!.some((s) => s.id === id)) : ids;
}

/** The friend on the same booking (app contract §4.12 `companion`), from the booking's passengers, unless Go already named one. */
function withCompanion(state: CheckinState, b: FlightBooking, personId: string): CheckinState {
  if (state.companion) return state;
  const other = b.for_person_ids.find((id) => id !== personId);
  if (!other) return state;
  const seat = b.passengers?.find((p) => p.person_id === other)?.seat;
  const beside = seat ? nextTo(seat, state.seat_map) : undefined;
  return { ...state, companion: { person_id: other, ...(seat ? { seat } : {}), ...(beside?.length ? { next_to_seats: beside } : {}) } };
}

/** The state as the app reads it: the person's typed mobile stays here, and `boarding_pass` is null until there is one. */
function forApp(state: CheckinState): CheckinState {
  const { mobile: _m, ...rest } = state;
  return { ...rest, boarding_pass: rest.boarding_pass ?? null };
}

/**
 * Marks check-in open for these covered people without a row (a minimal state, with what is shared: the times and the
 * flight) or whose row says not open yet; rows already open, done, or waiting on Go's submit are left alone. Answers who
 * flipped.
 */
async function markOpen(db: Db, bookingId: string, personIds: string[], shared: Partial<CheckinState>): Promise<string[]> {
  const flipped: string[] = [];
  for (const personId of new Set(personIds)) {
    const r = await db.query(
      `insert into checkins (booking_id, person_id, status, state) values ($1, $2, 'open', $3)
       on conflict (booking_id, person_id) do update set status = 'open', state = checkins.state || $4::jsonb, updated_at = now()
         where checkins.status = 'not_open' and checkins.state->>'status' <> 'working'
       returning person_id`,
      [bookingId, personId, JSON.stringify({ ...shared, status: 'open' }), JSON.stringify({ status: 'open' })],
    );
    if (r.rowCount) flipped.push(personId);
  }
  return flipped;
}

/** What every covered person shares of one person's state: the times and the flight, never the seat or the passenger. */
const sharedOf = (s: CheckinState): Partial<CheckinState> => ({ ...(s.opens_at ? { opens_at: s.opens_at } : {}), ...(s.closes_at ? { closes_at: s.closes_at } : {}), ...(s.flight ? { flight: s.flight } : {}) });

/**
 * Asks Go for the person's check-in (get_checkin, 2 s) and keeps the answer. Go's `working` keeps whatever is cached (the
 * cached state is answered; with nothing cached, Go's working state is answered and not kept). When Go is away the cached
 * state is answered; with nothing cached, 502 go_unavailable. The first time a state is open, everyone the booking covers
 * gets a row (so their strip shows it too).
 */
async function refresh(ctx: Ctx, go: GoClient, tripId: string, personId: string, b: FlightBooking): Promise<CheckinState> {
  const cached = await cachedState(ctx.pool, b.booking_id, personId);
  let fresh: CheckinState;
  try {
    fresh = await askGo<CheckinState>(go, 'get_checkin', { trip_id: tripId, booking_id: b.booking_id, person_id: personId });
  } catch (err) {
    if (!(err instanceof GoUnavailable)) throw err;
    if (cached) return withCompanion(cached, b, personId);
    throw new GoUnavailable(502, 'Go could not read the check-in just now. Try again.');
  }
  if (fresh.status === 'working') return withCompanion(cached ?? fresh, b, personId);
  const state = withCompanion(mergeFromGo(cached, fresh), b, personId);
  await saveState(ctx.pool, b.booking_id, personId, state);
  if (state.status === 'open') {
    await markOpen(ctx.pool, b.booking_id, b.for_person_ids.filter((id) => id !== personId), sharedOf(state));
  }
  return state;
}

/** GET /trips/:trip/bookings/:booking_id/checkin. */
export async function getCheckin(ctx: Ctx, go: GoClient, tripId: string, personId: string, bookingId: string): Promise<CheckinState> {
  const b = await flightFor(ctx.pool, tripId, bookingId, personId);
  return forApp(await refresh(ctx, go, tripId, personId, b));
}

/** 409 unless the person can act on the state now. */
function assertActionable(state: CheckinState): void {
  if (state.status === 'open' || state.status === 'failed') return;
  const why = { not_open: 'web check-in has not opened yet', working: 'Go is finishing your check-in', done: 'you are already checked in', closed: 'web check-in has closed' }[state.status] ?? `web check-in is ${state.status}`;
  throw conflict(why);
}

/** "+91 98765 43210" → "+91 9•••• ••210": the first five and the last three characters stay (spaces too). */
export function maskMobile(mobile: string): string {
  const chars = Array.from(mobile.trim());
  return chars.map((c, i) => (i < 5 || i >= chars.length - 3 || c === ' ' ? c : '•')).join('');
}

const PICKABLE = new Set(['free', 'paid', 'companion']);

/**
 * PATCH …/checkin: the person's answers go into the cached state (fetched from Go first when there is none). A seat must be
 * in the seat map and free, paid or companion (422 `seat`); a taken seat is 409. A paid seat (a price) is not set: the
 * answer carries `payment_required` and the price, the vault pays, and Go takes it from there.
 */
export async function patchCheckin(ctx: Ctx, go: GoClient, tripId: string, personId: string, bookingId: string, input: PatchCheckinInput): Promise<PatchedCheckin> {
  const b = await flightFor(ctx.pool, tripId, bookingId, personId);
  const state = (await cachedState(ctx.pool, bookingId, personId)) ?? (await refresh(ctx, go, tripId, personId, b));
  assertActionable(state);
  const next: CheckinState = { ...state };
  if (input.digi_yatra !== undefined) next.digi_yatra = input.digi_yatra;
  if (input.declaration !== undefined) next.declaration = input.declaration;
  if (input.mobile !== undefined) {
    next.mobile = input.mobile;
    next.passenger = { ...(next.passenger ?? {}), mobile_masked: maskMobile(input.mobile) };
  }
  let price: { amount_minor: number; currency: string } | null = null;
  if (input.seat !== undefined) {
    const seat = state.seat_map?.seats?.find((s) => s.id === input.seat);
    if (!seat) throw invalid(`seat ${input.seat} is not on the seat map`, 'seat');
    if (seat.state === 'taken') throw conflict(`seat ${input.seat} is taken`);
    if (!PICKABLE.has(seat.state)) throw invalid(`seat ${input.seat} cannot be chosen (${seat.state})`, 'seat');
    const paid = seat.state === 'paid' || (seat.price_minor ?? 0) > 0;
    if (paid && seat.id !== state.seat) price = { amount_minor: seat.price_minor ?? 0, currency: seat.currency ?? b.currency };
    else next.seat = seat.id;
  }
  await saveState(ctx.pool, bookingId, personId, next);
  const out = forApp(next);
  return price ? { ...out, payment_required: true, seat_price: price } : out;
}

/**
 * POST …/checkin/complete: one submit_checkin to Go (2 s) with the cached answers. `done` → the state with the boarding
 * pass (200); `working` → the state marked working, 202, and Go finishes by replace_card or a later get_checkin;
 * `failed` → 409 with Go's message and the state left as it was, so the person can fix and retry; Go away → 502.
 */
export async function completeCheckin(ctx: Ctx, go: GoClient, tripId: string, personId: string, bookingId: string): Promise<{ working: boolean; state: CheckinState }> {
  await flightFor(ctx.pool, tripId, bookingId, personId);
  const state = await cachedState(ctx.pool, bookingId, personId);
  if (!state) throw conflict('open the check-in first (GET …/checkin)');
  assertActionable(state);
  if (state.declaration !== true) throw invalid('the declaration must be accepted first', 'declaration');
  if (!state.seat) throw invalid('pick a seat first', 'seat');
  let result: { status: 'done' | 'working' | 'failed'; boarding_pass?: Record<string, unknown>; message?: string };
  try {
    result = await askGo(go, 'submit_checkin', {
      trip_id: tripId, booking_id: bookingId, person_id: personId,
      digi_yatra: state.digi_yatra === true, declaration: true, seat: state.seat, ...(state.mobile ? { mobile: state.mobile } : {}),
    });
  } catch (err) {
    if (err instanceof GoUnavailable) throw new GoUnavailable(502, 'Go could not complete the check-in just now. Try again.');
    throw err;
  }
  if (result.status === 'failed') throw conflict(result.message ?? 'the airline did not accept the check-in: check the details and try again');
  const next: CheckinState = { ...state, status: result.status, ...(result.status === 'done' ? { boarding_pass: result.boarding_pass ?? null } : {}) };
  await saveState(ctx.pool, bookingId, personId, next);
  return { working: result.status === 'working', state: forApp(next) };
}

// ---------------------------------------------------------------- the strip, the home card and Go's "it's open" signal

/** "Fri 6 Nov" from a date, or the text as it came when it is not one. */
function shortDate(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? date : new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d);
}

/** "6E 5313 · Fri 6 Nov · closes 19:40": the time is the one written in `closes_at` (the airport's own clock, as Go wrote it). */
export function checkinSubtitle(state: CheckinState, b: { journey: JourneyLike | null; title: string }): string {
  const date = state.flight?.date ?? b.journey?.depart_at;
  const closes = state.closes_at ? /T(\d{2}:\d{2})/.exec(state.closes_at)?.[1] : undefined;
  return [flightNumberOf(state, b), date ? shortDate(date) : undefined, closes ? `closes ${closes}` : undefined].filter(Boolean).join(' · ');
}

/** The `checkin` items of the strip: each confirmed flight covering the person whose cached state is open. Never asks Go. */
export async function checkinItems(db: Db, tripId: string, personId: string): Promise<NeedsYouItem[]> {
  const { rows } = await db.query<{ booking_id: string; state: CheckinState; updated_at: Date; journey: JourneyLike | null; title: string }>(
    `select c.booking_id, c.state, c.updated_at, b.journey, b.title from checkins c join bookings b using (booking_id)
      where b.trip_id = $1 and b.kind = 'flight' and b.status = 'confirmed' and c.person_id = $2 and c.status = 'open'
      order by coalesce(b.starts_at, b.created_at), b.booking_id`,
    [tripId, personId],
  );
  return rows.map((r) => ({
    item_id: `checkin:${r.booking_id}`,
    kind: 'checkin',
    title: 'Web check-in is open',
    subtitle: checkinSubtitle(r.state, r),
    cta_label: 'Check in now',
    since: r.state.opens_at ?? new Date(r.updated_at).toISOString(),
    target: { booking_id: r.booking_id },
  }));
}

/** `go://trips/<trip>/checkin/<booking_id>` (GO-CHANGES 1.4): the booking it names, when the link is this trip's. */
function checkinLinkOf(url: unknown, tripId: string): string | null {
  if (typeof url !== 'string') return null;
  const m = /^go:\/\/trips\/([^/]+)\/checkin\/([^/?#]+)$/.exec(url);
  return m && m[1] === tripId ? m[2]! : null;
}

/**
 * Go's "check-in is open" signal (GO-CHANGES 3: an event, or a notice card with a go://…/checkin/<booking_id> link). The
 * 1.1 overlay has no event for it, so the card is the signal: a `notice` card from Go whose `source.url`, or whose action's
 * `url`, is `go://trips/<trip>/checkin/<booking_id>`. For the people the card names (else everyone the booking covers) the
 * cached state becomes open (a minimal `{ status: "open" }` row when there is none). Answers whose state flipped.
 * Nothing happens when the flag is off.
 */
export async function noteCheckinSignal(ctx: Ctx, tripId: string, card: Record<string, unknown>): Promise<string[]> {
  if (!checkinOn(ctx.features) || card.kind !== 'notice') return [];
  const actions = Array.isArray(card.actions) ? (card.actions as Array<Record<string, unknown>>) : [];
  const links = [(card.source as Record<string, unknown> | undefined)?.url, ...actions.map((a) => a.url)];
  const bookingId = links.map((u) => checkinLinkOf(u, tripId)).find((id): id is string => !!id);
  if (!bookingId) return [];
  const b = (await ctx.pool.query<FlightBooking & { kind: string }>('select booking_id, kind, status, title, currency, for_person_ids, journey, passengers from bookings where trip_id = $1 and booking_id = $2', [tripId, bookingId])).rows[0];
  if (!b || b.kind !== 'flight' || b.status !== 'confirmed') return [];
  const named = Array.isArray(card.for_person_ids) && card.for_person_ids.length ? (card.for_person_ids as string[]) : b.for_person_ids;
  return markOpen(ctx.pool, bookingId, named.filter((id) => b.for_person_ids.includes(id)), {});
}
