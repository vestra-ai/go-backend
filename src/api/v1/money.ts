// §4.9: money. The Expenses tab (MoneyView), the Transactions page, expenses people add by hand, payments recorded
// outside Go (settlements) and the settle_up card's pay link.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { createExpense, listExpenses, removeExpense, updateExpenseSplit } from '../../domain/expenses.js';
import { invalid } from '../../domain/errors.js';
import { readMoneyView } from '../../domain/money-view.js';
import { recordSettlement } from '../../domain/settlements.js';
import { FILTERS, PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX, listTransactions, type Filter } from '../../domain/transactions.js';
import { payLinkFor } from '../../domain/transfers.js';
import { checkAddExpense, checkPatchExpense, checkPayLink, checkRecordSettlement } from '../bodies.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import { inTrip, memberFirst, type V1Deps } from './shared.js';

const ERR = (code: string, message: string, field: string | null = null, retry: number | null = null) => ({ error: { code, message, field, retry_after_seconds: retry, request_id: 'a1b2c3d4e5f6' } });
const TRANSFER = { from_person_id: 'p_priya', to_person_id: 'p_aarav', amount_minor: 170000, currency: 'INR' };
const EXPENSE = {
  expense_id: 'e_cab', paid_by_person_id: 'p_aarav', amount_minor: 680000, currency: 'INR', note: 'Airport cab', category: 'getting_around', split_person_ids: ['p_aarav', 'p_priya', 'p_rahul', 'p_kabir'],
  added_by_person_id: 'p_aarav', created_at: '2026-11-06T16:40:00.000Z',
};
const SETTLEMENT = { settlement_id: 'st_01', from_person_id: 'p_priya', to_person_id: 'p_aarav', amount_minor: 170000, currency: 'INR', method: 'upi', note: 'cab share', created_at: '2026-11-07T09:00:00.000Z' };
const MONEY = {
  currency: 'INR', plan_minor: 7500000, spent_minor: 680000, by_category: [{ category: 'getting_around', amount_minor: 680000 }], transfers: [TRANSFER],
  me: { spent_minor: 170000, by_category: [{ category: 'getting_around', amount_minor: 170000 }], owed_to_me: [], i_owe: [TRANSFER] }, seq: 42,
};
const ROW_EXPENSE = { transaction_id: 'e_cab', kind: 'booking', occurred_at: '2026-11-06T16:40:00.000Z', payer_person_id: 'p_aarav', verb: 'paid', to: { kind: 'merchant', name: 'Airport cab' }, amount_minor: 680000, currency: 'INR', note: 'Airport cab', mine: true, expense_id: 'e_cab' };
const ROW_PAYBACK = { transaction_id: 'st_01', kind: 'payback', occurred_at: '2026-11-07T09:00:00.000Z', payer_person_id: 'p_priya', verb: 'paid', to: { kind: 'person', person_id: 'p_aarav' }, amount_minor: 170000, currency: 'INR', method: 'upi', note: 'cab share', mine: true, settlement_id: 'st_01' };

export const routes: RouteMeta[] = [
  { method: 'GET', path: '/app/v1/trips/:trip/money', section: SECTIONS.money, title: 'Money', summary: 'The Expenses tab in one read: the contract Money (plan_minor, spent_minor, by_category, transfers) plus me (my share spent by equal split, my share by category, owed_to_me, i_owe) and seq. Every expense and every recorded payment counts. private, no-store.',
    example: { responses: [{ name: 'MoneyView', status: 200, body: MONEY }] } },
  { method: 'GET', path: '/app/v1/trips/:trip/transactions', section: SECTIONS.money, title: 'Transactions', summary: '?filter=all|booking|payback|mine&limit=50&before=<cursor> → { items: Transaction[], total_count, next_cursor }, newest first. booking = an expense, payback = a settlement; method card only on an expense of a vault-paid booking. total_count ignores the filter.',
    example: { query: { filter: 'all', limit: '50' }, responses: [{ name: 'First page', status: 200, body: { items: [ROW_PAYBACK, ROW_EXPENSE], total_count: 2, next_cursor: null } }, { name: 'Bad cursor', status: 422, body: ERR('invalid', 'before is not a cursor from this list', 'before') }] } },
  { method: 'GET', path: '/app/v1/trips/:trip/expenses', section: SECTIONS.money, title: 'List expenses', summary: '{ items: Expense[], seq }, newest first: every expense that stands. The old ?status= filter is gone (422 status).',
    example: { responses: [{ name: 'Expenses', status: 200, body: { items: [EXPENSE], seq: 42 } }] } },
  { method: 'POST', path: '/app/v1/trips/:trip/expenses', section: SECTIONS.money, title: 'Add an expense', summary: '{ amount_minor, note, category, split_person_ids, booking_id?, paid_by_person_id? (default: you) } → 201 Expense (+ seq). It counts at once, split equally. Go hears expense.changed added.',
    example: { body: { amount_minor: 680000, note: 'Airport cab', category: 'getting_around', split_person_ids: ['p_aarav', 'p_priya', 'p_rahul', 'p_kabir'] }, responses: [{ name: 'Created', status: 201, body: { ...EXPENSE, seq: 43 } }, { name: 'Someone not in the trip', status: 422, body: ERR('invalid', 'paid_by_person_id/split_person_ids: someone is not in the trip', 'split_person_ids') }] } },
  { method: 'PATCH', path: '/app/v1/trips/:trip/expenses/:id', section: SECTIONS.money, title: 'Fix the split', summary: '{ split_person_ids, note? } → 200 Expense (+ seq). Only the person who added it; the payer when Go added it or the adder has left; the organizer when neither is in the trip (403). Go hears expense.changed updated (contract 1.1).',
    example: { body: { split_person_ids: ['p_aarav', 'p_priya', 'p_kabir'], note: 'Airport cab (3 of us)' }, responses: [{ name: 'Split fixed', status: 200, body: { ...EXPENSE, note: 'Airport cab (3 of us)', split_person_ids: ['p_aarav', 'p_priya', 'p_kabir'], seq: 48 } }, { name: 'Not yours', status: 403, body: ERR('forbidden', 'only the person responsible for this expense can change it') }] } },
  { method: 'DELETE', path: '/app/v1/trips/:trip/expenses/:id', section: SECTIONS.money, title: 'Remove an expense', summary: 'The same people as Fix the split (403) → 200 { seq }. 404 when not in this trip or already removed. Go hears expense.changed removed.',
    example: { responses: [{ name: 'Removed', status: 200, body: { seq: 49 } }] } },
  { method: 'POST', path: '/app/v1/trips/:trip/settlements', section: SECTIONS.money, title: 'Record a payment', summary: '{ to_person_id, amount_minor, currency, method: upi|cash|bank_transfer|other, note? } → 201 { settlement, transfers, seq }. Money you sent someone outside Go. The payee must be another member and the currency the trip\'s (422). It counts at once and for good: the transfer shrinks, and Go hears settlement.recorded.',
    example: { body: { to_person_id: 'p_aarav', amount_minor: 170000, currency: 'INR', method: 'upi', note: 'cab share' }, responses: [{ name: 'Recorded', status: 201, body: { settlement: SETTLEMENT, transfers: [], seq: 50 } }, { name: 'Wrong currency', status: 422, body: ERR('invalid', "currency must be INR, the trip's currency", 'currency') }] } },
  { method: 'POST', path: '/app/v1/trips/:trip/transfers/pay-link', section: SECTIONS.money, title: 'Pay by UPI', summary: '{ to_person_id, amount_minor } → { upi_uri: "upi://pay?pa=…&pn=…&am=…&cu=INR&tn=…", expires_at (+10 min) }. Only to someone you owe in the current transfers (422). 409 when the payee is not in the trip or has no UPI id (has_upi false): record the payment instead.',
    example: { body: { to_person_id: 'p_aarav', amount_minor: 170000 }, responses: [{ name: 'Link', status: 200, body: { upi_uri: 'upi://pay?pa=aarav%40okhdfc&pn=Aarav%20Shah&am=1700.00&cu=INR&tn=Goa%20%F0%9F%8C%B4%20%C2%B7%20settle%20up', expires_at: '2026-11-07T09:10:00.000Z' } }, { name: 'No UPI id', status: 409, body: ERR('conflict', 'Aarav Shah has no UPI id saved: record the payment instead') }] } },
];

/** `?status=` belonged to expense approval, which is gone: any value is refused, so an old client never mistakes the whole list for a filtered one. */
function noStatusQuery(raw: unknown): void {
  if (raw !== undefined && raw !== '') throw invalid('status is no longer a filter: every expense counts', 'status');
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

  app.get('/app/v1/trips/:trip/money', { preValidation: memberFirst(ctx, 'private, no-store') }, async (req: any) =>
    readMoneyView(ctx, req.params.trip, req.personId)); // membership is checked again inside, with the read

  app.get('/app/v1/trips/:trip/transactions', { ...privateRead, ...inTrip(ctx, (req, trip, me) => listTransactions(ctx, trip, me, transactionsQuery(req.query ?? {})), 200, 'private, no-store') });

  // ---- expenses
  app.get('/app/v1/trips/:trip/expenses', { ...privateRead, ...inTrip(ctx, (req, trip, me) => (noStatusQuery(req.query?.status), listExpenses(ctx, trip, me))) });
  app.post('/app/v1/trips/:trip/expenses', inTrip(ctx, (req, trip, me) => createExpense(ctx, trip, me, checkAddExpense(req.body)), 201));
  app.patch('/app/v1/trips/:trip/expenses/:id', inTrip(ctx, (req, trip, me) => updateExpenseSplit(ctx, trip, me, req.params.id!, checkPatchExpense(req.body))));
  app.delete('/app/v1/trips/:trip/expenses/:id', inTrip(ctx, (req, trip, me) => removeExpense(ctx, trip, me, req.params.id!)));

  // ---- settlements: payments made outside Go
  app.post('/app/v1/trips/:trip/settlements', inTrip(ctx, (req, trip, me) => recordSettlement(ctx, trip, me, checkRecordSettlement(req.body)), 201));

  // ---- the settle_up card's buttons
  app.post('/app/v1/trips/:trip/transfers/pay-link', inTrip(ctx, (req, trip, me) => payLinkFor(ctx, trip, me, checkPayLink(req.body))));
}
