// The one error shape of the app's API (app contract §1.5):
//   { "error": { "code", "message", "field": null | string, "retry_after_seconds": null | number, "request_id" } }
// 400 `bad_request` is only for a request that cannot be read at all (unparseable JSON, a broken address); every body
// or query rule is 422 `invalid`, with the field when it is known. The domain keeps throwing its typed errors
// (src/domain/errors.ts); this file turns them, and Fastify's own refusals, into that shape.
import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { GoUnavailable } from '../domain/ask-go.js';
import { Forbidden } from '../domain/actions.js';
import { InvalidInput } from '../domain/errors.js';
import { SocketCallError } from '../go/go-socket.js';
import { fieldOf } from './input.js';

export type ErrorCode = 'bad_request' | 'invalid' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'rate_limited' | 'internal' | 'go_unavailable' | 'unavailable';

export interface HttpError {
  status: number;
  code: ErrorCode;
  message: string;
  field?: string | null;
  retryAfterSeconds?: number | null;
}

/** A short id for one request: it goes in the `X-Request-Id` header, the error body and the log line, so a report can be matched to a line. */
export const newRequestId = () => randomBytes(6).toString('hex');

/** Writes the error body (and `Retry-After` when there is a wait). The request id is the one the request was given on arrival. */
export function sendError(reply: FastifyReply, e: HttpError, requestId: string) {
  if (e.retryAfterSeconds) reply.header('retry-after', String(e.retryAfterSeconds));
  return reply.code(e.status).send({
    error: { code: e.code, message: e.message, field: e.field ?? null, retry_after_seconds: e.retryAfterSeconds ?? null, request_id: requestId },
  });
}

const CODE_BY_STATUS: Record<number, ErrorCode> = { 404: 'not_found', 409: 'conflict', 422: 'invalid', 429: 'rate_limited', 503: 'unavailable' };

/** What an error thrown anywhere under a route means to the app, or null for a bug (answered 500 and logged). */
export function toHttpError(err: unknown): HttpError | null {
  if (err instanceof Forbidden) return { status: 403, code: 'forbidden', message: err.message };
  if (err instanceof GoUnavailable) return { status: err.status, code: err.code as ErrorCode, message: err.message, retryAfterSeconds: err.retryAfterSeconds };
  if (err instanceof InvalidInput) return { status: 422, code: 'invalid', message: err.message, field: err.field };
  if (err instanceof SocketCallError && CODE_BY_STATUS[err.code]) {
    return { status: err.code, code: CODE_BY_STATUS[err.code]!, message: err.message, retryAfterSeconds: err.retryAfterSeconds };
  }
  const e = err as { validation?: Array<Parameters<typeof fieldOf>[0]>; statusCode?: number; message?: string; code?: string };
  // A route's own schema (Fastify's validation): a rule about the body or the query, so 422, naming the field.
  if (Array.isArray(e.validation) && e.validation[0]) return { status: 422, code: 'invalid', message: e.message ?? 'invalid', field: fieldOf(e.validation[0]) };
  if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
    // Fastify's own refusals before a handler runs: JSON that cannot be read (400), a body too large (413), a wrong content type (415).
    const unreadable = e.statusCode === 400;
    return { status: e.statusCode, code: unreadable ? 'bad_request' : 'invalid', message: e.message ?? 'bad request' };
  }
  return null;
}

/** The error handler for the whole app: the typed errors become their status, anything else is a 500 with the request id in the log. */
export function handleError(err: unknown, req: FastifyRequest, reply: FastifyReply) {
  const known = toHttpError(err);
  if (known) return sendError(reply, known, req.id);
  console.error(`[${req.id}] ${req.method} ${req.url.split('?')[0]}`, err);
  return sendError(reply, { status: 500, code: 'internal', message: 'something went wrong' }, req.id);
}
