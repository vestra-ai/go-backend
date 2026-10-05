import { createHmac, timingSafeEqual } from 'node:crypto';

// The app's sign-in. A session is a signed token naming the person. The contract does not say how the
// app signs people in (it is "yours to design"), so this is one small piece you can swap, for example
// for Supabase Auth: all the routes need is `personId`.
const DAY = 24 * 60 * 60;

export function signSession(personId: string, secret: string, nowSec = Math.floor(Date.now() / 1000), ttlSec = 90 * DAY): string {
  const payload = Buffer.from(JSON.stringify({ sub: personId, exp: nowSec + ttlSec })).toString('base64url');
  const mac = createHmac('sha256', secret).update(payload).digest('base64url');
  return `s1.${payload}.${mac}`;
}

export function verifySession(token: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): string | null {
  const [v, payload, mac] = token.split('.');
  if (v !== 's1' || !payload || !mac) return null;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { sub, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof sub === 'string' && exp > nowSec ? sub : null;
  } catch {
    return null;
  }
}
