// §4.9: money. The Expenses tab (MoneyView), the Transactions page, expenses people add by hand and the approval of
// each by its split (D6), payments recorded outside Go (settlements) and the settle_up card's two buttons.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { answerExpense, createExpense, listExpenses, removeExpense, updateExpenseSplit } from '../../domain/expenses.js';
import { invalid } from '../../domain/errors.js';
import { readMoneyView } from '../../domain/money-view.js';
import { answerSettlement, recordSettlement } from '../../domain/settlements.js';
import { FILTERS, PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX, listTransactions, type Filter } from '../../domain/transactions.js';
import { nudgePerson, payLinkFor } from '../../domain/transfers.js';
import { checkAddExpense, checkDisputeExpense, checkNudge, checkPatchExpense, checkPayLink, checkRecordSettlement } from '../bodies.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import { inTrip, type V1Deps } from './shared.js';

const ERR = (code: string, message: string, field: string | null = null, retry: number | null = null) => ({ error: { code, message, field, retry_after_seconds: retry, request_id: 'a1b2c3d4e5f6' } });
const TRANSFER = { from_person_id: 'p_priya', to_person_id: 'p_aarav', amount_minor: 170000, currency: 'INR' };
const EXPENSE = {
  expense_id: 'e_cab', paid_by_person_id: 'p_aarav', amount_minor: 680000, currency: 'INR', note: 'Airport cab', category: 'getting_around', split_person_ids: ['p_aarav', 'p_priya', 'p_rahul', 'p_kabir'],
  added_by_person_id: 'p_aarav', created_at: '2026-11-06T16:40:00.000Z', status: 'pending',
  confirmations: [{ person_id: 'p_priya', state: 'pending', at: '2026-11-06T16:40:00.000Z' }, { person_id: 'p_rahul', state: 'pending', at: '2026-11-06T16:40:00.000Z' }, { person_id: 'p_kabir', state: 'pending', at: '2026-11-06T16:40:00.000Z' }],
};
const APPROVED = { ...EXPENSE, status: 'approved', confirmations: EXPENSE.confirmations.map((c) => ({ ...c, state: 'approved', at: '2026-11-06T17:02:00.000Z' })) };
const DISPUTED = { ...EXPENSE, status: 'disputed', confirmations: [EXPENSE.confirmations[0], { ...EXPENSE.confirmations[1], state: 'disputed', at: '2026-11-06T17:05:00.000Z', reason: 'I took the bus' }, EXPENSE.confirmations[2]] };
const SETTLEMENT = { settlement_id: 'st_01', from_person_id: 'p_priya', to_person_id: 'p_aarav', amount_minor: 170000, currency: 'INR', method: 'upi', note: 'cab share', status: 'pending_confirmation', created_at: '2026-11-07T09:00:00.000Z' };
const MONEY = {
  currency: 'INR', plan_minor: 7500000, spent_minor: 680000, by_category: [{ category: 'getting_around', amount_minor: 680000 }], transfers: [TRANSFER],
  me: { budget: { min_minor: 1500000, max_minor: 2500000, currency: 'INR' }, spent_minor: 170000, by_category: [{ category: 'getting_around', amount_minor: 170000 }], owed_to_me: [], i_owe: [TRANSFER] }, seq: 42,
};
const ROW_EXPENSE = { transaction_id: 'e_cab', kind: 'booking', occurred_at: '2026-11-06T16:40:00.000Z', payer_person_id: 'p_aarav', verb: 'paid', to: { kind: 'merchant', name: 'Airport cab' }, amount_minor: 680000, currency: 'INR', note: 'Airport cab', mine: true, expense_id: 'e_cab', expense_status: 'pending' };
const ROW_PAYBACK = { transaction_id: 'st_01', kind: 'payback', occurred_at: '2026-11-07T09:00:00.000Z', payer_person_id: 'p_priya', verb: 'paid', to: { kind: 'person', person_id: 'p_aarav' }, amount_minor: 170000, currency: 'INR', method: 'upi', note: 'cab share', mine: true, settlement_id: 'st_01', settlement_status: 'pending_confirmation' };

export const routes: RouteMeta[] = [
  { method: 'GET', path: '/app/v1/trips/:trip/money', section: SECTIONS.money, title: 'Money', summary: 'The Expenses tab in one read: the contract Money (plan_minor, spent_minor, by_category, transfers) plus me (my private budget range or null, my share spent by equal split, my share by category, owed_to_me, i_owe) and seq. Pending and approved expenses count; disputed ones do not; recorded settlements count until disputed. private, no-store.',
    example: { responses: [{ name: 'MoneyView', status: 200, body: MONEY }] } },
  { method: 'GET', path: '/app/v1/trips/:trip/transactions', section: SECTIONS.money, title: 'Transactions', summary: '?filter=all|booking|payback|mine|pending|disputed&limit=50&before=<cursor> → { items: Transaction[], total_count, next_cursor }, newest first. booking = an expense (expense_status), payback = a settlement (settlement_status); method card only on an expense of a vault-paid booking. total_count ignores the filter.',
    example: { query: { filter: 'all', limit: '50' }, responses: [{ name: 'First page', status: 200, body: { items: [ROW_PAYBACK, ROW_EXPENSE], total_count: 2, next_cursor: null } }, { name: 'Bad cursor', status: 422, body: ERR('invalid', 'before is not a cursor from this list', 'before') }] } },
  { method: 'GET', path: '/app/v1/trips/:trip/expenses', section: SECTIONS.money, title: 'List expenses', summary: '?status=pending|approved|disputed (or none for all) → { items: Expense[], seq }, newest first, each with status and confirmations. For the Approvals / Disputed views and "N expenses to approve".',
    example: { query: { status: 'pending' }, responses: [{ name: 'Pending', status: 200, body: { items: [EXPENSE], seq: 42 } }] } },
  { method: 'POST', path: '/app/v1/trips/:trip/expenses', section: SECTIONS.money, title: 'Add an expense', summary: '{ amount_minor, note, category, split_person_ids, booking_id?, paid_by_person_id? (default: you) } → 201 Expense (+ seq). Starts pending with one confirmation per split member other than the payer (approved at once when the payer is alone, or features.expense_approval is off); those people are pushed (type expense). Go hears expense.changed added.',
    example: { body: { amount_minor: 680000, note: 'Airport cab', category: 'getting_around', split_person_ids: ['p_aarav', 'p_priya', 'p_rahul', 'p_kabir'] }, responses: [{ name: 'Created', status: 201, body: { ...EXPENSE, seq: 43 } }, { name: 'Someone not in the trip', status: 422, body: ERR('invalid', 'paid_by_person_id/split_person_ids: someone is not in the trip', 'split_person_ids') }] } },
  { method: 'POST', path: '/app/v1/trips/:trip/expenses/:id/approve', section: SECTIONS.money, title: 'Approve an expense', summary: 'Your entry becomes approved → 200 Expense (+ seq). Only people with an entry (403); 409 when you already approved, or approval is off. Go hears expense.changed approved.',
    example: { responses: [{ name: 'Approved by everyone', status: 200, body: { ...APPROVED, seq: 46 } }, { name: 'Not in the split', status: 403, body: ERR('forbidden', 'p_meher has nothing to answer on expense e_cab') }, { name: 'Already', status: 409, body: ERR('conflict', 'you already approved expense e_cab') }] } },
  { method: 'POST', path: '/app/v1/trips/:trip/expenses/:id/dispute', section: SECTIONS.money, title: 'Dispute an expense', summary: '{ reason? } → 200 Expense (+ seq), now disputed: it stays listed and marked but counts in neither the totals nor the transfers until the payer fixes the split or removes it. The payer is pushed (type expense). Only people with an entry (403); 409 when already disputed by you. Go hears expense.changed disputed.',
    example: { body: { reason: 'I took the bus' }, responses: [{ name: 'Disputed', status: 200, body: { ...DISPUTED, seq: 47 } }] } },
  { method: 'PATCH', path: '/app/v1/trips/:trip/expenses/:id', section: SECTIONS.money, title: 'Fix the split', summary: '{ split_person_ids, note? } → 200 Expense (+ seq). Payer or organizer (403). Anyone whose share changed or who is new to the split is asked again (entry back to pending, pushed); someone taken out loses their entry; an unchanged share keeps its answer. Go hears expense.changed updated.',
    example: { body: { split_person_ids: ['p_aarav', 'p_priya', 'p_kabir'], note: 'Airport cab (3 of us)' }, responses: [{ name: 'Split fixed', status: 200, body: { ...EXPENSE, note: 'Airport cab (3 of us)', split_person_ids: ['p_aarav', 'p_priya', 'p_kabir'], confirmations: [EXPENSE.confirmations[0], EXPENSE.confirmations[2]], seq: 48 } }] } },
  { method: 'DELETE', path: '/app/v1/trips/:trip/expenses/:id', section: SECTIONS.money, title: 'Remove an expense', summary: 'Payer or organizer (403) → 200 { seq }. 404 when not in this trip or already removed. Go hears expense.changed removed.',
    example: { responses: [{ name: 'Removed', status: 200, body: { seq: 49 } }] } },
  { method: 'POST', path: '/app/v1/trips/:trip/settlements', section: SECTIONS.money, title: 'Record a payment', summary: '{ to_person_id, amount_minor, currency, method: upi|cash|bank_transfer|other, note? } → 201 { settlement, transfers, seq }. Money you sent someone outside Go. The payee must be another member and the currency the trip\'s (422). Starts pending_confirmation and already counts: the transfer shrinks; the payee is pushed "Got it?" (type settlement). Go is told only when confirmed.',
    example: { body: { to_person_id: 'p_aarav', amount_minor: 170000, currency: 'INR', method: 'upi', note: 'cab share' }, responses: [{ name: 'Recorded', status: 201, body: { settlement: SETTLEMENT, transfers: [], seq: 50 } }, { name: 'Wrong currency', status: 422, body: ERR('invalid', "currency must be INR, the trip's currency", 'currency') }] } },
  { method: 'POST', path: '/app/v1/trips/:trip/settlements/:id/confirm', section: SECTIONS.money, title: 'Confirm a payment', summary: 'The payee says "I got it" → 200 Settlement (confirmed). Payee only (403); 409 once answered. Go hears settlement.recorded (contract 1.1) now and only now.',
    example: { responses: [{ name: 'Confirmed', status: 200, body: { ...SETTLEMENT, status: 'confirmed', responded_at: '2026-11-07T09:05:00.000Z' } }, { name: 'Not the payee', status: 403, body: ERR('forbidden', 'only the payee can answer a settlement') }] } },
  { method: 'POST', path: '/app/v1/trips/:trip/settlements/:id/dispute', section: SECTIONS.money, title: 'Dispute a payment', summary: 'The payee says "I didn\'t get this" → 200 Settlement (disputed): the amount goes back into the transfers. Payee only (403); 409 once answered. Go hears nothing.',
    example: { responses: [{ name: 'Disputed', status: 200, body: { ...SETTLEMENT, status: 'disputed', responded_at: '2026-11-07T09:05:00.000Z' } }, { name: 'Already answered', status: 409, body: ERR('conflict', 'settlement st_01 is already confirmed') }] } },
  { method: 'POST', path: '/app/v1/trips/:trip/transfers/pay-link', section: SECTIONS.money, title: 'Pay by UPI', summary: '{ to_person_id, amount_minor } → { upi_uri: "upi://pay?pa=…&pn=…&am=…&cu=INR&tn=…", expires_at (+10 min) }. Only to someone you owe in the current transfers (422). 409 when the payee is not in the trip or has no UPI id (has_upi false): record the payment instead.',
    example: { body: { to_person_id: 'p_aarav', amount_minor: 170000 }, responses: [{ name: 'Link', status: 200, body: { upi_uri: 'upi://pay?pa=aarav%40okhdfc&pn=Aarav%20Shah&am=1700.00&cu=INR&tn=Goa%20%F0%9F%8C%B4%20%C2%B7%20settle%20up', expires_at: '2026-11-07T09:10:00.000Z' } }, { name: 'No UPI id', status: 409, body: ERR('conflict', 'Aarav Shah has no UPI id saved: record the payment instead') }] } },
  { method: 'POST', path: '/app/v1/trips/:trip/transfers/nudge', section: SECTIONS.money, title: 'Nudge', summary: '{ from_person_id }: remind someone who owes you (409 when they do not). One per person per trip every 24 hours: 429 with retry_after_seconds and Retry-After after that. 204: the reminder was accepted (not that it arrived).',
    example: { body: { from_person_id: 'p_priya' }, responses: [{ name: 'Reminded', status: 204 }, { name: 'Too soon', status: 429, body: ERR('rate_limited', 'p_priya was reminded recently: try again later', null, 86340) }] } },
];

/** `?status=` on the expenses list: one of the three standings, or none. */
function statusQuery(raw: unknown): 'pending' | 'approved' | 'disputed' | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'pending' || raw === 'approved' || raw === 'disputed') return raw;
  throw invalid('status must be pending, approved or disputed', 'status');
}

/** The Transactions page's query: the filter (default all), the page size (1-100, default 50) and the cursor. */
function transactionsQuery(q: Record<string, unknown>): { filter: Filter; limit: number; before?: string } {
  const filter = q.filter === undefined || q.filter === '' ? 'all' : q.filter;
  if (!(FILTERS as readonly unknown[]).includes(filter)) throw invalid(`filter must be one of ${FILTERS.join(', ')}`, 'filter');
  let limit = PAGE_LIMIT_DEFAULT;
  if (q.limit !== undefined && q.limit !== '') {
    limit = Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT_MAX) throw invalid(`limit must be a whole number from 1 to ${PAGE_LIMIT_MAX}`, 'limit');
  }
  const before = typeof q.before === 'string' && q.before !== '' ? q.before : undefined;
  return { filter: filter as Filter, limit, before };
}

export function register(app: FastifyInstance, ctx: Ctx, _deps: V1Deps): void {
  const privateRead = { schema: { querystring: { type: 'object', additionalProperties: true } } }; // the handler checks the query itself (no coercion)

  app.get('/app/v1/trips/:trip/money', async (req: any, reply) => {
    reply.header('cache-control', 'private, no-store');
    return readMoneyView(ctx, req.params.trip, req.personId); // membership is checked inside, with the read
  });
  app.get('/app/v1/trips/:trip/transactions', { ...privateRead, ...inTrip(ctx, (req, trip, me) => listTransactions(ctx, trip, me, transactionsQuery(req.query ?? {}))) });

  // ---- expenses and their approval (D6)
  app.get('/app/v1/trips/:trip/expenses', { ...privateRead, ...inTrip(ctx, (req, trip, me) => listExpenses(ctx, trip, me, statusQuery(req.query?.status))) });
  app.post('/app/v1/trips/:trip/expenses', inTrip(ctx, (req, trip, me) => createExpense(ctx, trip, me, checkAddExpense(req.body)), 201));
  app.post('/app/v1/trips/:trip/expenses/:id/approve', inTrip(ctx, (req, trip, me) => answerExpense(ctx, trip, me, req.params.id!, 'approved')));
  app.post('/app/v1/trips/:trip/expenses/:id/dispute', inTrip(ctx, (req, trip, me) => answerExpense(ctx, trip, me, req.params.id!, 'disputed', checkDisputeExpense(req.body).reason)));
  app.patch('/app/v1/trips/:trip/expenses/:id', inTrip(ctx, (req, trip, me) => updateExpenseSplit(ctx, trip, me, req.params.id!, checkPatchExpense(req.body))));
  app.delete('/app/v1/trips/:trip/expenses/:id', inTrip(ctx, (req, trip, me) => removeExpense(ctx, trip, me, req.params.id!)));

  // ---- settlements: payments made outside Go
  app.post('/app/v1/trips/:trip/settlements', inTrip(ctx, (req, trip, me) => recordSettlement(ctx, trip, me, checkRecordSettlement(req.body)), 201));
  app.post('/app/v1/trips/:trip/settlements/:id/confirm', inTrip(ctx, (req, trip, me) => answerSettlement(ctx, trip, me, req.params.id!, 'confirmed')));
  app.post('/app/v1/trips/:trip/settlements/:id/dispute', inTrip(ctx, (req, trip, me) => answerSettlement(ctx, trip, me, req.params.id!, 'disputed')));

  // ---- the settle_up card's buttons
  app.post('/app/v1/trips/:trip/transfers/pay-link', inTrip(ctx, (req, trip, me) => payLinkFor(ctx, trip, me, checkPayLink(req.body))));
  app.post('/app/v1/trips/:trip/transfers/nudge', inTrip(ctx, async (req, trip, me) => {
    await nudgePerson(ctx, trip, me, checkNudge(req.body));
  }, 204));
}
