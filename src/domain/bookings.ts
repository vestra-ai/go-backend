// §4.10 Bookings as the app reads them, and the ticket files behind them. Two rules live here. Who sees a booking (app
// contract §1.7): an app read sends a booking only to the people in its `for_person_ids` and to its payer, whole
// (passengers, documents); to anyone else it does not exist (a single booking or its file answers 404, as for an
// unknown one). Go's own reads keep every booking, and the trip's stage counts them all. And the
// files: when Go's add_booking names documents, each `url` is fetched once, the file is kept in Storage under our own
// path, and the app only ever gets short signed links, never the stored link: each document it sees carries `url`
// (valid an hour, minted on every read), and GET …/documents/:document_id answers a fresh one.
import type { Ctx } from '../context.js';
import type { Db } from '../db/pool.js';
import { IMAGE, MAX_UPLOAD_BYTES, extensionFor } from '../api/v1/uploads.js';
import { DOWNLOAD_TTL_SECONDS, type Storage } from '../storage/storage.js';
import { notFound } from './errors.js';
import { bookingOf, compact, type BookingRow } from './mappers.js';
import type { Booking } from './types.js';

/** A document the app sees: the file's facts and, in reads, a signed link to it (`url`, valid an hour). Never where it is stored. */
export interface AppDocument { document_id: string; name: string; mime: string; size_bytes: number; pages?: number; visibility: 'covered' | 'group'; url?: string }

export interface BookingDocumentRow extends Omit<AppDocument, 'url'> { booking_id: string; path: string; created_at: Date }

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

/** Who sees a booking in the app: the people it covers, and its payer (they paid for it). A friend's flight is not yours to see. */
export const seesBooking = (booking: Pick<Booking, 'for_person_ids' | 'payer_person_id'>, personId: string): boolean =>
  booking.for_person_ids.includes(personId) || booking.payer_person_id === personId;

/**
 * The booking as one person gets it: whole for someone who sees it (`seesBooking`), without `passengers` and `documents`
 * otherwise. Reads never send the second kind (they leave the booking out); only the answer to the person who just added
 * a booking for others can be one.
 */
export function bookingForApp(booking: Booking, documents: BookingDocumentRow[], viewerId: string): BookingForApp {
  const { passengers, ...rest } = booking as Booking & { passengers?: unknown };
  if (!seesBooking(booking, viewerId)) return rest as BookingForApp;
  return compact({ ...booking, passengers, documents: documents.map(documentOf) }) as BookingForApp;
}

/**
 * The trip's bookings this person sees (the others are left out), inside the caller's transaction (TripView and the list
 * share it), and where each of their documents is stored, by document id: `linkDocuments` signs them once the read is over.
 */
export async function bookingsForPerson(db: Db, bookings: Booking[], personId: string): Promise<{ items: BookingForApp[]; paths: Map<string, string> }> {
  const theirs = bookings.filter((b) => seesBooking(b, personId));
  const docs = await documentsOf(db, theirs.map((b) => b.booking_id));
  const paths = new Map(theirs.flatMap((b) => (docs.get(b.booking_id) ?? []).map((d) => [d.document_id, d.path] as const)));
  return { items: theirs.map((b) => bookingForApp(b, docs.get(b.booking_id) ?? [], personId)), paths };
}

/**
 * Every document in the answer gets `url`: a signed link valid an hour, minted now, all in one batch. If Storage cannot
 * sign, the documents go out without it (logged); the documents route still opens them.
 */
export async function linkDocuments(
  storage: Storage,
  items: BookingForApp[],
  paths: Map<string, string>,
  log: (msg: string, err?: unknown) => void = (m, e) => console.error(`[bookings] ${m}`, e ?? ''),
): Promise<BookingForApp[]> {
  if (paths.size === 0) return items;
  const ids = [...paths.keys()];
  let urls: Map<string, string>;
  try {
    const signed = await storage.signDownloads(ids.map((id) => paths.get(id)!), DOWNLOAD_TTL_SECONDS);
    urls = new Map(ids.map((id, i) => [id, signed[i]!]));
  } catch (err) {
    log('the documents could not be signed; answered without their links', err instanceof Error ? err.message : err);
    return items;
  }
  return items.map((b) => (b.documents?.length ? ({ ...b, documents: b.documents.map((d) => compact({ ...d, url: urls.get(d.document_id) })) } as BookingForApp) : b));
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

/** GET /trips/:trip/bookings: the bookings the person sees, confirmed and cancelled, newest first, with the trip's change number. */
export async function listBookings(ctx: Ctx, tripId: string, personId: string): Promise<{ items: BookingForApp[]; seq: number }> {
  const { items, paths, seq } = await readOnly(ctx, async (db) => {
    const seq = (await db.query('select seq from trips where trip_id = $1', [tripId])).rows[0]?.seq as number | undefined;
    if (seq === undefined) throw notFound(`trip ${tripId} does not exist`);
    const { rows } = await db.query<BookingRow>('select * from bookings where trip_id = $1 order by created_at desc, booking_id desc', [tripId]);
    return { ...(await bookingsForPerson(db, rows.map(bookingOf), personId)), seq };
  });
  return { items: await linkDocuments(ctx.storage, items, paths), seq };
}

/** The booking, for someone who sees it: 404 for anyone else, worded as for an unknown booking, so ids cannot be probed. */
async function bookingRow(db: Db, tripId: string, bookingId: string, personId: string): Promise<BookingRow> {
  const row = (await db.query<BookingRow>('select * from bookings where trip_id = $1 and booking_id = $2', [tripId, bookingId])).rows[0];
  if (!row || !seesBooking(row, personId)) throw notFound(`booking ${bookingId} does not exist in trip ${tripId}`);
  return row;
}

/** GET /trips/:trip/bookings/:id: 404 for a booking the person does not see. */
export async function getBooking(ctx: Ctx, tripId: string, personId: string, bookingId: string): Promise<BookingForApp> {
  const row = await bookingRow(ctx.pool, tripId, bookingId, personId);
  const { items, paths } = await bookingsForPerson(ctx.pool, [bookingOf(row)], personId);
  return (await linkDocuments(ctx.storage, items, paths))[0]!;
}

/**
 * GET …/bookings/:id/documents/:document_id: a signed link valid ten minutes, for someone who sees the booking (a covered
 * person or the payer), whatever the document's `visibility`. 404 for anyone else, as for a document that is not on it.
 */
export async function documentLink(ctx: Ctx, tripId: string, personId: string, bookingId: string, documentId: string): Promise<string> {
  await bookingRow(ctx.pool, tripId, bookingId, personId);
  const doc = (await ctx.pool.query<BookingDocumentRow>('select * from booking_documents where booking_id = $1 and document_id = $2', [bookingId, documentId])).rows[0];
  if (!doc) throw notFound(`document ${documentId} is not on booking ${bookingId}`);
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
