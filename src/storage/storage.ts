// Where files live (app contract §4.5): photos, voice notes and ticket PDFs the app uploads, and later the booking
// documents the server copies from Go. The app never sends bytes through the server: it PUTs them to a signed upload
// URL, and every link the app reads is a signed download URL minted at read time (ALIGNMENT-REVIEW 3.8).
import type { FastifyInstance } from 'fastify';

export interface SignedUpload {
  /** Where the app PUTs the bytes. */
  url: string;
  /** The headers the PUT must carry. */
  headers: Record<string, string>;
  expires_at: string;
}

export interface Storage {
  /** A one-off URL the app may PUT one file to, at `path`, with this MIME type and at most `sizeBytes` bytes. */
  signUpload(path: string, mime: string, sizeBytes: number): Promise<SignedUpload>;
  /** A link to read the file at `path`, valid `ttlSeconds`. */
  signDownload(path: string, ttlSeconds: number): Promise<string>;
  /** Links for several files at once (one round trip where the backend allows it). Same order as `paths`. */
  signDownloads(paths: string[], ttlSeconds: number): Promise<string[]>;
  delete(path: string): Promise<void>;
  /** Copies the file behind `url` into Storage at `path` (phase 4: booking documents, call recordings). */
  putFromUrl(url: string, path: string): Promise<void>;
  /** Routes the storage serves itself (the in-process fake's upload and download endpoints). */
  attach?(app: FastifyInstance): void;
}

/** How long a download link the app reads is good for (app contract §4.5: one hour, minted when read). */
export const DOWNLOAD_TTL_SECONDS = 3600;
