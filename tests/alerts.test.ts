// Slack alerts: a first sign-in, and every N of Go's messages in one trip (Go's replies cost tokens). Alerts are recorded
// by a fake here; the real one posts to SLACK_WEBHOOK_URL in the background.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SlackAlerts, slackSafe, tripAlertEveryOf, type Alerts } from '../src/alerts.js';
import { SupabaseAuth } from '../src/api/auth.js';
import { FakeSupabaseAuth } from './helpers/fake-supabase-auth.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';

const sent: string[] = [];
const recording: Alerts = { send: (text) => void sent.push(text) };
const auth = new FakeSupabaseAuth();
let h: Harness;
beforeAll(async () => {
  await auth.start();
  h = await startHarness({ alerts: recording, tripAlertEvery: 3, makeAuth: (pool) => new SupabaseAuth({ supabaseUrl: auth.url, pool, alerts: recording }) });
});
afterAll(async () => {
  await h.stop();
  await auth.close();
});
afterEach(() => void (sent.length = 0));

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
};
let n = 0;
const goSays = (text = 'hi') => h.go.call('post_message', { request_id: `rq_alert_${++n}`, trip_id: 't_goa', text });

describe('sign-up alert', () => {
  it('a first sign-in tells the channel once, with the name, email and provider; a later sign-in says nothing', async () => {
    const token = await auth.mint({ name: 'Meera <b>', email: 'meera@gmail.com' });
    const me = await h.app.inject({ method: 'GET', url: '/app/v1/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    await until(() => sent.length > 0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('New sign-up: *Meera &lt;b&gt;* (meera@gmail.com) via google');
    expect(sent[0]).toContain(JSON.parse(me.body).person_id);

    const again = await auth.mint({ name: 'Meera <b>', email: 'meera@gmail.com' });
    await h.app.inject({ method: 'GET', url: '/app/v1/me', headers: { authorization: `Bearer ${again}` } });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(1);
  });
});

describe('trip usage alert', () => {
  it("every 3rd of Go's messages in a trip alerts once, with the trip's numbers; a repeated request does not count twice", async () => {
    await h.pool.query('update trips set go_messages = 0 where trip_id = $1', ['t_goa']);
    await goSays();
    await goSays();
    await goSays(); // 3
    await until(() => sent.length > 0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/Trip \*.+\* has reached \*3\* messages from Go/);
    expect(sent[0]).toContain('`t_goa`');
    expect(sent[0]).toMatch(/\d+ members/);
    expect(sent[0]).toMatch(/\d+ from Go in the last hour/);

    // Go retries the same request: the first answer comes back and nothing is counted.
    await h.go.call('post_message', { request_id: `rq_alert_${n}`, trip_id: 't_goa', text: 'hi' });
    const [t] = await rows(h.pool, 'select go_messages from trips where trip_id = $1', ['t_goa']);
    expect(t.go_messages).toBe(3);

    await goSays();
    await goSays();
    expect(sent).toHaveLength(1);
    await goSays(); // 6
    await until(() => sent.length > 1);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('has reached *6* messages from Go');
  });
});

describe('settings and the Slack call', () => {
  it('TRIP_ALERT_GO_MESSAGES: 50 by default, 0 turns it off, anything else stops the start', () => {
    expect(tripAlertEveryOf({})).toBe(50);
    expect(tripAlertEveryOf({ TRIP_ALERT_GO_MESSAGES: '0' })).toBe(0);
    expect(tripAlertEveryOf({ TRIP_ALERT_GO_MESSAGES: '120' })).toBe(120);
    expect(() => tripAlertEveryOf({ TRIP_ALERT_GO_MESSAGES: 'lots' })).toThrow(/whole number/);
  });

  it('posts { text } to the webhook, and a failing Slack is one log line, never an error', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('ok')).mockRejectedValueOnce(new Error('down'));
    const logs: string[] = [];
    const slack = new SlackAlerts('https://hooks.slack.test/T/B/X', (m) => logs.push(m));
    slack.send('one');
    slack.send('two');
    await until(() => logs.length > 0);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://hooks.slack.test/T/B/X');
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({ text: 'one' });
    expect(logs).toEqual(['slack unreachable: down']);
    fetchMock.mockRestore();
  });

  it('slackSafe escapes what Slack reads as markup', () => {
    expect(slackSafe('A & B <@here>')).toBe('A &amp; B &lt;@here&gt;');
  });
});
