// Rules for values that reach the database from a request, shared by the app's routes and Go's requests. Each refuses with 422
// `invalid` what Postgres or a Go frame could not take, instead of failing later with a 500.
import { invalid } from './errors.js';

/** A calendar date as `YYYY-MM-DD` from year 1 (the contract's `date` format admits year 0000; Postgres has no year 0). */
export function assertDate(value: unknown, field: string): void {
  const m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null; // text only: an array or a number is not a date
  const [year, month, day] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const inMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  if (!m || year < 1 || day < 1 || day > inMonth) throw invalid(`${field} must be a date from year 1 (YYYY-MM-DD)`);
}

/** The itinerary, as JSON, may take a quarter of the 1 MiB frame Go reads a trip in (build-direction ruling: the rest of a trip must still fit). */
export const MAX_ITINERARY_BYTES = 262_144;

export function assertItinerarySize(itinerary: unknown): void {
  if (Buffer.byteLength(JSON.stringify(itinerary)) > MAX_ITINERARY_BYTES) throw invalid(`itinerary is too large: at most ${MAX_ITINERARY_BYTES} bytes as JSON`);
}
