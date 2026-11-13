/**
 * Room logic (pure, no Cloudflare APIs) so it can be unit-tested in Node.
 * The Durable Object adapter (room.ts) owns sockets, storage, alarms and I/O.
 *
 * Round 2: display names, host claim/vote, partner-based teams, seat swaps between games,
 * game end after both teams finish, clock + expected duration, saved scoreboard, dealer jokes,
 * no-collision music controls (anyone, last action wins, per-person rate limit).
 */

import { SEATS, isSeat, partnerOf, teamOf, type Seat } from '../shared/board';
import {
  CHAT_HISTORY, CHAT_PER_WINDOW, CHAT_WINDOW_MS, CLOSE_ABUSE, CLOSE_FULL, CLOSE_KICKED, CLOSE_REPLACED, EST_DEFAULT_MS, EST_MIN_GAMES, HOST_GRACE_MS,
  HOST_VOTE_COOLDOWN_MS, HOST_VOTE_MS, JOKE_COUNT, MAX_SPECTATORS, MUSIC_ACTS_PER_10S, QUEUE_CAP,
  QUEUE_PER_USER_CAP, REQUEST_TTL_MS,
  type ChatMsg, type ClientMsg, type ClockView, type ErrorCode, type GameEvent, type GameRecord, type GameResult, type MusicAct,
  type NoticeCode, type QueueItem, type RoomView, type ScoreRow, type Scoreboard, type ServerMsg, type Team,
  type TeamFinish,
} from '../shared/protocol';
import {
  applyPlay, buildGameView, handCounts, handOf, legalPlays, newGame, seatDone, seatFinished, type GameState,
} from '../engine/game';
import { shuffle, type Rng } from '../engine/rng';
import { cleanChat, cleanName } from './validate';

export const SEAT_HOLD_MS = 5 * 60_000; // a player may leave the browser up to 5 min and keep the seat
export const MSG_PER_10S = 120;
export const SIGNAL_PER_10S = 200;
/** Malformed frames tolerated per 10 s before the socket is closed. */
export const BAD_PER_10S = 20;
/** After a kick, the display name stays banned this long (M4). Not by IP: friends may share one Wi-Fi. */
export const KICK_BAN_MS = 30 * 60_000;

interface SeatRec { sid: string; ready: boolean; since: number; leftAt: number | null; open: boolean }
interface Person { id: string; name: string; named?: boolean }
/** Kick ban: the name (lowercased) cannot be used to name, sit or claim host. Bounded + TTL. */
interface Ban { name: string; until: number }
interface QueueRec { id: string; videoId: string; title: string; thumb: string; bySid: string }
interface Req { kind: 'partner' | 'swap'; from: string; to: string; at: number }
interface Vote { bySid: string; endsAt: number; votes: Record<string, string> }
interface Clock { startedAt: number; pausedTotal: number; pausedSince: number | null }

export interface RoomState {
  v: 2;
  phase: 'lobby' | 'playing' | 'ended';
  seats: (SeatRec | null)[];
  people: Record<string, Person>; // by sid
  game: GameState | null;
  winner: Team | null;
  scores: { A: number; B: number };
  queue: QueueRec[];
  playing: { itemId: string; startedAt: number; paused?: boolean; pausedAt?: number } | null;
  banned: string[];
  host: string | null;
  hostLeftAt: number | null;
  vote: Vote | null;
  voteCooldownUntil: number;
  /** Agreed partner pairs (sids); valid only while both sit opposite each other. */
  pairs: [string, string][];
  reqs: Req[];
  clock: Clock | null;
  /** Names per team captured at game start (scoreboard identity). */
  gameNames: { A: string[]; B: string[] } | null;
  finishes: TeamFinish[];
  result: GameResult | null;
  jokeBag: number[];
  lastJoke: number | null;
  musicLast: { sid: string; act: MusicAct; at: number } | null;
  bans: Ban[];
}

export interface Conn { key: string; sid: string; muted: boolean }

export type Out =
  | { to: string; msg: ServerMsg }
  | { close: string; code: number; reason: string };

/** Saved game history (room.ts: SQLite table; tests: memory). list() = newest first, already pruned. */
export interface GameStore {
  save(rec: GameRecord): boolean;
  list(): GameRecord[];
}

export interface CoreDeps {
  rng: Rng;
  newId: () => string; // 10 hex chars
  videoMeta: (videoId: string) => { title: string; thumb: string } | null;
  store?: GameStore;
}

export function memoryStore(): GameStore & { rows: GameRecord[] } {
  const rows: GameRecord[] = [];
  return { rows, save: (r) => { rows.unshift(r); return true; }, list: () => rows.slice() };
}

export function emptyRoom(): RoomState {
  return {
    v: 2, phase: 'lobby', seats: [null, null, null, null], people: {}, game: null, winner: null,
    scores: { A: 0, B: 0 }, queue: [], playing: null, banned: [],
    host: null, hostLeftAt: null, vote: null, voteCooldownUntil: 0, pairs: [], reqs: [],
    clock: null, gameNames: null, finishes: [], result: null, jokeBag: [], lastJoke: null, musicLast: null, bans: [],
  };
}

/** Expected game length: reasoned constant until EST_MIN_GAMES saved games exist, then mean of the last 20. */
export function expectedFrom(games: GameRecord[]): { ms: number; from: 'estimate' | 'history' } {
  if (games.length < EST_MIN_GAMES) return { ms: EST_DEFAULT_MS, from: 'estimate' };
  const recent = games.slice(0, 20);
  return { ms: Math.round(recent.reduce((a, g) => a + g.durationMs, 0) / recent.length), from: 'history' };
}

export function buildScoreboard(games: GameRecord[]): Scoreboard {
  const teams = new Map<string, ScoreRow>();
  const players = new Map<string, ScoreRow>();
  for (const g of games) {
    for (const t of ['A', 'B'] as Team[]) {
      const names = [...g.teams[t]].sort();
      const k = names.join('\u0000');
      const row = teams.get(k) ?? { names, wins: 0, games: 0 };
      row.games++;
      if (g.winner === t) row.wins++;
      teams.set(k, row);
      for (const n of g.teams[t]) {
        const p = players.get(n) ?? { names: [n], wins: 0, games: 0 };
        p.games++;
        if (g.winner === t) p.wins++;
        players.set(n, p);
      }
    }
  }
  const order = (a: ScoreRow, b: ScoreRow) => b.wins - a.wins || a.games - b.games || a.names.join().localeCompare(b.names.join());
  return {
    teams: [...teams.values()].sort(order),
    players: [...players.values()].sort(order),
    recent: games.slice(0, 30),
    total: games.length,
    since: games.length ? games[games.length - 1]!.startedAt : null,
  };
}

const sameName = (a: string, b: string) => a.toLocaleLowerCase('en') === b.toLocaleLowerCase('en');

export class RoomCore {
  conns = new Map<string, Conn>();
  private rate = new Map<string, { at: number; msgs: number; sig: number; bad: number }>();
  private musicRate = new Map<string, { at: number; n: number }>();
  private chatRate = new Map<string, { at: number; n: number }>();
  /** Last CHAT_HISTORY chat lines, memory only (lost on eviction by design: never persisted). */
  chat: ChatMsg[] = [];
  private expected: { ms: number; from: 'estimate' | 'history' };
  private store: GameStore;
  dirty = false;
  s: RoomState;

  constructor(s: RoomState | (Partial<RoomState> & { v: number }), private deps: CoreDeps) {
    // Upgrade older saved states (v1) by filling new fields.
    this.s = { ...emptyRoom(), ...(s as Partial<RoomState>), v: 2 };
    this.store = deps.store ?? memoryStore();
    this.expected = expectedFrom(this.safeList());
  }

  private safeList(): GameRecord[] {
    try { return this.store.list(); } catch { return []; }
  }

  // ---------------------------------------------------------------- queries

  private seatOfSid(sid: string): Seat | null {
    const i = this.s.seats.findIndex((r) => r?.sid === sid && !r.open);
    return i >= 0 ? (i as Seat) : null;
  }
  private connsOfSid(sid: string): Conn[] {
    return [...this.conns.values()].filter((c) => c.sid === sid);
  }
  private connectedSids(): Set<string> {
    return new Set([...this.conns.values()].map((c) => c.sid));
  }
  private nonSeatedSids(): string[] {
    return [...this.connectedSids()].filter((sid) => this.seatOfSid(sid) === null);
  }
  hostSid(): string | null {
    return this.s.host;
  }
  /**
   * The game (and its clock) pauses while a seat is open, or while the player whose turn it is is
   * disconnected (held seat): nobody else can move then, so the clock must not count the wait (M2).
   */
  private paused(): boolean {
    if (this.s.phase !== 'playing') return false;
    if (this.s.seats.some((r) => !r || r.open)) return true;
    const t = this.s.game?.turn;
    const r = t === undefined ? null : this.s.seats[t];
    return !!r && r.leftAt !== null;
  }
  private person(sid: string): Person {
    let p = this.s.people[sid];
    if (!p) {
      p = { id: this.deps.newId(), name: 'ضيف' };
      this.s.people[sid] = p;
      this.prunePeople();
    }
    return p;
  }
  private nameOf(sid: string): string {
    return this.s.people[sid]?.name ?? '';
  }
  private sidById(id: string): string | null {
    for (const [sid, p] of Object.entries(this.s.people)) if (p.id === id) return sid;
    return null;
  }
  private prunePeople(): void {
    const keys = Object.keys(this.s.people);
    if (keys.length <= 64) return;
    const keep = new Set([
      ...this.connectedSids(), ...this.s.seats.flatMap((r) => (r ? [r.sid] : [])), ...this.s.queue.map((q) => q.bySid),
      ...(this.s.host ? [this.s.host] : []),
    ]);
    for (const k of keys) if (!keep.has(k)) delete this.s.people[k];
  }
  /** Partner sid if `sid` is in a valid pair (both seated opposite), else null. */
  private partnerSid(sid: string): string | null {
    const p = this.s.pairs.find((x) => x[0] === sid || x[1] === sid);
    if (!p) return null;
    const other = p[0] === sid ? p[1] : p[0];
    const a = this.seatOfSid(sid);
    const b = this.seatOfSid(other);
    return a !== null && b !== null && partnerOf(a) === b ? other : null;
  }
  canStart(): boolean {
    if (this.s.phase !== 'lobby') return false;
    const connected = this.connectedSids();
    if (!this.s.seats.every((r) => r && !r.open && connected.has(r.sid) && this.s.people[r.sid]?.named)) return false;
    return SEATS.every((i) => this.partnerSid(this.s.seats[i]!.sid) !== null);
  }
  private elapsed(now: number): number {
    const c = this.s.clock;
    if (!c) return 0;
    return Math.max(0, now - c.startedAt - c.pausedTotal - (c.pausedSince !== null ? now - c.pausedSince : 0));
  }
  private clockView(now: number): ClockView {
    const ended = this.s.phase === 'ended' && this.s.result;
    return {
      startedAt: this.s.phase === 'lobby' ? null : this.s.clock?.startedAt ?? null,
      elapsedMs: this.s.phase === 'lobby' ? 0 : ended ? this.s.result!.durationMs : this.elapsed(now),
      paused: this.s.phase === 'playing' && this.paused(),
      expectedMs: this.expected.ms,
      expectedFrom: this.expected.from,
    };
  }

  // ---------------------------------------------------------------- views

  viewFor(conn: Conn, now: number): RoomView {
    const me = this.person(conn.sid);
    const seat = this.seatOfSid(conn.sid);
    const g = this.s.game;
    const connected = this.connectedSids();
    const counts = g ? handCounts(g) : [0, 0, 0, 0];
    const names: Record<string, string> = {};
    for (const sid of connected) { const p = this.person(sid); names[p.id] = p.name; }
    for (const r of this.s.seats) if (r) { const p = this.person(r.sid); names[p.id] = p.name; }
    const voice = [...connected].map((sid) => ({
      id: this.person(sid).id,
      muted: this.connsOfSid(sid).every((c) => c.muted),
    }));
    const idOf = (sid: string) => this.person(sid).id;
    const v = this.s.vote;
    let hostVote: RoomView['hostVote'] = null;
    if (v) {
      const tally: Record<string, number> = {};
      for (const [vs, choice] of Object.entries(v.votes)) {
        if (!connected.has(vs)) continue;
        const k = choice === 'keep' ? 'keep' : idOf(choice);
        tally[k] = (tally[k] ?? 0) + 1;
      }
      const mine = v.votes[conn.sid];
      hostVote = {
        by: idOf(v.bySid), endsAt: v.endsAt, tally, voters: connected.size,
        mine: mine === undefined ? null : mine === 'keep' ? 'keep' : idOf(mine),
      };
    }
    const ml = this.s.musicLast;
    return {
      phase: this.s.phase,
      you: { id: me.id, name: me.name, named: !!me.named, seat, spectator: seat === null, host: this.s.host === conn.sid },
      hostId: this.s.host ? idOf(this.s.host) : null,
      hostVote,
      hostVoteCooldownUntil: this.s.voteCooldownUntil,
      requests: this.s.reqs.filter((r) => r.from === conn.sid || r.to === conn.sid)
        .map((r) => ({ kind: r.kind, from: idOf(r.from), to: idOf(r.to), at: r.at })),
      canStart: this.canStart(),
      clock: this.clockView(now),
      finishes: this.s.finishes.map((f) => ({ ...f, names: [...f.names] })),
      result: this.s.phase === 'ended' && this.s.result ? structuredClone(this.s.result) : null,
      musicLast: ml ? { by: this.nameOf(ml.sid), byId: this.s.people[ml.sid]?.id ?? '', act: ml.act, at: ml.at } : null,
      seats: SEATS.map((i) => {
        const r = this.s.seats[i];
        const p = r && !r.open ? this.person(r.sid) : null;
        return {
          index: i, team: teamOf(i), id: p?.id ?? null, name: p?.name ?? null,
          ready: !!r && !r.open && r.ready, connected: !!r && !r.open && connected.has(r.sid),
          open: !!r?.open, cards: counts[i] ?? 0, finished: g ? seatFinished(g, i) : false,
          paired: !!r && !r.open && this.partnerSid(r.sid) !== null,
          teamDone: g && this.s.phase !== 'lobby' ? seatDone(g, i) : false,
        };
      }),
      spectators: this.nonSeatedSids().map((sid) => ({ id: this.person(sid).id, name: this.person(sid).name })),
      turnSeat: g && this.s.phase === 'playing' ? g.turn : null,
      scores: { ...this.s.scores },
      hand: g && this.s.phase !== 'lobby' ? handOf(g, seat) : [],
      winner: this.s.winner,
      game: g && this.s.phase !== 'lobby' ? buildGameView(g, seat, this.paused()) : null,
      queue: this.s.queue.map((q): QueueItem => ({
        id: q.id, videoId: q.videoId, title: q.title, thumb: q.thumb,
        by: this.s.people[q.bySid]?.name ?? '', byId: this.s.people[q.bySid]?.id ?? '',
      })),
      nowPlaying: this.s.playing ? { ...this.s.playing, serverNow: now } : null,
      voiceIds: voice.map((x) => x.id),
      voice,
      names,
      serverNow: now,
    };
  }

  private allViews(now: number): Out[] {
    return [...this.conns.values()].map((c) => ({ to: c.key, msg: { t: 'view', view: this.viewFor(c, now) } as ServerMsg }));
  }
  private err(key: string, code: ErrorCode): Out[] {
    return [{ to: key, msg: { t: 'error', code } }];
  }
  private changed(now: number, extra: Out[] = []): Out[] {
    this.tidy(now);
    this.syncPause(now);
    this.dirty = true;
    return [...extra, ...this.allViews(now)];
  }
  private broadcast(msg: ServerMsg): Out[] {
    return [...this.conns.values()].map((c) => ({ to: c.key, msg }));
  }
  private noticeAll(code: NoticeCode, name?: string, by?: string): Out[] {
    return this.broadcast({ t: 'notice', code, ...(name !== undefined ? { name } : {}), ...(by !== undefined ? { by } : {}) });
  }
  private noticeTo(sid: string, code: NoticeCode, name?: string): Out[] {
    return this.connsOfSid(sid).map((c) => ({ to: c.key, msg: { t: 'notice', code, ...(name !== undefined ? { name } : {}) } as ServerMsg }));
  }

  /** Drop stale requests, invalid pairs and votes of people who left. */
  private tidy(now: number): void {
    const s = this.s;
    const connected = this.connectedSids();
    if (s.phase === 'lobby') s.pairs = s.pairs.filter(([a]) => this.partnerSid(a) !== null);
    s.reqs = s.reqs.filter((r) => {
      if (!connected.has(r.from) || !connected.has(r.to) || now - r.at > REQUEST_TTL_MS || s.phase !== 'lobby') return false;
      if (r.kind === 'partner') {
        return this.seatOfSid(r.from) !== null && this.seatOfSid(r.to) !== null
          && this.partnerSid(r.from) === null && this.partnerSid(r.to) === null;
      }
      return this.seatOfSid(r.from) !== null || this.seatOfSid(r.to) !== null;
    }).slice(-32);
    if (s.vote) for (const k of Object.keys(s.vote.votes)) if (!connected.has(k)) delete s.vote.votes[k];
  }

  /** Track time paused by an open seat so elapsed excludes it. */
  private syncPause(now: number): void {
    const c = this.s.clock;
    if (!c || this.s.phase !== 'playing') return;
    const p = this.paused();
    if (p && c.pausedSince === null) c.pausedSince = now;
    else if (!p && c.pausedSince !== null) { c.pausedTotal += now - c.pausedSince; c.pausedSince = null; }
  }

  // ---------------------------------------------------------------- connection lifecycle

  /** Admission check + register. Returns outputs, or a close for this key when refused. */
  connect(key: string, sid: string, now: number): Out[] {
    if (this.s.banned.includes(sid)) return [{ close: key, code: CLOSE_KICKED, reason: 'kicked' }];
    this.s.bans = this.s.bans.filter((b) => b.until > now);
    const out: Out[] = [];
    // One socket per session: replace older ones.
    for (const c of this.connsOfSid(sid)) {
      this.conns.delete(c.key);
      out.push({ close: c.key, code: CLOSE_REPLACED, reason: 'replaced' });
    }
    // Reclaim a held or open seat that belongs to this session.
    const held = this.s.seats.findIndex((r) => r?.sid === sid);
    if (held >= 0) {
      const r = this.s.seats[held]!;
      r.leftAt = null;
      r.open = false;
    } else {
      const others = this.nonSeatedSids().length;
      const total = this.connectedSids().size;
      if (total >= 8) return [...out, { close: key, code: CLOSE_FULL, reason: 'full' }];
      if (others >= MAX_SPECTATORS) {
        const free = this.s.phase === 'lobby' ? this.s.seats.findIndex((r) => r === null) : -1;
        if (free < 0) return [...out, { close: key, code: CLOSE_FULL, reason: 'full' }];
        this.s.seats[free] = { sid, ready: false, since: now, leftAt: null, open: false };
      }
    }
    if (this.s.host === sid) this.s.hostLeftAt = null;
    this.person(sid);
    this.conns.set(key, { key, sid, muted: true });
    const hist: Out = { to: key, msg: { t: 'chatHistory', msgs: this.chat.map((m) => ({ ...m })) } };
    return this.changed(now, [...out, hist, ...this.evalVote(now)]);
  }

  disconnect(key: string, now: number): Out[] {
    const c = this.conns.get(key);
    if (!c) return [];
    this.conns.delete(key);
    this.rate.delete(key);
    if (this.connsOfSid(c.sid).length === 0) {
      const seat = this.s.seats.findIndex((r) => r?.sid === c.sid && !r.open);
      if (seat >= 0) this.s.seats[seat]!.leftAt = now;
      if (this.s.host === c.sid) this.s.hostLeftAt = now;
      this.musicRate.delete(c.sid);
      this.chatRate.delete(c.sid);
    }
    this.tidy(now);
    return this.changed(now, this.evalVote(now));
  }

  /**
   * Rebuild after hibernation or a DO restart. Re-registers surviving sockets (banned sids are refused and
   * returned for closing) and starts the hold/grace timers for seats and the host that have no socket,
   * so they expire instead of staying reserved forever (H2/M4).
   */
  restore(conns: Conn[], now: number): string[] {
    const drop: string[] = [];
    for (const c of conns) {
      if (this.s.banned.includes(c.sid)) { drop.push(c.key); continue; }
      this.conns.set(c.key, { key: c.key, sid: c.sid, muted: c.muted });
    }
    const live = this.connectedSids();
    for (const r of this.s.seats) {
      if (r && !r.open && r.leftAt === null && !live.has(r.sid)) { r.leftAt = now; this.dirty = true; }
    }
    if (this.s.host && this.s.hostLeftAt === null && !live.has(this.s.host)) { this.s.hostLeftAt = now; this.dirty = true; }
    if (this.dirty) this.syncPause(now);
    return drop;
  }

  /** Earliest time the adapter should call alarm(), or null. */
  nextAlarm(): number | null {
    let t = Infinity;
    for (const r of this.s.seats) if (r && r.leftAt !== null && !r.open) t = Math.min(t, r.leftAt + SEAT_HOLD_MS);
    if (this.s.host && this.s.hostLeftAt !== null) t = Math.min(t, this.s.hostLeftAt + HOST_GRACE_MS);
    if (this.s.vote) t = Math.min(t, this.s.vote.endsAt);
    return t === Infinity ? null : t;
  }

  alarm(now: number): Out[] {
    let changed = false;
    const events: GameEvent[] = [];
    const out: Out[] = [];
    this.s.seats.forEach((r, i) => {
      if (!r || r.open || r.leftAt === null || r.leftAt + SEAT_HOLD_MS > now) return;
      changed = true;
      if (this.s.phase === 'playing') {
        r.open = true;
        events.push({ kind: 'pause', seat: i as Seat });
      } else {
        this.s.seats[i] = null;
      }
    });
    if (this.s.host && this.s.hostLeftAt !== null && this.s.hostLeftAt + HOST_GRACE_MS <= now) {
      const name = this.nameOf(this.s.host);
      this.s.host = null;
      this.s.hostLeftAt = null;
      changed = true;
      out.push(...this.noticeAll('host_left', name));
    }
    if (this.s.vote && this.s.vote.endsAt <= now) {
      changed = true;
      out.push(...this.closeVote(null, now));
    }
    if (!changed) return [];
    const ev: Out[] = events.length ? this.broadcast({ t: 'event', kind: 'pause', events }) : [];
    return this.changed(now, [...ev, ...out]);
  }

  private nameBanned(name: string, now: number): boolean {
    const n = name.toLocaleLowerCase('en');
    return this.s.bans.some((b) => b.name === n && b.until > now);
  }
  /** Kick ban check for playing roles (seat, partner, host): spectating stays allowed. */
  private banned(sid: string, now: number): boolean {
    const p = this.s.people[sid];
    return !!p?.named && this.nameBanned(p.name, now);
  }

  private limited(key: string, now: number, signal: boolean): boolean {
    const r = this.rateRec(key, now);
    if (signal) return ++r.sig > SIGNAL_PER_10S;
    return ++r.msgs > MSG_PER_10S;
  }
  private rateRec(key: string, now: number) {
    let r = this.rate.get(key);
    if (!r || now - r.at > 10_000) { r = { at: now, msgs: 0, sig: 0, bad: 0 }; this.rate.set(key, r); }
    return r;
  }
  private musicLimited(sid: string, now: number): boolean {
    let r = this.musicRate.get(sid);
    if (!r || now - r.at > 10_000) { r = { at: now, n: 0 }; this.musicRate.set(sid, r); }
    return ++r.n > MUSIC_ACTS_PER_10S;
  }
  // ---------------------------------------------------------------- messages

  /** m = 'too_big' for frames over MAX_MSG_BYTES (answered with error too_big; repeats close the socket). */
  message(key: string, m: ClientMsg | null | 'too_big', now: number): Out[] {
    const c = this.conns.get(key);
    if (!c) return [];
    if (this.limited(key, now, m !== 'too_big' && m?.t === 'signal')) {
      const r = this.rateRec(key, now);
      // A flood well past the limit closes the socket; the room is unaffected.
      if (r.msgs > MSG_PER_10S * 2 || r.sig > SIGNAL_PER_10S * 2) return this.closeAbuseAndUpdate(key, now);
      return this.err(key, 'rate');
    }
    if (!m || m === 'too_big') {
      if (++this.rateRec(key, now).bad > BAD_PER_10S) return this.closeAbuseAndUpdate(key, now);
      return this.err(key, m === 'too_big' ? 'too_big' : 'bad_msg');
    }
    const sid = c.sid;
    const seat = this.seatOfSid(sid);
    const isHost = this.s.host === sid;
    const me = this.person(sid);
    const s = this.s;

    switch (m.t) {
      case 'ping':
        return [{ to: key, msg: { t: 'pong', serverNow: now } }];

      case 'name': {
        const name = cleanName(m.name);
        if (!name) return this.err(key, 'name');
        if (s.phase === 'playing' && seat !== null) return this.err(key, 'not_lobby');
        if (this.nameBanned(name, now)) return this.err(key, 'banned');
        // Offline seated players (held seat) keep their name reserved too (M3).
        const holders = new Set([...this.connectedSids(), ...s.seats.flatMap((r) => (r && !r.open ? [r.sid] : []))]);
        for (const other of holders) {
          if (other !== sid && this.s.people[other]?.named && sameName(this.nameOf(other), name)) return this.err(key, 'name_taken');
        }
        me.name = name;
        me.named = true;
        return this.changed(now);
      }

      case 'sit': {
        if (!isSeat(m.seat)) return this.err(key, 'bad_msg');
        if (!me.named) return this.err(key, 'not_named');
        if (this.banned(sid, now)) return this.err(key, 'banned');
        const r = s.seats[m.seat];
        if (s.phase !== 'lobby') {
          // Mid-game only an open (abandoned) seat can be taken, by someone not seated.
          if (!r?.open || seat !== null) return this.err(key, 'seat_taken');
          s.seats[m.seat] = { sid, ready: true, since: r.since, leftAt: null, open: false };
          // The newcomer plays for that team: inherit the old occupant's pair.
          s.pairs = s.pairs.map((p) => p.map((x) => (x === r.sid ? sid : x)) as [string, string]);
          const ev = this.broadcast({ t: 'event', kind: 'resume', seat: m.seat, events: [{ kind: 'resume', seat: m.seat }] });
          const wasPaused = this.paused();
          return this.changed(now, wasPaused ? [] : ev);
        }
        if (seat === m.seat) return this.stand(key, sid, seat, now); // tap again to stand
        if (r) return this.err(key, 'seat_taken');
        const out = seat !== null ? this.breakPair(sid) : [];
        if (seat !== null) s.seats[seat] = null;
        s.seats[m.seat] = { sid, ready: false, since: now, leftAt: null, open: false };
        return this.changed(now, out);
      }

      case 'stand':
      case 'spectate':
        if (seat === null) return [];
        return this.stand(key, sid, seat, now);

      case 'ready':
        if (s.phase !== 'lobby' || seat === null) return this.err(key, 'not_lobby');
        s.seats[seat]!.ready = m.value;
        return this.changed(now);

      case 'start': {
        if (!isHost) return this.err(key, 'not_host');
        if (s.phase !== 'lobby') return this.err(key, 'not_lobby');
        this.tidy(now);
        if (!this.canStart()) return this.err(key, 'teams_incomplete');
        return this.startGame(now);
      }

      case 'again':
      case 'toLobby':
        if (!isHost) return this.err(key, 'not_host');
        if (m.t === 'again' && s.phase !== 'ended') return this.err(key, 'not_allowed');
        // Between-games lobby: same people, teams kept (if still seated opposite), seats may change.
        s.phase = 'lobby';
        s.game = null;
        s.winner = null;
        s.clock = null;
        s.finishes = [];
        s.result = null;
        s.seats.forEach((r, i) => { if (r) { if (r.open) s.seats[i] = null; else r.ready = false; } });
        return this.changed(now);

      case 'kick': {
        if (!isHost) return this.err(key, 'not_host');
        const target = this.sidById(m.id);
        if (!target || target === sid) return this.err(key, 'not_allowed');
        if (!s.banned.includes(target)) s.banned = [...s.banned, target].slice(-50);
        const tp = s.people[target];
        if (tp?.named) {
          s.bans = [...s.bans.filter((b) => b.until > now), { name: tp.name.toLocaleLowerCase('en'), until: now + KICK_BAN_MS }].slice(-50);
        }
        const out: Out[] = this.breakPair(target);
        const ts = s.seats.findIndex((r) => r?.sid === target);
        if (ts >= 0) {
          if (s.phase === 'playing') s.seats[ts] = { ...s.seats[ts]!, open: true, leftAt: null };
          else s.seats[ts] = null;
        }
        for (const tc of this.connsOfSid(target)) {
          this.conns.delete(tc.key);
          out.push({ close: tc.key, code: CLOSE_KICKED, reason: 'kicked' });
        }
        return this.changed(now, [...out, ...this.evalVote(now)]);
      }

      // ------------------------------------------------------------ host
      case 'hostClaim': {
        if (!me.named) return this.err(key, 'not_named');
        if (this.banned(sid, now)) return this.err(key, 'banned');
        if (s.host) return this.err(key, 'host_taken'); // first processed claim wins (DO is single-threaded)
        s.host = sid;
        s.hostLeftAt = null;
        s.vote = null;
        return this.changed(now, this.noticeAll('host_claimed', me.name));
      }

      case 'hostGive': {
        if (!isHost) return this.err(key, 'not_host');
        const to = this.sidById(m.to);
        if (!to || to === sid || !this.connectedSids().has(to) || !this.s.people[to]?.named) return this.err(key, 'not_allowed');
        s.host = to;
        s.vote = null;
        return this.changed(now, this.noticeAll('host_changed', this.nameOf(to), me.name));
      }

      case 'hostVoteStart': {
        if (!me.named) return this.err(key, 'not_named');
        if (s.vote) return this.err(key, 'vote_open');
        if (now < s.voteCooldownUntil) return this.err(key, 'vote_cooldown');
        s.vote = { bySid: sid, endsAt: now + HOST_VOTE_MS, votes: {} };
        return this.changed(now);
      }

      case 'hostVote': {
        const v = s.vote;
        if (!v) return this.err(key, 'no_vote');
        let choice = 'keep';
        if (m.choice !== 'keep') {
          const cs = this.sidById(m.choice);
          if (!cs || !this.connectedSids().has(cs) || !this.s.people[cs]?.named) return this.err(key, 'not_allowed');
          choice = cs;
        }
        v.votes[sid] = choice;
        return this.changed(now, this.evalVote(now));
      }

      // ------------------------------------------------------------ teams
      case 'partnerReq': {
        if (s.phase !== 'lobby') return this.err(key, 'not_lobby');
        if (seat === null) return this.err(key, 'not_seated');
        const to = this.sidById(m.to);
        if (!to || to === sid || !this.connectedSids().has(to)) return this.err(key, 'not_allowed');
        if (this.seatOfSid(to) === null) return this.err(key, 'not_seated');
        if (this.partnerSid(sid) !== null || this.partnerSid(to) !== null) return this.err(key, 'has_partner');
        // Mutual request = accept.
        if (s.reqs.some((r) => r.kind === 'partner' && r.from === to && r.to === sid)) return this.formPair(to, sid, now);
        s.reqs = s.reqs.filter((r) => !(r.kind === 'partner' && r.from === sid));
        s.reqs.push({ kind: 'partner', from: sid, to, at: now });
        return this.changed(now, this.noticeTo(to, 'partner_request', me.name));
      }

      case 'partnerCancel':
        s.reqs = s.reqs.filter((r) => !(r.kind === 'partner' && r.from === sid));
        return this.changed(now);

      case 'partnerAnswer': {
        const from = this.sidById(m.from);
        this.tidy(now);
        const req = from ? s.reqs.find((r) => r.kind === 'partner' && r.from === from && r.to === sid) : undefined;
        if (!from || !req) {
          // Race: the requester (or we) got a partner first.
          const taken = from ? this.partnerSid(from) : null;
          return taken ? this.noticeTo(sid, 'partner_taken', this.nameOf(from!)) : this.err(key, 'no_request');
        }
        s.reqs = s.reqs.filter((r) => r !== req);
        if (!m.accept) return this.changed(now, this.noticeTo(from, 'partner_declined', me.name));
        return this.formPair(from, sid, now);
      }

      case 'partnerBreak': {
        if (s.phase !== 'lobby') return this.err(key, 'not_lobby');
        if (this.partnerSid(sid) === null) return this.err(key, 'not_allowed');
        return this.changed(now, this.breakPair(sid));
      }

      case 'shuffleTeams': {
        if (!isHost) return this.err(key, 'not_host');
        if (s.phase !== 'lobby') return this.err(key, 'not_lobby');
        const sids = s.seats.flatMap((r) => (r && !r.open ? [r.sid] : []));
        if (sids.length !== 4) return this.err(key, 'teams_incomplete');
        const recs = new Map(s.seats.map((r) => [r!.sid, r!] as const));
        shuffle(sids, this.deps.rng);
        s.seats = sids.map((x) => recs.get(x)!);
        s.pairs = [[sids[0]!, sids[2]!], [sids[1]!, sids[3]!]];
        s.reqs = s.reqs.filter((r) => r.kind !== 'partner');
        return this.changed(now, this.noticeAll('teams_shuffled', undefined, me.name));
      }

      // ------------------------------------------------------------ seat swap (between games only)
      case 'swapReq': {
        if (s.phase !== 'lobby') return this.err(key, 'not_lobby');
        if (!me.named) return this.err(key, 'not_named');
        const to = this.sidById(m.to);
        if (!to || to === sid || !this.connectedSids().has(to)) return this.err(key, 'not_allowed');
        if (seat === null && this.seatOfSid(to) === null) return this.err(key, 'not_seated');
        s.reqs = s.reqs.filter((r) => !(r.kind === 'swap' && r.from === sid));
        s.reqs.push({ kind: 'swap', from: sid, to, at: now });
        return this.changed(now, this.noticeTo(to, 'swap_request', me.name));
      }

      case 'swapCancel':
        s.reqs = s.reqs.filter((r) => !(r.kind === 'swap' && r.from === sid));
        return this.changed(now);

      case 'swapAnswer': {
        const from = this.sidById(m.from);
        this.tidy(now);
        const req = from ? s.reqs.find((r) => r.kind === 'swap' && r.from === from && r.to === sid) : undefined;
        if (!from || !req) return this.err(key, 'no_request');
        s.reqs = s.reqs.filter((r) => r !== req);
        if (!m.accept) return this.changed(now, this.noticeTo(from, 'swap_declined', me.name));
        const a = this.seatOfSid(from);
        const b = this.seatOfSid(sid);
        const out = [...this.breakPair(from), ...this.breakPair(sid)];
        const ra = a !== null ? s.seats[a]! : null;
        const rb = b !== null ? s.seats[b]! : null;
        if (a !== null) s.seats[a] = rb ?? { sid, ready: false, since: now, leftAt: null, open: false };
        if (b !== null) s.seats[b] = ra ?? { sid: from, ready: false, since: now, leftAt: null, open: false };
        return this.changed(now, [...out, ...this.noticeTo(from, 'swapped', me.name), ...this.noticeTo(sid, 'swapped', this.nameOf(from))]);
      }

      // Chat is a pure relay: never touches game/lobby state, never produces views (no-collision rule).
      case 'chat': {
        if (!me.named) return this.err(key, 'not_named');
        let r = this.chatRate.get(sid);
        if (!r || now - r.at > CHAT_WINDOW_MS) { r = { at: now, n: 0 }; this.chatRate.set(sid, r); }
        if (++r.n > CHAT_PER_WINDOW) return this.err(key, 'rate');
        const text = cleanChat(m.text);
        if (!text) return this.err(key, 'chat');
        const line: ChatMsg = { id: this.deps.newId(), from: me.id, name: me.name, text, at: now };
        this.chat.push(line);
        if (this.chat.length > CHAT_HISTORY) this.chat.splice(0, this.chat.length - CHAT_HISTORY);
        return this.broadcast({ t: 'chat', msg: line });
      }

      case 'scoreboard':
        return [{ to: key, msg: { t: 'scoreboard', board: buildScoreboard(this.safeList()) } }];

      // ------------------------------------------------------------ play
      case 'play': {
        const g = s.game;
        if (s.phase !== 'playing' || !g) return this.err(key, 'not_allowed');
        if (seat === null) return this.err(key, 'not_player');
        if (this.paused()) return this.err(key, 'paused');
        if (g.turn !== seat) return this.err(key, 'not_turn');
        const dealBefore = g.dealNo;
        const res = applyPlay(g, seat, { cardId: m.cardId, moves: m.moves }, this.deps.rng);
        if (!res.ok) return this.err(key, res.code === 'not_turn' ? 'not_turn' : res.code === 'no_card' ? 'no_card' : 'illegal');
        const out: Out[] = [this.broadcast({ t: 'event', kind: res.events[0]?.kind ?? 'throw', seat, events: res.events })].flat();
        while (s.finishes.length < g.done.length) {
          const team = g.done[s.finishes.length]!;
          s.finishes.push({ team, names: [...(s.gameNames?.[team] ?? [])], ms: this.elapsed(now), turns: g.doneTurn[s.finishes.length]! });
        }
        if (g.over) out.push(...this.endGame(now));
        else if (g.dealNo !== dealBefore) out.push(...this.joke(g));
        return this.changed(now, out);
      }

      case 'hint': {
        const g = s.game;
        if (s.phase !== 'playing' || !g || seat === null || g.turn !== seat) return [{ to: key, msg: { t: 'hint', plays: [] } }];
        return [{ to: key, msg: { t: 'hint', plays: legalPlays(g, seat) } }];
      }

      case 'voice':
        c.muted = m.muted;
        return this.changed(now);

      case 'signal': {
        const toSid = this.sidById(m.to);
        if (!toSid || toSid === sid) return [];
        const from = me.id;
        return this.connsOfSid(toSid).map((tc) => ({ to: tc.key, msg: { t: 'signal', from, data: m.data } as ServerMsg }));
      }

      // ------------------------------------------------------------ music: independent of game state, anyone, last action wins
      case 'qAdd': {
        if (this.musicLimited(sid, now)) return this.err(key, 'rate');
        if (s.queue.length >= QUEUE_CAP || s.queue.filter((q) => q.bySid === sid).length >= QUEUE_PER_USER_CAP) {
          return this.err(key, 'queue_full');
        }
        const meta = this.deps.videoMeta(m.videoId);
        if (!meta) return this.err(key, 'unknown_video');
        const item: QueueRec = { id: this.deps.newId(), videoId: m.videoId, title: meta.title, thumb: meta.thumb, bySid: sid };
        s.queue.push(item);
        if (!s.playing) s.playing = { itemId: s.queue[0]!.id, startedAt: now };
        this.musicAct(sid, 'add', now);
        return this.changed(now);
      }

      case 'qRemove': {
        const i = s.queue.findIndex((q) => q.id === m.id);
        if (i < 0) return [];
        if (s.queue[i]!.bySid !== sid && !isHost) return this.err(key, 'not_allowed');
        if (this.musicLimited(sid, now)) return this.err(key, 'rate');
        if (i === 0 && s.playing?.itemId === m.id) return this.advanceMusic(now, sid, 'skip');
        s.queue.splice(i, 1);
        return this.changed(now);
      }

      case 'qSkip':
        if (!s.playing) return [];
        if (m.itemId !== undefined && m.itemId !== s.playing.itemId) return []; // stale skip: ignore (no double-skip)
        if (this.musicLimited(sid, now)) return this.err(key, 'rate');
        return this.advanceMusic(now, sid, 'skip');

      case 'qStop':
        if (!s.playing) return [];
        if (this.musicLimited(sid, now)) return this.err(key, 'rate');
        s.queue = s.queue.filter((q) => q.id !== s.playing!.itemId);
        s.playing = null;
        this.musicAct(sid, 'stop', now);
        return this.changed(now);

      case 'qPause': {
        const p = s.playing;
        if (!p || !!p.paused === m.paused) return [];
        if (this.musicLimited(sid, now)) return this.err(key, 'rate');
        if (m.paused) { p.paused = true; p.pausedAt = now; } else {
          p.startedAt += now - (p.pausedAt ?? now);
          delete p.paused;
          delete p.pausedAt;
        }
        this.musicAct(sid, m.paused ? 'pause' : 'resume', now);
        return this.changed(now);
      }

      case 'qPlay': {
        const i = s.queue.findIndex((q) => q.id === m.id);
        if (i < 0) return [];
        if (this.musicLimited(sid, now)) return this.err(key, 'rate');
        const [item] = s.queue.splice(i, 1);
        if (s.playing) s.queue = s.queue.filter((q) => q.id !== s.playing!.itemId);
        s.queue.unshift(item!);
        s.playing = { itemId: item!.id, startedAt: now };
        this.musicAct(sid, 'play', now);
        return this.changed(now);
      }

      case 'qEnded':
      case 'qError':
        if (!s.playing || s.playing.itemId !== m.itemId || s.playing.paused) return [];
        // Ignore "ended" reports that arrive implausibly early (any client can report).
        if (m.t === 'qEnded' && now - s.playing.startedAt < 5_000) return [];
        return this.advanceMusic(now, null, 'skip');
    }
  }

  private closeAbuseAndUpdate(key: string, now: number): Out[] {
    const rest = this.disconnect(key, now);
    return [{ close: key, code: CLOSE_ABUSE, reason: 'abuse' }, ...rest];
  }

  private musicAct(sid: string, act: MusicAct, now: number): void {
    this.s.musicLast = { sid, act, at: now };
  }

  private stand(_key: string, sid: string, seat: Seat, now: number): Out[] {
    const s = this.s;
    if (s.phase !== 'lobby') return this.err(_key, 'not_lobby');
    if (this.nonSeatedSids().length >= MAX_SPECTATORS) return this.err(_key, 'full');
    const out = this.breakPair(sid);
    if (s.seats[seat]?.sid === sid) s.seats[seat] = null;
    return this.changed(now, out);
  }

  /** Remove sid's pair (lobby) and tell the partner. */
  private breakPair(sid: string): Out[] {
    const s = this.s;
    const p = s.pairs.find((x) => x[0] === sid || x[1] === sid);
    if (!p || s.phase === 'playing') return [];
    s.pairs = s.pairs.filter((x) => x !== p);
    const other = p[0] === sid ? p[1] : p[0];
    return this.noticeTo(other, 'team_broken', this.nameOf(sid));
  }

  /**
   * Pair a and b atomically and seat them opposite each other on a team not held by another pair.
   * Unpaired seated players are moved to the remaining seats (at most 4 seated, so they always fit).
   */
  private formPair(a: string, b: string, now: number): Out[] {
    const s = this.s;
    const other = s.pairs.find(([x]) => x !== a && x !== b && this.partnerSid(x) !== null);
    const otherSeats = new Set(other ? [this.seatOfSid(other[0])!, this.seatOfSid(other[1])!] : []);
    const recs = new Map(s.seats.flatMap((r) => (r && !r.open ? [[r.sid, r] as const] : [])));
    const sa = this.seatOfSid(a)!;
    const seatA: Seat = !otherSeats.has(sa) ? sa : (SEATS.find((i) => !otherSeats.has(i)) as Seat);
    const seatB = partnerOf(seatA);
    const next: (SeatRec | null)[] = [null, null, null, null];
    for (const i of otherSeats) next[i] = s.seats[i]!;
    next[seatA] = recs.get(a)!;
    next[seatB] = recs.get(b)!;
    const placed = new Set([a, b, ...(other ?? [])]);
    const rest = [...recs.values()].filter((r) => !placed.has(r.sid));
    for (const r of rest) { const free = next.findIndex((x) => x === null); next[free] = r; }
    s.seats = next;
    s.pairs = [...(other ? [other] : []), [a, b]];
    // Cancel all other partner requests involving either; tell the losers of a race.
    const out: Out[] = [];
    for (const r of s.reqs) {
      if (r.kind !== 'partner') continue;
      if (r.to === a || r.to === b) { if (r.from !== a && r.from !== b) out.push(...this.noticeTo(r.from, 'partner_taken', this.nameOf(r.to))); }
    }
    s.reqs = s.reqs.filter((r) => r.kind !== 'partner' || ![a, b].includes(r.from) && ![a, b].includes(r.to));
    out.push(...this.noticeAll('team_formed', this.nameOf(a), this.nameOf(b)));
    return this.changed(now, out);
  }

  /** Close the host vote with a winning choice (sid or 'keep'), or null = no majority. */
  private closeVote(choice: string | null, now: number): Out[] {
    const s = this.s;
    s.vote = null;
    if (choice && choice !== 'keep' && this.connectedSids().has(choice)) {
      s.host = choice;
      s.hostLeftAt = null;
      return this.noticeAll('host_changed', this.nameOf(choice));
    }
    s.voteCooldownUntil = now + HOST_VOTE_COOLDOWN_MS;
    return this.noticeAll('host_kept', s.host ? this.nameOf(s.host) : undefined);
  }

  /** Majority of people present decides (denominator is live). */
  private evalVote(now: number): Out[] {
    const v = this.s.vote;
    if (!v) return [];
    const connected = this.connectedSids();
    const tally = new Map<string, number>();
    for (const [vs, ch] of Object.entries(v.votes)) if (connected.has(vs)) tally.set(ch, (tally.get(ch) ?? 0) + 1);
    for (const [ch, n] of tally) if (n > connected.size / 2) return this.closeVote(ch, now);
    return [];
  }

  private nextJoke(): number {
    const s = this.s;
    if (!s.jokeBag.length) {
      const bag = shuffle(Array.from({ length: JOKE_COUNT }, (_, i) => i), this.deps.rng);
      // Avoid an immediate repeat across the refill boundary (bag is popped from the end).
      if (bag.length > 1 && bag[bag.length - 1] === s.lastJoke) [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1]!, bag[0]!];
      s.jokeBag = bag;
    }
    const j = s.jokeBag.pop()!;
    s.lastJoke = j;
    return j;
  }

  private joke(g: GameState): Out[] {
    return this.broadcast({ t: 'joke', seat: g.dealer, index: this.nextJoke(), dealNo: g.dealNo });
  }

  private startGame(now: number): Out[] {
    const s = this.s;
    const dealer = this.deps.rng.int(4) as Seat;
    const { state, events } = newGame(this.deps.rng, dealer);
    s.game = state;
    s.phase = 'playing';
    s.winner = null;
    s.clock = { startedAt: now, pausedTotal: 0, pausedSince: null };
    s.finishes = [];
    s.result = null;
    const nm = (i: Seat) => this.nameOf(s.seats[i]!.sid);
    s.gameNames = { A: [nm(0), nm(2)], B: [nm(1), nm(3)] };
    s.reqs = [];
    const ev = this.broadcast({ t: 'event', kind: 'deal', seat: dealer, events });
    return this.changed(now, [...ev, ...this.joke(state)]);
  }

  private endGame(now: number): Out[] {
    const s = this.s;
    const g = s.game!;
    const [first, second] = s.finishes as [TeamFinish, TeamFinish];
    const duration = this.elapsed(now);
    const rec: GameRecord = {
      id: this.deps.newId(),
      startedAt: s.clock?.startedAt ?? now,
      endedAt: now,
      durationMs: duration,
      turns: g.turns,
      teams: { A: [...(s.gameNames?.A ?? [])], B: [...(s.gameNames?.B ?? [])] },
      winner: first.team,
      order: [first, second].map((f) => ({ ...f, names: [...f.names] })),
      marginMs: Math.max(0, second.ms - first.ms),
      marginTurns: Math.max(0, second.turns - first.turns),
    };
    const expectedMs = this.expected.ms;
    let saved = false;
    try { saved = this.store.save(rec); } catch { saved = false; }
    this.expected = expectedFrom(this.safeList());
    s.phase = 'ended';
    s.winner = first.team;
    s.scores[first.team]++;
    s.result = { ...rec, expectedMs, saved };
    return this.noticeAll(saved ? 'game_saved' : 'save_failed');
  }

  private advanceMusic(now: number, sid: string | null, act: MusicAct): Out[] {
    const s = this.s;
    const cur = s.playing?.itemId;
    s.queue = s.queue.filter((q) => q.id !== cur);
    s.playing = s.queue[0] ? { itemId: s.queue[0].id, startedAt: now } : null;
    if (sid) this.musicAct(sid, act, now);
    return this.changed(now);
  }
}
