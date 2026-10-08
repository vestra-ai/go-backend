import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { SIGNATURE_HEADER, verifyRequest } from '../../src/contract/index.js';

type Frame = Record<string, any>;

const NOW = () => new Date().toISOString();

/** One of Go's own cards, as the fake Go sends them: each matches the contract's schema for its kind. */
export function fakeCard(kind: 'options' | 'working' | 'call' | 'pay' | 'notice', cardId: string, payerId: string): Frame {
  const base = { card_id: cardId, kind };
  switch (kind) {
    case 'options':
      return { ...base, fallback_text: '3 flights to Goa on Friday', title: 'Flights to Goa', option_kind: 'flight', checked_at: NOW(),
        options: [{ option_id: 'opt_fl_1', title: 'IndiGo 6E 2134', price_minor: 592000, currency: 'INR', highlights: ['Non-stop'] }],
        actions: [{ action_id: 'pick', label: 'Pick', style: 'primary', per_option: true }] };
    case 'working':
      return { ...base, fallback_text: 'Go is comparing villas', task_id: `task_${cardId}`, title: 'Comparing villas', state: 'running',
        steps: [{ text: 'Searching 30 villas', state: 'doing' }], updated_at: NOW(), actions: [{ action_id: 'stop', label: 'Stop', style: 'secondary' }] };
    case 'call':
      return { ...base, fallback_text: 'Go is calling Villa Sol', call_id: `call_${cardId}`, business: 'Villa Sol', goal: 'Ask about late check-in',
        state: 'dialing', actions: [{ action_id: 'stop', label: 'Stop', style: 'secondary' }] };
    case 'pay':
      return { ...base, fallback_text: 'Approve ₹54,200 for Villa Sol', for_person_ids: [payerId], approval_id: `ap_fake_${cardId}`, payer_person_id: payerId,
        amount_minor: 5420000, currency: 'INR', merchant: 'ixigo', purpose: 'Villa Sol, 3 nights', expires_at: new Date(Date.now() + 600_000).toISOString(),
        state: 'waiting', actions: [{ action_id: 'approve', label: 'Approve', style: 'primary', only_for_person_ids: [payerId] }, { action_id: 'decline', label: 'Not now', style: 'secondary', only_for_person_ids: [payerId] }] };
    case 'notice':
      return { ...base, fallback_text: 'Heads up: fares are rising', tone: 'heads_up', title: 'Fares are rising', body: 'Friday fares went up 8% today.' };
  }
}

/** Go's chips under a message (GO-CHANGES 1.3), as the fake Go sends them with post_message. */
export const fakeQuickReplies = () => [{ label: '🏖️ Beach', text: 'Beach' }, { label: '⛰️ Mountains', text: 'Mountains' }, { label: 'Not sure, suggest some' }];

/** A location Go shares (GO-CHANGES 1.6), and a voice note with its length: the 1.1 attachment shapes. */
export const fakeLocation = () => ({ kind: 'location', lat: 15.5736, lng: 73.7407, name: 'Anjuna Beach', address: 'Anjuna, Goa' });
export const fakeVoiceNote = (url = 'https://files.example/note.m4a') => ({ kind: 'file', url, name: 'note.m4a', mime: 'audio/mp4', size_bytes: 48213, duration_s: 12 });

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
  /**
   * Behave like Keshav's fake Go (guides: "Work without the other side"): when a message.created mentions Go,
   * send `typing`, then `read_trip`, add a ✅ with `add_reaction`, and `post_message` a reply with one of Go's
   * own cards, a different kind each time (options, working, call, pay, notice). Off unless a test turns it on.
   */
  fakeGo = false;
  /** What the fake Go did, in order, for tests to check: one entry per reply. */
  readonly replies: Array<{ trip_id: string; to_message_id: string; card_kind: string; reply: Frame }> = [];
  private seenEvents = new Set<string>();
  private cardTurn = 0;
  private http!: Server;
  private wss = new WebSocketServer({ noServer: true });
  private used = new Set<string>();
  private sockets = new Set<WebSocket>();
  private waiting = new Map<string, (f: Frame) => void>();
  private n = 0;

  async listen(port = 0): Promise<string> {
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
    await new Promise<void>((r) => this.http.listen(port, r));
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
        let body: Frame | null;
        if (f.method === 'send_event' && this.fakeGo) {
          // The fake Go answers duplicate: true for an event_id it has seen, and reacts to messages that name it.
          const dup = this.seenEvents.has(f.params.event_id);
          this.seenEvents.add(f.params.event_id);
          body = { result: { accepted: true, duplicate: dup } };
          const m = f.params.data?.message;
          if (!dup && f.params.type === 'message.created' && m?.mentions_go && m.author?.kind === 'person') {
            setTimeout(() => void this.answerMention(f.params.trip_id, m.message_id).catch((err) => console.error('[fake go]', err)), 0);
          }
        } else {
          const answer = this.answers[f.method];
          // A handler that returns null never answers (Go is silent); a method with no handler is unknown.
          body = f.method === 'send_event' ? await this.onEvent(f.params) : answer ? answer(f.params) : { error: { code: -32601, message: `unknown method ${f.method}` } };
        }
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

  /** The fake Go's answer to a message that names it. */
  private async answerMention(tripId: string, messageId: string): Promise<void> {
    this.notify('typing', { trip_id: tripId, on: true });
    const snap = await this.call('read_trip', { trip_id: tripId });
    if (snap.error) throw new Error(`read_trip: ${JSON.stringify(snap.error)}`);
    const n = ++this.n;
    await this.call('add_reaction', { request_id: `rq_fake_react_${n}`, trip_id: tripId, message_id: messageId, emoji: '✅' });
    const kinds = ['options', 'working', 'call', 'pay', 'notice'] as const;
    const kind = kinds[this.cardTurn++ % kinds.length]!;
    const payer = snap.result.people[0].person_id as string;
    const reply = await this.call('post_message', {
      request_id: `rq_fake_reply_${n}`,
      trip_id: tripId,
      text: `On it! Here is a ${kind} card.`,
      reply_to: messageId,
      card: fakeCard(kind, `c_fake_${n}`, payer),
    });
    if (reply.error) throw new Error(`post_message: ${JSON.stringify(reply.error)}`);
    this.replies.push({ trip_id: tripId, to_message_id: messageId, card_kind: kind, reply: reply.result });
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
