import { signSession } from '../../src/api/auth.js';
import type { Harness } from './harness.js';

export type Who = { id: string; token: string };
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

/**
 * The app's HTTP API as a test sees it. `api` calls a route in process and returns the status, the parsed body
 * and the response headers; `as` signs a person in (the person need not exist, which is how a stranger is made).
 */
export function appApi(h: Harness) {
  const api = async (who: Who | null, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const r = await h.app.inject({
      method,
      url,
      payload: payload as any,
      headers: { ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...headers },
    });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, headers: r.headers };
  };
  const as = (id: string): Who => ({ id, token: signSession(id, h.sessionSecret) });
  const events = (type: string) => h.go.events.filter((e) => e.type === type);
  return { api, as, events };
}
