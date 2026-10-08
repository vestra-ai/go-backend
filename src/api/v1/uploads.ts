// §4.5 Uploads: POST /uploads signs a one-off upload URL into Storage; the app PUTs the bytes there and then names the
// upload_id in a message (§4.6) or in PATCH /me { photo_upload_id } (§4.1). Size and MIME are checked here; the file is
// never streamed through this server.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { newId } from '../../db/ids.js';
import { invalid } from '../../domain/errors.js';
import { checkUpload, type UploadBody } from '../bodies.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import type { V1Deps } from './shared.js';

/** App contract §4.5. */
export const MAX_UPLOAD_BYTES = 26_214_400; // 25 MB
export const UPLOAD_EXPIRES_HOURS = 24;
export const IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);
export const DOCUMENT = new Set(['application/pdf']);
export const AUDIO = new Set(['audio/mp4', 'audio/mpeg', 'audio/webm', 'audio/ogg']);
/** Which MIME types each kind may carry: a photo is an image; a file is a PDF or an image (a ticket as a picture); a voice note is audio. */
const ALLOWED: Record<UploadBody['kind'], Set<string>> = { photo: IMAGE, file: new Set([...DOCUMENT, ...IMAGE]), audio: AUDIO };
const EXTENSION: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav' };
/** The file extension a stored path gets for a MIME type (`bin` for one the table does not know). */
export const extensionFor = (mime: string): string => EXTENSION[mime.toLowerCase()] ?? 'bin';

export const routes: RouteMeta[] = [
  {
    method: 'POST', path: '/app/v1/uploads', section: SECTIONS.uploads, title: 'Sign an upload',
    summary: 'Before attaching a photo, a PDF or a voice note, or changing the profile photo: { purpose: chat_attachment | profile_photo, kind: photo | file | audio, mime, name?, size_bytes, width?, height?, duration_s? }. MIME allow-list image/jpeg|png|webp|heic, application/pdf, audio/mp4|mpeg|webm|ogg; at most 25 MB (422 otherwise). PUT the bytes to upload_url with the headers, then use upload_id. Unused uploads expire after 24 hours.',
    example: {
      body: { purpose: 'chat_attachment', kind: 'photo', mime: 'image/jpeg', name: 'seats.jpg', size_bytes: 482113, width: 1280, height: 960, duration_s: null },
      responses: [
        { name: 'signed', status: 201, body: { upload_id: 'up_01JA', upload_url: 'https://<ref>.supabase.co/storage/v1/object/upload/sign/go-files/chat_attachment/up_01JA.jpg?token=…', headers: { 'content-type': 'image/jpeg', 'x-upsert': 'false' }, expires_at: '2026-10-08T09:12:00Z', max_size_bytes: MAX_UPLOAD_BYTES } },
        { name: 'wrong type', status: 422, body: { error: { code: 'invalid', message: 'mime: image/gif is not allowed for a photo', field: 'mime', retry_after_seconds: null, request_id: 'req_01JA7Q3V8Z' } } },
      ],
    },
  },
];

export function register(app: FastifyInstance, ctx: Ctx, _deps: V1Deps): void {
  app.post('/app/v1/uploads', async (req, reply) => {
    const input = checkUpload(req.body);
    const mime = input.mime.toLowerCase();
    if (!ALLOWED[input.kind].has(mime)) throw invalid(`mime: ${input.mime} is not allowed for a ${input.kind === 'audio' ? 'voice note' : input.kind}`, 'mime');
    if (input.size_bytes > MAX_UPLOAD_BYTES) throw invalid(`size_bytes: at most ${MAX_UPLOAD_BYTES} bytes (25 MB)`, 'size_bytes');
    if (input.purpose === 'profile_photo' && input.kind !== 'photo') throw invalid('kind: a profile photo is a photo', 'kind');
    const upload_id = newId('up');
    const path = `${input.purpose}/${req.personId}/${upload_id}.${EXTENSION[mime]}`;
    const signed = await ctx.storage.signUpload(path, mime, input.size_bytes);
    await ctx.pool.query(
      `insert into uploads (upload_id, person_id, purpose, kind, mime, name, size_bytes, width, height, duration_s, path, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(hours => $12))`,
      [upload_id, req.personId, input.purpose, input.kind, mime, input.name ?? null, input.size_bytes, input.width ?? null, input.height ?? null, input.duration_s ?? null, path, UPLOAD_EXPIRES_HOURS],
    );
    return reply.code(201).send({ upload_id, upload_url: signed.url, headers: signed.headers, expires_at: signed.expires_at, max_size_bytes: MAX_UPLOAD_BYTES });
  });
}

/** Removes uploads that were never used within their 24 hours, and their files. Safe to run on every instance. */
export async function sweepUploads(ctx: Ctx): Promise<number> {
  const { rows } = await ctx.pool.query<{ upload_id: string; path: string }>('delete from uploads where used_at is null and expires_at < now() returning upload_id, path');
  for (const r of rows) await ctx.storage.delete(r.path).catch((err) => console.error(`[uploads] could not delete ${r.path}`, err));
  return rows.length;
}
