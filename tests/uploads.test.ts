// Uploads (app contract §4.5) end to end on the in-process storage: sign, PUT, a message naming the upload, signed
// download links minted at read time, the expiry sweep, and the MIME and size rules.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check } from '../src/contract/index.js';
import { MAX_UPLOAD_BYTES, sweepUploads } from '../src/api/v1/uploads.js';
import { forgetSignedLinks, resolveUploadUrl } from '../src/domain/attachments.js';
import { appApi } from './helpers/app-api.js';
import { rows, startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
let t: ReturnType<typeof appApi>;
beforeAll(async () => {
  h = await startHarness(); // t_goa: p_rahul (organizer), p_priya, p_arjun, p_meher, p_kabir
  t = appApi(h);
});
afterAll(() => h.stop());

const priya = () => t.as('p_priya');
const sign = (body: Record<string, unknown>, who = priya()) => t.api(who, 'POST', '/app/v1/uploads', body);
const photo = { purpose: 'chat_attachment', kind: 'photo', mime: 'image/jpeg', name: 'seats.jpg', size_bytes: 4, width: 1280, height: 960, duration_s: null };
/** PUTs bytes to a signed upload URL, as the app does (the fake storage's route lives on the server under test). */
const put = (uploadUrl: string, bytes: Buffer, mime: string) => h.app.inject({ method: 'PUT', url: new URL(uploadUrl).pathname, payload: bytes, headers: { 'content-type': mime } });
const fetchLink = (url: string) => h.app.inject({ method: 'GET', url: new URL(url).pathname });

describe('sign, PUT, attach, read', () => {
  let uploadId: string;
  let messageId: string;

  it('signs a one-off upload URL with the headers to send, and the file lands behind it', async () => {
    const r = await sign(photo);
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ upload_id: expect.stringMatching(/^up_/), upload_url: expect.stringContaining('/_dev/storage/upload/'), headers: { 'content-type': 'image/jpeg' }, expires_at: expect.any(String), max_size_bytes: MAX_UPLOAD_BYTES });
    uploadId = r.body.upload_id;
    expect((await put(r.body.upload_url, Buffer.from('JPEG'), 'image/jpeg')).statusCode).toBe(200);
    expect((await put(r.body.upload_url, Buffer.from('JPEG'), 'image/jpeg')).statusCode).toBe(403); // one PUT per link
    const [row] = await rows(h.pool, 'select person_id, purpose, kind, mime, name, size_bytes, width, height, duration_s, used_at from uploads where upload_id = $1', [uploadId]);
    expect(row).toEqual({ person_id: 'p_priya', purpose: 'chat_attachment', kind: 'photo', mime: 'image/jpeg', name: 'seats.jpg', size_bytes: 4, width: 1280, height: 960, duration_s: null, used_at: null });
  });

  it('a message naming the upload gets a PhotoAttachment with a signed link; the link fetches the bytes; the upload is used', async () => {
    const r = await t.api(priya(), 'POST', '/app/v1/trips/t_goa/messages', { client_message_id: 'cm-photo', text: 'the seats', attachments: [{ upload_id: uploadId, caption: 'Seats' }] });
    expect(r.status).toBe(201);
    messageId = r.body.message_id;
    expect(check('Message', r.body)).toMatchObject({ ok: true });
    expect(r.body.attachments).toEqual([{ kind: 'photo', url: expect.stringContaining('/_dev/storage/'), width: 1280, height: 960, caption: 'Seats', upload_id: uploadId }]);
    const got = await fetchLink(r.body.attachments[0].url);
    expect([got.statusCode, got.headers['content-type'], got.body]).toEqual([200, 'image/jpeg', 'JPEG']);
    expect((await rows(h.pool, 'select used_at from uploads where upload_id = $1', [uploadId]))[0].used_at).not.toBeNull();
    await h.flush();
    const e = h.go.events.find((x) => x.type === 'message.created' && x.data.message.message_id === messageId)!;
    expect(check('Event', e)).toMatchObject({ ok: true }); // Go gets the attachment with a (longer-lived) link too
    expect(e.data.message.attachments[0]).toMatchObject({ kind: 'photo', url: expect.stringContaining('/_dev/storage/') });
  });

  it('every read mints a fresh one-hour link (an <img> cannot send Authorization), so an old link going stale is harmless', async () => {
    const first = (await t.api(t.as('p_rahul'), 'GET', '/app/v1/trips/t_goa/messages')).body.messages.find((m: any) => m.message_id === messageId);
    forgetSignedLinks(); // as if an hour had gone by
    const second = (await t.api(t.as('p_rahul'), 'GET', `/app/v1/trips/t_goa/messages?after_seq=0`)).body.messages.find((m: any) => m.message_id === messageId);
    expect(first.attachments[0].url).not.toBe(second.attachments[0].url);
    expect((await fetchLink(second.attachments[0].url)).statusCode).toBe(200);
    h.storage.now = () => Date.now() + 2 * 3600_000; // two hours later the old link is dead
    expect((await fetchLink(first.attachments[0].url)).statusCode).toBe(403);
    h.storage.now = () => Date.now();
    // Go's own read_messages gets fresh links as well.
    const viaGo = (await h.go.call('read_messages', { trip_id: 't_goa', after_seq: 0 })).result.messages.find((m: any) => m.message_id === messageId);
    expect((await fetchLink(viaGo.attachments[0].url)).statusCode).toBe(200);
  });

  it('refuses an upload that is used, someone else\'s, unknown or signed for another purpose, naming the field (422)', async () => {
    const post = (attachments: unknown[]) => t.api(priya(), 'POST', '/app/v1/trips/t_goa/messages', { client_message_id: `cm-${Math.random()}`, attachments });
    const used = await post([{ upload_id: uploadId }]);
    expect([used.status, used.body.error.field, used.body.error.message]).toEqual([422, 'attachments[0].upload_id', expect.stringContaining('already used')]);
    const theirs = (await sign(photo, t.as('p_rahul'))).body.upload_id;
    expect((await post([{ upload_id: theirs }])).body.error.field).toBe('attachments[0].upload_id');
    expect((await post([{ kind: 'photo', url: 'https://x.example/a.jpg' }, { upload_id: 'up_nope' }])).body.error.field).toBe('attachments[1].upload_id');
    const profile = (await sign({ purpose: 'profile_photo', kind: 'photo', mime: 'image/png', size_bytes: 10 })).body.upload_id;
    expect((await post([{ upload_id: profile }])).body.error.message).toContain('profile_photo');
    expect((await post([{ upload_id: theirs, extra: 1 }])).body.error.field).toBe('attachments[0].extra');
    expect((await rows(h.pool, 'select count(*)::int as n from messages where trip_id = $1 and attachments::text like $2', ['t_goa', '%up_nope%']))[0].n).toBe(0);
  });

  it('a voice note is a file attachment with the audio MIME and duration_s; a PDF is a file; a shared location passes through', async () => {
    const voice = (await sign({ purpose: 'chat_attachment', kind: 'audio', mime: 'audio/mp4', size_bytes: 3, duration_s: 12.4 })).body;
    await put(voice.upload_url, Buffer.from('m4a'), 'audio/mp4');
    const pdf = (await sign({ purpose: 'chat_attachment', kind: 'file', mime: 'application/pdf', name: 'ticket.pdf', size_bytes: 3 })).body;
    await put(pdf.upload_url, Buffer.from('pdf'), 'application/pdf');
    const location = { kind: 'location', lat: 15.5736, lng: 73.7407, name: 'Anjuna Beach' };
    const r = await t.api(priya(), 'POST', '/app/v1/trips/t_goa/messages', { client_message_id: 'cm-mixed', attachments: [{ upload_id: voice.upload_id }, { upload_id: pdf.upload_id }, location] });
    expect(r.status).toBe(201);
    expect(r.body.attachments).toEqual([
      { kind: 'file', url: expect.any(String), name: expect.stringMatching(/\.m4a$/), mime: 'audio/mp4', size_bytes: 3, duration_s: 12, upload_id: voice.upload_id },
      { kind: 'file', url: expect.any(String), name: 'ticket.pdf', mime: 'application/pdf', size_bytes: 3, upload_id: pdf.upload_id },
      location,
    ]);
    expect(check('Message', r.body)).toMatchObject({ ok: true });
  });
});

describe('the rules', () => {
  it('422 for a MIME outside the allow-list or wrong for the kind, over 25 MB, a non-photo profile photo, or an unknown field', async () => {
    const refused = async (body: Record<string, unknown>) => { const r = await sign(body); return [r.status, r.body.error.field]; };
    expect(await refused({ ...photo, mime: 'image/gif' })).toEqual([422, 'mime']);
    expect(await refused({ ...photo, kind: 'audio' })).toEqual([422, 'mime']); // a jpeg is not a voice note
    expect(await refused({ ...photo, kind: 'file', mime: 'audio/mp4' })).toEqual([422, 'mime']);
    expect(await refused({ ...photo, size_bytes: MAX_UPLOAD_BYTES + 1 })).toEqual([422, 'size_bytes']);
    expect(await refused({ ...photo, size_bytes: 0 })).toEqual([422, 'size_bytes']);
    expect(await refused({ ...photo, purpose: 'profile_photo', kind: 'file', mime: 'application/pdf' })).toEqual([422, 'kind']);
    expect(await refused({ ...photo, colour: 'blue' })).toEqual([422, 'colour']);
    expect((await sign({ ...photo, mime: 'application/pdf', kind: 'file' })).status).toBe(201); // a ticket as a PDF
    expect((await sign({ ...photo, mime: 'image/heic', kind: 'file' })).status).toBe(201); // or as a picture
    expect((await sign({ purpose: 'chat_attachment', kind: 'audio', mime: 'audio/ogg', size_bytes: MAX_UPLOAD_BYTES })).status).toBe(201); // exactly 25 MB
  });

  it('the fake storage refuses more bytes than the upload was signed for', async () => {
    const r = (await sign({ ...photo, size_bytes: 2 })).body;
    expect((await put(r.upload_url, Buffer.from('three'), 'image/jpeg')).statusCode).toBe(413);
  });

  it('the sweep removes uploads unused for 24 hours and their files, and leaves used and fresh ones alone', async () => {
    const stale = (await sign(photo)).body;
    await put(stale.upload_url, Buffer.from('old'), 'image/jpeg');
    const fresh = (await sign(photo)).body;
    await h.pool.query(`update uploads set expires_at = now() - interval '1 minute' where upload_id = $1`, [stale.upload_id]);
    const [{ path }] = await rows(h.pool, 'select path from uploads where upload_id = $1', [stale.upload_id]);
    expect(h.storage.files.has(path)).toBe(true);
    expect(await sweepUploads(h.ctx)).toBe(1);
    expect([h.storage.files.has(path), (await rows(h.pool, 'select upload_id from uploads where upload_id = any($1)', [[stale.upload_id, fresh.upload_id]])).map((r) => r.upload_id)]).toEqual([false, [fresh.upload_id]]);
    expect(await sweepUploads(h.ctx)).toBe(0);
  });

  it('resolveUploadUrl (for PATCH /me { photo_upload_id }) takes a profile_photo upload once and answers a long-lived link', async () => {
    const up = (await sign({ purpose: 'profile_photo', kind: 'photo', mime: 'image/png', size_bytes: 3 })).body;
    await put(up.upload_url, Buffer.from('png'), 'image/png');
    const url = await resolveUploadUrl(h.ctx, h.pool, 'p_priya', up.upload_id);
    expect((await fetchLink(url)).body).toBe('png');
    h.storage.now = () => Date.now() + 30 * 24 * 3600_000; // a month later it still works
    expect((await fetchLink(url)).statusCode).toBe(200);
    h.storage.now = () => Date.now();
    await expect(resolveUploadUrl(h.ctx, h.pool, 'p_priya', up.upload_id)).rejects.toMatchObject({ code: 422, field: 'photo_upload_id' });
    await expect(resolveUploadUrl(h.ctx, h.pool, 'p_rahul', (await sign({ purpose: 'profile_photo', kind: 'photo', mime: 'image/png', size_bytes: 3 })).body.upload_id)).rejects.toMatchObject({ code: 422 }); // Priya's, not Rahul's
  });
});
