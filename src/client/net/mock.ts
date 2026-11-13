import { Emitter } from './socket';
import type { ClientMsg, GateReply, Net, RoomView, SearchReply, SeatView } from './types';

/** Local offline mock (use with ?mock on localhost). Accepts any non-empty phrase; contains no secrets. */
export class MockNet extends Emitter implements Net {
  private v: RoomView = {
    phase: 'lobby',
    you: { id: 'me', name: 'أنا', named: true, seat: null, spectator: false, host: true },
    seats: ([0, 1, 2, 3] as const).map((i): SeatView => ({
      index: i, team: i % 2 === 0 ? 'A' : 'B', id: null, name: null, ready: false, connected: true, open: false, cards: 0, finished: false, paired: false, teamDone: false,
    })),
    hostId: 'me', hostVote: null, hostVoteCooldownUntil: 0, requests: [], canStart: false,
    clock: { startedAt: null, elapsedMs: 0, paused: false, expectedMs: 2_400_000, expectedFrom: 'estimate' }, finishes: [], result: null, musicLast: null,
    spectators: [], turnSeat: null, scores: { A: 0, B: 0 }, hand: [], winner: null, game: null,
    queue: [], nowPlaying: null, voiceIds: ['me'], voice: [], names: { me: 'أنا' }, serverNow: Date.now(),
  };
  async gate(p: string): Promise<GateReply> { return p.trim() ? { ok: true } : { ok: false }; }
  connect(): void { this.emit('status', 'open'); this.push(); }
  private push(): void { this.emit('view', structuredClone(this.v)); }
  send(m: ClientMsg): void {
    const v = this.v;
    if (m.t === 'sit' && (m.seat === 0 || m.seat === 1 || m.seat === 2 || m.seat === 3)) {
      v.seats[m.seat] = { ...v.seats[m.seat]!, name: 'أنا', id: 'me', ready: false }; v.you.seat = m.seat; v.you.spectator = false;
    }
    if (m.t === 'stand') { if (v.you.seat !== null) v.seats[v.you.seat] = { ...v.seats[v.you.seat]!, name: null, id: null }; v.you.seat = null; }
    if (m.t === 'ready' && v.you.seat !== null) v.seats[v.you.seat]!.ready = m.value;
    if (m.t === 'start') {
      v.phase = 'playing'; v.turnSeat = v.you.seat ?? 0;
      v.hand = [['A', 'S'], ['K', 'H'], ['4', 'D'], ['7', 'C'], ['J', 'S']].map(([r, s], i) => ({ id: 'c' + i, rank: r as never, suit: s as never }));
    }
    if (m.t === 'qAdd') v.queue.push({ id: String(Date.now()), videoId: m.videoId, title: m.title ?? '', thumb: m.thumb ?? '', by: 'أنا', byId: 'me' });
    if (m.t === 'qRemove') v.queue = v.queue.filter((q) => q.id !== m.id);
    if (v.queue[0] && !v.nowPlaying) v.nowPlaying = { itemId: v.queue[0].id, startedAt: Date.now(), serverNow: Date.now() };
    if (m.t === 'qSkip' || m.t === 'qEnded') { v.queue.shift(); v.nowPlaying = null; if (v.queue[0]) v.nowPlaying = { itemId: v.queue[0].id, startedAt: Date.now(), serverNow: Date.now() }; }
    if (m.t === 'toLobby') { v.phase = 'lobby'; v.winner = null; }
    this.push();
  }
  async search(q: string): Promise<SearchReply> {
    return { ok: true, results: [1, 2, 3].map((i) => ({ videoId: 'dQw4w9WgXcQ', title: `${q} ${i}`, thumb: '' })) };
  }
  async iceServers(): Promise<RTCIceServer[]> { return [{ urls: 'stun:stun.cloudflare.com:3478' }]; }
}
