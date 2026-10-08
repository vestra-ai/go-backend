// §4.8: votes, the mandate and the trip record. These buttons are the Server's own: they never reach Go.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { answerMandate, cancelDecision, castVote, closeVoteByPerson, getDecision, getRecord, redoRecordLine, retractVote, undoRecordLine } from '../../domain/actions.js';
import { conflict, invalid } from '../../domain/errors.js';
import { openPersonVote } from '../../domain/votes-bookings.js';
import { RateLimiter } from '../rate-limit.js';
import { checkCastVote, checkOpenVote } from '../bodies.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import { inTrip, requirePressKey, withTrip, type V1Deps } from './shared.js';

/** App contract Appendix A: 20 votes a minute per person (cast, moved or taken back). */
export const VOTES_PER_MINUTE = 20;

const decision = {
  decision_id: 'd_01JA', question: 'Where do we stay?', kind: 'choice', anonymous: false, status: 'open', opened_by_person_id: 'p_priya',
  options: [{ label: 'Villa Sol', price_minor: 5420000, currency: 'INR' }, { label: 'Casa Azul' }], voted: 2, of: 5, tally: [2, 0],
  votes: [{ person_id: 'p_priya', option_index: 0 }, { person_id: 'p_rahul', option_index: 0 }], opened_at: '2026-10-08T07:00:00Z', my_vote: { option_index: 0 },
};
const line = { line_id: 'r_01JA', kind: 'decided', text: 'Villa Sol', status: 'active', proof: [], person_ids: [], decision_id: 'd_01JA', source: 'vote', created_at: '2026-10-08T08:00:00Z', updated_at: '2026-10-08T08:00:00Z' };
const mandate = { choice_index: 0, cap_minor: 5500000, currency: 'INR', refundable_only: true, payer_person_id: 'p_rahul', set_at: '2026-10-08T08:10:00Z' };
const refused = (status: number, code: string, msg: string) => ({ name: code, status, body: { error: { code, message: msg, field: null, retry_after_seconds: null, request_id: 'req_01JA7Q3V8Z' } } });

export const routes: RouteMeta[] = [
  {
    method: 'GET', path: '/app/v1/trips/:trip/decisions/:id', section: SECTIONS.decisions, title: 'Read a vote',
    summary: 'The Decision plus my_vote ({ option_index } | { flexible: true } | null), to redraw a vote card. flexible_count when anyone is flexible; cancels_booking_id on a vote about cancelling a booking (as in TripView.decisions and the needs-you target).',
    example: { responses: [{ name: 'decision', status: 200, body: decision }, { name: 'a cancellation vote', status: 200, body: { ...decision, decision_id: 'd_01JB', question: 'Cancel this booking?', kind: 'yesno', options: [{ label: 'Yes, cancel' }, { label: 'No, keep it' }], closes_at: '2026-10-09T07:00:00Z', cancels_booking_id: 'b_01JA' } }] },
  },
  {
    method: 'POST', path: '/app/v1/trips/:trip/decisions', section: SECTIONS.decisions, title: 'Open a vote',
    summary: 'A member opens a vote (question, kind, anonymous, 2-10 options, closes_at?). The Server posts a system message carrying the vote card so the poll shows in the room, and answers both. Strict body; client_id or an Idempotency-Key makes a retry safe.',
    example: {
      body: { question: 'Where do we stay?', kind: 'choice', anonymous: false, options: [{ label: 'Villa Sol', price_minor: 5420000 }, { label: 'Casa Azul' }] },
      responses: [{ name: 'opened', status: 201, body: { decision: { ...decision, voted: 0, tally: [0, 0], votes: [], my_vote: null }, message: { message_id: 'm_01JB', seq: 58, updated_seq: 58, author: { kind: 'system' }, text: 'Where do we stay?', card: { kind: 'vote', card_id: 'c_01JB', decision_id: 'd_01JA', fallback_text: 'Where do we stay?' }, attachments: [], mentions_go: false, mentions: [], reactions: [], withheld: false, deleted: false, sent_at: '2026-10-08T07:00:00Z' } } }],
    },
  },
  {
    method: 'PUT', path: '/app/v1/trips/:trip/decisions/:id/vote', section: SECTIONS.decisions, title: 'Vote',
    summary: `{ option_index } casts or moves your vote; { flexible: true } says "any of these work" (counts in voted, not in the tally; only when features.vote_flexible, else 409). Until the vote closes (409 after). It closes by itself when everyone has voted. Answers the Decision with my_vote. ${VOTES_PER_MINUTE} votes a minute per person (429), taking one back included.`,
    example: { body: { option_index: 0 }, responses: [{ name: 'voted', status: 200, body: decision }, refused(409, 'conflict', 'decision d_01JA is closed'), { name: 'rate_limited', status: 429, body: { error: { code: 'rate_limited', message: `at most ${VOTES_PER_MINUTE} votes a minute: slow down`, field: null, retry_after_seconds: 42, request_id: 'req_01JA7Q3V8Z' } } }] },
  },
  {
    method: 'DELETE', path: '/app/v1/trips/:trip/decisions/:id/vote', section: SECTIONS.decisions, title: 'Take a vote back',
    summary: 'Withdraws your vote (Go hears decision.voted with retracted: true and the new totals). Only when features.vote_retract, else 409. Answers the Decision.',
    example: { responses: [{ name: 'retracted', status: 200, body: { ...decision, voted: 1, tally: [1, 0], votes: [{ person_id: 'p_priya', option_index: 0 }], my_vote: null } }, refused(409, 'conflict', 'taking a vote back is not on yet (features.vote_retract)')] },
  },
  {
    method: 'POST', path: '/app/v1/trips/:trip/decisions/:id/close', section: SECTIONS.decisions, title: 'Close a vote',
    summary: 'Closes the vote now with the current result (a tie or no votes: no result). Organizer or the person who opened it (403 otherwise). Also closes by itself at closes_at and when everyone has voted. Answers the Decision.',
    example: { responses: [{ name: 'closed', status: 200, body: { ...decision, status: 'closed', result_index: 0, closed_at: '2026-10-08T08:00:00Z' } }, refused(403, 'forbidden', 'only the organizer or the person who opened the vote can do that')] },
  },
  {
    method: 'POST', path: '/app/v1/trips/:trip/decisions/:id/cancel', section: SECTIONS.decisions, title: 'Call a vote off',
    summary: 'Cancels an open vote; no record line. Organizer or opener only. Answers the Decision (status cancelled).',
    example: { responses: [{ name: 'cancelled', status: 200, body: { ...decision, status: 'cancelled' } }] },
  },
  {
    method: 'POST', path: '/app/v1/trips/:trip/decisions/:id/mandate/confirm', section: SECTIONS.decisions, title: 'Mandate: yes, book it',
    summary: 'The payer confirms the mandate; Go may then ask for a spend approval. Payer only (403). Answers the Mandate.',
    example: { responses: [{ name: 'confirmed', status: 200, body: { ...mandate, confirmed_at: '2026-10-08T08:12:00Z' } }] },
  },
  {
    method: 'POST', path: '/app/v1/trips/:trip/decisions/:id/mandate/decline', section: SECTIONS.decisions, title: 'Mandate: not now',
    summary: 'The payer declines the mandate. Payer only (403). Answers the Mandate.',
    example: { responses: [{ name: 'declined', status: 200, body: { ...mandate, declined_at: '2026-10-08T08:12:00Z' } }] },
  },
  {
    method: 'GET', path: '/app/v1/trips/:trip/record', section: SECTIONS.decisions, title: 'The trip record',
    summary: 'The record lines, oldest first: active and done by default; ?include_undone=true adds the undone ones (struck through). seq = the trip change number the list matches.',
    example: { query: { include_undone: 'false' }, responses: [{ name: 'record', status: 200, body: { lines: [line], seq: 60 } }] },
  },
  {
    method: 'POST', path: '/app/v1/trips/:trip/record/:line_id/undo', section: SECTIONS.decisions, title: 'Undo a record line',
    summary: 'Anyone in the trip undoes a line (Go hears record.changed undone and never writes it back). Answers the RecordLine; already undone: the line, unchanged.',
    example: { responses: [{ name: 'undone', status: 200, body: { ...line, status: 'undone' } }] },
  },
  {
    method: 'POST', path: '/app/v1/trips/:trip/record/:line_id/redo', section: SECTIONS.decisions, title: 'Redo a record line',
    summary: 'Takes an undo back: the line is active again (record.changed updated). 409 when it was not undone. Answers the RecordLine.',
    example: { responses: [{ name: 'active again', status: 200, body: line }, refused(409, 'conflict', 'line r_01JA is active, not undone')] },
  },
];

export function register(app: FastifyInstance, ctx: Ctx, deps: V1Deps): void {
  app.get('/app/v1/trips/:trip/decisions/:id', inTrip(ctx, (req, trip, me) => getDecision(ctx, trip, me, req.params.id!)));
  app.post('/app/v1/trips/:trip/decisions', inTrip(ctx, (req, trip, me) => (requirePressKey(req), openPersonVote(ctx, trip, me, checkOpenVote(req.body))), 201));
  const votes = new RateLimiter(() => ctx.limits?.votesPerMinute ?? VOTES_PER_MINUTE, 60_000, { what: 'votes' });
  app.put('/app/v1/trips/:trip/decisions/:id/vote', withTrip((t, me, r) => {
    const { option_index, flexible } = checkCastVote(r.body);
    if ((option_index === undefined) === (flexible === undefined)) throw invalid('send option_index or flexible: true, not both', option_index === undefined ? 'option_index' : 'flexible');
    if (flexible && !deps.features.vote_flexible) throw conflict('"I\'m flexible" is not on yet (features.vote_flexible)');
    votes.take(me);
    return castVote(ctx, t, me, r.params.id!, flexible ? { flexible: true } : { option_index: option_index! });
  }));
  app.delete('/app/v1/trips/:trip/decisions/:id/vote', withTrip((t, me, r) => {
    if (!deps.features.vote_retract) throw conflict('taking a vote back is not on yet (features.vote_retract)');
    votes.take(me);
    return retractVote(ctx, t, me, r.params.id!);
  }));
  app.post('/app/v1/trips/:trip/decisions/:id/close', withTrip((t, me, r) => closeVoteByPerson(ctx, t, me, r.params.id!)));
  app.post('/app/v1/trips/:trip/decisions/:id/cancel', withTrip((t, me, r) => cancelDecision(ctx, t, me, r.params.id!)));
  app.post('/app/v1/trips/:trip/decisions/:id/mandate/confirm', withTrip((t, me, r) => answerMandate(ctx, t, me, r.params.id!, 'confirm')));
  app.post('/app/v1/trips/:trip/decisions/:id/mandate/decline', withTrip((t, me, r) => answerMandate(ctx, t, me, r.params.id!, 'decline')));
  app.get('/app/v1/trips/:trip/record', {
    schema: { querystring: { type: 'object', properties: { include_undone: { type: 'string', enum: ['1', '0', 'true', 'false'] } } } },
    ...inTrip(ctx, (req, trip) => getRecord(ctx, trip, req.query.include_undone === '1' || req.query.include_undone === 'true')),
  });
  app.post('/app/v1/trips/:trip/record/:line_id/undo', withTrip((t, me, r) => undoRecordLine(ctx, t, me, r.params.line_id!)));
  app.post('/app/v1/trips/:trip/record/:line_id/redo', withTrip((t, me, r) => redoRecordLine(ctx, t, me, r.params.line_id!)));
}
