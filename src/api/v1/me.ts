// §4.1: the signed-in person (Me), their UPI id, their push devices, the vault link and account deletion; dev sign-in when
// the server runs with dev tokens.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { deleteAccount } from '../../domain/account.js';
import { createPerson } from '../../domain/actions.js';
import { vaultLink } from '../../domain/ask-go.js';
import { invalid } from '../../domain/errors.js';
import { getMyProfile, setMyUpi, updateMyProfile } from '../../domain/person-edits.js';
import { removeDevice, saveSubscription } from '../../push/subscriptions.js';
import { isAllowedPushEndpoint, isValidSubscriptionKeys } from '../../push/web-push.js';
import { signSession } from '../auth.js';
import { checkAddDevice, checkDeleteMe, checkPatchMe, checkPutUpi } from '../bodies.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import { PUBLIC, atLeastOneField, body, id, str, type V1Deps } from './shared.js';

const ME_EXAMPLE = {
  person_id: 'p_aarav', name: 'Aarav Shah', email: 'aarav@gmail.com', photo_url: 'https://lh3.googleusercontent.com/a/photo', auth_provider: 'google',
  from_city: 'Bengaluru', has_upi: true, upi_id_masked: 'aar••••@okhdfc', notifications_enabled: true,
  counts: { active_trips: 1, past_trips: 2, pending_invites: 1 }, created_at: '2026-10-01T09:00:00.000Z', seq: null,
};

export const routes: RouteMeta[] = [
  { method: 'GET', path: '/app/v1/me', section: SECTIONS.me, title: 'Me', summary: 'Your own profile: name, photo, email, sign-in provider, masked UPI id, default city, notifications switch and the counts for the Profile row.',
    example: { responses: [{ name: 'Me', status: 200, body: ME_EXAMPLE }] } },
  { method: 'PATCH', path: '/app/v1/me', section: SECTIONS.me, title: 'Edit me', summary: 'Change your name, photo link (https), default "travelling from" or the notifications switch. Strict body, at least one field. A name or photo change tells every active trip (person.updated).',
    example: { body: { name: 'Aarav S', from_city: 'Bengaluru', notifications_enabled: true }, responses: [{ name: 'Me', status: 200, body: { ...ME_EXAMPLE, name: 'Aarav S', seq: 12 } }] } },
  { method: 'PUT', path: '/app/v1/me/upi', section: SECTIONS.me, title: 'Set my UPI id', summary: 'Payment methods → UPI. Validated (name@bank); the id never comes back, only has_upi and a masked form. Go hears has_upi when it flips.',
    example: { body: { upi_id: 'aarav@okhdfc' }, responses: [{ name: 'Me', status: 200, body: ME_EXAMPLE }, { name: 'Not a UPI id', status: 422, body: { error: { code: 'invalid', message: 'upi_id must match pattern "^[\\w.\\-]{2,256}@[a-zA-Z]{2,64}$"', field: 'upi_id', retry_after_seconds: null, request_id: 'a1b2c3d4e5f6' } } }] } },
  { method: 'DELETE', path: '/app/v1/me/upi', section: SECTIONS.me, title: 'Remove my UPI id', summary: 'Removes it. Safe to repeat.',
    example: { responses: [{ name: 'Me', status: 200, body: { ...ME_EXAMPLE, has_upi: false, upi_id_masked: null } }] } },
  { method: 'POST', path: '/app/v1/me/devices', section: SECTIONS.me, title: 'Register a device', summary: 'Register this browser for Web Push: { platform: "web_push", web_push: { endpoint, keys }, locale?, tz? }. At most 10 devices per person (the oldest goes). Answers the device_id to delete at sign-out. Pushes (§8) then carry { type, trip_id, message_id?, title, body, deep_link, tag }; none when Me.notifications_enabled is off.',
    example: { body: { platform: 'web_push', web_push: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: { p256dh: 'BNcRd…', auth: 'tBHI…' } }, locale: 'en-IN', tz: 'Asia/Kolkata' }, responses: [{ name: 'Registered', status: 201, body: { device_id: 'dev_01JA7R' } }] } },
  { method: 'DELETE', path: '/app/v1/me/devices/:device_id', section: SECTIONS.me, title: 'Remove a device', summary: 'Removes your own device registration (sign-out). Safe to repeat.', example: { responses: [{ name: 'Removed', status: 204 }] } },
  { method: 'POST', path: '/app/v1/me/vault-link', section: SECTIONS.me, title: 'Vault link', summary: "A short-lived link to the person's vault page in Go, for the browser sheet: { start?: home | add_card | add_login | add_documents, context?: { trip_id, purpose: \"visa\" } }. add_documents is the visa form (passport data never touches the server), behind features.visa: 422 start when it is off. start and context go to Go's vault_link as they are. Never cached, never put in a push.",
    example: { body: { start: 'add_documents', context: { trip_id: 't_goa', purpose: 'visa' } }, responses: [{ name: 'Link', status: 200, body: { url: 'https://brain.go.example/vault/documents?link=lk_4Rt8Zp2Lq', expires_at: '2026-10-05T09:06:30Z' } }, { name: 'Visa off', status: 422, body: { error: { code: 'invalid', message: 'add_documents is not on yet (features.visa)', field: 'start', retry_after_seconds: null, request_id: 'a1b2c3d4e5f6' } } }] } },
  { method: 'DELETE', path: '/app/v1/me', section: SECTIONS.me, title: 'Delete my account', summary: 'Body { confirm: true }. Go forgets you everywhere (502 and nothing else if it cannot), your answers are cleared, you leave every trip, your messages read "Former member", your email, UPI id and photo go. Your token stops working.',
    example: { body: { confirm: true }, responses: [{ name: 'Accepted', status: 202 }, { name: 'Go did not answer', status: 502, body: { error: { code: 'go_unavailable', message: 'Go could not forget you just now; nothing was deleted. Try again.', field: null, retry_after_seconds: null, request_id: 'a1b2c3d4e5f6' } } }] } },
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

  // Me holds the email and the masked UPI id: never cached.
  app.get('/app/v1/me', async (req, reply) => (reply.header('cache-control', 'no-store'), getMyProfile(ctx, req.personId)));
  app.patch('/app/v1/me', async (req, reply) => {
    const input = checkPatchMe(req.body);
    atLeastOneField(input);
    reply.header('cache-control', 'no-store');
    return updateMyProfile(ctx, req.personId, input);
  });
  app.put('/app/v1/me/upi', async (req, reply) => (reply.header('cache-control', 'no-store'), setMyUpi(ctx, req.personId, checkPutUpi(req.body).upi_id)));
  app.delete('/app/v1/me/upi', async (req, reply) => (reply.header('cache-control', 'no-store'), setMyUpi(ctx, req.personId, null)));

  // Web Push: the browser's address and keys become a device of the person.
  app.post('/app/v1/me/devices', async (req, reply) => {
    const device = checkAddDevice(req.body);
    const sub = device.web_push;
    if (!isAllowedPushEndpoint(sub.endpoint)) throw invalid('endpoint must be an https address on a known push service', 'web_push.endpoint');
    if (!isValidSubscriptionKeys(sub.keys)) throw invalid('keys must be the browser\'s p256dh (65 bytes) and auth (16 bytes) values, base64url', 'web_push.keys');
    return reply.code(201).send(await saveSubscription(ctx.pool, req.personId, sub, { locale: device.locale, tz: device.tz }));
  });
  app.delete('/app/v1/me/devices/:device_id', async (req: any, reply) => {
    await removeDevice(ctx.pool, req.personId, req.params.device_id);
    return reply.code(204).send();
  });

  // `start: add_documents` (+ `context`) is the visa form (GO-CHANGES 2.2), behind features.visa: the overlay lets both through to Go.
  app.post('/app/v1/me/vault-link', body({
    start: { type: 'string', enum: ['home', 'add_card', 'add_login', 'add_documents'] },
    context: { type: 'object', required: ['trip_id', 'purpose'], additionalProperties: false, properties: { trip_id: id, purpose: { type: 'string', enum: ['visa'] } } },
  }), async (req: any) => {
    if (req.body.start === 'add_documents' && !deps.features.visa) throw invalid('add_documents is not on yet (features.visa)', 'start');
    return vaultLink(deps.go, req.personId, req.body.start, req.body.context);
  });

  app.delete('/app/v1/me', async (req, reply) => {
    checkDeleteMe(req.body);
    await deleteAccount(ctx, deps.go, req.personId);
    return reply.code(202).send();
  });
}
