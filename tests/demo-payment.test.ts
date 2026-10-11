// The demo's payment (docs/GO-TEAM-DEMO-PAYMENT.md): the payer's Approve on a waiting pay card is taken as paid by the
// Server. The tap never reaches Go; the card becomes paid, the booking and its expense are written, the room gets its
// lines, and Go hears booking.changed, record.changed, expense.changed and then payment.completed.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { check } from '../src/contract/index.js';
import { settleDocumentCopies } from '../src/domain/bookings.js';
import * as demoBooking from '../src/domain/demo-booking.js';
import { settleDemoTickets } from '../src/demo/attach.js';
import { setPdfRenderer } from '../src/demo/pdf.js';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
let files: Server; // stands in for wherever the booking module keeps its ticket files
let filesUrl: string;
beforeAll(async () => {
  setPdfRenderer(async () => null); // no Chromium here, whatever the machine has: one test puts in a fake renderer
  h = await startHarness();
  t = appApi(h);
  files = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/pdf' }).end(Buffer.from('%PDF-1.4 demo')));
  await new Promise<void>((r) => files.listen(0, '127.0.0.1', r));
  filesUrl = `http://127.0.0.1:${(files.address() as AddressInfo).port}`;
});
afterAll(async () => {
  setPdfRenderer(undefined);
  files.close();
  await h.stop();
});

let n = 0;
const call = (method: string, params: Record<string, unknown>) => h.go.call(method, { request_id: `rq_demo_${++n}`, trip_id: 't_goa', ...params });
const ok = async (method: string, params: Record<string, unknown>) => {
  const f = await call(method, params);
  if (f.error) throw new Error(`${method}: ${JSON.stringify(f.error)}`);
  return f.result;
};
const tap = (personId: string, cardId: string, body: Record<string, unknown>) => t.api(t.as(personId), 'POST', `/app/v1/trips/t_goa/cards/${cardId}/actions`, body);
const cardTaps = () => h.go.requests.filter((r) => r.method === 'card_tap').length;
const JOURNEY = { mode: 'flight', origin: { name: 'Bengaluru', code: 'BLR' }, destination: { name: 'Goa', code: 'GOX' }, depart_at: '2026-11-06T14:10:00Z', arrive_at: '2026-11-06T16:25:00Z', carrier_name: 'IndiGo', number: '6E 2134' };

const payCard = (cardId: string, approvalId: string, payer: string, amount: number, over: Record<string, unknown> = {}) => ({
  card_id: cardId, kind: 'pay', fallback_text: 'Approve the payment', for_person_ids: [payer], approval_id: approvalId, payer_person_id: payer,
  amount_minor: amount, currency: 'INR', merchant: 'ixigo', purpose: 'IndiGo 6E 2134 to Goa', expires_at: new Date(Date.now() + 600_000).toISOString(), state: 'waiting',
  actions: [{ action_id: 'approve', label: 'Pay with ixigo money', style: 'primary', only_for_person_ids: [payer] }, { action_id: 'decline', label: 'Not now', style: 'secondary', only_for_person_ids: [payer] }],
  ...over,
});

/** Go posts that person their flights card, they pick, Go is granted the approval and posts its pay card. */
const personalPayCard = async (personId: string, tag: string) => {
  const flights = `c_fl_${tag}`;
  await ok('post_message', {
    text: 'Flights',
    card: {
      card_id: flights, kind: 'options', fallback_text: 'Flights to Goa', title: 'Flights', option_kind: 'flight', checked_at: '2026-10-05T06:49:30Z', for_person_ids: [personId],
      options: [{ option_id: 'o1', title: 'IndiGo 6E 2134', price_minor: 592000, currency: 'INR', highlights: ['Non-stop'], journey: JOURNEY }],
      actions: [{ action_id: 'pick', label: 'Pick', style: 'primary', per_option: true }],
    },
  });
  await tap(personId, flights, { action_id: 'pick', option_id: 'o1' });
  const approval = await ok('request_spend_approval', { amount_minor: 600000, currency: 'INR', merchant: 'ixigo', purpose: 'Flight to Goa', personal: { person_id: personId, card_id: flights, option_id: 'o1' } });
  expect(approval.status).toBe('approved');
  const pay = `c_pay_${tag}`;
  await ok('post_message', { text: 'Ready to pay', card: payCard(pay, approval.approval_id, personId, 600000) });
  return { flights, pay, approval_id: approval.approval_id as string };
};
const cardOf = async (cardId: string) => (await rows(h.pool, 'select card from messages where card_id = $1', [cardId]))[0].card;

describe("the demo's payment", () => {
  it("a person's own ticket: Approve marks the card paid, writes the booking and the expense, and tells Go, without the tap reaching Go", async () => {
    const { flights, pay, approval_id } = await personalPayCard('p_priya', 'a');
    await h.flush();
    const [taps, events, liveMark] = [cardTaps(), h.go.events.length, h.live.events.length];

    const r = await tap('p_priya', pay, { action_id: 'approve', press_id: 'press_a_1' });
    expect([r.status, r.body]).toEqual([200, { result: 'done' }]);
    expect(cardTaps()).toBe(taps); // Go never heard the tap
    // Phones are told: the card and its message, the booking and the record, the money, and the payer's home.
    const live = h.live.events.slice(liveMark).map((e) => e.event);
    expect(live.filter((e) => e.kind === 'card').length).toBe(1);
    expect(live.filter((e) => e.kind === 'trip').flatMap((e: any) => e.kinds)).toEqual(expect.arrayContaining(['booking', 'record', 'expense']));
    expect(live.some((e: any) => e.kind === 'home' && e.person_id === 'p_priya')).toBe(true);
    expect(live.filter((e) => e.kind === 'message').length).toBe(3); // the paid card's message, "booked", the money line

    // The card is paid and has no buttons; the rest is as Go sent it.
    expect(await cardOf(pay)).toMatchObject({ kind: 'pay', state: 'paid', actions: null, approval_id, amount_minor: 600000, merchant: 'ixigo' });

    const [booking] = await rows(h.pool, 'select * from bookings where approval_id = $1', [approval_id]);
    expect(booking).toMatchObject({ kind: 'flight', status: 'confirmed', title: 'IndiGo 6E 2134 · BLR → GOX', vendor: 'ixigo', currency: 'INR', payer_person_id: 'p_priya', for_person_ids: ['p_priya'], decision_id: null });
    expect([Number(booking.amount_minor), booking.ref, booking.journey.number]).toEqual([600000, expect.stringMatching(/^DEMO-[0-9A-F]{6}$/), '6E 2134']);
    // The demo module's richer booking: the times, a seat and PNR for the traveller, and the rows that say it is a demo.
    expect([booking.starts_at.toISOString(), booking.ends_at.toISOString()]).toEqual(['2026-11-06T14:10:00.000Z', '2026-11-06T16:25:00.000Z']);
    expect(booking.passengers).toEqual([{ person_id: 'p_priya', seat: expect.stringMatching(/^\d+[A-F]$/), pnr: expect.stringMatching(/^[A-HJ-NP-Z2-9]{6}$/) }]);
    expect(booking.details).toEqual(expect.arrayContaining([{ label: 'Cabin', value: 'Economy' }, { label: 'Duration', value: '2h 15m' }, { label: 'Booking', value: 'Demo, no real ticket' }]));
    const [approval] = await rows(h.pool, 'select used_at, booking_id from spend_approvals where approval_id = $1', [approval_id]);
    expect([approval.used_at, approval.booking_id]).toEqual([expect.any(Date), booking.booking_id]);
    const [expense] = await rows(h.pool, 'select * from expenses where booking_id = $1', [booking.booking_id]);
    expect(expense).toMatchObject({ paid_by_person_id: 'p_priya', split_person_ids: ['p_priya'], category: 'getting_around', note: 'IndiGo 6E 2134 · BLR → GOX' });
    expect(Number(expense.amount_minor)).toBe(600000);

    // Go hears them in this order, and payment.completed names what came before it.
    await h.flush();
    const heard = h.go.events.slice(events) as any[];
    expect(heard.map((e) => e.type)).toEqual(['booking.changed', 'record.changed', 'expense.changed', 'payment.completed', 'message.created', 'message.created']);
    expect(heard.map((e) => e.seq)).toEqual([...heard.map((e) => e.seq)].sort((a, b) => a - b));
    expect(heard[0].data).toMatchObject({ change: 'added', by: { kind: 'system' }, booking: { booking_id: booking.booking_id, approval_id } });
    const paid = heard[3];
    expect(check('Event', paid)).toMatchObject({ ok: true });
    expect(paid.data).toEqual({
      approval_id, card_id: pay, payer_person_id: 'p_priya', amount_minor: 600000, currency: 'INR', merchant: 'ixigo', purpose: 'IndiGo 6E 2134 to Goa',
      personal: { person_id: 'p_priya', card_id: flights, option_id: 'o1' }, booking_id: booking.booking_id, expense_id: expense.expense_id,
      method: 'demo', paid_at: expect.any(String), by: { kind: 'person', person_id: 'p_priya' },
    });
    expect(heard.slice(4).map((e) => e.data.message.text)).toEqual(['IndiGo 6E 2134 · BLR → GOX booked', expect.stringMatching(/^Priya added IndiGo 6E 2134 · BLR → GOX · ₹6,000 · split/)]);

    // The app reads it back: the booking, the money, and the card in the paid list.
    const bookings = await t.api(t.as('p_priya'), 'GET', '/app/v1/trips/t_goa/bookings');
    expect(JSON.stringify(bookings.body)).toContain(booking.booking_id);
    const cards = await t.api(t.as('p_priya'), 'GET', '/app/v1/trips/t_goa/cards?kind=pay&state=paid');
    expect(cards.body.items.map((i: any) => i.card.card_id)).toContain(pay);
  });

  it("the booking module's ticket file is copied into the Server's storage after the payment and shows on the booking for the people it covers", async () => {
    const { pay, approval_id } = await personalPayCard('p_priya', 'f');
    const spy = vi.spyOn(demoBooking, 'demoBookingFor').mockImplementationOnce(async (s) => ({
      kind: 'flight', title: 'IndiGo 6E 2134', vendor: 'ixigo', ref: 'DEMO-TICKET', passengers: [{ person_id: s.for_person_ids[0]!, seat: '14A', pnr: 'DEMO-TICKET' }],
      documents: [{ name: 'Boarding pass.pdf', mime: 'application/pdf', url: `${filesUrl}/pass.pdf`, visibility: 'covered' }],
    }));
    expect((await tap('p_priya', pay, { action_id: 'approve' })).body).toEqual({ result: 'done' });
    spy.mockRestore();
    await settleDocumentCopies();
    const [booking] = await rows(h.pool, 'select booking_id, passengers from bookings where approval_id = $1', [approval_id]);
    expect(booking.passengers).toEqual([{ person_id: 'p_priya', seat: '14A', pnr: 'DEMO-TICKET' }]);
    const docs = await rows(h.pool, 'select name, mime, visibility from booking_documents where booking_id = $1', [booking.booking_id]);
    expect(docs).toEqual([{ name: 'Boarding pass.pdf', mime: 'application/pdf', visibility: 'covered' }]);
    const mine = (await t.api(t.as('p_priya'), 'GET', '/app/v1/trips/t_goa/bookings')).body.items.find((b: any) => b.booking_id === booking.booking_id);
    const theirs = (await t.api(t.as('p_arjun'), 'GET', '/app/v1/trips/t_goa/bookings')).body.items.find((b: any) => b.booking_id === booking.booking_id);
    expect([mine.documents.length, theirs.documents, theirs.passengers]).toEqual([1, undefined, undefined]);
  });

  it("the demo module's ticket PDF is rendered after the payment, kept in storage, and reaches the covered person with a signed link; others get none", async () => {
    const { pay, approval_id } = await personalPayCard('p_meher', 'k');
    const rendered: string[] = [];
    setPdfRenderer(async (html) => {
      rendered.push(html);
      return { bytes: Buffer.from('%PDF-1.7 e-ticket'), pages: 1 };
    });
    try {
      const liveMark = h.live.events.length;
      expect((await tap('p_meher', pay, { action_id: 'approve' })).body).toEqual({ result: 'done' });
      await settleDemoTickets();
      const [booking] = await rows(h.pool, 'select booking_id, passengers from bookings where approval_id = $1', [approval_id]);
      expect(rendered.length).toBe(1);
      for (const want of ['BLR', 'GOX', 'Meher', booking.passengers[0].pnr, booking.passengers[0].seat, 'CONFIRMED · DEMO']) expect(rendered[0]).toContain(want);
      const docs = await rows(h.pool, 'select document_id, name, mime, size_bytes, pages, visibility, path from booking_documents where booking_id = $1', [booking.booking_id]);
      expect(docs).toEqual([{ document_id: expect.stringMatching(/^doc_/), name: 'E-ticket BLR-GOX.pdf', mime: 'application/pdf', size_bytes: 17, pages: 1, visibility: 'covered', path: `bookings/t_goa/${booking.booking_id}/${docs[0].document_id}.pdf` }]);
      expect(h.storage.files.get(docs[0].path)).toEqual({ bytes: Buffer.from('%PDF-1.7 e-ticket'), mime: 'application/pdf' });
      // Phones hear it landed: a new change number for the booking, and the covered person's home.
      const live = h.live.events.slice(liveMark).map((e) => e.event as any);
      const landed = live.filter((e) => e.kind === 'trip' && e.kinds.length === 1 && e.kinds[0] === 'booking');
      const [trip] = await rows(h.pool, `select seq from trips where trip_id = 't_goa'`);
      expect(landed.map((e) => e.seq)).toEqual([Number(trip.seq)]);
      expect(live.filter((e) => e.kind === 'home' && e.person_id === 'p_meher').length).toBeGreaterThanOrEqual(2);

      // Meher gets the document with a link valid an hour, in the list, the booking and the trip; Rahul gets no documents.
      const mine = (await t.api(t.as('p_meher'), 'GET', '/app/v1/trips/t_goa/bookings')).body.items.find((b: any) => b.booking_id === booking.booking_id);
      expect(mine.documents).toEqual([{ document_id: docs[0].document_id, name: 'E-ticket BLR-GOX.pdf', mime: 'application/pdf', size_bytes: 17, pages: 1, visibility: 'covered', url: expect.stringContaining('/_dev/storage/') }]);
      const fetched = await h.app.inject({ method: 'GET', url: new URL(mine.documents[0].url).pathname });
      expect([fetched.statusCode, fetched.body]).toEqual([200, '%PDF-1.7 e-ticket']);
      h.storage.now = () => Date.now() + 59 * 60_000; // still good just before the hour
      expect((await h.app.inject({ method: 'GET', url: new URL(mine.documents[0].url).pathname })).statusCode).toBe(200);
      h.storage.now = () => Date.now() + 61 * 60_000;
      expect((await h.app.inject({ method: 'GET', url: new URL(mine.documents[0].url).pathname })).statusCode).toBe(403);
      h.storage.now = () => Date.now();
      const one = (await t.api(t.as('p_meher'), 'GET', `/app/v1/trips/t_goa/bookings/${booking.booking_id}`)).body;
      const inTrip = (await t.api(t.as('p_meher'), 'GET', '/app/v1/trips/t_goa')).body.bookings.find((b: any) => b.booking_id === booking.booking_id);
      expect([one.documents[0].url, inTrip.documents[0].url]).toEqual([expect.stringContaining('/_dev/storage/'), expect.stringContaining('/_dev/storage/')]);
      expect(one.documents[0].url).not.toBe(mine.documents[0].url); // minted on every read
      const theirs = (await t.api(t.as('p_rahul'), 'GET', '/app/v1/trips/t_goa/bookings')).body.items.find((b: any) => b.booking_id === booking.booking_id);
      expect([theirs.documents, theirs.passengers, theirs.details.length > 0]).toEqual([undefined, undefined, true]);
      expect((await t.api(t.as('p_meher'), 'GET', `/app/v1/trips/t_goa/bookings/${booking.booking_id}/documents/${docs[0].document_id}`)).status).toBe(302);

      // A render that fails is logged and skipped: the booking stands without a file.
      const failing = await personalPayCard('p_priya', 'l');
      setPdfRenderer(async () => { throw new Error('chromium crashed'); });
      expect((await tap('p_priya', failing.pay, { action_id: 'approve' })).body).toEqual({ result: 'done' });
      await settleDemoTickets();
      const [standing] = await rows(h.pool, `select b.booking_id, b.status, count(d.*)::int as files from bookings b left join booking_documents d using (booking_id) where b.approval_id = $1 group by b.booking_id`, [failing.approval_id]);
      expect([standing.status, standing.files]).toEqual(['confirmed', 0]);
    } finally {
      setPdfRenderer(async () => null);
    }
  });

  it('is done once: a second tap, with the same press or a new one, is answered the same and writes nothing more', async () => {
    const { pay, approval_id } = await personalPayCard('p_arjun', 'b');
    const first = await tap('p_arjun', pay, { action_id: 'approve', press_id: 'press_b_1' });
    const again = await tap('p_arjun', pay, { action_id: 'approve', press_id: 'press_b_1' });
    const other = await tap('p_arjun', pay, { action_id: 'approve', press_id: 'press_b_2' });
    expect([first.body, again.body, other.body]).toEqual([{ result: 'done' }, { result: 'done' }, { result: 'done' }]);
    expect((await rows(h.pool, 'select 1 from bookings where approval_id = $1', [approval_id])).length).toBe(1);
    expect((await rows(h.pool, 'select 1 from expenses e join bookings b using (booking_id) where b.approval_id = $1', [approval_id])).length).toBe(1);
  });

  it('two taps at the same moment make one booking', async () => {
    const { pay, approval_id } = await personalPayCard('p_kabir', 'c');
    const both = await Promise.all([tap('p_kabir', pay, { action_id: 'approve', press_id: 'press_c_1' }), tap('p_kabir', pay, { action_id: 'approve', press_id: 'press_c_2' })]);
    expect(both.map((r) => r.body)).toEqual([{ result: 'done' }, { result: 'done' }]);
    expect((await rows(h.pool, 'select 1 from bookings where approval_id = $1', [approval_id])).length).toBe(1);
  });

  it('a paid card stays paid: Go may replace it as paid, never as expired, and its own add_booking for that approval is refused', async () => {
    const { pay, approval_id } = await personalPayCard('p_meher', 'd');
    await tap('p_meher', pay, { action_id: 'approve' });
    const expired = await call('replace_card', { card: payCard(pay, approval_id, 'p_meher', 600000, { state: 'expired', actions: null }) });
    expect(expired.error).toMatchObject({ code: 409 });
    expect((await cardOf(pay)).state).toBe('paid');
    const richer = await call('replace_card', { card: payCard(pay, approval_id, 'p_meher', 600000, { state: 'paid', actions: null, fallback_text: 'Paid ₹6,000' }) });
    expect(richer.error).toBeUndefined();
    expect(await cardOf(pay)).toMatchObject({ state: 'paid', fallback_text: 'Paid ₹6,000' });
    const twice = await call('add_booking', { kind: 'flight', title: 'IndiGo 6E 2134', vendor: 'ixigo', ref: 'PNR1', amount_minor: 600000, currency: 'INR', payer_person_id: 'p_meher', for_person_ids: ['p_meher'], approval_id });
    expect(twice.error).toMatchObject({ code: 409 });
  });

  it("is not booked twice through two cards: when the first approval ran out and a second card was paid, the first card's Approve is refused", async () => {
    const first = await personalPayCard('p_kabir', 'g');
    await h.pool.query(`update spend_approvals set expires_at = now() - interval '1 minute' where approval_id = $1`, [first.approval_id]); // it ran out unpaid; Go has not expired the card yet
    const again = await ok('request_spend_approval', { amount_minor: 600000, currency: 'INR', merchant: 'ixigo', purpose: 'Flight to Goa', personal: { person_id: 'p_kabir', card_id: first.flights, option_id: 'o1' } });
    expect(again.status).toBe('approved');
    await ok('post_message', { text: 'Ready to pay', card: payCard('c_pay_g2', again.approval_id, 'p_kabir', 600000) });
    expect((await tap('p_kabir', 'c_pay_g2', { action_id: 'approve' })).body).toEqual({ result: 'done' });
    const stale = await tap('p_kabir', first.pay, { action_id: 'approve' });
    expect([stale.status, stale.body]).toEqual([200, { result: 'refused', toast: 'This payment is no longer waiting.' }]);
    expect((await rows(h.pool, `select 1 from bookings where payer_person_id = 'p_kabir' and approval_id = any($1)`, [[first.approval_id, again.approval_id]])).length).toBe(1);
    expect((await cardOf(first.pay)).state).toBe('waiting');
  });

  it('an approval Go called off cannot be paid, a card without the button is not payable, and Go cannot add a second expense for a paid one', async () => {
    const off = await personalPayCard('p_meher', 'h');
    await ok('cancel_spend_approval', { approval_id: off.approval_id, reason: 'other' });
    expect((await tap('p_meher', off.pay, { action_id: 'approve' })).body).toMatchObject({ result: 'refused' });
    expect((await rows(h.pool, 'select 1 from bookings where approval_id = $1', [off.approval_id])).length).toBe(0);

    const bare = await personalPayCard('p_arjun', 'i');
    await ok('replace_card', { card: payCard(bare.pay, bare.approval_id, 'p_arjun', 600000, { actions: null }) }); // still waiting, no buttons
    expect((await tap('p_arjun', bare.pay, { action_id: 'approve' })).status).toBe(422);

    const paid = await personalPayCard('p_rahul', 'j');
    await tap('p_rahul', paid.pay, { action_id: 'approve' });
    const [b] = await rows(h.pool, 'select booking_id from bookings where approval_id = $1', [paid.approval_id]);
    const twice = await call('add_expense', { paid_by_person_id: 'p_rahul', amount_minor: 600000, currency: 'INR', note: 'Flight', category: 'getting_around', split_person_ids: ['p_rahul'], booking_id: b.booking_id, approval_id: paid.approval_id });
    expect(twice.error).toMatchObject({ code: 409 });
  });

  it('only the payer pays, and only while the card waits: anyone else, Not now, and an expired card go to Go as before', async () => {
    const { pay, approval_id } = await personalPayCard('p_rahul', 'e');
    h.go.answers.card_tap = () => ({ result: { result: 'done', toast: 'ok' } });
    let taps = cardTaps();
    expect((await tap('p_priya', pay, { action_id: 'approve' })).body).toMatchObject({ toast: 'ok' }); // not the payer: Go answers
    expect((await tap('p_rahul', pay, { action_id: 'decline' })).body).toMatchObject({ toast: 'ok' });
    expect(cardTaps()).toBe(taps + 2);
    await ok('replace_card', { card: payCard(pay, approval_id, 'p_rahul', 600000, { state: 'expired', actions: [{ action_id: 'approve', label: 'Start again', style: 'primary' }] }) });
    taps = cardTaps();
    expect((await tap('p_rahul', pay, { action_id: 'approve' })).body).toMatchObject({ toast: 'ok' }); // "Start again" is Go's
    expect(cardTaps()).toBe(taps + 1);
    expect((await rows(h.pool, 'select 1 from bookings where approval_id = $1', [approval_id])).length).toBe(0);
  });

  it("a group's stay: the booking covers everyone, the expense is split across the trip, and the vote's decided line becomes the booked line", async () => {
    const everyone = (await rows(h.pool, `select person_id from trip_people where trip_id = 't_goa' and left_at is null order by joined_at, person_id`)).map((r) => r.person_id as string);
    const did = (await ok('open_vote', { question: 'Where do we stay?', kind: 'choice', anonymous: false, options: [{ label: 'Villa Sol', price_minor: 5420000, currency: 'INR' }, { label: 'Casa Azul' }] })).decision_id as string;
    for (const p of everyone) expect((await t.api(t.as(p), 'PUT', `/app/v1/trips/t_goa/decisions/${did}/vote`, { option_index: 0 })).status).toBe(200);
    expect((await rows(h.pool, 'select status from decisions where decision_id = $1', [did]))[0].status).toBe('closed'); // everyone voted
    await ok('set_mandate', { decision_id: did, choice_index: 0, cap_minor: 5500000, currency: 'INR', refundable_only: false, payer_person_id: 'p_rahul' });
    await t.api(t.as('p_rahul'), 'POST', `/app/v1/trips/t_goa/decisions/${did}/mandate/confirm`);
    const approval = await ok('request_spend_approval', { amount_minor: 5420000, currency: 'INR', merchant: 'ixigo: Villa Sol', purpose: 'Villa Sol, 3 nights', decision_id: did });
    expect(approval.status).toBe('approved');
    await ok('post_message', { text: 'Ready to pay', card: payCard('c_pay_villa', approval.approval_id, 'p_rahul', 5420000, { merchant: 'ixigo: Villa Sol', purpose: 'Villa Sol, 3 nights' }) });
    await h.flush();
    const events = h.go.events.length;

    expect((await tap('p_rahul', 'c_pay_villa', { action_id: 'approve' })).body).toEqual({ result: 'done' });
    const [booking] = await rows(h.pool, 'select * from bookings where approval_id = $1', [approval.approval_id]);
    expect(booking).toMatchObject({ kind: 'stay', title: 'Villa Sol', vendor: 'ixigo: Villa Sol', payer_person_id: 'p_rahul', decision_id: did });
    expect([...booking.for_person_ids].sort()).toEqual([...everyone].sort());
    const [expense] = await rows(h.pool, 'select * from expenses where booking_id = $1', [booking.booking_id]);
    expect([expense.category, [...expense.split_person_ids].sort(), Number(expense.amount_minor)]).toEqual(['stay', [...everyone].sort(), 5420000]);
    const lines = await rows(h.pool, 'select kind, booking_id from record_lines where decision_id = $1', [did]);
    expect(lines).toEqual([{ kind: 'booked', booking_id: booking.booking_id }]);
    await h.flush();
    const paid = (h.go.events.slice(events) as any[]).find((e) => e.type === 'payment.completed');
    expect(check('Event', paid)).toMatchObject({ ok: true });
    expect(paid.data).toMatchObject({ decision_id: did, booking_id: booking.booking_id, by: { kind: 'person', person_id: 'p_rahul' } });
    expect(paid.data.personal).toBeUndefined();
    // A second approval for the same vote is refused: it is booked.
    expect(await ok('request_spend_approval', { amount_minor: 5420000, currency: 'INR', merchant: 'ixigo: Villa Sol', purpose: 'Villa Sol, 3 nights', decision_id: did })).toMatchObject({ status: 'denied', reason: 'already_booked' });
  });
});
