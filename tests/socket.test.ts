import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => (h = await startHarness()));
afterAll(() => h.stop());

describe('the socket', () => {
  it('opens with a signature Go accepts and names the instance in the target', () => {
    expect(h.go.connected).toBe(true);
    expect(h.go.targets[0]).toBe('/v1/socket?instance=test-1');
    expect(h.go.refused).toEqual([]);
  });

  it('answers -32601 for a method it does not handle', async () => {
    const f = await h.go.call('add_sticker', { trip_id: 't_goa' });
    expect(f.error).toMatchObject({ code: -32601 });
    expect(f.error.message).toContain('add_sticker');
  });

  it('answers 422 invalid and names the field when the params are wrong', async () => {
    const f = await h.go.call('add_reaction', { request_id: 'r1', trip_id: 't_goa', message_id: 'm1', emoji: '' });
    expect(f.error).toMatchObject({ code: 422, data: { code: 'invalid' } });
    expect(f.error.message).toContain('emoji');
  });

  it('answers -32700 with a null id for a frame it cannot read', async () => {
    const f = await h.go.raw('this is not json');
    expect(f).toMatchObject({ id: null, error: { code: -32700 } });
  });

  it('answers 404 when the trip does not exist', async () => {
    const f = await h.go.call('read_trip', { trip_id: 't_nope' });
    expect(f.error).toMatchObject({ code: 404, data: { code: 'not_found' } });
  });

  it('reconnects with a fresh signature after the socket drops', async () => {
    h.go.dropSockets();
    await new Promise((r) => setTimeout(r, 100));
    await h.go.untilConnected(5000);
    expect(h.go.targets.length).toBe(2);
    expect(h.go.refused).toEqual([]); // the second connect was not a replay of the first signature
    const f = await h.go.call('read_trip', { trip_id: 't_goa' });
    expect(f.result.trip_id).toBe('t_goa');
  });
});

describe('the 2 second deadline', () => {
  it('answers 503 unavailable when a request cannot be answered in time, and the retry gets the stored answer', async () => {
    const { goRequestHandlers } = await import('../src/requests/index.js');
    const { SocketCallError } = await import('../src/go/go-socket.js');
    const slow = goRequestHandlers(h.ctx, 50);
    // hold the trip row so the write cannot finish within 50 ms
    const lock = await h.pool.connect();
    await lock.query('begin');
    await lock.query("select * from trips where trip_id = 't_goa' for update");
    const params = { request_id: 'rq_slow', trip_id: 't_goa', text: 'slow write' };
    const first = slow.post_message!(params, params).catch((e: unknown) => e);
    const err = await first;
    expect(err).toBeInstanceOf(SocketCallError);
    expect(err).toMatchObject({ code: 503, dataCode: 'unavailable' });
    await lock.query('commit');
    lock.release();
    await new Promise((r) => setTimeout(r, 300)); // the write finishes after the deadline and stores its answer
    const retry = await h.go.call('post_message', params);
    expect(retry.result.message_id).toBeTruthy();
    const { rows } = await h.pool.query("select count(*)::int as n from messages where text = 'slow write'");
    expect(rows[0].n).toBe(1); // done once
  });
});
