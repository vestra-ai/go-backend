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
    const pre = await t.api(null, 'OPTIONS', '/app/v1/trips/t_goa/messages', undefined, { origin: PWA, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' });
    expect(pre.status).toBe(204);
    expect(pre.headers).toMatchObject({
      'access-control-allow-origin': PWA, 'access-control-max-age': '600', 'access-control-expose-headers': 'Retry-After, X-Request-Id, Idempotent-Replayed', vary: 'Origin',
      'access-control-allow-headers': 'authorization, content-type, idempotency-key', 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE',
    });
    const ok = await t.api(t.as('p_rahul'), 'GET', '/app/v1/trips/t_goa', undefined, { origin: PWA });
    expect(ok.status).toBe(200);
    expect(ok.headers).toMatchObject({ 'access-control-allow-origin': PWA, 'access-control-expose-headers': 'Retry-After, X-Request-Id, Idempotent-Replayed', vary: 'Origin' });
    const refused = await t.api(null, 'GET', '/app/v1/trips/t_goa', undefined, { origin: PWA });
    expect(refused.status).toBe(401);
    expect(refused.headers).toMatchObject({ 'access-control-allow-origin': PWA, vary: 'Origin' });
  });

  it('an unlisted origin, and a server with no origins configured, get no access headers but still vary on origin', async () => {
    const stranger = await t.api(null, 'OPTIONS', '/app/v1/trips/t_goa/messages', undefined, { origin: 'https://evil.example', 'access-control-request-method': 'POST' });
    expect(stranger.headers['access-control-allow-origin']).toBeUndefined();
    expect(stranger.headers['access-control-allow-methods']).toBeUndefined();
    expect(stranger.headers.vary).toBe('Origin');
    const none = await bare.inject({ method: 'GET', url: '/health', headers: { origin: PWA } });
    expect(none.headers['access-control-allow-origin']).toBeUndefined();
    expect(none.headers.vary).toBe('Origin');
  });

  it('the live ticket, and its 401 refusal, carry the headers (the socket itself is not a browser fetch)', async () => {
    const ticket = await t.api(t.as('p_rahul'), 'POST', '/app/v1/live/ticket', {}, { origin: PWA });
    expect([ticket.status, ticket.body.ticket.startsWith('tk_'), ticket.headers['access-control-allow-origin'], ticket.headers.vary]).toEqual([201, true, PWA, 'Origin']);
    const unsigned = await t.api(null, 'POST', '/app/v1/live/ticket', {}, { origin: PWA });
    expect([unsigned.status, unsigned.headers['access-control-allow-origin'], unsigned.headers.vary]).toEqual([401, PWA, 'Origin']);
  });
});

describe('request errors', () => {
  it('malformed JSON and a broken address answer 400 "bad_request"; a body that breaks a rule answers 422 "invalid" naming the field; never 500', async () => {
    const who = t.as('p_rahul');
    const send = async (payload: string) => h.app.inject({ method: 'POST', url: '/app/v1/trips', payload, headers: { 'content-type': 'application/json', authorization: `Bearer ${await who.token}` } });
    const malformed = await send('{"title": ');
    expect(malformed.statusCode).toBe(400);
    expect(JSON.parse(malformed.body).error).toEqual({ code: 'bad_request', message: expect.any(String), field: null, retry_after_seconds: null, request_id: malformed.headers['x-request-id'] });
    const empty = await send('{"title": 5}');
    expect(empty.statusCode).toBe(422); // a rule broken: the title is not text
    expect(JSON.parse(empty.body).error).toMatchObject({ code: 'invalid', field: 'title' });
    const unknown = await t.api(who, 'POST', '/app/v1/trips', { colour: 'blue' });
    expect([unknown.status, unknown.body.error.code, unknown.body.error.field]).toEqual([422, 'invalid', 'colour']);
    expect((await send('')).statusCode).toBe(201); // read as no body: everything is optional on this route ("New trip")
    // An address with broken percent-encoding is answered by the framework itself: same shape, and the headers for a listed origin.
    const badUrl = await t.api(null, 'GET', '/app/v1/invites/%zz', undefined, { origin: PWA });
    expect([badUrl.status, badUrl.body.error.code, badUrl.headers['access-control-allow-origin'], badUrl.headers.vary, typeof badUrl.headers['x-request-id']]).toEqual([400, 'bad_request', PWA, 'Origin', 'string']);
  });
});

describe('the newer routes and unknown paths in the merged server', () => {
  it('a strict route answers 422 for no body or empty JSON and 400 for unreadable JSON', async () => {
    const send = async (payload: string | undefined, headers: Record<string, string>) =>
      h.app.inject({ method: 'POST', url: '/app/v1/trips/t_goa/decisions', payload, headers: { authorization: `Bearer ${await t.as('p_rahul').token}`, ...headers } });
    expect((await send(undefined, {})).statusCode).toBe(422);
    expect((await send('', { 'content-type': 'application/json' })).statusCode).toBe(422);
    const bad = await send('{"question": ', { 'content-type': 'application/json' });
    expect([bad.statusCode, JSON.parse(bad.body).error.code]).toEqual([400, 'bad_request']);
  });

  it('an unknown path answers 404 in the standard shape and a listed origin still gets its headers, including on a preflight', async () => {
    const missing = await t.api(null, 'GET', '/app/v1/no-such-route', undefined, { origin: PWA });
    expect([missing.status, missing.body.error.code, missing.headers['access-control-allow-origin']]).toEqual([404, 'not_found', PWA]);
    const pre = await t.api(null, 'OPTIONS', '/app/v1/no-such-route', undefined, { origin: PWA, 'access-control-request-method': 'POST' });
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
