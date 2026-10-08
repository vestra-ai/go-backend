// A small in-memory rate limiter for the two public-facing reads the contract asks us to bound: the invite preview
// (30 a minute per IP, so codes cannot be guessed) and the city search (5 a second per person). Per instance, not
// shared: with several instances the real limit is that many times higher, which is fine for what it guards. Keys
// are forgotten when their window has passed, so the map cannot grow without bound.
import { rateLimited } from '../domain/errors.js';

export class RateLimiter {
  private readonly hits = new Map<string, { count: number; windowStart: number }>();
  private lastSweep = 0;

  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  /** Counts one request for `key`; throws 429 `rate_limited` (with the seconds to wait) above the limit. */
  take(key: string): void {
    const t = this.now();
    if (t - this.lastSweep > this.windowMs) this.sweep(t);
    const cur = this.hits.get(key);
    if (!cur || t - cur.windowStart >= this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: t });
      return;
    }
    cur.count++;
    if (cur.count > this.limit) throw rateLimited('too many requests: slow down', Math.max(1, Math.ceil((cur.windowStart + this.windowMs - t) / 1000)));
  }

  private sweep(t: number): void {
    this.lastSweep = t;
    for (const [key, v] of this.hits) if (t - v.windowStart >= this.windowMs) this.hits.delete(key);
  }
}
