// An in-process stand-in for Supabase Storage, for the tests and the dev stack: files live in memory, and the server
// itself serves the two endpoints a signed URL points at, PUT /_dev/storage/upload/:token and GET /_dev/storage/:token.
// Tokens are random and expire like the real signed links, so a stale link fails here as it would there.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { fetchForCopy, type Copied, type CopyLimits, type SignedUpload, type Storage } from './storage.js';

interface Pending { path: string; mime: string; maxBytes: number; expiresAt: number }
interface Stored { bytes: Buffer; mime: string }

const UPLOAD_TTL_SECONDS = 2 * 3600;

export class MemoryStorage implements Storage {
  readonly files = new Map<string, Stored>();
  private readonly uploads = new Map<string, Pending>();
  private readonly downloads = new Map<string, { path: string; expiresAt: number }>();
  /** Whether a signed download link may be fetched later: a test can turn the clock forward. */
  now: () => number = () => Date.now();

  /** `baseUrl` is this server's own address: the signed URLs point back at it. */
  constructor(private readonly baseUrl = 'http://localhost:8080') {}

  async signUpload(path: string, mime: string, sizeBytes: number): Promise<SignedUpload> {
    const token = randomBytes(16).toString('hex');
    const expiresAt = this.now() + UPLOAD_TTL_SECONDS * 1000;
    this.uploads.set(token, { path, mime, maxBytes: sizeBytes, expiresAt });
    return { url: `${this.baseUrl}/_dev/storage/upload/${token}`, headers: { 'content-type': mime }, expires_at: new Date(expiresAt).toISOString() };
  }

  async signDownload(path: string, ttlSeconds: number): Promise<string> {
    const token = randomBytes(16).toString('hex');
    this.downloads.set(token, { path, expiresAt: this.now() + ttlSeconds * 1000 });
    return `${this.baseUrl}/_dev/storage/${token}`;
  }

  signDownloads(paths: string[], ttlSeconds: number): Promise<string[]> {
    return Promise.all(paths.map((p) => this.signDownload(p, ttlSeconds)));
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }

  async putFromUrl(url: string, path: string, limits?: CopyLimits): Promise<Copied> {
    const { bytes, mime } = await fetchForCopy(url, limits);
    this.files.set(path, { bytes, mime });
    return { mime, size_bytes: bytes.length };
  }

  /** Stores bytes straight away, as if they had been PUT (the demo's ticket PDFs, and tests). */
  async put(path: string, bytes: Buffer, mime: string): Promise<void> {
    this.files.set(path, { bytes, mime });
  }

  attach(app: FastifyInstance): void {
    // In a plugin of its own, so the raw-bytes body parser applies to these two routes only, never to the app's API.
    // Both routes are public: the token is the credential.
    void app.register(async (storage) => {
      storage.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 26_214_400 }, (_req, body, done) => done(null, body));
      storage.put('/_dev/storage/upload/:token', { config: { public: true } }, async (req: any, reply) => {
        const pending = this.uploads.get(req.params.token);
        if (!pending || pending.expiresAt < this.now()) return reply.code(403).send({ error: 'upload link unknown or expired' });
        const bytes: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? ''));
        if (bytes.length > pending.maxBytes) return reply.code(413).send({ error: 'more bytes than the upload was signed for' });
        this.uploads.delete(req.params.token);
        this.files.set(pending.path, { bytes, mime: pending.mime });
        return reply.code(200).send({ Key: pending.path });
      });
      storage.get('/_dev/storage/:token', { config: { public: true } }, async (req: any, reply) => {
        const link = this.downloads.get(req.params.token);
        if (!link || link.expiresAt < this.now()) return reply.code(403).send({ error: 'download link unknown or expired' });
        const file = this.files.get(link.path);
        if (!file) return reply.code(404).send({ error: 'no such file' });
        return reply.header('content-type', file.mime).header('cache-control', 'private, max-age=3600').send(file.bytes);
      });
    });
  }
}
