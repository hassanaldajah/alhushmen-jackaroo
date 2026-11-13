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

/** Real network client: HTTP for gate/search/ice, WebSocket for the room. */
export class WsNet extends Emitter implements Net {
  private ws: WebSocket | null = null;
  private tries = 0;
  private timer = 0;
  private lostTimer = 0;
  private closed = false;

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

  connect(): void {
    this.closed = false;
    this.emit('status', this.tries ? 'retrying' : 'connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/ws`);
    this.ws = ws;
    ws.onopen = () => { this.tries = 0; clearTimeout(this.lostTimer); this.emit('status', 'open'); };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string' || e.data.length > MAX_MSG_BYTES * 8) return;
      let m: { t?: string } & Record<string, unknown>;
      try { m = JSON.parse(e.data); } catch { return; }
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
      if (this.closed) return;
      if (e.code === CLOSE_AUTH) { this.emit('status', 'expired'); return; }
      if (e.code === CLOSE_FULL) { this.emit('status', 'full'); return; }
      if (e.code === CLOSE_KICKED) { this.emit('status', 'kicked'); return; }
      if (e.code === CLOSE_REPLACED) { this.emit('status', 'replaced'); return; }
      this.tries++;
      this.emit('status', 'retrying');
      clearTimeout(this.lostTimer);
      this.lostTimer = window.setTimeout(() => this.emit('status', 'lost'), 30000);
      this.timer = window.setTimeout(() => this.connect(), Math.min(10000, 500 * 2 ** this.tries));
    };
  }

  retryNow(): void { clearTimeout(this.timer); this.tries = 0; this.connect(); }

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

  close(): void { this.closed = true; clearTimeout(this.timer); this.ws?.close(); }
}
