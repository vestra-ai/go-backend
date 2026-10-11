// The demo booking's ticket files, made once the payment is saved: each ticket is rendered to HTML, then to a PDF, kept
// in Storage under the booking, and listed in booking_documents for the people the booking covers. In the background,
// like the copies of Go's documents (src/domain/bookings.ts): the payer's tap never waits for Chromium, and a render that
// fails is logged and skipped; the booking stands without that file. When at least one file landed the phones are told,
// with a new change number so the app reads the booking again (a change number with no event, like a card's).
import type { Ctx } from '../context.js';
import { newId } from '../db/ids.js';
import { withTx } from '../db/pool.js';
import { nextSeq } from '../db/write-change.js';
import { publishHome } from '../domain/actions.js';
import { renderPdf } from './pdf.js';
import { ticketHtml, type DemoTicket } from './tickets/index.js';

const PDF = 'application/pdf';

/** Renders still running: a test (or a shutdown) can wait for them. */
const inflight = new Set<Promise<void>>();
export const settleDemoTickets = () => Promise.allSettled([...inflight]).then(() => undefined);

/** Starts making the booking's ticket files in the background and returns at once. */
export function attachDemoTickets(
  ctx: Ctx,
  tripId: string,
  bookingId: string,
  tickets: DemoTicket[],
  log: (msg: string, err?: unknown) => void = (m, e) => console.error(`[tickets] ${m}`, e ?? ''),
): void {
  if (!tickets.length) return;
  const task = attach(ctx, tripId, bookingId, tickets, log)
    .catch((err) => log(`the tickets of booking ${bookingId} were not attached`, err instanceof Error ? err.message : err))
    .finally(() => inflight.delete(task));
  inflight.add(task);
}

async function attach(ctx: Ctx, tripId: string, bookingId: string, tickets: DemoTicket[], log: (msg: string, err?: unknown) => void): Promise<void> {
  const made: Array<{ document_id: string; name: string; size_bytes: number; pages: number; path: string }> = [];
  for (const ticket of tickets.slice(0, 10)) {
    try {
      const pdf = await renderPdf(ticketHtml(ticket));
      if (!pdf) return; // no Chromium here: no files for anyone (said once by renderPdf)
      const document_id = newId('doc');
      const path = `bookings/${tripId}/${bookingId}/${document_id}.pdf`;
      await ctx.storage.put(path, pdf.bytes, PDF);
      made.push({ document_id, name: ticket.name.slice(0, 200), size_bytes: pdf.bytes.length, pages: pdf.pages, path });
    } catch (err) {
      log(`${ticket.name} of booking ${bookingId} was not made; skipped`, err instanceof Error ? err.message : err);
    }
  }
  if (!made.length) return;
  await withTx(ctx.pool, async (db) => {
    for (const d of made) {
      await db.query(
        `insert into booking_documents (document_id, booking_id, name, mime, size_bytes, pages, visibility, path) values ($1, $2, $3, $4, $5, $6, 'covered', $7)`,
        [d.document_id, bookingId, d.name, PDF, d.size_bytes, d.pages, d.path],
      );
    }
    // The people who see the file: those the booking covers, and its payer.
    const b = (await db.query('select for_person_ids, payer_person_id from bookings where trip_id = $1 and booking_id = $2', [tripId, bookingId])).rows[0];
    await ctx.live.publish(tripId, { kind: 'trip', seq: await nextSeq(db, tripId), kinds: ['booking'] });
    await publishHome(ctx, tripId, b ? [...(b.for_person_ids as string[]), b.payer_person_id as string] : []);
  });
}
