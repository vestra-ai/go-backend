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
  resolve: (result: object) => void;
  reject: (err: Error) => void;
}

export interface GoSocketOptions {
  /** The full socket URL, with any query string, such as wss://brain.go.example/v1/socket?instance=server-1 */
  url: string;
  secret: string;
  handlers: Record<string, Handler>;
  log?: (msg: string) => void;
}

export class GoSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly opts: GoSocketOptions) {}

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
      for (const p of this.pending.values()) ws.send(p.frame); // unanswered requests go again, same ids
    });
    ws.on('ping', heard);
    ws.on('message', (data) => {
      heard();
      void this.onFrame(ws, data.toString());
    });
    // No 'unexpected-response' listener: with one, ws does not abort a refused upgrade (a 401) and never closes,
    // so the reconnect never runs. Without it the 401 becomes an 'error' and then 'close'.
    ws.on('error', (err) => this.opts.log?.(`go socket error: ${err.message}`)); // 'close' always follows
    ws.on('close', () => {
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
        reject(new SocketTimeoutError(`${method}: no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      const settle = () => (clearTimeout(timer), this.pending.delete(id));
      this.pending.set(id, { frame, resolve: (r) => (settle(), resolve(r)), reject: (e) => (settle(), reject(e)) });
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
      return ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'cannot read the frame' } }));
    }
    if (typeof frame.method !== 'string') {
      // the answer to one of your requests
      const p = this.pending.get(frame.id);
      if (!frame.error) return p?.resolve(frame.result);
      const { code, message, data } = frame.error;
      return p?.reject(new SocketCallError(code, message, data?.code, data?.retry_after_seconds ?? undefined));
    }
    const handler = this.opts.handlers[frame.method];
    const check = parseParams(frame.method, frame.params);
    if (frame.id === undefined) {
      // a notification: never answered
      if (!check.ok) this.opts.log?.(`notification ${frame.method} dropped: ${check.message}`);
      if (handler && check.ok) await handler(check.value, frame.params).catch(() => {});
      return;
    }
    const answer = (body: object) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, ...body }));
    };
    try {
      if (!handler) throw new SocketCallError(-32601, `unknown method ${frame.method}`);
      if (!check.ok) throw new SocketCallError(422, check.message, 'invalid');
      answer({ result: (await handler(check.value, frame.params)) ?? {} });
    } catch (err) {
      const e = err instanceof SocketCallError ? err : new SocketCallError(500, 'internal error', 'internal');
      if (!(err instanceof SocketCallError)) this.opts.log?.(`handler ${frame.method} failed: ${(err as Error).stack ?? err}`);
      const data = e.dataCode ? { data: { code: e.dataCode, retry_after_seconds: e.retryAfterSeconds } } : {};
      answer({ error: { code: e.code, message: e.message.slice(0, 500), ...data } });
    }
  }
}
