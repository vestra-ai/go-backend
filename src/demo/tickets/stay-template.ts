// The ixigo-style hotel voucher, ported from mock-tickets/stays as it is. The only change is the font stack: "Noto Sans"
// and "DejaVu Sans" so ₹, ★, • and ✓ have glyphs on a Linux Chromium.
import type { HotelBookingData } from "./stay-types.js";

const esc = (v: unknown = ""): string =>
  String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const row = (label: string, body: string) => `
  <div class="row">
    <div class="label">${label}</div>
    <div class="body">${body}</div>
  </div>`;

export function renderHotelHtml(d: HotelBookingData): string {
  const cur = esc(d.price.currency ?? "₹");
  const money = (amount: string) => `${cur}&#8202;${esc(amount)}`;

  const brand = d.brand.logoDataUri
    ? `<img class="brand-img" src="${esc(d.brand.logoDataUri)}" alt="">`
    : `<div class="brand" style="background:${esc(d.brand.color ?? "#e8682d")}">${esc(d.brand.name)}</div>`;

  const travelDates = `
    <div class="cols">
      <div><div class="cap">CHECK-IN</div><div class="val">${esc(d.checkIn)}</div></div>
      <div><div class="cap">CHECK-OUT</div><div class="val">${esc(d.checkOut)}</div></div>
    </div>`;

  const guests = `
    <div class="cols">
      <div>
        <div class="cap">PRIMARY GUEST</div>
        <div class="val">${esc(d.primaryGuest.name)}</div>
        ${d.primaryGuest.email ? `<div class="soft break">${esc(d.primaryGuest.email)}</div>` : ""}
      </div>
      <div>
        <div class="cap">TRAVELLERS</div>
        <div class="val">${esc(d.travellers)}</div>
        ${d.guestId ? `<div class="soft">${esc(d.guestId.label)} : ${esc(d.guestId.value)}</div>` : ""}
      </div>
    </div>`;

  const rooms = `
    <div class="val">${esc(d.rooms.summary)}</div>
    ${d.rooms.inclusions ? `<div class="soft">${esc(d.rooms.inclusions)}</div>` : ""}`;

  const p = d.price;
  const extra = p.additionalCharges?.length
    ? `<div>Mandatory additional charges to be paid directly at the hotel</div>
       ${p.additionalCharges.map((c) => `<div>${esc(c.label)}: ${money(c.amount)}</div>`).join("")}`
    : "";
  const price = `
    <div><span class="val">${money(p.total)}</span> <span class="soft">${esc(p.note ?? "(including taxes & charges)")}</span></div>
    ${p.paymentMode ? `<div>Payment Mode : ${esc(p.paymentMode)}</div>` : ""}
    ${p.payByDeadline ? `<div>Pay the full amount of ${money(p.total)} before ${esc(p.payByDeadline)} to avoid auto cancellation</div>` : ""}
    ${extra}`;

  const cancellation = `
    ${d.cancellation.rules.map((r) => `<div class="rule"><b>${esc(r.title)}</b><div>${esc(r.description)}</div></div>`).join("")}
    ${d.cancellation.footnote ? `<div>${esc(d.cancellation.footnote)}</div>` : ""}`;

  const support = d.support
    ? `<div class="box support">
        <div class="s-title">${esc(d.support.title)}</div>
        <div class="s-links">
          <span>${esc(d.support.phone ?? "")}</span>
          <span>${esc(d.support.email ?? "")}</span>
        </div>
      </div>`
    : "";

  const terms = d.terms
    ? `<h2>${esc(d.terms.title)}</h2>
       <ul class="terms">${d.terms.items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`
    : "";

  const c = d.company;
  const company = c
    ? `<div class="box company">
        <div class="c-top">
          <div><b>${esc(c.name)}</b><div>${esc(c.address)}</div></div>
          ${c.serviceDescription ? `<div><b>Service Description</b><div>${esc(c.serviceDescription)}</div></div>` : ""}
        </div>
        <div class="c-ids">
          ${c.cin ? `<span><b>CIN</b> ${esc(c.cin)}</span>` : ""}
          ${c.pan ? `<span><b>PAN</b> ${esc(c.pan)}</span>` : ""}
          ${c.hsnSac ? `<span><b>HSN/SAC</b> ${esc(c.hsnSac)}</span>` : ""}
        </div>
      </div>`
    : "";

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(d.bookingId)}</title>
<style>
  @page { size: A4; margin: 14mm 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Helvetica Neue", Arial, "Noto Sans", "DejaVu Sans", sans-serif; color: #1f2937; font-size: 14px; }
  .page { width: 210mm; padding: 0 20mm; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; }
  .brand { color: #fff; font-weight: 800; font-size: 26px; padding: 6px 12px; border-radius: 3px; letter-spacing: -0.5px; }
  .brand-img { height: 46px; }
  .ids { text-align: right; color: #4b5563; font-size: 13px; line-height: 1.45; }
  .ids .main { color: #111827; font-size: 15px; }
  .ids .main b { font-weight: 700; }
  .card { margin-top: 20px; border: 1px solid #e5eaf2; border-radius: 10px; }
  .hero { background: #e9effa; border-radius: 10px 10px 0 0; padding: 16px 16px 14px; display: flex; justify-content: space-between; }
  .hero h1 { margin: 0; font-size: 21px; line-height: 1.25; max-width: 330px; }
  .hero .addr { color: #4b5563; font-size: 13px; margin-top: 4px; max-width: 330px; line-height: 1.4; }
  .hero .side { display: flex; flex-direction: column; justify-content: space-between; align-items: flex-end; }
  .hero .map { color: #e8682d; font-weight: 600; font-size: 15px; text-decoration: none; margin-top: 4px; }
  .status { margin-top: 40px; border: 1px solid #3b9a4a; color: #3b9a4a; border-radius: 14px; padding: 2px 16px 2px 12px; font-size: 14px; white-space: nowrap; }
  .status::before { content: "✓ "; }
  .row { display: flex; padding: 22px 16px; border-top: 1px solid #e5eaf2; break-inside: avoid; }
  .row:first-of-type { border-top: 0; }
  .label { flex: 0 0 140px; font-weight: 600; font-size: 15px; padding-right: 20px; }
  .body { flex: 1; line-height: 1.55; }
  .cols { display: flex; }
  .cols > div { flex: 1; padding-right: 16px; }
  .cap { color: #6b7280; font-size: 12px; letter-spacing: 0.3px; }
  .val { font-size: 15px; color: #111827; }
  .soft { color: #6b7280; font-size: 13px; }
  .break { word-break: break-all; }
  .rule b { font-weight: 600; }
  .row.cancel { break-inside: auto; }
  .box { border: 1px solid #e5eaf2; border-radius: 10px; margin-top: 20px; break-inside: avoid; }
  .support { padding: 14px 16px; }
  .s-title { font-weight: 600; font-size: 14px; }
  .s-links { display: flex; justify-content: space-between; color: #2563eb; margin-top: 6px; }
  h2 { font-size: 16px; font-weight: 600; margin: 22px 0 8px; break-after: avoid; }
  .terms li { break-inside: avoid; }
  .terms { margin: 0; padding-left: 18px; color: #4b5563; font-size: 13.5px; line-height: 1.55; }
  .terms li { margin-bottom: 9px; padding-left: 4px; }
  .terms li::marker { color: #6b7280; }
  .company { margin-top: 40px; font-size: 11.5px; color: #4b5563; }
  .company b { color: #111827; font-weight: 600; }
  .c-top { display: flex; justify-content: space-between; gap: 16px; padding: 14px 14px 10px; }
  .c-ids { display: flex; justify-content: space-between; border-top: 1px solid #e5eaf2; padding: 10px 14px; }
  .c-ids b { margin-right: 4px; }
</style></head>
<body><div class="page">
  <div class="top">
    ${brand}
    <div class="ids">
      <div class="main">${esc(d.brand.name)} Booking ID :&nbsp; <b>${esc(d.bookingId)}</b></div>
      ${d.hotelBookingNumber ? `<div>Hotel Booking Number : ${esc(d.hotelBookingNumber)}</div>` : ""}
      <div>Booked on ${esc(d.bookedOn)}</div>
    </div>
  </div>

  <div class="card">
    <div class="hero">
      <div>
        <h1>${esc(d.hotel.name)}</h1>
        <div class="addr">${esc(d.hotel.address)}</div>
      </div>
      <div class="side">
        ${d.hotel.mapUrl ? `<a class="map" href="${esc(d.hotel.mapUrl)}">View on Map</a>` : "<span></span>"}
        <span class="status">${esc(d.status ?? "Booking Confirmed")}</span>
      </div>
    </div>
    ${row("Travel<br>Dates", travelDates)}
    ${row("Guests", guests)}
    ${row("Rooms", rooms)}
    ${row("Price", price)}
    ${row("Cancellation<br>Policy", cancellation).replace('class="row"', 'class="row cancel"')}
  </div>

  ${support}
  ${terms}
  ${company}

</div></body></html>`;
}
