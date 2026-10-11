// The Server's end of the socket to Go. Ported from the reference GoSocket in guides/socket.md.
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  IDLE_CLOSE_SECONDS,
  MAX_FRAME_BYTES,
  RECONNECT_BACKOFF_SECONDS,
  SIGNATURE_HEADER,
  parseParams,
  signRequest,
} from '../contract/index.js';

export class SocketCallError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly dataCode?: string,
    readonly retryAfterSeconds: number | undefined = undefined,
  ) {
    super(message);
  }
}
export class SocketTimeoutError extends Error {}

/** `params` is the checked params (nulls dropped); `raw` is the frame's params exactly as they arrived. */
export type Handler = (params: any, raw: Record<string, unknown>) => Promise<object | void>;

interface Pending {
  frame: string;
  method: string;
  sentAt: number;
  tripId?: string;
  resolve: (result: object) => void;
  reject: (err: Error) => void;
}

export interface GoSocketOptions {
  /** The full socket URL, with any query string, such as wss://brain.go.example/v1/socket?instance=server-1 */
  url: string;
  secret: string;
  handlers: Record<string, Handler>;
  log?: (msg: string) => void;
  /** Called for every frame and answer on the socket, for a traffic log while testing. Never sees the signature header. */
  traffic?: (entry: TrafficEntry) => void;
}

export interface TrafficEntry {
  /** `go_request`/`go_notify`: Go asked us; `our_answer`: what we answered; `our_request`: we asked Go; `go_answer`: Go answered us. */
  kind: 'go_request' | 'go_notify' | 'our_answer' | 'our_request' | 'go_answer' | 'socket' | 'bad_frame';
  method?: string;
  id?: unknown;
  trip_id?: string;
  request_id?: string;
  ms?: number;
  ok?: boolean;
  error?: { code: number; message?: string; data_code?: string };
  params?: unknown;
  result_bytes?: number;
  note?: string;
}

/**
 * A copy for the traffic log with every `live_url` blanked: the link to Go's live view of its screen carries its token,
 * and for 15 minutes anyone holding it can watch. It reaches the app on its card and is written nowhere else.
 */
export function withoutLiveLinks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutLiveLinks);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'live_url' && typeof v === 'string' ? '[not logged]' : withoutLiveLinks(v)]));
}

/** The same for a frame that could not be read as JSON-RPC, where only its text is at hand. */
const withoutLiveLinksText = (raw: string): string => raw.replace(/("live_url"\s*:\s*")(?:[^"\\]|\\.)*/g, '$1[not logged]');

export class GoSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly opts: GoSocketOptions) {}

  private trace(entry: TrafficEntry): void {
    if (!this.opts.traffic) return;
    try {
      this.opts.traffic(entry.params === undefined ? entry : { ...entry, params: withoutLiveLinks(entry.params) });
    } catch {
      // a broken traffic log must never break the socket
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    if (this.stopped) return;
    const { pathname, search } = new URL(this.opts.url);
    // A fresh signature on every connect: Go accepts each signature once.
    const signature = signRequest({ method: 'GET', target: pathname + search, body: '' }, this.opts.secret);
    const ws = new WebSocket(this.opts.url, { headers: { [SIGNATURE_HEADER]: signature }, maxPayload: MAX_FRAME_BYTES, handshakeTimeout: 10_000 });
    let idle: NodeJS.Timeout | undefined;
    const heard = () => {
      clearTimeout(idle);
      idle = setTimeout(() => ws.terminate(), IDLE_CLOSE_SECONDS * 1000);
    };
    ws.on('open', () => {
      this.ws = ws;
      this.attempt = 0;
      heard();
      this.opts.log?.('go socket open');
      this.trace({ kind: 'socket', note: `open ${pathname}${search}; resending ${this.pending.size} unanswered` });
      for (const p of this.pending.values()) ws.send(p.frame); // unanswered requests go again, same ids
    });
    ws.on('ping', heard);
    ws.on('message', (data) => {
      heard();
      void this.onFrame(ws, data.toString());
    });
    // No 'unexpected-response' listener: with one, ws does not abort a refused upgrade (a 401) and never closes,
    // so the reconnect never runs. Without it the 401 becomes an 'error' and then 'close'.
    ws.on('error', (err) => {
      this.opts.log?.(`go socket error: ${err.message}`);
      this.trace({ kind: 'socket', note: `error: ${err.message}` });
    }); // 'close' always follows
    ws.on('close', (code, reason) => {
      this.trace({ kind: 'socket', note: `close ${code} ${reason.toString()}`.trim() });
      clearTimeout(idle);
      if (this.ws === ws) this.ws = null;
      if (this.stopped) return;
      const wait = RECONNECT_BACKOFF_SECONDS[Math.min(this.attempt++, RECONNECT_BACKOFF_SECONDS.length - 1)]!;
      this.timer = setTimeout(() => this.start(), wait * 1000);
    });
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.terminate();
    for (const p of this.pending.values()) p.reject(new SocketTimeoutError('socket stopped'));
    this.pending.clear();
  }

  request(method: string, params: object, { timeoutMs = 2000 } = {}): Promise<object> {
    const id = `gs_${randomUUID()}`;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.trace({ kind: 'go_answer', method, id, trip_id: (params as Record<string, unknown>).trip_id as string | undefined, ok: false, ms: timeoutMs, note: 'no answer in time' });
        reject(new SocketTimeoutError(`${method}: no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      const settle = () => (clearTimeout(timer), this.pending.delete(id));
      const sentAt = Date.now();
      const p = params as Record<string, unknown>;
      this.trace({ kind: 'our_request', method, id, trip_id: p.trip_id as string | undefined, params: method === 'send_event' ? { type: p.type, seq: p.seq, event_id: p.event_id } : params });
      this.pending.set(id, { frame, method, sentAt, tripId: p.trip_id as string | undefined, resolve: (r) => (settle(), resolve(r)), reject: (e) => (settle(), reject(e)) });
      if (this.connected) this.ws!.send(frame); // while disconnected, 'open' sends it
    });
  }

  notify(method: string, params: object): void {
    if (this.connected) this.ws!.send(JSON.stringify({ jsonrpc: '2.0', method, params })); // dropped while disconnected
  }

  private async onFrame(ws: WebSocket, raw: string): Promise<void> {
    let frame: any;
    try {
      frame = JSON.parse(raw);
      if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('not a frame');
    } catch {
      this.trace({ kind: 'bad_frame', note: withoutLiveLinksText(raw).slice(0, 500) });
      return ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'cannot read the frame' } }));
    }
    if (frame.jsonrpc !== '2.0' || (typeof frame.method !== 'string' && !('result' in frame) && !('error' in frame))) {
      this.trace({ kind: 'bad_frame', note: withoutLiveLinksText(raw).slice(0, 500) });
      // Neither a request, a notification nor an answer: not a JSON-RPC frame.
      return ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'not a JSON-RPC 2.0 frame' } }));
    }
    if (typeof frame.method !== 'string') {
      // the answer to one of your requests (an answer with an id we no longer wait for is ignored)
      const p = this.pending.get(frame.id);
      this.trace({
        kind: 'go_answer', method: p?.method, id: frame.id, trip_id: p?.tripId, ok: !frame.error, ms: p ? Date.now() - p.sentAt : undefined,
        ...(frame.error ? { error: { code: frame.error.code, message: frame.error.message, data_code: frame.error.data?.code } } : { params: p?.method === 'send_event' ? frame.result : undefined, result_bytes: raw.length }),
        ...(p ? {} : { note: 'answer to an id we no longer wait for' }),
      });
      if (!frame.error) return p?.resolve(frame.result);
      const { code, message, data } = frame.error;
      return p?.reject(new SocketCallError(code, message, data?.code, data?.retry_after_seconds ?? undefined));
    }
    const handler = this.opts.handlers[frame.method];
    const check = parseParams(frame.method, frame.params);
    const fp = (frame.params ?? {}) as Record<string, unknown>;
    const started = Date.now();
    this.trace({ kind: frame.id === undefined ? 'go_notify' : 'go_request', method: frame.method, id: frame.id, trip_id: fp.trip_id as string | undefined, request_id: fp.request_id as string | undefined, params: frame.params, ...(check.ok ? {} : { ok: false, note: `params refused: ${check.message}` }) });
    if (frame.id === undefined) {
      // a notification: never answered
      if (!check.ok) this.opts.log?.(`notification ${frame.method} dropped: ${check.message}`);
      if (handler && check.ok) await handler(check.value, frame.params).catch(() => {});
      return;
    }
    const answer = (body: { result?: object; error?: { code: number; message: string; data?: { code?: string } } }) => {
      const text = JSON.stringify({ jsonrpc: '2.0', id: frame.id, ...body });
      this.trace({
        kind: 'our_answer', method: frame.method, id: frame.id, trip_id: fp.trip_id as string | undefined, request_id: fp.request_id as string | undefined,
        ms: Date.now() - started, ok: !body.error, result_bytes: text.length,
        ...(body.error ? { error: { code: body.error.code, message: body.error.message, data_code: body.error.data?.code } } : {}),
        ...(ws.readyState === WebSocket.OPEN ? {} : { note: 'socket closed before we could answer' }),
      });
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    };
    try {
      if (!handler) throw new SocketCallError(-32601, `unknown method ${frame.method}`);
      if (!check.ok) throw new SocketCallError(422, check.message, 'invalid');
      answer({ result: (await handler(check.value, frame.params)) ?? {} });
    } catch (err) {
      const e = err instanceof SocketCallError ? err : new SocketCallError(500, 'internal error', 'internal');
      if (!(err instanceof SocketCallError)) this.opts.log?.(`handler ${frame.method} failed: ${(err as Error).stack ?? err}`);
      const data = e.dataCode ? { data: { code: e.dataCode, retry_after_seconds: e.retryAfterSeconds } } : {};
      const message = e.message.slice(0, 500);
      // Every refusal is printed, in production too (there is no traffic log there): ids, the code, the field and our
      // own message. Never the params, which carry names and words.
      const field = (err as { field?: string | null }).field;
      console.warn(`[go] ${frame.method} answered ${e.code} trip=${fp.trip_id ?? '-'} request=${fp.request_id ?? '-'}${field ? ` field=${field}` : ''}: ${message}`);
      answer({ error: { code: e.code, message, ...data } });
    }
  }
}
