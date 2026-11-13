import { CLOSE_AUTH, CLOSE_FULL, CLOSE_KICKED, CLOSE_REPLACED, MAX_MSG_BYTES } from '../../shared/protocol';
import type { ClientMsg, GateReply, Net, SearchReply, ServerEvents } from './types';

type Handlers = { [K in keyof ServerEvents]?: Array<(v: ServerEvents[K]) => void> };

export class Emitter {
  private h: Handlers = {};
  on<K extends keyof ServerEvents>(k: K, f: (v: ServerEvents[K]) => void): () => void {
    ((this.h[k] ??= []) as Array<(v: ServerEvents[K]) => void>).push(f);
    return () => { this.h[k] = (this.h[k] as Array<(v: ServerEvents[K]) => void>).filter((x) => x !== f) as never; };
  }
  emit<K extends keyof ServerEvents>(k: K, v: ServerEvents[K]): void {
    (this.h[k] as Array<(v: ServerEvents[K]) => void> | undefined)?.slice().forEach((f) => f(v));
  }
}

/** Per-tab id: sessionStorage survives a refresh but is never shared with other tabs, so each tab is its own player. */
function tabId(): string {
  try {
    let t = sessionStorage.getItem('tab');
    if (!t || !/^[0-9a-f]{16}$/.test(t)) {
      t = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
      sessionStorage.setItem('tab', t);
    }
    return t;
  } catch { return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join(''); }
}

/** Real network client: HTTP for gate/search/ice, WebSocket for the room. */
export class WsNet extends Emitter implements Net {
  private ws: WebSocket | null = null;
  private tries = 0;
  private timer = 0;
  private lostTimer = 0;
  private closed = false;
  private pongTimer = 0;
  private livenessOn = false;

  async gate(pass: string): Promise<GateReply> {
    try {
      const r = await fetch('/api/auth', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phrase: pass }),
      });
      if (r.ok) return { ok: true };
      const j = (await r.json().catch(() => ({}))) as { wait?: number };
      // Only 401/429 mean "wrong phrase / wait"; 403 (origin), 503 (config), 5xx are service problems, not the user's typing.
      return { ok: false, wait: typeof j.wait === 'number' ? j.wait : undefined, net: r.status !== 401 && r.status !== 429 };
    } catch { return { ok: false, net: true }; }
  }

  async hasSession(): Promise<boolean> {
    try { return (await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' })).ok; } catch { return false; }
  }

  /** Detach and close the current socket so its late events can never reach the app (H3). */
  private dropSocket(): void {
    const old = this.ws;
    this.ws = null;
    clearTimeout(this.pongTimer); this.pongTimer = 0;
    if (!old) return;
    old.onopen = null; old.onmessage = null; old.onclose = null; old.onerror = null;
    try { old.close(); } catch { /* already closed */ }
  }

  /** Liveness (H4): ping every 25 s and on resume/online; no pong within 3 s means a zombie socket, reconnect. */
  private installLiveness(): void {
    if (this.livenessOn) return;
    this.livenessOn = true;
    const check = () => { if (!this.closed && document.visibilityState !== 'hidden') this.probe(); };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('pageshow', check);
    window.addEventListener('online', check);
    window.setInterval(check, 25_000);
  }

  private probe(): void {
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      // Dead socket without a pending retry (e.g. the close event never fired while backgrounded).
      if (!this.timer) this.retryNow();
      return;
    }
    if (ws.readyState !== WebSocket.OPEN || this.pongTimer) return;
    ws.send(JSON.stringify({ t: 'ping' } satisfies ClientMsg));
    this.pongTimer = window.setTimeout(() => {
      this.pongTimer = 0;
      if (ws === this.ws && !this.closed) this.retryNow();
    }, 3_000);
  }

  connect(): void {
    this.closed = false;
    clearTimeout(this.timer); this.timer = 0;
    this.dropSocket(); // never two live sockets
    this.installLiveness();
    this.emit('status', this.tries ? 'retrying' : 'connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/ws?t=${tabId()}`);
    this.ws = ws;
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.tries = 0; clearTimeout(this.lostTimer); this.lostTimer = 0; this.emit('status', 'open');
    };
    ws.onmessage = (e) => {
      if (ws !== this.ws) return;
      if (typeof e.data !== 'string' || e.data.length > MAX_MSG_BYTES * 8) return;
      let m: { t?: string } & Record<string, unknown>;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'pong') { clearTimeout(this.pongTimer); this.pongTimer = 0; return; }
      if (m.t === 'view') this.emit('view', m.view as never);
      else if (m.t === 'signal') this.emit('signal', { from: String(m.from), data: m.data });
      else if (m.t === 'event') this.emit('event', m as never);
      else if (m.t === 'hint') this.emit('hint', m as never);
      else if (m.t === 'joke') this.emit('joke', m as never);
      else if (m.t === 'scoreboard') this.emit('scoreboard', m as never);
      else if (m.t === 'chat') this.emit('chat', m as never);
      else if (m.t === 'chatHistory') this.emit('chatHistory', m as never);
      else if (m.t === 'notice') this.emit('notice', m as never);
      else if (m.t === 'error') this.emit('error', { code: String(m.code), detail: typeof m.detail === 'string' ? m.detail : undefined });
    };
    ws.onclose = (e) => {
      if (ws !== this.ws || this.closed) return;
      this.ws = null;
      clearTimeout(this.pongTimer); this.pongTimer = 0;
      const end = (s: 'expired' | 'full' | 'kicked' | 'replaced') => { this.closed = true; clearTimeout(this.lostTimer); this.lostTimer = 0; this.emit('status', s); };
      if (e.code === CLOSE_AUTH) { end('expired'); return; }
      if (e.code === CLOSE_FULL) { end('full'); return; }
      if (e.code === CLOSE_KICKED) { end('kicked'); return; }
      if (e.code === CLOSE_REPLACED) { end('replaced'); return; }
      this.tries++;
      this.emit('status', 'retrying');
      // The "lost" banner counts from the first failure, not from every retry.
      if (!this.lostTimer) this.lostTimer = window.setTimeout(() => this.emit('status', 'lost'), 30000);
      this.timer = window.setTimeout(() => { this.timer = 0; this.connect(); }, Math.min(10000, 500 * 2 ** this.tries));
    };
  }

  retryNow(): void { clearTimeout(this.timer); this.timer = 0; this.tries = 0; this.connect(); }

  send(m: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  async search(q: string): Promise<SearchReply> {
    try {
      const r = await fetch(`/api/search?q=${encodeURIComponent(q.slice(0, 80))}`, { credentials: 'same-origin' });
      if (r.status === 429) {
        const j = (await r.json().catch(() => ({}))) as { retryAfter?: number };
        return { ok: false, reason: 'rate', retryAfter: j.retryAfter ?? 10 };
      }
      if (r.status === 403) return { ok: false, reason: 'quota' };
      if (!r.ok) return { ok: false, reason: 'network' };
      const j = (await r.json()) as { results: Array<{ videoId: string; title: string; thumb: string }> };
      return { ok: true, results: j.results };
    } catch { return { ok: false, reason: 'network' }; }
  }

  async iceServers(): Promise<RTCIceServer[]> {
    const stun: RTCIceServer = { urls: 'stun:stun.cloudflare.com:3478' };
    try {
      const r = await fetch('/api/ice', { credentials: 'same-origin' });
      if (!r.ok) return [stun];
      const j = (await r.json()) as { iceServers?: RTCIceServer[] };
      return j.iceServers?.length ? j.iceServers : [stun];
    } catch { return [stun]; }
  }

  close(): void { this.closed = true; clearTimeout(this.timer); this.timer = 0; clearTimeout(this.lostTimer); this.lostTimer = 0; this.dropSocket(); }
}
