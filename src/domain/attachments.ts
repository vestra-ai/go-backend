// Attachments on a message (app contract §4.5, §4.6). The app uploads a file first (POST /uploads) and then names its
// `upload_id` in a message; the server turns that into the contract's PhotoAttachment or FileAttachment, with a link
// into Storage. The stored link is signed when the message is written; every time the app reads the message the
// links are signed again, valid one hour (an <img> cannot send Authorization).
import type pg from 'pg';
import type { Ctx } from '../context.js';
import { check } from '../contract/index.js';
import type { Db } from '../db/pool.js';
import { DOWNLOAD_TTL_SECONDS } from '../storage/storage.js';
import { invalid } from './errors.js';
import { compact } from './mappers.js';
import type { Message } from './types.js';

/** How long the link written into the row (and into Go's `message.created`) stays good. Go reads it when the event lands. */
export const STORED_LINK_TTL_SECONDS = 24 * 3600;
/** A profile photo link (people.photo_url) is sent to Go on every event about the person: it must stay good for a long time. */
export const PROFILE_PHOTO_TTL_SECONDS = 365 * 24 * 3600;

export interface UploadRow {
  upload_id: string; person_id: string; purpose: 'chat_attachment' | 'profile_photo'; kind: 'photo' | 'file' | 'audio'; mime: string;
  name: string | null; size_bytes: number; width: number | null; height: number | null; duration_s: number | null; path: string;
  created_at: Date; used_at: Date | null; expires_at: Date;
}

/** An attachment as stored on a message: the contract's shape plus the upload it came from, so its link can be re-signed. */
export type StoredAttachment = Record<string, unknown> & { kind: string; url?: string; upload_id?: string };

/**
 * Takes the upload for this person, once: an upload that is not theirs, is already used or has expired is refused
 * with 422 naming `field`. The row is locked, so two messages naming the same upload at the same moment get one 422.
 */
export async function takeUpload(db: Db, personId: string, uploadId: string, purpose: UploadRow['purpose'], field: string): Promise<UploadRow> {
  const row = (await db.query<UploadRow>('select * from uploads where upload_id = $1 for update', [uploadId])).rows[0];
  if (!row || row.person_id !== personId) throw invalid(`${field}: ${uploadId} is not one of your uploads`, field);
  if (row.purpose !== purpose) throw invalid(`${field}: ${uploadId} was signed for ${row.purpose}, not ${purpose}`, field);
  if (row.used_at) throw invalid(`${field}: ${uploadId} is already used`, field);
  if (row.expires_at.getTime() < Date.now()) throw invalid(`${field}: ${uploadId} has expired`, field);
  await db.query('update uploads set used_at = now() where upload_id = $1', [uploadId]);
  return row;
}

/**
 * The attachments of a new message as they are stored: each `{ upload_id, caption? }` becomes a photo or file attachment
 * (a voice note is a file with its audio MIME and `duration_s`); anything else must already be a contract Attachment.
 */
export async function resolveAttachments(ctx: Ctx, db: pg.PoolClient, personId: string, input: unknown[]): Promise<StoredAttachment[]> {
  const out: StoredAttachment[] = [];
  for (const [i, a] of input.entries()) {
    const field = `attachments[${i}]`;
    if (a && typeof a === 'object' && 'upload_id' in a) {
      const { upload_id, caption, ...rest } = a as { upload_id: unknown; caption?: unknown };
      if (typeof upload_id !== 'string' || !upload_id) throw invalid(`${field}.upload_id must be an upload id`, `${field}.upload_id`);
      if (caption !== undefined && caption !== null && (typeof caption !== 'string' || caption.length > 500)) throw invalid(`${field}.caption must be text of at most 500 characters`, `${field}.caption`);
      const extra = Object.keys(rest)[0];
      if (extra) throw invalid(`${field}.${extra} is not a known field`, `${field}.${extra}`);
      const up = await takeUpload(db, personId, upload_id, 'chat_attachment', `${field}.upload_id`);
      const url = await ctx.storage.signDownload(up.path, STORED_LINK_TTL_SECONDS);
      out.push(up.kind === 'photo'
        ? compact({ kind: 'photo', url, width: up.width ?? undefined, height: up.height ?? undefined, caption: (caption as string | null | undefined) ?? undefined, upload_id })
        : compact({ kind: 'file', url, name: up.name ?? up.path.split('/').pop()!, mime: up.mime, size_bytes: up.size_bytes, duration_s: up.duration_s === null ? undefined : Math.round(up.duration_s), upload_id }));
      continue;
    }
    const ok = check('Attachment', a);
    if (!ok.ok) throw invalid(`${field}: ${ok.message}`, field);
    out.push(ok.value as StoredAttachment);
  }
  return out;
}

/** Signed links minted recently, so a room of fifty photos does not ask Storage fifty times per read. A cached link is good for at least half its hour. */
const recent = new Map<string, { url: string; madeAt: number }>();
const CACHE_MS = (DOWNLOAD_TTL_SECONDS / 2) * 1000;
const CACHE_MAX = 5000;

/** Fresh one-hour links for every upload-backed attachment in these messages. Messages without uploads are returned as they are. */
export async function freshenAttachments<T extends Pick<Message, 'attachments'>>(ctx: Ctx, db: Db, messages: T[]): Promise<T[]> {
  const ids = new Set<string>();
  for (const m of messages) for (const a of m.attachments as StoredAttachment[]) if (a.upload_id) ids.add(a.upload_id);
  if (ids.size === 0) return messages;
  const paths = new Map((await db.query<{ upload_id: string; path: string }>('select upload_id, path from uploads where upload_id = any($1)', [[...ids]])).rows.map((r) => [r.upload_id, r.path]));
  const now = Date.now();
  const toSign = [...new Set([...paths.values()])].filter((p) => !(recent.get(p) && now - recent.get(p)!.madeAt < CACHE_MS));
  if (toSign.length) {
    const signed = await ctx.storage.signDownloads(toSign, DOWNLOAD_TTL_SECONDS);
    if (recent.size + toSign.length > CACHE_MAX) recent.clear();
    toSign.forEach((p, i) => recent.set(p, { url: signed[i]!, madeAt: now }));
  }
  return messages.map((m) => ({
    ...m,
    attachments: (m.attachments as StoredAttachment[]).map((a) => {
      const path = a.upload_id && paths.get(a.upload_id);
      return path && recent.get(path) ? { ...a, url: recent.get(path)!.url } : a;
    }),
  }));
}

/** Forgets the cached links (tests, or after a bucket change). */
export const forgetSignedLinks = () => recent.clear();

/**
 * For `PATCH /me { photo_upload_id }` (owned by the Me section): takes the person's `profile_photo` upload and answers a
 * long-lived link to store in `people.photo_url`. 422 (field `photo_upload_id`) when it is not theirs, used or expired.
 */
export async function resolveUploadUrl(ctx: Ctx, db: Db, personId: string, uploadId: string, purpose: UploadRow['purpose'] = 'profile_photo', field = 'photo_upload_id'): Promise<string> {
  const up = await takeUpload(db, personId, uploadId, purpose, field);
  return ctx.storage.signDownload(up.path, PROFILE_PHOTO_TTL_SECONDS);
}
