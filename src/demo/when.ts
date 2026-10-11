// Dates and times as a ticket prints them ("07:50", "Fri, 11 Sep '26", "Thu, 08 Aug"), in the place's own time. A time
// Go sent with an offset (`2026-11-06T19:40:00+05:30`) is shown at that offset, the airport's local time; one sent in
// UTC is shown in the place's time zone, India when nobody said. Month and day names are our own, never the locale's
// ("Sep", not "Sept").
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const INDIA = 'Asia/Kolkata';

/** A wall clock reading: what a clock in that place shows. */
export interface Wall { y: number; mo: number; d: number; h: number; mi: number }

const formats = new Map<string, Intl.DateTimeFormat>();
const formatIn = (tz: string): Intl.DateTimeFormat => {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    formats.set(tz, f);
  }
  return f;
};

/** A time zone name we can use, else India. */
export const zoneOr = (tz: unknown): string => {
  if (typeof tz !== 'string' || !tz) return INDIA;
  try {
    formatIn(tz);
    return tz;
  } catch {
    return INDIA;
  }
};

/** The wall clock in `tz` at this instant. */
export function wallAt(ms: number, tz: string): Wall {
  const parts = Object.fromEntries(formatIn(tz).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day), h: Number(parts.hour) % 24, mi: Number(parts.minute) };
}

/** The wall clock of an ISO time: at its own offset when it has one, else in `tz`. Throws on a time that is not one. */
export function wallOf(iso: string, tz: string): Wall {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError(`not a time: ${iso}`);
  const offset = /([+-])(\d{2}):?(\d{2})$/.exec(iso);
  if (!offset) return wallAt(ms, tz);
  const shifted = new Date(ms + (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) * 60_000);
  return { y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth() + 1, d: shifted.getUTCDate(), h: shifted.getUTCHours(), mi: shifted.getUTCMinutes() };
}

const two = (n: number) => String(n).padStart(2, '0');
const weekday = (w: Pick<Wall, 'y' | 'mo' | 'd'>) => WEEKDAYS[new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay()]!;
const month = (w: Pick<Wall, 'mo'>) => MONTHS[w.mo - 1]!;

/** "07:50" */
export const clock = (w: Wall) => `${two(w.h)}:${two(w.mi)}`;
/** "Fri, 11 Sep '26" */
export const flightDate = (w: Wall) => `${weekday(w)}, ${two(w.d)} ${month(w)} '${String(w.y).slice(-2)}`;
/** The e-ticket's calendar leaf: "SEP", "11", "Fri". */
export const leaf = (w: Wall) => ({ month: month(w).toUpperCase(), day: String(w.d), weekday: weekday(w) });
/** "18 Nov 2026 11:59 PM" */
export const longTime = (w: Wall) => `${two(w.d)} ${month(w)} ${w.y} ${two(w.h % 12 || 12)}:${two(w.mi)} ${w.h < 12 ? 'AM' : 'PM'}`;
/** "11 Oct 2026" */
export const longDate = (w: Pick<Wall, 'y' | 'mo' | 'd'>) => `${two(w.d)} ${month(w)} ${w.y}`;

/** A calendar date `YYYY-MM-DD` as its parts; undefined for anything else. */
export function dateParts(date: unknown): Pick<Wall, 'y' | 'mo' | 'd'> | undefined {
  const m = typeof date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const back = new Date(Date.UTC(y, mo - 1, d));
  return back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? { y, mo, d } : undefined;
}

/** "Thu, 08 Aug" for a calendar date. */
export const stayDay = (p: Pick<Wall, 'y' | 'mo' | 'd'>) => `${weekday(p)}, ${two(p.d)} ${month(p)}`;

/** `YYYY-MM-DD` of today in `tz`, moved by `days`. */
export function dayIn(now: Date, tz: string, days = 0): string {
  const w = wallAt(now.getTime(), tz);
  return new Date(Date.UTC(w.y, w.mo - 1, w.d + days)).toISOString().slice(0, 10);
}

/** Whole days from one calendar date to another. */
export const daysBetween = (a: Pick<Wall, 'y' | 'mo' | 'd'>, b: Pick<Wall, 'y' | 'mo' | 'd'>) => Math.round((Date.UTC(b.y, b.mo - 1, b.d) - Date.UTC(a.y, a.mo - 1, a.d)) / 86_400_000);

/** The instant a clock in `tz` shows `h:mi` on that date, as an ISO time in UTC (check-in at 14:00 in Goa). */
export function zonedIso(p: Pick<Wall, 'y' | 'mo' | 'd'>, h: number, mi: number, tz: string): string {
  const want = Date.UTC(p.y, p.mo - 1, p.d, h, mi);
  const offsetAt = (ms: number) => {
    const w = wallAt(ms, tz);
    return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - ms;
  };
  let ms = want - offsetAt(want);
  ms = want - offsetAt(ms); // once more, for a day the clocks change
  return new Date(ms).toISOString();
}

/** "2h 15m", "45m"; "-" when the times make no sense. */
export function duration(departIso: string, arriveIso: string): string {
  const minutes = Math.round((Date.parse(arriveIso) - Date.parse(departIso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return '-';
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
