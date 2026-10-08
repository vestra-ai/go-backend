// §4.1: the signed-in person (Me), their push devices and the vault link; dev sign-in when the server runs with dev tokens.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { createPerson } from '../../domain/actions.js';
import { vaultLink } from '../../domain/ask-go.js';
import { invalid } from '../../domain/errors.js';
import { getMyProfile, updateMyProfile } from '../../domain/person-edits.js';
import { removeDevice, saveSubscription } from '../../push/subscriptions.js';
import { isAllowedPushEndpoint, isValidSubscriptionKeys } from '../../push/web-push.js';
import { signSession } from '../auth.js';
import { checkAddDevice, checkPatchMe } from '../bodies.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import { PUBLIC, atLeastOneField, body, str, type V1Deps } from './shared.js';

export const routes: RouteMeta[] = [
  { method: 'GET', path: '/app/v1/me', section: SECTIONS.me, title: 'Me', summary: 'Your own profile: name, photo, email, sign-in provider, UPI id, default city, notifications switch.' },
  { method: 'PATCH', path: '/app/v1/me', section: SECTIONS.me, title: 'Edit me', summary: 'Change your name, photo link, UPI id, default "travelling from" or the notifications switch. Strict body, at least one field.' },
  { method: 'POST', path: '/app/v1/me/devices', section: SECTIONS.me, title: 'Register a device', summary: 'Register this browser for Web Push: { platform: "web_push", web_push: { endpoint, keys } }. Answers the device_id to delete at sign-out.' },
  { method: 'DELETE', path: '/app/v1/me/devices/:device_id', section: SECTIONS.me, title: 'Remove a device', summary: 'Removes your own device registration. Safe to repeat.' },
  { method: 'POST', path: '/app/v1/me/vault-link', section: SECTIONS.me, title: 'Vault link', summary: "A short-lived link to the person's vault page in Go, for the browser sheet." },
  { method: 'POST', path: '/app/v1/dev/sign-in', section: SECTIONS.dev, title: 'Dev sign-in', summary: 'Creates a person and answers a dev token. Only when the server runs with AUTH_MODE=dev.', auth: 'none', dev: true },
];

export function register(app: FastifyInstance, ctx: Ctx, deps: V1Deps): void {
  // Dev sign-in only. With Supabase sign-in, the person is created the first time their Supabase token is used.
  if (deps.authenticator.mode === 'dev') {
    app.post('/app/v1/dev/sign-in', {
      ...PUBLIC,
      schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, photo_url: str, phone: str, email: str, upi_id: str } } },
    }, async (req, reply) => {
      const { person_id } = await createPerson(ctx, { ...(req.body as any), auth_provider: 'dev' });
      return reply.code(201).send({ person_id, token: signSession(person_id, deps.sessionSecret) });
    });
  }

  app.get('/app/v1/me', async (req, reply) => (reply.header('cache-control', 'no-store'), getMyProfile(ctx, req.personId))); // it holds the UPI id and the email
  app.patch('/app/v1/me', async (req, reply) => {
    const input = checkPatchMe(req.body);
    atLeastOneField(input);
    reply.header('cache-control', 'no-store');
    return updateMyProfile(ctx, req.personId, input);
  });

  // Web Push: the browser's address and keys become a device of the person.
  app.post('/app/v1/me/devices', async (req, reply) => {
    const device = checkAddDevice(req.body);
    const sub = device.web_push;
    if (!isAllowedPushEndpoint(sub.endpoint)) throw invalid('endpoint must be an https address on a known push service', 'web_push.endpoint');
    if (!isValidSubscriptionKeys(sub.keys)) throw invalid('keys must be the browser\'s p256dh (65 bytes) and auth (16 bytes) values, base64url', 'web_push.keys');
    return reply.code(201).send(await saveSubscription(ctx.pool, req.personId, sub));
  });
  app.delete('/app/v1/me/devices/:device_id', async (req: any, reply) => {
    await removeDevice(ctx.pool, req.personId, req.params.device_id);
    return reply.code(204).send();
  });

  app.post('/app/v1/me/vault-link', body({ start: { type: 'string', enum: ['home', 'add_card', 'add_login'] } }), async (req: any) => vaultLink(deps.go, req.personId, req.body.start));
}
