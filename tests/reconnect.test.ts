import { afterAll, beforeAll, expect, it } from 'vitest';
import { GoSocket } from '../src/go/go-socket.js';
import { MockGo } from './helpers/mock-go.js';

let go: MockGo;
let socket: GoSocket;
beforeAll(async () => (go = new MockGo()));
afterAll(async () => (socket?.stop(), await go.close()));

it('after Go refuses the upgrade with 401, it waits and tries again with a fresh signature, and recovers when the secret is right', async () => {
  const base = await go.listen();
  const wrong = { secret: 'the-wrong-secret' };
  socket = new GoSocket({ url: `${base}/v1/socket?instance=a`, secret: wrong.secret, handlers: {}, log: () => {} });
  socket.start();
  const end = Date.now() + 5000;
  while (go.refused.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  expect(go.refused.length).toBeGreaterThanOrEqual(2); // it kept trying after the 401 (1 s, then 2 s)
  expect(go.connected).toBe(false);
  // The secret is fixed: the next try connects.
  (socket as any).opts.secret = go.secret;
  while (!go.connected && Date.now() < end + 8000) await new Promise((r) => setTimeout(r, 100));
  expect(go.connected).toBe(true);
}, 20000);
