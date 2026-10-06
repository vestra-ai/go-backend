import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { bodyChecker } from '../src/api/input.js';
import { appApi } from './helpers/app-api.js';
import { startHarness, type Harness } from './helpers/harness.js';

const PWA = 'https://pwa.example';
let h: Harness;
let bare: ReturnType<typeof buildApp>;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness({ origins: [PWA] }); // seeds t_goa with p_rahul as organizer
  t = appApi(h);
  bare = buildApp({ ctx: h.ctx, go: h.socket, sessionSecret: h.sessionSecret }); // no origins configured
  await bare.ready();
});
afterAll(async () => {
  await bare.close();
  await h.stop();
});

describe('browser access', () => {
  it('a listed origin gets the headers on a preflight (no sign-in), a real call and an error', async () => {
    const pre = await t.api(null, 'OPTIONS', '/app/trips/t_goa/messages', undefined, { origin: PWA, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' });
    expect(pre.status).toBe(204);
    expect(pre.headers).toMatchObject({
      'access-control-allow-origin': PWA, 'access-control-max-age': '600', 'access-control-expose-headers': 'Retry-After', vary: 'Origin',
      'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE',
    });
    const ok = await t.api(t.as('p_rahul'), 'GET', '/app/trips/t_goa', undefined, { origin: PWA });
    expect(ok.status).toBe(200);
    expect(ok.headers).toMatchObject({ 'access-control-allow-origin': PWA, 'access-control-expose-headers': 'Retry-After', vary: 'Origin' });
    const refused = await t.api(null, 'GET', '/app/trips/t_goa', undefined, { origin: PWA });
    expect(refused.status).toBe(401);
    expect(refused.headers).toMatchObject({ 'access-control-allow-origin': PWA, vary: 'Origin' });
  });

  it('an unlisted origin, and a server with no origins configured, get no access headers but still vary on origin', async () => {
    const stranger = await t.api(null, 'OPTIONS', '/app/trips/t_goa/messages', undefined, { origin: 'https://evil.example', 'access-control-request-method': 'POST' });
    expect(stranger.headers['access-control-allow-origin']).toBeUndefined();
    expect(stranger.headers['access-control-allow-methods']).toBeUndefined();
    expect(stranger.headers.vary).toBe('Origin');
    const none = await bare.inject({ method: 'GET', url: '/health', headers: { origin: PWA } });
    expect(none.headers['access-control-allow-origin']).toBeUndefined();
    expect(none.headers.vary).toBe('Origin');
  });

  it('the live stream, and its 401 and 403 refusals, carry the headers', async () => {
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${(h.app.server.address() as any).port}/app/trips/t_goa/live`;
    const get = (who: ReturnType<typeof t.as> | null) => fetch(url, { headers: { origin: PWA, ...(who ? { authorization: `Bearer ${who.token}` } : {}) } });
    const stream = await get(t.as('p_rahul'));
    expect(stream.headers.get('content-type')).toBe('text/event-stream');
    expect([stream.headers.get('access-control-allow-origin'), stream.headers.get('vary')]).toEqual([PWA, 'Origin']);
    await stream.body!.cancel();
    const unsigned = await get(null);
    expect([unsigned.status, unsigned.headers.get('access-control-allow-origin'), unsigned.headers.get('vary')]).toEqual([401, PWA, 'Origin']);
    const notMember = await get(t.as('p_nobody'));
    expect([notMember.status, notMember.headers.get('access-control-allow-origin'), notMember.headers.get('vary')]).toEqual([403, PWA, 'Origin']);
  });
});

describe('request errors', () => {
  it('malformed and empty JSON and a broken address answer 4xx "invalid", not 500; a missing name still answers 400 "invalid"', async () => {
    const send = (payload: string) => h.app.inject({ method: 'POST', url: '/app/people', payload, headers: { 'content-type': 'application/json' } });
    const malformed = await send('{"name": ');
    expect(malformed.statusCode).toBe(400);
    expect(JSON.parse(malformed.body).error.code).toBe('invalid');
    const empty = await send('');
    expect(empty.statusCode).toBe(400);
    expect(JSON.parse(empty.body).error.code).toBe('invalid');
    const noName = await t.api(null, 'POST', '/app/people', {});
    expect([noName.status, noName.body.error.code]).toEqual([400, 'invalid']);
    // An address with broken percent-encoding is answered by the framework itself: same shape, and the headers for a listed origin.
    const badUrl = await t.api(null, 'GET', '/app/join/%zz', undefined, { origin: PWA });
    expect([badUrl.status, badUrl.body.error.code, badUrl.headers['access-control-allow-origin'], badUrl.headers.vary]).toEqual([400, 'invalid', PWA, 'Origin']);
  });
});

describe('the newer routes and unknown paths in the merged server', () => {
  it('a strict route answers 422 for no body or empty JSON and 400 for unreadable JSON', async () => {
    const send = (payload: string | undefined, headers: Record<string, string>) =>
      h.app.inject({ method: 'POST', url: '/app/trips/t_goa/decisions', payload, headers: { authorization: `Bearer ${t.as('p_rahul').token}`, ...headers } });
    expect((await send(undefined, {})).statusCode).toBe(422);
    expect((await send('', { 'content-type': 'application/json' })).statusCode).toBe(422);
    const bad = await send('{"question": ', { 'content-type': 'application/json' });
    expect([bad.statusCode, JSON.parse(bad.body).error.code]).toEqual([400, 'invalid']);
  });

  it('an unknown path answers 404 in the standard shape and a listed origin still gets its headers, including on a preflight', async () => {
    const missing = await t.api(null, 'GET', '/app/no-such-route', undefined, { origin: PWA });
    expect([missing.status, missing.body.error.code, missing.headers['access-control-allow-origin']]).toEqual([404, 'not_found', PWA]);
    const pre = await t.api(null, 'OPTIONS', '/app/no-such-route', undefined, { origin: PWA, 'access-control-request-method': 'POST' });
    expect([pre.status, pre.headers['access-control-allow-origin']]).toEqual([204, PWA]);
  });
});

describe('the strict body checker', () => {
  const check = bodyChecker<Record<string, any>>({
    type: 'object',
    additionalProperties: false,
    required: ['n'],
    properties: {
      n: { type: 'integer', minimum: 0 },
      label: { type: ['string', 'null'], maxLength: 20 },
      link: { type: 'string', format: 'uri' },
      nested: { type: 'object', additionalProperties: false, properties: { x: { type: 'string', maxLength: 5 } } },
    },
  });
  const refused = { code: 422, dataCode: 'invalid' };

  it('refuses an unknown field, an unknown nested field, a string where a number is required, and null where it is not allowed', () => {
    expect(() => check({ n: 1, extra: true })).toThrow(expect.objectContaining({ ...refused, message: 'extra is not a known field' }));
    expect(() => check({ n: 1, nested: { y: 1 } })).toThrow(expect.objectContaining({ ...refused, message: 'nested.y is not a known field' }));
    expect(() => check({ n: '5' })).toThrow(expect.objectContaining({ ...refused, message: 'n must be integer' })); // names the rule, never the value
    expect(() => check({ n: 1, link: null })).toThrow(expect.objectContaining(refused));
  });

  it('accepts null on a clearable field and returns the body unchanged; refuses a non-URL where a URL is declared, and a body that is not an object', () => {
    const body = { n: 0, label: null, link: 'https://x.example/a', nested: { x: 'abc' } };
    expect(check(body)).toBe(body);
    expect(body).toEqual({ n: 0, label: null, link: 'https://x.example/a', nested: { x: 'abc' } });
    expect(() => check({ n: 0, link: 'not a url' })).toThrow(expect.objectContaining(refused));
    for (const notAnObject of [[], null, 'text', undefined]) expect(() => check(notAnObject)).toThrow(expect.objectContaining(refused));
  });
});
