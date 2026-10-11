// The made-up parts of a demo ticket (docs/DEMO-BOOKING-MODULE.md): the PNR, e-ticket numbers, seats, ixigo-style
// booking ids, the terminal and the fare type. Nothing here is real. The numbers come from a random generator seeded with
// the payment's approval id, so the same payment always gets the same ticket (a re-run, a test, a second render).
import { createHash } from 'node:crypto';

/** Letters and digits a person cannot misread: no I, O, 0 or 1. */
const PNR_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SEAT_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
const FARE_TYPES = ['SAVER', 'SAVER', 'FLEX', 'VALUE', 'CORPORATE'];

export interface Fakes {
  /** A whole number from `min` to `max`, both included. */
  int(min: number, max: number): number;
  /** `n` random digits, the first one never 0. */
  digits(n: number): string;
  /** The booking's PNR: 6 characters, shared by every traveller on it. */
  pnr(): string;
  /** One 13-digit e-ticket number per traveller, consecutive, as an airline issues them in one booking. */
  eTickets(count: number): string[];
  /** Seats side by side for `count` travellers on one leg: "14A", "14B", ... running into the next row. */
  seats(count: number): string[];
  /** ixigo's flight booking id: `IF` and 14 digits. */
  flightBookingId(): string;
  /** ixigo's hotel booking id: `IH` and 16 digits. */
  stayBookingId(): string;
  /** The hotel's own booking number: 10 digits. */
  hotelBookingNumber(): string;
  terminal(): string;
  fareType(): string;
  /** The booking's reference, which says what it is: `DEMO-4K7Q2M` (hex, as `demoRef()`). */
  ref(): string;
}

/** The generator for one payment. xorshift128 seeded from sha256(seed): fast, and the same seed gives the same draws. */
export function fakesFor(seed: string): Fakes {
  const h = createHash('sha256').update(seed).digest();
  let [x, y, z, w] = [h.readUInt32LE(0), h.readUInt32LE(4), h.readUInt32LE(8), h.readUInt32LE(12)];
  if ((x | y | z | w) === 0) x = 1;
  const next = (): number => {
    const t = (x ^ (x << 11)) >>> 0;
    [x, y, z] = [y, z, w];
    w = (w ^ (w >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return w / 0x1_0000_0000;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(xs: T[]): T => xs[int(0, xs.length - 1)]!;
  const digits = (n: number) => String(int(1, 9)) + Array.from({ length: n - 1 }, () => String(int(0, 9))).join('');
  return {
    int,
    digits,
    pnr: () => Array.from({ length: 6 }, () => pick([...PNR_CHARS])).join(''),
    eTickets: (count) => {
      const first = BigInt(digits(13));
      return Array.from({ length: count }, (_, i) => String(first + BigInt(i)).slice(0, 13).padStart(13, '0'));
    },
    seats: (count) => {
      const row = int(3, 30);
      const start = int(0, SEAT_LETTERS.length - 1);
      return Array.from({ length: count }, (_, i) => `${row + Math.floor((start + i) / SEAT_LETTERS.length)}${SEAT_LETTERS[(start + i) % SEAT_LETTERS.length]}`);
    },
    flightBookingId: () => `IF${digits(14)}`,
    stayBookingId: () => `IH${digits(16)}`,
    hotelBookingNumber: () => digits(10),
    terminal: () => `Terminal ${int(1, 3)}`,
    fareType: () => pick(FARE_TYPES),
    ref: () => `DEMO-${Array.from({ length: 6 }, () => int(0, 15).toString(16)).join('').toUpperCase()}`,
  };
}
