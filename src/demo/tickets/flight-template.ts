// The ixigo-style flight e-ticket, one leg per page, ported from mock-tickets/flights as it is. The only change is the
// font stack: "Noto Sans" and "DejaVu Sans" so ₹, ★, • and ✓ have glyphs on a Linux Chromium.
import { STATIC_QR_SVG } from "./static-qr.js";
import type { FlightEndpoint, TicketData, Traveller } from "./flight-types.js";

const esc = (v: unknown = ""): string =>
  String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const dash = (v?: string) => esc(v && v.trim() ? v : "-");

const endpoint = (e: FlightEndpoint, align: "left" | "right") => `
  <div class="ep ${align}">
    <div class="ep-head">${esc(e.code)} <b>${esc(e.time)}</b></div>
    <div class="ep-date">${esc(e.date)}</div>
    <div class="muted">${esc(e.city)}</div>
    <div class="muted">${esc(e.airport)}</div>
    ${e.terminal ? `<div class="term">${esc(e.terminal)}</div>` : ""}
  </div>`;

const travellerRow = (t: Traveller) => `
  <tr>
    <td class="qr">${STATIC_QR_SVG}</td>
    <td>${esc(t.name)}</td>
    <td>${esc(t.pnr)}</td>
    <td class="r">${dash(t.eTicketNo)}</td>
  </tr>`;

const addonRow = (t: Traveller) => `
  <tr>
    <td>${esc(t.name)}</td>
    <td>${dash(t.sector)}</td>
    <td><b>${dash(t.seat)}</b></td>
    <td class="r">${dash(t.meal)}</td>
  </tr>`;

export function renderTicketHtml(d: TicketData): string {
  const brand = d.brand.logoDataUri
    ? `<img class="brand-img" src="${esc(d.brand.logoDataUri)}" alt="">`
    : `<div class="brand" style="background:${esc(d.brand.color ?? "#fc4c02")}">${esc(d.brand.name)}</div>`;

  const airlineLogo = d.flight.airlineLogoDataUri
    ? `<img class="al-logo" src="${esc(d.flight.airlineLogoDataUri)}" alt="">`
    : `<div class="al-logo al-fallback">${esc(d.flight.airline.slice(0, 2).toUpperCase())}</div>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(d.bookingId)}</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Helvetica Neue", Arial, "Noto Sans", "DejaVu Sans", sans-serif; color: #222; font-size: 13px; }
  .page { width: 210mm; padding: 18mm 22mm; }
  .muted { color: #8a8a8a; }
  .r { text-align: right; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; }
  .bid-label { font-size: 14px; }
  .bid { font-size: 17px; font-weight: 700; margin-top: 4px; }
  .brand { color: #fff; font-weight: 800; font-size: 26px; padding: 4px 12px; border-radius: 3px; letter-spacing: -0.5px; }
  .brand-img { height: 44px; }
  .assured { position: relative; margin-top: 22px; background: #ffedbf; border-radius: 4px; padding: 22px 12px 12px; }
  .assured .pill { position: absolute; top: -8px; left: 22px; background: #2c5fcf; color: #fff; font-size: 10px; padding: 2px 8px 2px 18px; border-radius: 10px; }
  .assured .pill::before { content: "★"; position: absolute; left: 5px; color: #f5c518; }
  .assured .t1 { font-size: 13px; }
  .assured .t2 { font-size: 11px; font-weight: 600; margin-top: 4px; }
  .card { margin-top: 30px; border: 1px solid #ddd; border-radius: 3px; overflow: hidden; }
  .card-head { background: #f2f2f2; display: flex; gap: 18px; align-items: center; padding: 14px 18px; }
  .cal { width: 52px; border: 1px solid #555; border-radius: 4px; overflow: hidden; text-align: center; background: #fff; }
  .cal .m { background: #555; color: #fff; font-size: 12px; font-weight: 600; padding: 2px 0; }
  .cal .d { font-size: 12px; padding-top: 3px; }
  .cal .w { font-size: 7px; padding-bottom: 3px; color: #666; }
  .route { font-size: 17px; letter-spacing: 0.2px; }
  .route .st { color: #666; }
  .sub { color: #666; font-size: 14px; margin-top: 6px; }
  .airline { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px dashed #ccc; font-size: 16px; }
  .airline .muted { color: #8a8a8a; }
  .al-logo { width: 38px; height: 30px; object-fit: contain; }
  .al-fallback { background: #1b2a7a; color: #fff; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; border-radius: 2px; }
  .legs { display: flex; justify-content: space-between; padding: 20px 26px 22px; }
  .ep { font-size: 14px; line-height: 1.75; max-width: 38%; }
  .ep-head { white-space: nowrap; }
  .ep.right { text-align: right; }
  .ep-head { font-size: 30px; line-height: 1.2; margin-bottom: 8px; }
  .ep-head b { font-weight: 700; }
  .term { font-weight: 600; }
  .dur { flex: 1; display: flex; align-items: center; justify-content: center; height: 34px; padding: 0 30px; }
  .dur .line { flex: 0 0 40px; height: 1px; background: #222; }
  .dur .line.arrow { position: relative; flex-basis: 40px; }
  .dur .line.arrow::after { content: ""; position: absolute; right: 0; top: -3px; border: 3.5px solid transparent; border-left: 6px solid #222; border-right: 0; }
  .dur .box { white-space: nowrap; border: 1px solid #ccc; border-radius: 4px; padding: 4px 14px; font-size: 15px; }
  .bag { background: #f2f2f2; padding: 18px 18px 20px; font-size: 14px; }
  .bag b { display: block; margin-bottom: 8px; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; }
  .tbl { margin-top: 24px; border: 1px solid #ddd; border-radius: 3px; }
  .tbl th { text-align: left; font-size: 14px; padding: 18px 18px; border-bottom: 1px solid #ddd; }
  .tbl td { padding: 8px 18px; font-size: 14px; vertical-align: middle; }
  .tbl tr + tr td { border-top: 1px solid #eee; }
  .tbl th.r, .tbl td.r { text-align: right; }
  td.qr { width: 120px; padding: 6px 18px; }
  td.qr svg { width: 56px; height: 56px; display: block; }
  .addons { margin-top: 22px; border: 1px solid #ddd; border-radius: 3px; overflow: hidden; }
  .addons h3 { margin: 0; background: #f2f2f2; padding: 18px; font-size: 16px; font-weight: 600; border-bottom: 1px solid #ddd; }
  .addons th { text-align: left; font-size: 15px; padding: 16px 18px; border-bottom: 1px solid #ddd; }
  .addons td { padding: 12px 18px; font-size: 14px; }
  .addons .r { text-align: right; }
</style></head>
<body><div class="page">
  <div class="top">
    <div><div class="bid-label">Booking Id:</div><div class="bid">${esc(d.bookingId)}</div></div>
    ${brand}
  </div>

  ${d.assured ? `
  <div class="assured">
    <span class="pill">Assured</span>
    <div class="t1">${esc(d.assured.title)}</div>
    <div class="t2">${esc(d.assured.subtitle)}</div>
  </div>` : ""}

  <div class="card">
    <div class="card-head">
      <div class="cal"><div class="m">${esc(d.journey.month)}</div><div class="d">${esc(d.journey.day)}</div><div class="w">${esc(d.journey.weekday)}</div></div>
      <div>
        <div class="route">${esc(d.journey.from)} TO ${esc(d.journey.to)} <span class="st">- ${esc(d.journey.status)}</span></div>
        <div class="sub">${esc(d.journey.stops)} • ${esc(d.journey.duration)}</div>
      </div>
    </div>
    <div class="airline">
      ${airlineLogo}
      <span>${esc(d.flight.airline)} <span class="muted">${esc(d.flight.flightNo)} - ${esc(d.flight.cabin)}${d.flight.fareType ? ` • ${esc(d.flight.fareType)}` : ""}</span></span>
    </div>
    <div class="legs">
      ${endpoint(d.departure, "left")}
      <div class="dur"><span class="line"></span><span class="box">${esc(d.journey.duration)}</span><span class="line arrow"></span></div>
      ${endpoint(d.arrival, "right")}
    </div>
    <div class="bag"><b>Baggage Allowance</b>Check-in : ${esc(d.baggage.checkIn)} , Cabin : ${esc(d.baggage.cabin)}</div>
  </div>

  <table class="tbl">
    <thead><tr><th>Barcode</th><th>Travellers</th><th>PNR</th><th class="r">E-Ticket no.</th></tr></thead>
    <tbody>${d.travellers.map(travellerRow).join("")}</tbody>
  </table>

  <div class="addons">
    <h3>Other Add-ons</h3>
    <table>
      <thead><tr><th>Travellers</th><th>Sector</th><th>Seat</th><th class="r">Meal</th></tr></thead>
      <tbody>${d.travellers.map(addonRow).join("")}</tbody>
    </table>
  </div>

</div></body></html>`;
}
