// Cross-origin access for the web app. One small function, used on every response (including errors and
// preflight) and by the live stream, which writes its own headers. No wildcard: only the exact origins listed.

const METHODS = 'GET, POST, PUT, PATCH, DELETE';
const HEADERS = 'authorization, content-type';
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
  out['access-control-expose-headers'] = 'Retry-After';
  if (preflight) {
    out['access-control-allow-methods'] = METHODS;
    out['access-control-allow-headers'] = HEADERS;
    out['access-control-max-age'] = String(PREFLIGHT_MAX_AGE_SECONDS);
  }
  return out;
}
