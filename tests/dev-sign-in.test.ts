// Dev sign-in (AUTH_MODE=dev, local runs only): POST /app/v1/dev/sign-in answers a token the server's own routes accept.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { appApi } from './helpers/app-api.js';
import { startHarness, v1, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => (h = await startHarness({ auth: 'dev', seed: false })));
afterAll(() => h.stop());

it('creates the person with auth_provider dev and signs them in; a seeded id signs in with a dev token too', async () => {
  const t = appApi(h);
  const r = await t.api(null, 'POST', v1('/dev/sign-in'), { name: 'Dev Dinesh', email: 'dinesh@x.test', upi_id: 'dinesh@upi' });
  expect([r.status, Object.keys(r.body).sort(), r.body.token.startsWith('s1.')]).toEqual([201, ['person_id', 'token'], true]);
  const me = await t.api({ id: r.body.person_id, token: r.body.token }, 'GET', v1('/me'));
  expect(me.body).toMatchObject({ person_id: r.body.person_id, name: 'Dev Dinesh', email: 'dinesh@x.test', has_upi: true, upi_id_masked: 'din••••@upi', auth_provider: 'dev' });
  const viaHelper = await t.person('Helper');
  expect((await t.api(viaHelper, 'GET', v1('/me'))).body.name).toBe('Helper');
  expect((await t.api(null, 'POST', v1('/dev/sign-in'), {})).status).toBe(422); // the name is required
  expect((await t.api(t.as(r.body.person_id), 'GET', v1('/me'))).status).toBe(200); // h.token() signs dev tokens in this mode
});
