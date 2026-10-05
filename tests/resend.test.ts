import { afterAll, beforeAll, expect, it } from 'vitest';
import { change } from '../src/db/write-change.js';
import { startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => (h = await startHarness()));
afterAll(() => h.stop());

it('sends an unanswered request again after reconnecting, with the same JSON-RPC id and the same event_id', async () => {
  await change(h.pool, 't_goa', 'message.deleted', { message_id: 'm_1' });
  const first: { id?: string; event_id?: string } = {};
  let dropped = false;
  h.go.onEvent = async (params) => {
    if (!dropped) {
      dropped = true;
      first.event_id = params.event_id;
      // the socket drops before the answer arrives
      h.go.dropSockets();
      return null as any;
    }
    return { result: { accepted: true, duplicate: true } };
  };
  const seenIds: string[] = [];
  const origFrames = h.go.frames;
  await h.sender.tick();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const sent = origFrames.filter((f) => f.method === 'send_event');
    seenIds.splice(0, seenIds.length, ...sent.map((f) => f.id));
    const { rows } = await h.pool.query("select status from outbox where trip_id = 't_goa' and seq = 2");
    if (rows[0]?.status === 'sent') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const { rows } = await h.pool.query("select status, attempts from outbox where trip_id = 't_goa' and seq = 2");
  expect(rows[0]).toEqual({ status: 'sent', attempts: 0 }); // the socket client resent it: no retry was used up
  const sends = origFrames.filter((f) => f.method === 'send_event');
  expect(sends.length).toBeGreaterThanOrEqual(2);
  expect(new Set(sends.map((f) => f.id)).size).toBe(1); // the same JSON-RPC id both times
  expect(new Set(sends.map((f) => f.params.event_id))).toEqual(new Set([first.event_id])); // and the same event
  expect(h.go.targets.length).toBe(2);
  expect(h.go.refused).toEqual([]);
});

it('after a restart the outbox sends the event again in a new frame, and Go still recognises the event_id', async () => {
  await change(h.pool, 't_goa', 'message.deleted', { message_id: 'm_2' });
  h.go.onEvent = async () => ({ result: { accepted: true, duplicate: false } });
  await h.flush();
  // Simulate a crash after Go answered but before we marked it sent: the row is pending again.
  await h.pool.query("update outbox set status = 'pending' where seq = 3");
  h.go.onEvent = async () => ({ result: { accepted: true, duplicate: true } });
  await h.flush();
  const again = h.go.events.filter((e) => e.seq === 3);
  expect(again.length).toBe(2);
  expect(again[0]!.event_id).toBe(again[1]!.event_id);
  const { rows } = await h.pool.query("select status from outbox where seq = 3");
  expect(rows[0].status).toBe('sent'); // `duplicate: true` is a success
});
