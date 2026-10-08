import type { Harness } from './harness.js';

/** A signed-in person as a test holds them. The token may still be on its way (minted by the fake Supabase Auth). */
export type Who = { id: string; token: string | Promise<string>; name?: string };
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

/**
 * The app's HTTP API as a test sees it. `api` calls a route in process and returns the status, the parsed body
 * and the response headers; `as` signs a person in by id (the person need not exist, which is how a stranger is
 * made); `person` signs a new person in by name, the way the app does.
 */
export function appApi(h: Harness) {
  const api = async (who: Who | null, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const token = who ? await who.token : null;
    const r = await h.app.inject({
      method,
      url,
      payload: payload as any,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, headers: r.headers };
  };
  const as = (id: string): Who => ({ id, token: h.token(id) });
  const person = (name: string, extra: Parameters<Harness['signIn']>[1] = {}) => h.signIn(name, extra);
  const events = (type: string) => h.go.events.filter((e) => e.type === type);
  return { api, as, person, events };
}
