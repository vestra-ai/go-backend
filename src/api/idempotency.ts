// `Idempotency-Key` (app contract §1.4): the one repeat mechanism for every write under /app/v1. A write that carries the
// header is done once per (person, method, path, key) for 24 hours: a repeat with the same body gets the stored answer
// back (any status), marked `Idempotent-Replayed: true`; a repeat with a different body is 422 `idempotency_key_reused`.
// The key is looked up after sign-in and before the handler, and the answer is stored as it is sent. Go's own requests
// keep their (trip_id, request_id) store in src/db/once.ts; this is only for the app.
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { invalid } from '../domain/errors.js';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_TTL_HOURS = 24;
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

declare module 'fastify' {
  interface FastifyRequest {
    /** The request body exactly as it arrived (JSON text), for the body hash. Empty when there was none. */
    rawBody?: string;
    /** Set when this request carries a new key: the answer is stored under it when it is sent. */
    idempotency?: { key: string; bodyHash: string; path: string };
  }
}

export const bodyHash = (raw: string) => createHash('sha256').update(raw).digest('hex');

export function registerIdempotency(app: FastifyInstance, pool: pg.Pool, prefix = '/app/v1') {
  // Runs after the global sign-in hook (both are preValidation hooks; they run in the order they were added), so
  // `req.personId` is set. A route without sign-in has no person and no store.
  app.addHook('preValidation', async (req, reply) => {
    const header = req.headers[IDEMPOTENCY_KEY_HEADER];
    if (header === undefined || !WRITES.has(req.method) || !req.url.startsWith(prefix) || !req.personId) return;
    const key = Array.isArray(header) ? header[0] : header;
    if (!key || key.length > 128) throw invalid('Idempotency-Key must be 1 to 128 characters', 'Idempotency-Key');
    const path = req.url; // path and query: `DELETE /me/go?trip_id=` differs from `DELETE /me/go`
    const hash = bodyHash(req.rawBody ?? '');
    const seen = await pool.query('select body_hash, status, response from idempotency_keys where person_id = $1 and method = $2 and path = $3 and key = $4', [req.personId, req.method, path, key]);
    const row = seen.rows[0];
    if (!row) {
      req.idempotency = { key, bodyHash: hash, path };
      return;
    }
    if (row.body_hash !== hash) throw invalid('idempotency_key_reused: this key was already used with a different body', 'Idempotency-Key');
    reply.header('idempotent-replayed', 'true');
    reply.code(row.status);
    return row.response === null ? reply.send() : reply.send(row.response);
  });

  // The answer, whatever its status, is stored as it leaves. Two copies racing past the lookup both run and the first
  // to store wins the row: the domain keys (client_id today, client_message_id and press_id later) still keep a double
  // press to one write where it matters.
  app.addHook('onSend', async (req, reply, payload) => {
    const pending = req.idempotency;
    if (!pending || !req.personId) return payload;
    let response: unknown = null;
    if (typeof payload === 'string' && payload.length > 0) {
      try {
        response = JSON.parse(payload);
      } catch {
        return payload; // not JSON (a stream, or text): nothing to replay
      }
    } else if (payload !== null && payload !== undefined) return payload;
    await pool
      .query(
        'insert into idempotency_keys (person_id, method, path, key, body_hash, status, response) values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing',
        [req.personId, req.method, pending.path, pending.key, pending.bodyHash, reply.statusCode, response === null ? null : JSON.stringify(response)],
      )
      .catch((err) => console.error(`[${req.id}] idempotency store failed`, err));
    return payload;
  });
}

/** Removes keys older than the 24-hour window. Safe to run on every instance. */
export async function sweepIdempotencyKeys(pool: pg.Pool): Promise<number> {
  const { rowCount } = await pool.query('delete from idempotency_keys where created_at < now() - make_interval(hours => $1)', [IDEMPOTENCY_TTL_HOURS]);
  return rowCount ?? 0;
}
