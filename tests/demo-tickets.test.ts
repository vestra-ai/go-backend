// The demo's ticket files: the ixigo-style templates (src/demo/tickets/), the PDF page count, Storage's `put` on
// Supabase, and, when PUPPETEER_EXECUTABLE_PATH names a Chromium, a real render of both PDFs.
import { afterAll, describe, expect, it } from 'vitest';
import { demoBookingFor, type DemoBookingFields, type DemoBookingSource } from '../src/domain/demo-booking.js';
import { closePdfBrowser, pdfPages, renderPdf } from '../src/demo/pdf.js';
import { renderHotelHtml, renderTicketHtml, ticketHtml, type HotelBookingData, type TicketData } from '../src/demo/tickets/index.js';
import { SupabaseStorage } from '../src/storage/supabase-storage.js';

const NOW = new Date('2026-10-12T06:00:00Z');
const base = { trip_id: 't_goa', merchant: 'ixigo', amount_minor: 2845000, currency: 'INR', payer_person_id: 'p_rahul' };
const flightSource: DemoBookingSource = {
  ...base, approval_id: 'ap_pdf_flight', purpose: 'DEL → GOI', for_person_ids: ['p_rahul', 'p_priya'], option_kind: 'flight',
  option: { journey: { mode: 'flight', origin: { name: 'New Delhi', code: 'DEL' }, destination: { name: 'Goa <Mopa>', code: 'GOX' }, depart_at: '2026-11-06T07:50:00+05:30', arrive_at: '2026-11-06T10:20:00+05:30', carrier_name: 'IndiGo', carrier_code: '6E', number: '2134' } },
  people: [{ person_id: 'p_rahul', name: 'Rahul <b>Manglani</b>' }, { person_id: 'p_priya', name: 'Priya Sharma' }],
};
const staySource: DemoBookingSource = {
  ...base, approval_id: 'ap_pdf_stay', merchant: 'ixigo: Villa Sol', purpose: 'Villa Sol, 3 nights', for_person_ids: ['p_rahul', 'p_priya', 'p_arjun', 'p_meher'], option_kind: 'stay',
  option: { title: 'Villa Sol & "Spa" <Anjuna>', place: { name: 'Villa Sol', address: 'Anjuna Beach Road, Goa', lat: 15.58, lng: 73.74 }, refundable_until: '2026-11-18T18:29:00Z' },
  people: [{ person_id: 'p_rahul', name: 'Rahul Manglani' }], trip: { title: 'Goa', dates: { start: '2026-11-20', end: '2026-11-23' } },
};
const fields = (s: DemoBookingSource) => demoBookingFor(s, NOW) as DemoBookingFields;

describe('the templates', () => {
  it('the e-ticket shows the real route, times, carrier and travellers, says DEMO, and escapes what it prints', () => {
    const t = fields(flightSource).tickets![0]!;
    const html = ticketHtml(t);
    expect(html).toBe(renderTicketHtml(t.data as TicketData));
    for (const want of ['DEL <b>07:50</b>', 'GOX <b>10:20</b>', "Fri, 06 Nov '26", 'IndiGo', '6E-2134', 'NEW DELHI TO GOA &lt;MOPA&gt;', 'CONFIRMED · DEMO', 'Priya Sharma', 'DEL-GOX', '"Noto Sans", "DejaVu Sans"', (t.data as TicketData).bookingId]) expect(html).toContain(want);
    expect(html).toContain('Rahul &lt;b&gt;Manglani&lt;/b&gt;');
    expect(html).not.toContain('<b>Manglani</b>');
  });

  it('the hotel voucher shows the stay, its dates, the guests and the price, says Demo, and escapes what it prints', () => {
    const t = fields(staySource).tickets![0]!;
    const html = ticketHtml(t);
    expect(html).toBe(renderHotelHtml(t.data as HotelBookingData));
    for (const want of ['Villa Sol &amp; &quot;Spa&quot; &lt;Anjuna&gt;', 'Anjuna Beach Road, Goa', 'Fri, 20 Nov', 'Mon, 23 Nov', 'RAHUL MANGLANI', '4 Adults', '₹&#8202;28450.00', 'Booking Confirmed · Demo', 'Free cancellation till 18 Nov 2026 11:59 PM', 'https://maps.google.com/?q=15.58,73.74', '"Noto Sans", "DejaVu Sans"']) expect(html).toContain(want);
    expect(html).not.toContain('<Anjuna>');
    expect(t.name).toBe('Hotel voucher Villa Sol & "Spa" <Anjuna>.pdf');
  });
});

describe('PDF pages', () => {
  it('counts the page objects, never the page tree', () => {
    const pdf = (n: number) => Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Pages /Count ${n} >> endobj\n${Array.from({ length: n }, (_, i) => `${i + 2} 0 obj << /Type /Page /Parent 1 0 R >> endobj`).join('\n')}\n%%EOF`, 'latin1');
    expect([pdfPages(pdf(1)), pdfPages(pdf(3)), pdfPages(Buffer.from('%PDF-1.4 /Type/Page /Type/Pages'))]).toEqual([1, 3, 1]);
  });
});

describe('SupabaseStorage.put', () => {
  it('uploads the bytes to the object path with their type, replacing what is there, and putFromUrl goes through it', async () => {
    const calls: Array<{ url: string; method?: string; headers: Record<string, string>; body: Buffer }> = [];
    const fetchStub = (async (url: string, init?: RequestInit) => {
      if (url === 'https://files.example/t.pdf') return new Response('%PDF-1.4 copied', { headers: { 'content-type': 'application/pdf' } });
      calls.push({ url, method: init?.method, headers: init?.headers as Record<string, string>, body: Buffer.from(await (init?.body as Blob).arrayBuffer()) });
      return new Response('{"Key":"x"}', { status: 200 });
    }) as typeof fetch;
    const storage = new SupabaseStorage({ supabaseUrl: 'https://ref.supabase.co/', secretKey: 'sk_test', bucket: 'go files', fetch: fetchStub });
    await storage.put('bookings/t_goa/b_1/doc 1.pdf', Buffer.from('%PDF-1.4 demo'), 'application/pdf');
    expect(calls[0]).toMatchObject({ url: 'https://ref.supabase.co/storage/v1/object/go%20files/bookings/t_goa/b_1/doc%201.pdf', method: 'POST', headers: { authorization: 'Bearer sk_test', apikey: 'sk_test', 'content-type': 'application/pdf', 'x-upsert': 'true' } });
    expect(calls[0]!.body.toString()).toBe('%PDF-1.4 demo');
    expect(await storage.putFromUrl('https://files.example/t.pdf', 'bookings/t_goa/b_1/doc_2.pdf')).toEqual({ mime: 'application/pdf', size_bytes: 15 });
    expect([calls[1]!.url.endsWith('/object/go%20files/bookings/t_goa/b_1/doc_2.pdf'), calls[1]!.body.toString()]).toEqual([true, '%PDF-1.4 copied']);
  });

  it('throws when Supabase refuses', async () => {
    const storage = new SupabaseStorage({ supabaseUrl: 'https://ref.supabase.co', secretKey: 'sk', bucket: 'b', fetch: (async () => new Response('no', { status: 403 })) as typeof fetch });
    await expect(storage.put('a.pdf', Buffer.from('x'), 'application/pdf')).rejects.toThrow(/403/);
  });
});

describe('a real Chromium (PUPPETEER_EXECUTABLE_PATH)', () => {
  afterAll(() => closePdfBrowser());
  it.skipIf(!process.env.PUPPETEER_EXECUTABLE_PATH)('renders the e-ticket and the voucher to A4 PDFs', async () => {
    for (const s of [flightSource, staySource]) {
      const pdf = await renderPdf(ticketHtml(fields(s).tickets![0]!));
      expect(pdf).not.toBeNull();
      expect(pdf!.bytes.subarray(0, 4).toString()).toBe('%PDF');
      expect(pdf!.pages).toBeGreaterThanOrEqual(1);
      expect(pdf!.pages).toBeLessThanOrEqual(3);
    }
  }, 60_000);
});
