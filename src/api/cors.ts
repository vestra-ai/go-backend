// Cross-origin access for the web app. One small function, used on every response (including errors and
// preflight) and by the live stream, which writes its own headers. No wildcard: only the exact origins listed.

const METHODS = 'GET, POST, PUT, PATCH, DELETE';
/** What a browser may send beyond the headers it always allows: the sign-in token, the body type and the repeat key. */
const HEADERS = 'authorization, content-type, idempotency-key';
/** What a browser may read back: the wait on a 429, the request id to quote in a bug report, and the replay mark. */
export const EXPOSED_HEADERS = 'Retry-After, X-Request-Id, Idempotent-Replayed';
const PREFLIGHT_MAX_AGE_SECONDS = 600;

/**
 * The headers for a response to a request from `origin`. `Vary: Origin` is always there, so a cache never
 * serves one origin's answer to another. A listed origin also gets the access headers; credentials mode
 * is not enabled. `preflight` adds what a browser asks for before a non-simple request.
 */
export function corsHeaders(allowed: readonly string[], origin: string | undefined, preflight = false): Record<string, string> {
  const out: Record<string, string> = { vary: 'Origin' };
  if (!origin || !allowed.includes(origin)) return out;
  out['access-control-allow-origin'] = origin;
  out['access-control-expose-headers'] = EXPOSED_HEADERS;
  if (preflight) {
    out['access-control-allow-methods'] = METHODS;
    out['access-control-allow-headers'] = HEADERS;
    out['access-control-max-age'] = String(PREFLIGHT_MAX_AGE_SECONDS);
  }
  return out;
}
