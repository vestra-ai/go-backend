// Where files live (app contract §4.5): photos, voice notes and ticket PDFs the app uploads, and the booking
// documents and call recordings the server copies from Go's links. The app never sends bytes through the
// server: it PUTs them to a signed upload URL, and every link the app reads is a signed download URL minted at read
// time.
import type { FastifyInstance } from 'fastify';

export interface SignedUpload {
  /** Where the app PUTs the bytes. */
  url: string;
  /** The headers the PUT must carry. */
  headers: Record<string, string>;
  expires_at: string;
}

/** What a copy from a link may be: at most `maxBytes`, and a MIME type `allow` accepts. */
export interface CopyLimits {
  maxBytes: number;
  allow: (mime: string) => boolean;
}

/** What a copy from a link turned out to be. */
export interface Copied {
  mime: string;
  size_bytes: number;
}

export interface Storage {
  /** A one-off URL the app may PUT one file to, at `path`, with this MIME type and at most `sizeBytes` bytes. */
  signUpload(path: string, mime: string, sizeBytes: number): Promise<SignedUpload>;
  /** A link to read the file at `path`, valid `ttlSeconds`. */
  signDownload(path: string, ttlSeconds: number): Promise<string>;
  /** Links for several files at once (one round trip where the backend allows it). Same order as `paths`. */
  signDownloads(paths: string[], ttlSeconds: number): Promise<string[]>;
  delete(path: string): Promise<void>;
  /** Stores these bytes at `path`, replacing a file already there (the demo's ticket PDFs, rendered by the server itself). */
  put(path: string, bytes: Buffer, mime: string): Promise<void>;
  /** Copies the file behind `url` into Storage at `path` (booking documents, call recordings), within `limits` when given. */
  putFromUrl(url: string, path: string, limits?: CopyLimits): Promise<Copied>;
  /** Routes the storage serves itself (the in-process fake's upload and download endpoints). */
  attach?(app: FastifyInstance): void;
}

/** How long a download link the app reads is good for (app contract §4.5: one hour, minted when read). */
export const DOWNLOAD_TTL_SECONDS = 3600;

/**
 * Fetches a file for a copy, refusing one over the size or outside the allowed types before the bytes are kept. The
 * declared length is checked first (so a large file is refused without reading it), the real length after.
 */
export async function fetchForCopy(url: string, limits: CopyLimits | undefined, fetchFn: typeof fetch = globalThis.fetch): Promise<{ bytes: Buffer; mime: string }> {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`could not fetch ${url}: ${res.status}`);
  const mime = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase();
  if (limits && !limits.allow(mime)) throw new Error(`${mime} is not an allowed type for this copy`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (limits && declared > limits.maxBytes) throw new Error(`the file is ${declared} bytes; at most ${limits.maxBytes}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (limits && bytes.length > limits.maxBytes) throw new Error(`the file is ${bytes.length} bytes; at most ${limits.maxBytes}`);
  return { bytes, mime };
}
