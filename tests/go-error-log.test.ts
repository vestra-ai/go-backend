// Every error the Server answers Go with is printed as one warn line (rev 5 K): method, code, trip, request, the field
// when known, and our message. Never the params.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.stop());
afterEach(() => vi.restoreAllMocks());

const warned = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[go] '));

describe('logging what we refuse Go', () => {
  it('a refused update_trip prints one line with the method, code, trip, request id and message, and none of the params', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await h.go.call('update_trip', { request_id: 'rq_log_1', trip_id: 't_goa', dates: { start: '2026-11-09', end: '2026-11-06' }, stay: 'Villa of Priya Sharma' });
    expect(r.error).toMatchObject({ code: 422 });
    expect(warned(warn)).toEqual([`[go] update_trip answered 422 trip=t_goa request=rq_log_1: ${r.error.message}`]);
    expect(warned(warn)[0]).not.toContain('Priya');
  });

  it('names the field when the refusal knows it, and covers params the contract refuses and unknown methods', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = await h.go.call('open_vote', { request_id: 'rq_log_2', trip_id: 't_goa', question: 'Lunch?', kind: 'yesno', anonymous: false, options: [{ label: 'Yes' }, { label: 'No' }], closes_at: '2020-01-01T00:00:00Z' });
    const shape = await h.go.call('update_trip', { request_id: 'rq_log_3', trip_id: 't_goa', colour: 'blue' });
    const unknown = await h.go.call('no_such_method', { trip_id: 't_goa' });
    expect([bad.error.code, shape.error.code, unknown.error.code]).toEqual([422, 422, -32601]);
    expect(warned(warn)).toEqual([
      `[go] open_vote answered 422 trip=t_goa request=rq_log_2 field=closes_at: ${bad.error.message}`,
      `[go] update_trip answered 422 trip=t_goa request=rq_log_3: ${shape.error.message}`,
      `[go] no_such_method answered -32601 trip=t_goa request=-: ${unknown.error.message}`,
    ]);
  });
});
