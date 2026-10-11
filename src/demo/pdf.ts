// HTML to PDF for the demo's ticket files, with puppeteer-core and the machine's own Chromium (no browser download):
// PUPPETEER_EXECUTABLE_PATH names it (/usr/bin/chromium on Railway, the local Chrome on a Mac). One browser is shared,
// launched on the first render, launched again if it dies, and closed after ten minutes without a render. With no
// Chromium the PDFs are off: renderPdf answers null, says so once in the log, and the booking stands without a file.
import puppeteer, { type Browser } from 'puppeteer-core';

export interface RenderedPdf { bytes: Buffer; pages: number }
export type PdfRenderer = (html: string) => Promise<RenderedPdf | null>;

const LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'];
const RENDER_TIMEOUT_MS = 15_000;
const IDLE_MS = 10 * 60_000;

let browser: Promise<Browser> | null = null;
let idle: NodeJS.Timeout | undefined;
let active = 0;
let saidOff = false;
let renderer: PdfRenderer | undefined;

/** Puts another renderer in place of Chromium (the tests' fake); undefined puts Chromium back. */
export function setPdfRenderer(fn: PdfRenderer | undefined): void {
  renderer = fn;
}

/** The startup log's words: which Chromium renders the ticket PDFs, or that they are off. */
export const pdfStatus = (): string => (process.env.PUPPETEER_EXECUTABLE_PATH ? `chromium ${process.env.PUPPETEER_EXECUTABLE_PATH}` : 'off');

const off = (why: string, err?: unknown) => {
  if (saidOff) return;
  saidOff = true;
  console.error(`[tickets] ${why}: PDFs off`, err instanceof Error ? err.message : err ?? '');
};

function launched(executablePath: string): Promise<Browser> {
  if (!browser) {
    const starting = puppeteer.launch({ executablePath, headless: true, args: LAUNCH_ARGS });
    browser = starting;
    starting.then(
      (b) => b.on('disconnected', () => { if (browser === starting) browser = null; }),
      () => { if (browser === starting) browser = null; },
    );
  }
  return browser;
}

/** Closes the shared browser now (a shutdown, a test); the next render launches a new one. */
export async function closePdfBrowser(): Promise<void> {
  clearTimeout(idle);
  const b = browser;
  browser = null;
  await b?.then((x) => x.close()).catch(() => {});
}

/** The number of pages in a PDF: its page objects (`/Type /Page`, not `/Pages`). */
export const pdfPages = (bytes: Buffer): number => Math.max(1, (bytes.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length);

const within = <T>(ms: number, work: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`the PDF took longer than ${ms / 1000} s`)), ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
};

/**
 * One A4 PDF of `html`, backgrounds printed. Null when there is no Chromium (no PUPPETEER_EXECUTABLE_PATH, or it does
 * not launch). A render that fails or takes more than 15 seconds throws.
 */
export async function renderPdf(html: string): Promise<RenderedPdf | null> {
  if (renderer) return renderer(html);
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (!executablePath) {
    off('no chromium');
    return null;
  }
  let b: Browser;
  try {
    b = await launched(executablePath);
  } catch (err) {
    off(`no chromium (${executablePath} did not launch)`, err);
    return null;
  }
  clearTimeout(idle);
  active++;
  try {
    const page = await b.newPage();
    try {
      return await within(RENDER_TIMEOUT_MS, (async () => {
        await page.setContent(html, { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS });
        const bytes = Buffer.from(await page.pdf({ format: 'A4', printBackground: true, timeout: RENDER_TIMEOUT_MS }));
        return { bytes, pages: pdfPages(bytes) };
      })());
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    // The idle clock starts when the last render ends.
    if (--active === 0) {
      clearTimeout(idle);
      idle = setTimeout(() => void closePdfBrowser(), IDLE_MS);
      idle.unref();
    }
  }
}

/**
 * The startup proof that ticket PDFs work on this machine: one tiny real render (₹ included), so a deploy shows
 * `ticket pdfs: ok` or why not in its first lines instead of on the first paid booking. Never throws.
 */
export async function pdfSelfTest(): Promise<string> {
  if (renderer) return 'ok (test renderer)';
  const started = Date.now();
  try {
    const pdf = await renderPdf('<html><body style="font-family: \'Noto Sans\', \'DejaVu Sans\', sans-serif"><p>Go ticket check ₹1</p></body></html>');
    if (!pdf) return `FAILED: no chromium at ${process.env.PUPPETEER_EXECUTABLE_PATH ?? '(PUPPETEER_EXECUTABLE_PATH not set)'}`;
    if (!pdf.bytes.subarray(0, 5).toString('latin1').startsWith('%PDF')) return 'FAILED: the render is not a PDF';
    return `ok: chromium ${process.env.PUPPETEER_EXECUTABLE_PATH}, a test PDF in ${Date.now() - started} ms (${pdf.bytes.length} bytes)`;
  } catch (err) {
    return `FAILED: ${err instanceof Error ? err.message : String(err)}`;
  }
}

