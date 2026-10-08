// §4.10 Bookings as the app reads them, and the ticket files behind them. Two rules live here. The covered-people rule
// (app contract §1.7, APP-CONTRACT-CHANGES): `passengers[]` and `documents[]` are returned only to the people in
// `for_person_ids`; everyone else gets the booking without those two keys. Go's own reads keep everything. And the
// files: when Go's add_booking names documents, each `url` is fetched once, the file is kept in Storage under our own
// path, and the app only ever gets a short signed link from GET …/documents/:document_id (never the stored link).
import type { Ctx } from '../context.js';
import type { Db } from '../db/pool.js';
import { IMAGE, MAX_UPLOAD_BYTES, extensionFor } from '../api/v1/uploads.js';
import { Forbidden } from './actions.js';
import { notFound } from './errors.js';
import { bookingOf, compact, type BookingRow } from './mappers.js';
import type { Booking } from './types.js';

/** A document the app sees: the file's facts and nothing about where it is. Opened through GET …/documents/:document_id. */
export interface AppDocument { document_id: string; name: string; mime: string; size_bytes: number; pages?: number; visibility: 'covered' | 'group' }

export interface BookingDocumentRow extends AppDocument { booking_id: string; path: string; created_at: Date }

export type BookingForApp = Booking & { documents?: AppDocument[] };

/** The signed link for a document is good this long (app contract §4.10: 10 minutes). */
export const DOCUMENT_LINK_TTL_SECONDS = 600;

const documentOf = (r: BookingDocumentRow): AppDocument => compact({ document_id: r.document_id, name: r.name, mime: r.mime, size_bytes: r.size_bytes, pages: r.pages ?? undefined, visibility: r.visibility });

/** The stored documents of these bookings, by booking, oldest first. */
export async function documentsOf(db: Db, bookingIds: string[]): Promise<Map<string, BookingDocumentRow[]>> {
  const out = new Map<string, BookingDocumentRow[]>();
  if (bookingIds.length === 0) return out;
  const { rows } = await db.query<BookingDocumentRow>('select * from booking_documents where booking_id = any($1) order by created_at, document_id', [bookingIds]);
  for (const r of rows) out.set(r.booking_id, [...(out.get(r.booking_id) ?? []), r]);
  return out;
}

/** The covered-people rule: the booking whole for someone in `for_person_ids`, without `passengers` and `documents` for anyone else. */
export function bookingForApp(booking: Booking, documents: BookingDocumentRow[], viewerId: string): BookingForApp {
  const { passengers, ...rest } = booking as Booking & { passengers?: unknown };
  if (!booking.for_person_ids.includes(viewerId)) return rest as BookingForApp;
  return compact({ ...booking, passengers, documents: documents.map(documentOf) }) as BookingForApp;
}

/** The trip's bookings as this person may see them, inside the caller's transaction (TripView and the list share it). */
export async function bookingsForPerson(db: Db, bookings: Booking[], personId: string): Promise<BookingForApp[]> {
  const docs = await documentsOf(db, bookings.map((b) => b.booking_id));
  return bookings.map((b) => bookingForApp(b, docs.get(b.booking_id) ?? [], personId));
}

async function readOnly<T>(ctx: Ctx, work: (db: Db) => Promise<T>): Promise<T> {
  const db = await ctx.pool.connect();
  try {
    await db.query('begin transaction isolation level repeatable read read only');
    const out = await work(db);
    await db.query('commit');
    return out;
  } catch (err) {
    await db.query('rollback').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

/** GET /trips/:trip/bookings: every booking, confirmed and cancelled, newest first, with the trip's change number. */
export async function listBookings(ctx: Ctx, tripId: string, personId: string): Promise<{ items: BookingForApp[]; seq: number }> {
  return readOnly(ctx, async (db) => {
    const seq = (await db.query('select seq from trips where trip_id = $1', [tripId])).rows[0]?.seq as number | undefined;
    if (seq === undefined) throw notFound(`trip ${tripId} does not exist`);
    const { rows } = await db.query<BookingRow>('select * from bookings where trip_id = $1 order by created_at desc, booking_id desc', [tripId]);
    return { items: await bookingsForPerson(db, rows.map(bookingOf), personId), seq };
  });
}

async function bookingRow(db: Db, tripId: string, bookingId: string): Promise<BookingRow> {
  const row = (await db.query<BookingRow>('select * from bookings where trip_id = $1 and booking_id = $2', [tripId, bookingId])).rows[0];
  if (!row) throw notFound(`booking ${bookingId} does not exist in trip ${tripId}`);
  return row;
}

/** GET /trips/:trip/bookings/:id. */
export async function getBooking(ctx: Ctx, tripId: string, personId: string, bookingId: string): Promise<BookingForApp> {
  const row = await bookingRow(ctx.pool, tripId, bookingId);
  return (await bookingsForPerson(ctx.pool, [bookingOf(row)], personId))[0]!;
}

/**
 * GET …/bookings/:id/documents/:document_id: a signed link valid ten minutes, for a covered person, or for anyone in
 * the trip when the document is group-visible. 403 otherwise, 404 for a document that is not on this booking.
 */
export async function documentLink(ctx: Ctx, tripId: string, personId: string, bookingId: string, documentId: string): Promise<string> {
  const booking = await bookingRow(ctx.pool, tripId, bookingId);
  const doc = (await ctx.pool.query<BookingDocumentRow>('select * from booking_documents where booking_id = $1 and document_id = $2', [bookingId, documentId])).rows[0];
  if (!doc) throw notFound(`document ${documentId} is not on booking ${bookingId}`);
  if (!booking.for_person_ids.includes(personId) && doc.visibility !== 'group') throw new Forbidden('this ticket is for the people the booking covers');
  return ctx.storage.signDownload(doc.path, DOCUMENT_LINK_TTL_SECONDS);
}

// ---------------------------------------------------------------- what Go sends with add_booking (GO-CHANGES 1.7)

/** A document as Go names it in add_booking: the 1.1 overlay's BookingDocument, with a fetchable link. */
export interface GoDocument { document_id: string; name: string; mime: string; size_bytes: number; pages?: number; visibility: 'covered' | 'group'; url: string }

/** A ticket is a PDF or a picture of one, at most 25 MB (the upload rules, applied to Go's files too). */
const DOCUMENT_LIMITS = { maxBytes: MAX_UPLOAD_BYTES, allow: (mime: string) => mime === 'application/pdf' || IMAGE.has(mime) };

/** Copies still running: a test (or a shutdown) can wait for them. */
const inflight = new Set<Promise<void>>();
export const settleDocumentCopies = () => Promise.allSettled([...inflight]).then(() => undefined);

/**
 * After Go's add_booking was answered: the 1.1 fields go on the row (the same values again on a retry), and each
 * document Go named is copied into Storage in the background. Go is never made to wait for a file, and a copy that
 * fails (a dead link, a wrong type, too large) is logged and that document is skipped; the booking stands without it.
 */
export async function storeBookingExtras(
  ctx: Ctx,
  tripId: string,
  bookingId: string,
  p: { details?: unknown[]; return_journey?: unknown; passengers?: unknown[]; documents?: GoDocument[] },
  log: (msg: string, err?: unknown) => void = (m, e) => console.error(`[bookings] ${m}`, e ?? ''),
): Promise<void> {
  if (p.details !== undefined || p.return_journey !== undefined || p.passengers !== undefined) {
    await ctx.pool.query(
      'update bookings set details = coalesce($3, details), return_journey = coalesce($4, return_journey), passengers = coalesce($5, passengers) where trip_id = $1 and booking_id = $2',
      [tripId, bookingId, p.details === undefined ? null : JSON.stringify(p.details), p.return_journey === undefined ? null : JSON.stringify(p.return_journey), p.passengers === undefined ? null : JSON.stringify(p.passengers)],
    );
  }
  if (!p.documents?.length) return;
  const task = copyDocuments(ctx, tripId, bookingId, p.documents, log).finally(() => inflight.delete(task));
  inflight.add(task);
}

async function copyDocuments(ctx: Ctx, tripId: string, bookingId: string, documents: GoDocument[], log: (msg: string, err?: unknown) => void): Promise<void> {
  for (const doc of documents) {
    const have = await ctx.pool.query('select 1 from booking_documents where document_id = $1', [doc.document_id]);
    if (have.rowCount) continue; // a retry of the same add_booking, or Go naming the same file twice
    const path = `bookings/${tripId}/${bookingId}/${doc.document_id}.${extensionFor(doc.mime)}`;
    try {
      const copied = await ctx.storage.putFromUrl(doc.url, path, DOCUMENT_LIMITS);
      await ctx.pool.query(
        `insert into booking_documents (document_id, booking_id, name, mime, size_bytes, pages, visibility, path) values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (document_id) do nothing`,
        [doc.document_id, bookingId, doc.name, copied.mime, copied.size_bytes, doc.pages ?? null, doc.visibility, path],
      );
    } catch (err) {
      log(`document ${doc.document_id} of booking ${bookingId} was not copied; skipped`, err instanceof Error ? err.message : err); // never the link itself (it is signed)
    }
  }
}
