// Real notifications to browsers (Web Push). The sender never delays or fails a write: `send` does no database or network work before
// it returns; it hands the notification to a background task that looks up the person's subscriptions, sends each with a time limit and
// catches every error. A subscription the push service reports gone (404 or 410) is deleted. Other failures are logged without the
// address or keys and are not retried. On shutdown the server waits a bounded time for sends in flight (`drain`).
import { parse as legacyParse } from 'node:url';
import type pg from 'pg';
import webpush from 'web-push';
import { LogPush } from './push.js';
import type { Push, PushPayload } from './push.js';

export interface Vapid {
  publicKey: string;
  privateKey: string;
  subject: string;
}
export interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export interface SendOptions {
  timeout: number;
  vapidDetails: { subject: string; publicKey: string; privateKey: string };
}
/** The library's send, as a function so a test can stand in for the push service. A refusal carries `statusCode`. */
export type SendFn = (subscription: Subscription, payload: string, options: SendOptions) => Promise<unknown>;

const libSend: SendFn = (subscription, payload, options) => webpush.sendNotification(subscription, payload, options);

// Push services a subscription may point at (owner decision, choice C12). https only, matched on the parsed host.
const EXACT_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com'];
const HOST_SUFFIXES = ['.push.apple.com', '.notify.windows.com'];

/**
 * True for an https address on a known push service: an exact host, or a host ending in an allowed name at a dot boundary. The
 * library re-reads the stored address with Node's older URL parser, and the two parsers disagree on some odd characters
 * (for example `https://evil.example;.push.apple.com/x`): an address is accepted only when both read the same host, which is made
 * of plain host characters, and it has no user name, password or port. Otherwise the server could be aimed at any host.
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  if (!/^https:\/\/[^/?#:@\\]+(?:[/?#]|$)/i.test(endpoint)) return false; // no colon, @ or backslash in the authority as written (a port spelled `:0443` reads as none)
  const host = url.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) return false;
  try {
    if (legacyParse(endpoint).hostname?.toLowerCase() !== host) return false;
  } catch {
    return false; // newer Node versions refuse some inputs outright: not an address we accept
  }
  return EXACT_HOSTS.includes(host) || HOST_SUFFIXES.some((suffix) => host.length > suffix.length && host.endsWith(suffix));
}

/** True when the keys have the shape a browser's subscription always has (and the library requires): a 65-byte public key and a 16-byte secret, base64url. */
export function isValidSubscriptionKeys(keys: { p256dh: string; auth: string }): boolean {
  const bytes = (text: string) => (/^[A-Za-z0-9_-]+={0,2}$/.test(text) ? Buffer.from(text, 'base64url').length : -1);
  return bytes(keys.p256dh) === 65 && bytes(keys.auth) === 16;
}

/** What the browser receives (app contract §8): the type, the trip, the title, the text (cut to 300 characters), the deep link and the tag. No file or vault links. */
export function payloadOf(n: PushPayload): string {
  return JSON.stringify({ ...n, body: Array.from(n.body).slice(0, 300).join('') }); // by characters, so a pair is never cut in half
}

const SEND_BATCH = 10;

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('push send timed out'), { name: 'PushTimeout' })), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

export interface WebPushOptions {
  pool: pg.Pool;
  vapid: Vapid;
  send?: SendFn;
  /** The longest one send may take (owner decision: 4 s). */
  sendTimeoutMs?: number;
  /** The longest shutdown waits for sends in flight (owner decision: 3 s). */
  drainWaitMs?: number;
  log?: (message: string) => void;
}

export class WebPushSender implements Push {
  private readonly inflight = new Set<Promise<void>>();
  private readonly sendFn: SendFn;
  private readonly sendTimeoutMs: number;
  private readonly drainWaitMs: number;
  private readonly log: (message: string) => void;

  constructor(private readonly o: WebPushOptions) {
    this.sendFn = o.send ?? libSend;
    this.sendTimeoutMs = o.sendTimeoutMs ?? 4_000;
    this.drainWaitMs = o.drainWaitMs ?? 3_000;
    const log = o.log ?? ((m: string) => console.error(m));
    this.log = (m) => {
      try {
        log(m);
      } catch {
        // a logger that throws must never become an unhandled rejection
      }
    };
  }

  /** Returns at once. The work happens in the background: a slow or failing push service never touches the caller. */
  send(personIds: string[], payload: PushPayload): Promise<void> {
    if (personIds.length === 0) return Promise.resolve();
    const task: Promise<void> = this.deliver(personIds, payload)
      .catch((err) => this.log(`web push delivery failed: ${err instanceof Error ? err.name : 'error'}`))
      .finally(() => this.inflight.delete(task));
    this.inflight.add(task);
    return Promise.resolve();
  }

  private async deliver(personIds: string[], p: PushPayload): Promise<void> {
    const payload = payloadOf(p);
    // Only people whose notifications switch is on (app contract §8): sendPush dropped them already; checked again here at delivery time, in case the switch went off since.
    const { rows } = await this.o.pool.query(
      'select s.endpoint, s.p256dh, s.auth from push_subscriptions s join people p using (person_id) where s.person_id = any($1) and p.notifications_enabled',
      [personIds],
    );
    // In small batches: the library signs and encrypts synchronously for each send, so a person with very many subscriptions must not
    // hold the server's single thread (and Go's answer deadline) for one long stretch.
    for (let i = 0; i < rows.length; i += SEND_BATCH) {
      await Promise.all(rows.slice(i, i + SEND_BATCH).map((row) => this.sendOne({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload)));
    }
  }

  private async sendOne(subscription: Subscription, payload: string): Promise<void> {
    try {
      await withTimeout(this.sendFn(subscription, payload, { timeout: this.sendTimeoutMs, vapidDetails: this.o.vapid }), this.sendTimeoutMs);
    } catch (err) {
      const status = (err as { statusCode?: number } | null)?.statusCode;
      if (status === 404 || status === 410) {
        await this.o.pool.query('delete from push_subscriptions where endpoint = $1', [subscription.endpoint]).catch(() => {});
      } else {
        this.log(`web push send failed (${status ?? (err instanceof Error ? err.name : 'error')}); not retried`); // never the address or the keys
      }
    }
  }

  /** Waits for the sends in flight, but never longer than the bound. */
  async drain(): Promise<void> {
    if (this.inflight.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.drainWaitMs);
    });
    try {
      await Promise.race([Promise.allSettled([...this.inflight]), bound]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface PushKeys {
  publicKey?: string;
  privateKey?: string;
  subject?: string;
}

/**
 * The sender the server runs with. Without all three settings (a partial set counts as absent), or with keys the library refuses, it
 * warns (naming the settings, never their values) and falls back to the log-only sender; `publicKey` is then null and
 * `GET /app/v1/config` says `web_push: false` with no `vapid_public_key`.
 */
export function createPush(opts: { pool: pg.Pool; keys: PushKeys; log?: (message: string) => void; warn?: (message: string) => void }): { push: Push; publicKey: string | null } {
  const warn = opts.warn ?? ((m) => console.warn(m));
  const { publicKey, privateKey, subject } = opts.keys;
  if (!publicKey || !privateKey || !subject) {
    warn('push: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT are not all set: notifications are only written to the log, and GET /app/v1/config turns web_push off');
    return { push: new LogPush(), publicKey: null };
  }
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey); // refuses keys that are not valid VAPID keys
  } catch {
    warn('push: the VAPID settings are not valid: notifications are only written to the log, and GET /app/v1/config turns web_push off');
    return { push: new LogPush(), publicKey: null };
  }
  return { push: new WebPushSender({ pool: opts.pool, vapid: { publicKey, privateKey, subject }, log: opts.log }), publicKey };
}
