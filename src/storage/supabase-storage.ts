// Supabase Storage (decision D4): one private bucket, the service key only on the server. Signed upload URLs come from
// POST /storage/v1/object/upload/sign/<bucket>/<path>; signed download links from POST /storage/v1/object/sign/<bucket>.
import type { SignedUpload, Storage } from './storage.js';

export interface SupabaseStorageOptions {
  /** The project URL, https://<ref>.supabase.co */
  supabaseUrl: string;
  /** The service (secret) key: it may read and write every object. Never the publishable key. */
  secretKey: string;
  bucket: string;
  fetch?: typeof fetch;
}

/** Supabase's signed upload URLs are valid two hours; the app is told so. */
const UPLOAD_TTL_SECONDS = 2 * 3600;

export class SupabaseStorage implements Storage {
  private readonly base: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: SupabaseStorageOptions) {
    this.base = `${opts.supabaseUrl.replace(/\/+$/, '')}/storage/v1`;
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  private async call<T>(method: string, path: string, body?: unknown | Blob, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.fetch(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.opts.secretKey}`, apikey: this.opts.secretKey, ...(body !== undefined && !(body instanceof Blob) ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Supabase Storage ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  private objectPath(path: string): string {
    return `${encodeURIComponent(this.opts.bucket)}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  async signUpload(path: string, mime: string, _sizeBytes: number): Promise<SignedUpload> {
    // { url: "/object/upload/sign/<bucket>/<path>?token=...", token }
    const { url } = await this.call<{ url: string }>('POST', `/object/upload/sign/${this.objectPath(path)}`);
    return {
      url: `${this.base}${url.startsWith('/') ? '' : '/'}${url}`,
      headers: { 'content-type': mime, 'x-upsert': 'false' },
      expires_at: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000).toISOString(),
    };
  }

  async signDownload(path: string, ttlSeconds: number): Promise<string> {
    const { signedURL } = await this.call<{ signedURL: string }>('POST', `/object/sign/${this.objectPath(path)}`, { expiresIn: ttlSeconds });
    return `${this.base}${signedURL.startsWith('/') ? '' : '/'}${signedURL}`;
  }

  async signDownloads(paths: string[], ttlSeconds: number): Promise<string[]> {
    if (paths.length === 0) return [];
    const rows = await this.call<Array<{ path: string; signedURL: string | null; error: string | null }>>('POST', `/object/sign/${encodeURIComponent(this.opts.bucket)}`, { expiresIn: ttlSeconds, paths });
    const byPath = new Map(rows.map((r) => [r.path, r.signedURL]));
    return paths.map((p) => {
      const signed = byPath.get(p);
      if (!signed) throw new Error(`Supabase Storage could not sign ${p}: ${rows.find((r) => r.path === p)?.error ?? 'not in the answer'}`);
      return `${this.base}${signed.startsWith('/') ? '' : '/'}${signed}`;
    });
  }

  async delete(path: string): Promise<void> {
    await this.call('DELETE', `/object/${encodeURIComponent(this.opts.bucket)}`, { prefixes: [path] });
  }

  async putFromUrl(url: string, path: string): Promise<void> {
    const res = await this.fetch(url);
    if (!res.ok) throw new Error(`could not fetch ${url}: ${res.status}`);
    const bytes = new Blob([await res.arrayBuffer()]);
    await this.call('POST', `/object/${this.objectPath(path)}`, bytes, { 'content-type': res.headers.get('content-type') ?? 'application/octet-stream', 'x-upsert': 'true' });
  }
}
