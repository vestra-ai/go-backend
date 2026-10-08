// A small in-memory rate limiter for the bounds the app contract's Appendix A asks us to keep: the invite preview (30 a
// minute per IP, so codes cannot be guessed), the city search (5 a second per person), and the per-person minute limits
// on reactions, card taps, votes, vault links and uploads. Per instance, not shared: with several instances the real
// limit is that many times higher, which is fine for what it guards. Keys are forgotten when their window has passed,
// so the map cannot grow without bound. The limit may be a function, so a test can loosen it through `ctx.limits`.
import { rateLimited } from '../domain/errors.js';

interface Window {
  count: number;
  windowStart: number;
  /** The tokens already counted in this window (`takeOnce`): a repeat of one is free. */
  seen?: Set<string>;
}

export class RateLimiter {
  private readonly hits = new Map<string, Window>();
  private lastSweep = 0;
  private readonly limitOf: () => number;
  private readonly now: () => number;
  private readonly what: string | undefined;

  constructor(limit: number | (() => number), private readonly windowMs: number, opts: { now?: () => number; what?: string } = {}) {
    this.limitOf = typeof limit === 'number' ? () => limit : limit;
    this.now = opts.now ?? Date.now;
    this.what = opts.what;
  }

  /** Counts one request for `key`; throws 429 `rate_limited` (with the seconds to wait) above the limit. */
  take(key: string): void {
    this.count(key, undefined);
  }

  /** Counts one request for `key` unless `token` was already counted in this window (a repeat of the same press is free). */
  takeOnce(key: string, token: string | undefined): void {
    this.count(key, token);
  }

  private count(key: string, token: string | undefined): void {
    const t = this.now();
    if (t - this.lastSweep > this.windowMs) this.sweep(t);
    const cur = this.hits.get(key);
    if (!cur || t - cur.windowStart >= this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: t, ...(token ? { seen: new Set([token]) } : {}) });
      return;
    }
    if (token && cur.seen?.has(token)) return;
    const limit = this.limitOf();
    if (cur.count + 1 > limit) {
      const wait = Math.max(1, Math.ceil((cur.windowStart + this.windowMs - t) / 1000));
      throw rateLimited(this.what ? `at most ${limit} ${this.what} a minute: slow down` : 'too many requests: slow down', wait);
    }
    cur.count++;
    if (token) (cur.seen ??= new Set()).add(token);
  }

  private sweep(t: number): void {
    this.lastSweep = t;
    for (const [key, v] of this.hits) if (t - v.windowStart >= this.windowMs) this.hits.delete(key);
  }
}
