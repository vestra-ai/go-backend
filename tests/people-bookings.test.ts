import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check } from '../src/contract/index.js';
import { settleDocumentCopies } from '../src/domain/bookings.js';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';
import { seedTrip } from './helpers/seed.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
/** A stand-in for Go's file host: the links Go puts in add_booking's documents[] point here. */
let files: Server;
let filesBase: string;
beforeAll(async () => {
  h = await startHarness(); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
  await seedTrip(h.pool, 't_other', [{ id: 'p_orgx', name: 'Orgx', role: 'organizer' }]);
  files = createServer((req, res) => {
    if (req.url === '/ticket.pdf') return res.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF-1.4 ticket');
    if (req.url === '/voucher.png') return res.writeHead(200, { 'content-type': 'image/png' }).end('PNG');
    if (req.url === '/page.html') return res.writeHead(200, { 'content-type': 'text/html' }).end('<html>');
    if (req.url === '/huge.pdf') return res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(30 * 1024 * 1024) }).end('x');
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => files.listen(0, '127.0.0.1', r));
  filesBase = `http://127.0.0.1:${(files.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await h.stop();
  await new Promise<void>((r) => files.close(() => r()));
});

const EVERYONE = ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir'];
const arjun = () => t.as('p_arjun');
let n = 0;
const booking = (over: Record<string, unknown> = {}) => ({
  kind: 'stay', title: `Villa ${++n}`, vendor: 'ixigo', ref: 'IXG-1', amount_minor: 5420000, payer_person_id: 'p_rahul', for_person_ids: EVERYONE, ...over,
});
/** Adds a booking as the app does: a strict body and an Idempotency-Key (one per body, so a repeat of the same body is the same press). */
const keys = new Map<string, string>();
const keyFor = (body: unknown) => {
  const text = JSON.stringify(body);
  if (!keys.has(text)) keys.set(text, `bk-${keys.size + 1}`);
  return keys.get(text)!;
};
const add = (body: unknown, who: any = arjun()) => t.api(who, 'POST', '/app/v1/trips/t_goa/bookings', body, { 'idempotency-key': keyFor(body) });
const list = (who: any = arjun(), trip = 't_goa') => t.api(who, 'GET', `/app/v1/trips/${trip}/bookings`);
const one = (bid: string, who: any = arjun()) => t.api(who, 'GET', `/app/v1/trips/t_goa/bookings/${bid}`);
const doc = (bid: string, docId: string, who: any = arjun()) => t.api(who, 'GET', `/app/v1/trips/t_goa/bookings/${bid}/documents/${docId}`);
const goBooking = (over: Record<string, unknown> = {}) => ({ request_id: `rq_doc_${++n}`, trip_id: 't_goa', kind: 'flight', title: `Flight ${n}`, vendor: 'ixigo', ref: 'K7QX2M', amount_minor: 1184000, currency: 'INR', payer_person_id: 'p_rahul', for_person_ids: ['p_rahul', 'p_arjun'], ...over });
const patch = (bid: string, body: unknown, who: any = arjun()) => t.api(who, 'PATCH', `/app/v1/trips/t_goa/bookings/${bid}`, body);
/** [status, error code] of a refused call. */
const refusal = (r: { status: number; body: any }) => [r.status, r.body.error.code];
const vote = (over: Record<string, unknown> = {}) => ({
  client_id: `v-${++n}`, question: `Question ${n}?`, kind: 'choice', anonymous: false, options: [{ label: 'Villa Sol', price_minor: 5420000 }, { label: 'Casa Azul', price_minor: 6180000 }], ...over,
});
/** Opens a vote as a member, and has all five vote for the first option so it closes with a result. */
const closedVote = async (over: Record<string, unknown> = {}) => {
  const opened = await t.api(t.as('p_priya'), 'POST', '/app/v1/trips/t_goa/decisions', vote(over));
  for (const p of EVERYONE) await t.api(t.as(p), 'PUT', `/app/v1/trips/t_goa/decisions/${opened.body.decision.decision_id}/vote`, { option_index: 0 });
  return opened.body.decision.decision_id as string;
};
const journey = {
  mode: 'flight', origin: { name: 'Delhi', code: 'DEL' }, destination: { name: 'Goa', code: 'GOI' },
  depart_at: '2026-11-06T08:00:00Z', arrive_at: '2026-11-06T10:30:00Z', carrier_name: 'IndiGo', number: '6E 123',
};

describe('adding a booking', () => {
  it('stores it with the person, confirmed, no approval and no expense; Go hears the booking and then the booked line; a repeat with the same Idempotency-Key is the same booking', async () => {
    const body = booking({ kind: 'flight', title: 'Flight DEL to GOI', journey, starts_at: '2026-11-06T08:00:00Z', ends_at: '2026-11-06T10:30:00Z', refundable_until: '2026-11-01T00:00:00Z' });
    const r = await add(body);
    expect([r.status, Object.keys(r.body).sort()]).toEqual([201, ['booking_id', 'seq']]);
    await h.flush();
    const added = t.events('booking.changed').find((e) => e.data.booking.booking_id === r.body.booking_id)!;
    const line = t.events('record.changed').find((e) => e.data.line.booking_id === r.body.booking_id)!;
    expect([check('Event', added).ok, check('Event', line).ok]).toEqual([true, true]);
    expect(added.data).toMatchObject({ change: 'added', by: { kind: 'person', person_id: 'p_arjun' }, booking: { status: 'confirmed', currency: 'INR', added_by_person_id: 'p_arjun', journey } });
    expect(added.data.booking).not.toHaveProperty('approval_id');
    expect([line.seq, line.data.line.kind, line.data.line.text]).toEqual([added.seq + 1, 'booked', 'Flight DEL to GOI']);
    expect(await rows(h.pool, 'select count(*)::int as n from expenses')).toEqual([{ n: 0 }]);
    const again = await add(body);
    expect([again.status, again.body, again.headers['idempotent-replayed']]).toEqual([201, r.body, 'true']);
    await h.flush();
    expect([(await rows(h.pool, `select booking_id from bookings where title = 'Flight DEL to GOI'`)).length, t.events('booking.changed').filter((e) => e.data.booking.title === 'Flight DEL to GOI').length]).toEqual([1, 1]); // one booking, one event
  });

  it('refuses an unsigned caller, someone outside the trip, an unknown field (client_id is gone: the header is the one repeat key), and a person outside the trip in for_person_ids', async () => {
    expect(refusal(await add(booking(), null))).toEqual([401, 'unauthorized']);
    expect(refusal(await add(booking(), t.as('p_stranger')))).toEqual([403, 'forbidden']);
    expect(refusal(await add({ ...booking(), extra: 1 }))).toEqual([422, 'invalid']);
    const pressKey = await add({ ...booking(), client_id: 'bk-old' });
    expect([pressKey.status, pressKey.body.error.field]).toEqual([422, 'client_id']);
    expect(refusal(await add(booking({ for_person_ids: ['p_rahul', 'p_stranger'] })))).toEqual([422, 'invalid']);
  });

  it('takes the 1.1 fields (details, return_journey, passengers) and stores them; a passenger who is not covered is 422 naming the field; Go\'s read keeps them all', async () => {
    const back = { ...journey, origin: journey.destination, destination: journey.origin, depart_at: '2026-11-09T18:00:00Z', arrive_at: '2026-11-09T20:30:00Z' };
    const body = booking({ kind: 'flight', title: 'Round trip', journey, return_journey: back, details: [{ label: 'Baggage', value: '15 kg' }], passengers: [{ person_id: 'p_arjun', seat: '14A', pnr: 'K7QX2M' }], for_person_ids: ['p_arjun', 'p_meher'] });
    const r = await add(body);
    expect(r.status).toBe(201);
    const snap = (await h.go.call('read_trip', { trip_id: 't_goa' })).result;
    const stored = snap.bookings.find((b: any) => b.booking_id === r.body.booking_id);
    expect([check('TripSnapshot', snap).ok, stored.return_journey, stored.details, stored.passengers]).toEqual([true, back, [{ label: 'Baggage', value: '15 kg' }], [{ person_id: 'p_arjun', seat: '14A', pnr: 'K7QX2M' }]]);
    const stranger = await add(booking({ for_person_ids: ['p_arjun'], passengers: [{ person_id: 'p_arjun' }, { person_id: 'p_meher', seat: '1A' }] }));
    expect([stranger.status, stranger.body.error.field]).toEqual([422, 'passengers[1].person_id']);
    expect(refusal(await add(booking({ passengers: [{ person_id: 'p_arjun', seat: 'A'.repeat(9) }] })))).toEqual([422, 'invalid']);
    expect(refusal(await add(booking({ details: [{ label: 'x' }] })))).toEqual([422, 'invalid']);
  });

  it('refuses a decision_id that is an open vote, a cancelled vote, a cancellation vote, or another trip\'s vote', async () => {
    const open = (await t.api(t.as('p_priya'), 'POST', '/app/v1/trips/t_goa/decisions', vote())).body.decision.decision_id;
    const cancelled = (await t.api(t.as('p_priya'), 'POST', '/app/v1/trips/t_goa/decisions', vote())).body.decision.decision_id;
    await t.api(t.as('p_priya'), 'POST', `/app/v1/trips/t_goa/decisions/${cancelled}/cancel`);
    // No code can open a cancellation vote yet, so this one is written straight into the table, closed, with the link set.
    await h.pool.query(
      `insert into decisions (decision_id, trip_id, question, kind, options, of_count, status, cancels_booking_id, closed_at)
       values ('d_cancelvote', 't_goa', 'Cancel this booking?', 'yesno', '[{"label":"Cancel: x"},{"label":"Keep: x"}]', 5, 'closed', 'b_some', now())`,
    );
    await h.pool.query(`insert into decisions (decision_id, trip_id, question, kind, options, of_count, status) values ('d_elsewhere', 't_other', 'Elsewhere?', 'choice', '[{"label":"a"},{"label":"b"}]', 1, 'closed')`);
    for (const decision_id of [open, cancelled, 'd_cancelvote', 'd_elsewhere']) expect(refusal(await add(booking({ decision_id })))).toEqual([422, 'invalid']);
  });

  it('accepts a closed vote and Go\'s spend approval for it still goes through; refuses ends before starts and an image that is not a URL', async () => {
    const decision_id = await closedVote();
    await h.go.call('set_mandate', { request_id: 'rq_m1', trip_id: 't_goa', decision_id, choice_index: 0, cap_minor: 5600000, currency: 'INR', refundable_only: false, payer_person_id: 'p_rahul' });
    await t.api(t.as('p_rahul'), 'POST', `/app/v1/trips/t_goa/decisions/${decision_id}/mandate/confirm`);
    const r = await add(booking({ decision_id }));
    const approval = await h.go.call('request_spend_approval', { request_id: 'rq_s1', trip_id: 't_goa', decision_id, amount_minor: 5420000, currency: 'INR', merchant: 'ixigo: Villa Sol', purpose: 'Villa Sol' });
    expect([r.status, approval.result.status]).toEqual([201, 'approved']);
    expect(await rows(h.pool, 'select kind, booking_id from record_lines where decision_id = $1', [decision_id])).toEqual([{ kind: 'booked', booking_id: r.body.booking_id }]); // the decided line became the booked line
    expect(refusal(await add(booking({ starts_at: '2026-11-09T10:00:00Z', ends_at: '2026-11-06T10:00:00Z' })))).toEqual([422, 'invalid']);
    expect(refusal(await add(booking({ image_url: 'not a url' })))).toEqual([422, 'invalid']);
  });
});

describe('updating a booking', () => {
  it('records the update by the person, null clears the three dates, and two identical updates at once give one event', async () => {
    const created = await add(booking({ ref: 'OLD', starts_at: '2026-11-06T08:00:00Z', ends_at: '2026-11-09T08:00:00Z', refundable_until: '2026-11-01T00:00:00Z' }));
    const bid = created.body.booking_id;
    const cleared = await patch(bid, { ref: 'NEW-1', refundable_until: null, starts_at: null, ends_at: null });
    await h.flush();
    const updated = t.events('booking.changed').find((e) => e.seq === cleared.body.seq)!;
    expect(updated.data).toMatchObject({ change: 'updated', by: { kind: 'person', person_id: 'p_arjun' }, booking: { booking_id: bid, ref: 'NEW-1' } });
    expect(updated.data.booking).not.toHaveProperty('starts_at');
    expect(updated.data.booking).not.toHaveProperty('ends_at');
    expect(updated.data.booking).not.toHaveProperty('refundable_until');
    const two = await Promise.all([patch(bid, { ref: 'NEW-2' }), patch(bid, { ref: 'NEW-2' })]);
    expect(two.map((x) => x.body.seq === null).sort()).toEqual([false, true]); // one change number, one "nothing changed"
    await h.flush();
    expect(t.events('booking.changed').filter((e) => e.data.change === 'updated' && e.data.booking.booking_id === bid && e.data.booking.ref === 'NEW-2')).toHaveLength(1);
    // A time the caller did not send keeps exactly what was stored, down to the microsecond (Go may have stored one).
    await h.pool.query(`update bookings set starts_at = '2026-11-06 08:00:00.123456+00' where booking_id = $1`, [bid]);
    await patch(bid, { ref: 'NEW-3' });
    expect((await rows(h.pool, `select to_char(starts_at at time zone 'UTC', 'HH24:MI:SS.US') as s from bookings where booking_id = $1`, [bid]))[0].s).toBe('08:00:00.123456');
  });

  it('refuses a merged result that ends before it starts, an empty update, and a cancelled booking', async () => {
    const bid = (await add(booking({ starts_at: '2026-11-06T08:00:00Z' }))).body.booking_id;
    expect(refusal(await patch(bid, { ends_at: '2026-11-05T08:00:00Z' }))).toEqual([422, 'invalid']);
    expect(refusal(await patch(bid, {}))).toEqual([422, 'invalid']); // nothing to change
    await h.pool.query(`update bookings set status = 'cancelled' where booking_id = $1`, [bid]);
    expect(refusal(await patch(bid, { ref: 'LATE' }))).toEqual([409, 'conflict']);
  });

  it('refuses an unsigned caller, someone outside the trip, an unknown field, and another trip\'s booking', async () => {
    const bid = (await add(booking())).body.booking_id;
    await h.pool.query(
      `insert into bookings (booking_id, trip_id, kind, title, vendor, ref, amount_minor, currency, payer_person_id) values ('b_elsewhere', 't_other', 'stay', 'Villa', 'V', 'R', 1, 'INR', 'p_orgx')`,
    );
    expect(refusal(await patch(bid, { ref: 'X' }, null))).toEqual([401, 'unauthorized']);
    expect(refusal(await patch(bid, { ref: 'X' }, t.as('p_stranger')))).toEqual([403, 'forbidden']);
    expect(refusal(await patch(bid, { ref: 'X', extra: 1 }))).toEqual([422, 'invalid']);
    expect(refusal(await patch('b_elsewhere', { ref: 'X' }))).toEqual([404, 'not_found']);
  });
});

describe('reading bookings (the covered-people rule)', () => {
  it('lists every booking newest first with seq, and gives passengers only to the people the booking covers; everyone else gets the booking without passengers or documents; one booking reads the same way; 404 for another trip\'s', async () => {
    const r = await add(booking({ kind: 'flight', title: 'Covered read', journey, for_person_ids: ['p_arjun', 'p_meher'], passengers: [{ person_id: 'p_arjun', seat: '14A' }, { person_id: 'p_meher', seat: '14B' }] }));
    const bid = r.body.booking_id as string;
    const seq = (await rows(h.pool, `select seq from trips where trip_id = 't_goa'`))[0].seq;
    const covered = await list(arjun());
    const other = await list(t.as('p_priya'));
    expect([covered.status, covered.body.seq, covered.body.items[0].booking_id, covered.body.items.length > 1]).toEqual([200, seq, bid, true]);
    const ordered = covered.body.items.map((b: any) => b.created_at);
    expect(ordered).toEqual([...ordered].sort().reverse()); // newest first
    const mine = covered.body.items.find((b: any) => b.booking_id === bid);
    const theirs = other.body.items.find((b: any) => b.booking_id === bid);
    expect([mine.passengers, mine.documents, 'passengers' in theirs, 'documents' in theirs, theirs.journey]).toEqual([[{ person_id: 'p_arjun', seat: '14A' }, { person_id: 'p_meher', seat: '14B' }], [], false, false, journey]);
    expect((await one(bid)).body.passengers).toHaveLength(2);
    expect('passengers' in (await one(bid, t.as('p_priya'))).body).toBe(false);
    // The trip read applies the same rule; Go's read does not.
    const view = (who: string) => t.api(t.as(who), 'GET', '/app/v1/trips/t_goa').then((x) => x.body.bookings.find((b: any) => b.booking_id === bid));
    expect([(await view('p_arjun')).passengers.length, 'passengers' in (await view('p_priya')), (await h.go.call('read_trip', { trip_id: 't_goa' })).result.bookings.find((b: any) => b.booking_id === bid).passengers.length]).toEqual([2, false, 2]);
    expect(refusal(await one('b_elsewhere'))).toEqual([404, 'not_found']);
    expect(refusal(await list(t.as('p_stranger')))).toEqual([403, 'forbidden']);
    expect(refusal(await list(null))).toEqual([401, 'unauthorized']);
  });
});

describe('documents Go sends with add_booking', () => {
  let bid: string;
  it('copies each file once into storage under its own path, keeps the facts without a link, skips a file it cannot copy without failing Go\'s request, and stores the 1.1 fields', async () => {
    const documents = [
      { document_id: 'doc_pdf', name: '6E5313-K7QX2M.pdf', mime: 'application/pdf', size_bytes: 15, pages: 2, visibility: 'covered', url: `${filesBase}/ticket.pdf` },
      { document_id: 'doc_png', name: 'voucher.png', mime: 'image/png', size_bytes: 3, visibility: 'group', url: `${filesBase}/voucher.png` },
      { document_id: 'doc_dead', name: 'gone.pdf', mime: 'application/pdf', size_bytes: 1, visibility: 'covered', url: `${filesBase}/missing.pdf` },
      { document_id: 'doc_html', name: 'page.pdf', mime: 'application/pdf', size_bytes: 1, visibility: 'covered', url: `${filesBase}/page.html` },
      { document_id: 'doc_huge', name: 'huge.pdf', mime: 'application/pdf', size_bytes: 1, visibility: 'covered', url: `${filesBase}/huge.pdf` },
    ];
    const params = goBooking({ documents, details: [{ label: 'PNR', value: 'K7QX2M' }], passengers: [{ person_id: 'p_rahul', seat: '14A', pnr: 'K7QX2M' }] });
    const r = await h.go.call('add_booking', params);
    expect(r.error).toBeUndefined();
    bid = r.result.booking_id;
    await settleDocumentCopies();
    const stored = await rows(h.pool, 'select document_id, name, mime, size_bytes, pages, visibility, path from booking_documents where booking_id = $1 order by document_id', [bid]);
    expect(stored).toEqual([
      { document_id: 'doc_pdf', name: '6E5313-K7QX2M.pdf', mime: 'application/pdf', size_bytes: 15, pages: 2, visibility: 'covered', path: `bookings/t_goa/${bid}/doc_pdf.pdf` },
      { document_id: 'doc_png', name: 'voucher.png', mime: 'image/png', size_bytes: 3, pages: null, visibility: 'group', path: `bookings/t_goa/${bid}/doc_png.png` },
    ]);
    expect(h.storage.files.get(`bookings/t_goa/${bid}/doc_pdf.pdf`)?.bytes.toString()).toBe('%PDF-1.4 ticket');
    // A retry of the same add_booking answers the same and copies nothing again.
    expect((await h.go.call('add_booking', params)).result).toEqual(r.result);
    await settleDocumentCopies();
    expect((await rows(h.pool, 'select count(*)::int as n from booking_documents where booking_id = $1', [bid]))[0].n).toBe(2);
    // Covered people see the documents (facts only, no url); the rest of the trip sees neither documents nor passengers.
    const rahul = (await one(bid, t.as('p_rahul'))).body;
    const priya = (await one(bid, t.as('p_priya'))).body;
    expect([rahul.documents, rahul.passengers, rahul.details, 'documents' in priya, 'passengers' in priya, priya.details]).toEqual([
      [{ document_id: 'doc_pdf', name: '6E5313-K7QX2M.pdf', mime: 'application/pdf', size_bytes: 15, pages: 2, visibility: 'covered' }, { document_id: 'doc_png', name: 'voucher.png', mime: 'image/png', size_bytes: 3, visibility: 'group' }],
      [{ person_id: 'p_rahul', seat: '14A', pnr: 'K7QX2M' }], [{ label: 'PNR', value: 'K7QX2M' }], false, false, [{ label: 'PNR', value: 'K7QX2M' }],
    ]);
    expect(JSON.stringify(rahul)).not.toContain(filesBase);
  });

  it('GET …/documents/:document_id answers 302 to a signed link valid 10 minutes for a covered person, 403 for anyone else unless the document is group-visible, 404 for an unknown document', async () => {
    const r = await doc(bid, 'doc_pdf', t.as('p_rahul'));
    expect([r.status, r.headers['cache-control'], String(r.headers.location).includes('/_dev/storage/')]).toEqual([302, 'private, no-store', true]);
    const fetched = await h.app.inject({ method: 'GET', url: new URL(String(r.headers.location)).pathname });
    expect([fetched.statusCode, fetched.headers['content-type'], fetched.body]).toEqual([200, 'application/pdf', '%PDF-1.4 ticket']);
    h.storage.now = () => Date.now() + 11 * 60_000; // eleven minutes on, the link is dead
    expect((await h.app.inject({ method: 'GET', url: new URL(String(r.headers.location)).pathname })).statusCode).toBe(403);
    h.storage.now = () => Date.now();
    expect(refusal(await doc(bid, 'doc_pdf', t.as('p_priya')))).toEqual([403, 'forbidden']); // not covered
    expect((await doc(bid, 'doc_png', t.as('p_priya'))).status).toBe(302); // group-visible
    expect(refusal(await doc(bid, 'doc_dead', t.as('p_rahul')))).toEqual([404, 'not_found']); // never copied
    expect(refusal(await doc('b_elsewhere', 'doc_pdf', t.as('p_rahul')))).toEqual([404, 'not_found']);
    expect(refusal(await doc(bid, 'doc_pdf', t.as('p_stranger')))).toEqual([403, 'forbidden']);
    expect(refusal(await doc(bid, 'doc_pdf', null))).toEqual([401, 'unauthorized']);
  });
});
