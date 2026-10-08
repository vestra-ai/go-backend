import { WebSocket } from 'ws';
import type { Harness } from './harness.js';

export type Frame = Record<string, any>;

/** The app's end of the live socket (app contract §3), for tests: a ticket, the socket, and the frames it received. */
export class LiveClient {
  readonly frames: Frame[] = [];
  closeCode: number | undefined;
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => this.frames.push(JSON.parse(d.toString())));
    ws.on('close', (code) => (this.closeCode = code));
  }

  /** Signs in as `personId`, takes a ticket and connects. `ticket` overrides the ticket (for the reuse and expiry tests). */
  static async open(h: Harness, personId: string, opts: { device_id?: string; ticket?: string; pong?: boolean } = {}): Promise<LiveClient> {
    const base = await h.listen();
    let ticket = opts.ticket;
    if (!ticket) {
      const r = await h.app.inject({ method: 'POST', url: '/app/v1/live/ticket', payload: opts.device_id ? { device_id: opts.device_id } : {}, headers: { authorization: `Bearer ${await h.token(personId)}` } });
      if (r.statusCode !== 201) throw new Error(`no ticket: ${r.body}`);
      ticket = JSON.parse(r.body).ticket;
    }
    const ws = new WebSocket(`${base.replace('http', 'ws')}/app/v1/live?ticket=${ticket}`);
    const client = new LiveClient(ws);
    if (opts.pong !== false) ws.on('message', (d) => JSON.parse(d.toString()).type === 'ping' && ws.send(JSON.stringify({ type: 'pong' })));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return client;
  }

  send(frame: Frame): void {
    this.ws.send(JSON.stringify(frame));
  }

  subscribe(tripId: string, sinceSeq = 0): void {
    this.send({ type: 'subscribe', trips: [{ trip_id: tripId, since_seq: sinceSeq }] });
  }

  /** Waits for a frame that matches, or fails after `ms`. */
  async until(pick: (f: Frame) => boolean, ms = 5000): Promise<Frame> {
    const end = Date.now() + ms;
    for (;;) {
      const hit = this.frames.find(pick);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`no frame matched; got ${JSON.stringify(this.frames.map((f) => f.type))}`);
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  /** Waits for the socket to close, or fails after `ms`. */
  async closed(ms = 5000): Promise<number> {
    const end = Date.now() + ms;
    while (this.closeCode === undefined) {
      if (Date.now() > end) throw new Error('the socket did not close');
      await new Promise((r) => setTimeout(r, 15));
    }
    return this.closeCode;
  }

  /** Frames of one type received so far. */
  of(type: string): Frame[] {
    return this.frames.filter((f) => f.type === type);
  }

  close(): void {
    this.ws.close();
  }
}

/** A short pause for frames to land. */
export const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
