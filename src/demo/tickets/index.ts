// The ticket files of a demo booking: a flight e-ticket per leg, or one hotel voucher, each with the name the app shows.
import { renderTicketHtml } from './flight-template.js';
import type { TicketData } from './flight-types.js';
import { renderHotelHtml } from './stay-template.js';
import type { HotelBookingData } from './stay-types.js';

export type { TicketData } from './flight-types.js';
export type { HotelBookingData } from './stay-types.js';
export { renderTicketHtml, renderHotelHtml };

/** One file to render: what the generator needs, and the document's name ("E-ticket DEL-GOI.pdf", ≤ 200). */
export type DemoTicket = { kind: 'flight'; name: string; data: TicketData } | { kind: 'stay'; name: string; data: HotelBookingData };

export const ticketHtml = (t: DemoTicket): string => (t.kind === 'flight' ? renderTicketHtml(t.data) : renderHotelHtml(t.data));
