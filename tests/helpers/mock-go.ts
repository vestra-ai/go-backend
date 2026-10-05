import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { SIGNATURE_HEADER, verifyRequest } from '../../src/contract/index.js';

type Frame = Record<string, any>;

/**
 * A stand-in for Go, for tests only: a real WebSocket server that checks the signature on the upgrade
 * (and refuses a signature it has seen before, as Go does), answers send_event, and lets a test send
 * Go's requests to the server and read the answers.
 */
export class MockGo {
  readonly secret = 'test-only-go-signing-secret';
  readonly frames: Frame[] = []; // every frame the server sent us
  readonly events: Frame[] = []; // the params of every send_event
  readonly requests: Array<{ method: string; params: Frame }> = []; // every other request the server sent us
  readonly refused: string[] = [];
  readonly targets: string[] = [];
  /** How each of the server's other requests is answered. A test can replace one: return { error } to refuse, or never answer by returning null. */
  answers: Record<string, (params: Frame) => Frame | null> = {
    card_tap: () => ({ result: { result: 'done', toast: 'Noted. Go will reply in the room.' } }),
    catch_up: () => ({ result: { summary: 'While you were away, Villa Sol won the vote.', items: [{ kind: 'decided', text: 'Villa Sol won, 4 to 1' }] } }),
    get_person: (p) => ({ result: { person_id: p.person_id, carry_over: false, facts: [] } }),
    update_person: () => ({ result: { ok: true } }),
    delete_fact: () => ({ result: { ok: true } }),
    forget_person: () => ({ result: { deleted_facts: 3, remaining_facts: 0 } }),
    vault_link: () => ({ result: { url: 'https://brain.go.example/vault/add-card?link=lk_1', expires_at: '2099-01-01T00:00:00Z' } }),
  };
  /** How send_event is answered. Return an error body to refuse. */
  onEvent: (params: Frame) => Frame | Promise<Frame> = () => ({ result: { accepted: true, duplicate: false } });
  private http!: Server;
  private wss = new WebSocketServer({ noServer: true });
  private used = new Set<string>();
  private sockets = new Set<WebSocket>();
  private waiting = new Map<string, (f: Frame) => void>();
  private n = 0;

  async listen(): Promise<string> {
    this.http = createServer();
    this.http.on('upgrade', (req, socket, head) => {
      const header = String(req.headers[SIGNATURE_HEADER] ?? '');
      const ok = verifyRequest(header, { method: 'GET', target: req.url!, body: '' }, this.secret);
      const fresh = !this.used.has(header);
      if (!ok || !fresh) {
        this.refused.push(!ok ? 'bad_signature' : 'signature already used');
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return socket.destroy();
      }
      this.used.add(header);
      this.targets.push(req.url!);
      this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
    });
    await new Promise<void>((r) => this.http.listen(0, r));
    return `ws://localhost:${(this.http.address() as AddressInfo).port}`;
  }

  private accept(ws: WebSocket) {
    this.sockets.add(ws);
    ws.on('close', () => this.sockets.delete(ws));
    ws.on('message', async (data) => {
      const f: Frame = JSON.parse(data.toString());
      this.frames.push(f);
      if (typeof f.method === 'string' && f.id !== undefined) {
        // a request from the server to Go
        if (f.method === 'send_event') this.events.push(f.params);
        else this.requests.push({ method: f.method, params: f.params });
        const body = f.method === 'send_event' ? await this.onEvent(f.params) : (this.answers[f.method]?.(f.params) ?? { error: { code: -32601, message: `unknown method ${f.method}` } });
        if (body) ws.send(JSON.stringify({ jsonrpc: '2.0', id: f.id, ...body }));
      } else if (f.id !== undefined) {
        this.waiting.get(f.id)?.(f);
        this.waiting.delete(f.id);
      }
    });
  }

  get connected(): boolean {
    return this.sockets.size > 0;
  }

  async untilConnected(ms = 5000): Promise<void> {
    const end = Date.now() + ms;
    while (!this.connected) {
      if (Date.now() > end) throw new Error('the server never connected');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** Go sends a request and waits for the server's answer frame: { result } or { error }. */
  call(method: string, params: Frame, id = `go_${++this.n}`): Promise<Frame> {
    const ws = [...this.sockets][0];
    if (!ws) throw new Error('not connected');
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no answer to ${method}`)), 3000);
      this.waiting.set(id, (f) => (clearTimeout(t), resolve(f)));
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /** Sends raw text, such as a broken frame, and waits for the next frame back. */
  raw(text: string): Promise<Frame> {
    const ws = [...this.sockets][0]!;
    return new Promise((resolve) => {
      const before = this.frames.length;
      const poll = setInterval(() => {
        if (this.frames.length > before) (clearInterval(poll), resolve(this.frames[before]!));
      }, 10);
      ws.send(text);
    });
  }

  notify(method: string, params: Frame): void {
    [...this.sockets][0]!.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  dropSockets(): void {
    for (const s of this.sockets) s.terminate();
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    await new Promise<void>((r) => this.http.close(() => r()));
  }
}
