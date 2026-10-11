// §4.1: the signed-in person (Me), their UPI id, the vault link and account deletion; dev sign-in when
// the server runs with dev tokens.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { deleteAccount } from '../../domain/account.js';
import { createPerson, requireMember } from '../../domain/actions.js';
import { vaultLink } from '../../domain/ask-go.js';
import { invalid } from '../../domain/errors.js';
import { getMyProfile, setMyUpi, updateMyProfile } from '../../domain/person-edits.js';
import { signSession } from '../auth.js';
import { RateLimiter } from '../rate-limit.js';
import { checkDeleteMe, checkPatchMe, checkPutUpi, checkVaultLink } from '../bodies.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import { PUBLIC, atLeastOneField, str, type V1Deps } from './shared.js';

/** App contract Appendix A: six vault links a minute per person. */
export const VAULT_LINKS_PER_MINUTE = 6;

// GET /me answers the profile alone; the edits add `seq` (the last change number written, or null).
const ME_EXAMPLE = {
  person_id: 'p_aarav', name: 'Aarav Shah', email: 'aarav@gmail.com', photo_url: 'https://lh3.googleusercontent.com/a/photo', auth_provider: 'google',
  from_city: 'Bengaluru', has_upi: true, upi_id_masked: 'aar••••@okhdfc',
  counts: { active_trips: 1, past_trips: 2 }, created_at: '2026-10-01T09:00:00.000Z',
};
const refused = (status: number, code: string, msg: string, field: string | null = null, retry: number | null = null) => ({ name: code, status, body: { error: { code, message: msg, field, retry_after_seconds: retry, request_id: 'a1b2c3d4e5f6' } } });

export const routes: RouteMeta[] = [
  { method: 'GET', path: '/app/v1/me', section: SECTIONS.me, title: 'Me', summary: 'Your own profile: name, photo, email, sign-in provider, masked UPI id, default city and the counts for the Profile row.',
    example: { responses: [{ name: 'Me', status: 200, body: ME_EXAMPLE }] } },
  { method: 'PATCH', path: '/app/v1/me', section: SECTIONS.me, title: 'Edit me', summary: 'Change your name, photo (photo_upload_id: a profile_photo upload of yours, taken once; or photo_url, an https link; not both), or default "travelling from". Strict body, at least one field. A name or photo change tells every active trip (person.updated). Answers Me plus seq.',
    example: { body: { name: 'Aarav S', photo_upload_id: 'up_01JC', from_city: 'Bengaluru' }, responses: [{ name: 'Me', status: 200, body: { ...ME_EXAMPLE, name: 'Aarav S', photo_url: 'https://<ref>.supabase.co/storage/v1/object/sign/go-files/profile_photo/p_aarav/up_01JC.jpg?token=…', seq: 12 } }, refused(422, 'invalid', 'photo_upload_id: up_01JC is already used', 'photo_upload_id')] } },
  { method: 'PUT', path: '/app/v1/me/upi', section: SECTIONS.me, title: 'Set my UPI id', summary: 'Payment methods → UPI. Validated (name@bank); the id never comes back, only has_upi and a masked form. Go hears has_upi when it flips. Answers Me plus seq.',
    example: { body: { upi_id: 'aarav@okhdfc' }, responses: [{ name: 'Me', status: 200, body: { ...ME_EXAMPLE, seq: 13 } }, refused(422, 'invalid', 'upi_id must match pattern "^[\\w.\\-]{2,256}@[a-zA-Z]{2,64}$"', 'upi_id')] } },
  { method: 'DELETE', path: '/app/v1/me/upi', section: SECTIONS.me, title: 'Remove my UPI id', summary: 'Removes it. Safe to repeat. Answers Me plus seq (null when there was none).',
    example: { responses: [{ name: 'Me', status: 200, body: { ...ME_EXAMPLE, has_upi: false, upi_id_masked: null, seq: 14 } }] } },
  { method: 'POST', path: '/app/v1/me/vault-link', section: SECTIONS.me, title: 'Vault link', summary: `A short-lived link to the person's vault page in Go, for the browser sheet, or with display: "embedded" for a frame inside the app: { start?: home | add_card | add_login | add_documents, display?: sheet | embedded, context?: { trip_id, purpose: "visa" } } (strict). embedded is for start home only (422 display otherwise); the page then posts { type: "go-vault", status: saved | cancelled | failed } to its parent. add_documents is the visa form (passport data never touches the server), behind features.visa: 422 start when it is off. start and context go to Go's vault_link as they are. ${VAULT_LINKS_PER_MINUTE} a minute per person (429), counting only calls that reach Go. Never cached.`,
    example: { body: { start: 'add_documents', context: { trip_id: 't_goa', purpose: 'visa' } }, responses: [{ name: 'Link', status: 200, body: { url: 'https://brain.go.example/vault/documents?link=lk_4Rt8Zp2Lq', expires_at: '2026-10-05T09:06:30Z' } }, refused(422, 'invalid', 'add_documents is not on yet (features.visa)', 'start'), refused(429, 'rate_limited', `at most ${VAULT_LINKS_PER_MINUTE} vault links a minute: slow down`, null, 42)] } },
  { method: 'DELETE', path: '/app/v1/me', section: SECTIONS.me, title: 'Delete my account', summary: 'Body { confirm: true }. Go forgets you everywhere (502 and nothing else if it cannot), your answers are cleared, you leave every trip, your messages and the room\'s pills that named you read "Former member", your email, UPI id and photo go. Your token stops working.',
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

  // `start: add_documents` (+ `context`) is the visa form (GO-CHANGES 2.2), behind features.visa: the overlay lets both through to Go.
  const vaultLinks = new RateLimiter(() => ctx.limits?.vaultLinksPerMinute ?? VAULT_LINKS_PER_MINUTE, 60_000, { what: 'vault links' });
  app.post('/app/v1/me/vault-link', async (req, reply) => {
    // The link is a key to the person's vault for a few minutes: not cached, and not kept for an Idempotency-Key replay
    // (a repeat asks Go for a fresh one).
    reply.header('cache-control', 'no-store');
    req.idempotency = undefined;
    const input = checkVaultLink(req.body);
    if (input.start === 'add_documents' && !deps.features.visa) throw invalid('add_documents is not on yet (features.visa)', 'start');
    // Go's vault frames only its home page (contract 1.3): adding a card or a login stays in the sheet. Said here, so the
    // app hears why and not "Go could not do that".
    if (input.display === 'embedded' && (input.start ?? 'home') !== 'home') throw invalid('embedded is for the vault home only: open this page in the sheet', 'display');
    if (input.context) await requireMember(ctx.pool, input.context.trip_id, req.personId); // only a trip you are in (403 otherwise)
    vaultLinks.take(req.personId); // after every check: only a request that goes to Go counts
    return vaultLink(deps.go, req.personId, input.start, input.context, input.display);
  });

  app.delete('/app/v1/me', async (req, reply) => {
    checkDeleteMe(req.body);
    await deleteAccount(ctx, deps.go, req.personId);
    return reply.code(202).send();
  });
}
