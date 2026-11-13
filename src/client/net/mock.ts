import { Emitter } from './socket';
import type { ClientMsg, GateReply, Net, RoomView, SearchReply, SeatView } from './types';
import { applyPlay, applySkip, buildGameView, legalPlays, newGame, type GameState } from '../../engine/game';
import { seededRng } from '../../engine/rng';
import { TRACK_LEN, startSquare, type Seat } from '../../shared/board';

/** Local offline mock (use with ?mock on localhost). Accepts any non-empty phrase; contains no secrets. */
export class MockNet extends Emitter implements Net {
  /** Dev-only local game (real engine, bots play the first legal move) so the play flow can be tried offline. */
  private g: GameState | null = null;
  private rng = seededRng(7);
  private botTimer = 0;
  private v: RoomView = {
    phase: 'lobby',
    you: { id: 'me', name: 'أنا', named: true, seat: null, spectator: false, host: true },
    seats: ([0, 1, 2, 3] as const).map((i): SeatView => ({
      index: i, team: i % 2 === 0 ? 'A' : 'B', id: null, name: null, ready: false, connected: true, open: false, cards: 0, finished: false, paired: false, teamDone: false,
    })),
    hostId: 'me', hostVote: null, hostVoteCooldownUntil: 0, requests: [], canStart: true,
    clock: { startedAt: null, elapsedMs: 0, paused: false, expectedMs: 2_400_000, expectedFrom: 'estimate' }, finishes: [], result: null, musicLast: null,
    spectators: [], turnSeat: null, scores: { A: 0, B: 0 }, hand: [], winner: null, game: null,
    queue: [], nowPlaying: null, voiceIds: ['me'], voice: [], names: { me: 'أنا' }, serverNow: Date.now(),
  };
  async gate(p: string): Promise<GateReply> { return p.trim() ? { ok: true } : { ok: false }; }
  async logout(): Promise<boolean> { return true; }
  close(): void { /* nothing to close */ }
  connect(): void { this.emit('status', 'open'); this.push(); }
  private push(): void {
    const v = this.v, g = this.g;
    if (g && v.phase === 'playing') {
      const me = v.you.seat as Seat;
      v.game = buildGameView(g, me, false);
      v.hand = g.hands[me]!.map((c) => ({ ...c }));
      v.turnSeat = g.turn;
      v.seats.forEach((s, i) => { s.cards = g.hands[i]!.length; });
    }
    this.emit('view', structuredClone(v));
  }
  private bots(): void {
    clearTimeout(this.botTimer);
    const g = this.g;
    if (!g || g.over || g.turn === this.v.you.seat) return;
    this.botTimer = window.setTimeout(() => {
      const seat = g.turn;
      const p = legalPlays(g, seat)[0];
      if (p) { const r = applyPlay(g, seat, p, this.rng); if (r.ok) this.emit('event', { kind: r.events[0]?.kind ?? 'throw', seat, events: r.events }); }
      this.push(); this.bots();
    }, 900);
  }
  send(m: ClientMsg): void {
    const v = this.v;
    if (m.t === 'sit' && (m.seat === 0 || m.seat === 1 || m.seat === 2 || m.seat === 3)) {
      v.seats[m.seat] = { ...v.seats[m.seat]!, name: 'أنا', id: 'me', ready: false }; v.you.seat = m.seat; v.you.spectator = false;
    }
    if (m.t === 'stand') { if (v.you.seat !== null) v.seats[v.you.seat] = { ...v.seats[v.you.seat]!, name: null, id: null }; v.you.seat = null; }
    if (m.t === 'ready' && v.you.seat !== null) v.seats[v.you.seat]!.ready = m.value;
    if (m.t === 'start') {
      if (v.you.seat === null) { v.you.seat = 0; v.seats[0] = { ...v.seats[0]!, name: 'أنا', id: 'me' }; }
      const me = v.you.seat as Seat;
      v.seats.forEach((s, i) => { if (i !== me) Object.assign(s, { name: 'بوت ' + (i + 1), id: 'b' + i, ready: true }); });
      v.phase = 'playing';
      this.g = newGame(this.rng, ((me + 3) % 4) as Seat).state; // the mock player holds the first turn
      // A marble of each seat already on the track, so step cards have something to move.
      for (let s = 0; s < 4; s++) this.g.marbles[s * 4] = { zone: 'track', square: (startSquare(s as Seat) + 6) % TRACK_LEN };
      v.clock = { ...v.clock, startedAt: Date.now() };
    }
    const g = this.g;
    if (g && m.t === 'hint' && v.you.seat !== null) { const plays = legalPlays(g, v.you.seat as Seat); queueMicrotask(() => this.emit('hint', { plays })); return; }
    if (g && v.you.seat !== null && (m.t === 'play' || m.t === 'skip')) {
      const seat = v.you.seat as Seat;
      const r = m.t === 'play' ? applyPlay(g, seat, { cardId: m.cardId, moves: m.moves }, this.rng) : applySkip(g, seat, this.rng);
      if (r.ok) this.emit('event', { kind: r.events[0]?.kind ?? 'throw', seat, events: r.events });
      else this.emit('error', { code: r.code });
      this.push(); this.bots();
      return;
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
