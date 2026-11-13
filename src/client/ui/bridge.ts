import { TRACK_LEN, progressOf, startSquare } from '../../shared/board';
import type { Seat } from '../../shared/board';
import type { GameEvent, MarblePos as WirePos, Move, Play } from '../../shared/protocol';
import { isWebGLAvailable } from '../scene/support';
import { samePos } from '../scene/layout';
import type { CardRef, MarblePos, MoveEvent, Quality, SceneApi, SceneView, Targets } from '../scene';
import type { Card, Net, RoomView } from '../net/types';
import { T } from './ar';
import { reducedMotion } from './tokens';
import { h } from './dom';

/** One way to complete the chosen card. Nothing is sent until the user confirms an option. */
export interface PendingOption { summary: string; moves: Move[] }
/** alt = side options offered while the player is still picking a marble (e.g. the 10's burn). */
export interface PendingMove { cardId: string; options: PendingOption[]; alt?: boolean }

/** What the Table needs from the 3D scene layer. */
export interface SceneHost {
  mount(container: HTMLElement): void;
  setView(v: RoomView): void;
  /** Server animation cues (hop, out, swap, deal...). */
  onEvent(kind: string, events: GameEvent[]): void;
  /** Currently selected card (or null); the scene then lets the user pick marble(s). */
  selectCard(card: Card | null): void;
  /** Legal-move highlight, shown on request only; must never select anything. */
  showHints(on: boolean): void;
  cancelPending(): void;
  onPending(cb: (p: PendingMove | null) => void): void;
  /** Short Arabic prompt for the next step ("اختر حجرك"), null when none. */
  onPrompt(cb: (s: string | null) => void): void;
  /** The scene reports a tap on one of the own cards. */
  onCardPick(cb: (cardId: string) => void): void;
  /** The 3D scene could not start (no WebGL / init failed): the table shows its 2D hand. */
  onFallback(cb: () => void): void;
  /** Called after each drawn frame (camera or cards moved): reposition HTML labels. */
  onFrame(cb: () => void): void;
  /** The player moved the camera away from / back to the seat view. */
  onCamera(cb: (moved: boolean) => void): void;
  seatAnchor(seat: number): { x: number; y: number } | null;
  cardAnchor(cardId: string): { x: number; y: number; w: number } | null;
  npcAnchor(): { head: { x: number; y: number } | null; badge: { x: number; y: number; w: number } | null };
  npcRead(): Promise<void>;
  npcDone(): void;
  resetCamera(): void;
  setViewSeat(seat: number): void;
  readonly quality: Quality;
  /** True when the 3D table is (or is about to be) shown: it draws the own hand itself. */
  readonly active: boolean;
  setQuality(q: Quality): void;
  onQuality(cb: (q: Quality, reason: 'auto' | 'user') => void): void;
}

/** Legal card ids, supplied by the server's hint reply (the UI never duplicates the rules). */
export interface HintSource { legalCardIds(v: RoomView): string[] }

const toScenePos = (p: WirePos, marble: number): MarblePos =>
  p.zone === 'track' ? { zone: 'track', index: p.square }
    : p.zone === 'home' ? { zone: 'home', seat: Math.floor(marble / 4), slot: p.slot }
      : { zone: 'base', seat: Math.floor(marble / 4), slot: marble % 4 };

const toRef = (c: Card): CardRef => ({ id: c.id, rank: c.rank, suit: c.suit });

export function toSceneView(v: RoomView, pile?: (CardRef | null)[]): SceneView {
  const g = v.game;
  const marbles: MarblePos[] = Array.from({ length: 16 }, (_, i) => ({ zone: 'base', seat: Math.floor(i / 4), slot: i % 4 }) as MarblePos);
  if (g) for (const m of g.marbles) marbles[m.id] = toScenePos(m.pos, m.id);
  const table: (CardRef | null)[] = pile ? pile.slice(0, 4) : [null, null, null, null];
  if (g?.last) table[g.last.seat] = toRef(g.last.card);
  return {
    mySeat: v.you.seat, dealer: g?.dealer ?? 0, turn: g?.turn ?? 0,
    hand: v.hand.map(toRef), handCounts: v.seats.map((s) => s.cards), marbles, table,
  };
}

/** Cell-by-cell path of a hop event, following the engine's movement (home entry after the last track square). */
export function hopPath(from: WirePos, to: WirePos, marble: number, n: number): MarblePos[] {
  const owner = Math.floor(marble / 4) as Seat;
  const path: MarblePos[] = [toScenePos(from, marble)];
  if (from.zone === 'track' && n > 0) {
    const p0 = progressOf(owner, from.square);
    for (let i = 1; i <= Math.min(n, TRACK_LEN + 4); i++) {
      const q = p0 + i;
      path.push(q < TRACK_LEN ? { zone: 'track', index: (startSquare(owner) + q) % TRACK_LEN } : { zone: 'home', seat: owner, slot: q - TRACK_LEN });
    }
  } else if (from.zone === 'track' && n < 0) {
    let sq = from.square;
    for (let i = 0; i < Math.min(-n, TRACK_LEN); i++) { sq = (sq - 1 + TRACK_LEN) % TRACK_LEN; path.push({ zone: 'track', index: sq }); }
  } else if (from.zone === 'home' && to.zone === 'home') {
    for (let s = from.slot + 1; s <= to.slot; s++) path.push({ zone: 'home', seat: owner, slot: s });
  }
  const end = toScenePos(to, marble);
  if (!samePos(path[path.length - 1], end)) return [path[0] as MarblePos, end];
  return path;
}

/** Where the first marble of a move lands (for highlighting destinations). Positions are the wire positions by marble id. */
export function destOf(m: Move, rank: string, pos: (id: number) => WirePos | undefined): MarblePos | null {
  if (m.k === 'burn' || m.k === 'discard') return null;
  const id = m.marble;
  const owner = Math.floor(id / 4) as Seat;
  if (m.k === 'out') return { zone: 'track', index: startSquare(owner) };
  if (m.k === 'swap') { const t = pos(m.target); return t ? toScenePos(t, m.target) : null; }
  const from = pos(id);
  if (!from) return null;
  if (rank === '4' || m.n < 0) {
    if (from.zone !== 'track') return null;
    return { zone: 'track', index: (from.square - Math.abs(m.n) + TRACK_LEN * 2) % TRACK_LEN };
  }
  if (from.zone === 'home') return { zone: 'home', seat: owner, slot: from.slot + m.n };
  if (from.zone !== 'track') return null;
  const t = progressOf(owner, from.square) + m.n;
  return t < TRACK_LEN ? { zone: 'track', index: (startSquare(owner) + t) % TRACK_LEN } : { zone: 'home', seat: owner, slot: t - TRACK_LEN };
}

function firstMarble(p: Play): number | undefined {
  const m = p.moves[0];
  return m && 'marble' in m ? m.marble : undefined;
}
const isDiscard = (p: Play) => p.moves[0]?.k === 'discard';

function describe(p: Play, rank: string): string {
  return p.moves.map((m) => {
    if (m.k === 'out') return T.moveOut;
    if (m.k === 'step') return rank === '4' || m.n < 0 ? T.moveBack(Math.abs(m.n)) : T.moveStep(m.n);
    if (m.k === 'burn') return T.moveBurn;
    if (m.k === 'swap') return T.moveSwap;
    return T.discardIt;
  }).join(' + ');
}

const PILE_KEY = 'pile';
type Step = 'none' | 'marble' | 'dest' | 'marble2';

let sceneMod: Promise<typeof import('../scene')> | null = null;
/** Fetch the 3D chunk (three.js) in the background; safe to call many times. */
export function preloadScene(): Promise<typeof import('../scene')> {
  sceneMod ??= import('../scene');
  return sceneMod;
}

/** Adapts the typed scene API to the Table. Move building uses the server's legal plays (hint reply). */
export class SceneBridge implements SceneHost, HintSource {
  private scene: SceneApi | null = null;
  private webgl = false;
  private failed = false;
  private plays: Play[] = [];
  private hintKey = '';
  private sel: Card | null = null;
  private step: Step = 'none';
  private first: number | null = null;
  private dest: MarblePos | null = null;
  private seconds: number[] = [];
  private view: RoomView | null = null;
  private latest: SceneView | null = null;
  private dealWanted = false;
  private busy = 0;
  private chain: Promise<void> = Promise.resolve();
  private pile: (CardRef | null)[] = [null, null, null, null];
  private pileGame: number | null = null;
  private pendingCb: (p: PendingMove | null) => void = () => {};
  private promptCb: (s: string | null) => void = () => {};
  private cardCb: (id: string) => void = () => {};
  private qualityCb: (q: Quality, r: 'auto' | 'user') => void = () => {};
  private fallbackCb: () => void = () => {};
  private frameCb: () => void = () => {};
  private cameraCb: (moved: boolean) => void = () => {};
  private ro: ResizeObserver | null = null;
  private off: () => void;
  private disposed = false;

  constructor(private net: Net) {
    const offHint = net.on('hint', (m) => { this.plays = m.plays; if (this.sel) this.selectCard(this.sel); });
    // A hint reply lost in a reconnect must be re-requested for the same turn.
    const offStatus = net.on('status', (s) => { if (s === 'open') this.hintKey = ''; }); // the fresh view after open asks again
    this.off = () => { offHint(); offStatus(); };
  }

  mount(container: HTMLElement): void {
    this.webgl = isWebGLAvailable();
    if (!this.webgl) { container.append(this.fallback()); this.failed = true; return; }
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none';
    container.append(canvas);
    const wait = h('div', { class: 'scene-wait', role: 'status' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), T.loading);
    container.append(wait);
    void preloadScene().then((mod) => {
      if (this.disposed) return;
      // Let the browser paint the table chrome first, then build the scene (procedural maps, shaders).
      requestAnimationFrame(() => setTimeout(() => {
        if (this.disposed) return;
        this.scene = mod.createScene(canvas, {
          reducedMotion: reducedMotion(),
          events: {
            onPickCard: (id) => this.cardCb(id),
            onPickMarble: (id) => this.pickMarble(id),
            onPickCell: (pos) => this.pickCell(pos),
            onPickNothing: () => this.pickNothing(),
            onDragStart: (id) => this.dragStart(id),
            onDrop: (id, cell) => this.drop(id, cell),
            onQuality: (q, r) => this.qualityCb(q, r),
            onFrame: () => this.frameCb(),
            onCamera: (m) => this.cameraCb(m),
          },
        });
        wait.remove();
        if (!this.scene) { canvas.remove(); container.append(this.fallback()); this.failed = true; this.fallbackCb(); return; }
        this.ro = new ResizeObserver(() => this.scene?.resize());
        this.ro.observe(container);
        if (this.view) this.setView(this.view);
        if (this.sel) this.selectCard(this.sel);
      }, 0));
    }, () => { wait.remove(); container.append(this.fallback()); this.failed = true; this.fallbackCb(); });
  }

  private fallback(): HTMLElement {
    return h('div', { class: 'scene-wait' }, T.noWebgl);
  }

  /** True when the WebGL scene is (or will be) running: it draws the own hand itself. */
  get active(): boolean { return this.webgl && !this.failed; }
  get quality(): Quality { return this.scene?.quality ?? 'high'; }
  setQuality(q: Quality): void { this.scene?.setQuality(q); }
  onQuality(cb: (q: Quality, reason: 'auto' | 'user') => void): void { this.qualityCb = cb; }
  onFallback(cb: () => void): void { this.fallbackCb = cb; }
  onFrame(cb: () => void): void { this.frameCb = cb; }
  onCamera(cb: (moved: boolean) => void): void { this.cameraCb = cb; }
  setViewSeat(seat: number): void { this.scene?.setViewSeat(seat, true); }
  seatAnchor(seat: number): { x: number; y: number } | null { return this.scene?.seatAnchor(seat) ?? null; }
  cardAnchor(id: string): { x: number; y: number; w: number } | null { return this.scene?.cardAnchor(id) ?? null; }
  npcAnchor(): { head: { x: number; y: number } | null; badge: { x: number; y: number; w: number } | null } { return this.scene?.npcAnchor() ?? { head: null, badge: null }; }
  npcRead(): Promise<void> { return this.scene?.npcRead() ?? Promise.resolve(); }
  npcDone(): void { this.scene?.npcDone(); }
  resetCamera(): void { this.scene?.resetCamera(true); }
  onPending(cb: (p: PendingMove | null) => void): void { this.pendingCb = cb; }
  onPrompt(cb: (s: string | null) => void): void { this.promptCb = cb; }
  onCardPick(cb: (cardId: string) => void): void { this.cardCb = cb; }

  /** Centre pile: last card each seat threw this game (kept across views and a refresh of this tab). */
  private syncPile(v: RoomView): void {
    const g = v.game;
    const gameId = v.phase !== 'lobby' && g ? v.clock.startedAt ?? 0 : null;
    if (gameId !== this.pileGame) {
      this.pileGame = gameId;
      this.pile = [null, null, null, null];
      if (gameId !== null) {
        try {
          const s = JSON.parse(sessionStorage.getItem(PILE_KEY) ?? 'null') as { g: number; c: (CardRef | null)[] } | null;
          if (s && s.g === gameId && Array.isArray(s.c) && s.c.length === 4) this.pile = s.c.map((c) => (c && typeof c.id === 'string' ? c : null));
        } catch { /* storage blocked or bad JSON */ }
      }
    }
    if (g?.last) this.pile[g.last.seat] = toRef(g.last.card);
    this.savePile();
  }
  private savePile(): void {
    try { if (this.pileGame !== null) sessionStorage.setItem(PILE_KEY, JSON.stringify({ g: this.pileGame, c: this.pile })); } catch { /* private mode */ }
  }
  /** Read-only copy for tests and the 2D fallback. */
  get pileCards(): (CardRef | null)[] { return this.pile.slice(); }

  setView(v: RoomView): void {
    this.view = v;
    this.syncPile(v);
    const sv = toSceneView(v, this.pile);
    this.latest = sv;
    // Ask the server for the legal plays once per turn (explicit read-only request; never plays).
    if (v.phase === 'playing' && v.game && v.you.seat !== null && v.turnSeat === v.you.seat) {
      const key = `${v.game.dealNo}:${v.hand.map((c) => c.id).join(',')}:${v.game.last?.card.id ?? ''}`;
      if (key !== this.hintKey) { this.hintKey = key; this.plays = []; this.net.send({ t: 'hint' }); }
    } else { this.hintKey = ''; this.plays = []; }
    if (!this.scene || !v.game) return;
    if (this.dealWanted && (v.you.seat === null || v.hand.length > 0)) {
      this.dealWanted = false;
      this.run(() => this.scene!.playDeal(sv));
    } else if (!this.busy) this.scene.applyView(sv);
  }

  private run(fn: () => Promise<void>): void {
    this.busy++;
    this.chain = this.chain.then(fn).catch(() => {}).then(() => {
      this.busy--;
      if (!this.busy && this.latest) this.scene?.applyView(this.latest);
    });
  }

  onEvent(kind: string, events: GameEvent[]): void {
    // Thrown cards stay in the centre (one per seat), even before the next view arrives.
    for (const e of events) {
      if ((e.kind === 'throw' || e.kind === 'discard' || e.kind === 'burn') && e.card && e.seat !== undefined) this.pile[e.seat] = toRef(e.card);
    }
    this.savePile();
    if (!this.scene) return;
    if (kind === 'deal') { this.dealWanted = true; if (this.view) this.setView(this.view); return; }
    const sc = this.scene;
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      if ((e.kind === 'throw' || e.kind === 'discard' || e.kind === 'burn') && e.card && e.seat !== undefined) {
        const seat = e.seat, card = toRef(e.card);
        this.run(() => sc.playThrow(seat, card));
        continue;
      }
      if (e.kind === 'deal') { this.dealWanted = true; continue; }
      if ((e.kind !== 'hop' && e.kind !== 'out' && e.kind !== 'swap') || e.marble === undefined || !e.from || !e.to || e.seat === undefined) continue;
      const m = e.marble;
      const path = e.kind === 'hop' ? hopPath(e.from, e.to, m, e.n ?? 0) : [toScenePos(e.from, m), toScenePos(e.to, m)];
      const captured: { marbleId: number; to: MarblePos }[] = [];
      for (let j = i + 1; j < events.length && events[j]!.kind === 'capture'; j++) {
        const c = events[j]!;
        if (c.marble !== undefined && c.other === m) captured.push({ marbleId: c.marble, to: toScenePos({ zone: 'base' }, c.marble) });
      }
      const mv: MoveEvent = { seat: e.seat, card: null, marbleId: m, path, swapWith: e.kind === 'swap' ? e.other : undefined, captured };
      this.run(() => sc.playMove(mv));
    }
  }

  // ---- card -> own marble -> destination (-> second marble for a split 7) -> confirm

  private cands(): Play[] { return this.sel ? this.plays.filter((p) => p.cardId === this.sel!.id) : []; }
  private wirePos = (id: number): WirePos | undefined => this.view?.game?.marbles.find((m) => m.id === id)?.pos;
  private firsts(): number[] { return [...new Set(this.cands().map(firstMarble).filter((x): x is number => x !== undefined))]; }
  private destsFor(marble: number): MarblePos[] {
    const out: MarblePos[] = [];
    for (const p of this.cands()) {
      if (firstMarble(p) !== marble) continue;
      const d = destOf(p.moves[0]!, this.sel?.rank ?? '', this.wirePos);
      if (d && !out.some((x) => samePos(x, d))) out.push(d);
    }
    return out;
  }
  private altOptions(): Play[] { return this.cands().filter((p) => firstMarble(p) === undefined); }
  private targets(t: Targets | null): void { this.scene?.setTargets(t); }

  selectCard(card: Card | null): void {
    this.sel = card; this.step = 'none'; this.first = null; this.dest = null; this.seconds = [];
    this.scene?.setSelection({ cardId: card?.id ?? null, marbleId: null });
    this.targets(null);
    this.pendingCb(null);
    if (!card) { this.promptCb(null); return; }
    const c = this.cands();
    if (!c.length) { this.promptCb(this.plays.length ? T.noMoves : null); return; }
    const firsts = this.firsts();
    // No marble to pick (discard only, or a 10 whose only legal play is burn) or no 3D board: offer the options directly.
    if (!firsts.length || !this.scene) { this.emit(c); return; }
    this.step = 'marble';
    this.targets({ marbles: firsts });
    this.promptCb(T.pickMarble);
    const alt = this.altOptions();
    if (alt.length) this.emit(alt, true);
  }

  private emit(options: Play[], alt = false): void {
    if (!this.sel) return;
    const rank = this.sel.rank;
    if (!alt) this.promptCb(null);
    this.pendingCb({ cardId: this.sel.id, alt, options: options.map((p) => ({ summary: describe(p, rank), moves: p.moves })) });
  }

  private pickMarble(id: number): void {
    if (!this.sel) return;
    if (this.step === 'marble2') { this.pickSecond(id); return; }
    if (this.step !== 'marble' && this.step !== 'dest') return;
    const firsts = this.firsts();
    if (!firsts.includes(id)) { this.promptCb(T.pickMarble); return; }
    this.first = id; this.dest = null; this.step = 'dest';
    this.scene?.setSelection({ cardId: this.sel.id, marbleId: id });
    this.targets({ marbles: firsts, selected: id, cells: this.destsFor(id) });
    const alt = this.altOptions();
    if (alt.length) this.emit(alt, true); else this.pendingCb(null);
    this.promptCb(this.sel.rank === 'J' ? T.pickTarget : T.pickDest);
  }

  private pickCell(pos: MarblePos): void {
    if (!this.sel || this.first === null || (this.step !== 'dest' && this.step !== 'marble2')) return;
    const first = this.first, rank = this.sel.rank;
    const matching = this.cands().filter((p) => firstMarble(p) === first && samePos(destOf(p.moves[0]!, rank, this.wirePos), pos));
    if (!matching.length) return;
    this.dest = pos;
    const singles = matching.filter((p) => p.moves.length === 1);
    const splits = matching.filter((p) => p.moves.length === 2);
    if (!singles.length && splits.length) {
      // 7 split: the rest of the steps go to a second marble, chosen by the mover.
      this.step = 'marble2';
      this.seconds = [...new Set(splits.map((p) => (p.moves[1] as { marble: number }).marble))];
      this.targets({ marbles: this.seconds, selected: first, chosen: pos });
      this.pendingCb(null);
      const n1 = (splits[0]!.moves[0] as { n: number }).n;
      this.promptCb(T.pickSecond(7 - n1));
      return;
    }
    this.step = 'dest';
    this.targets({ marbles: this.firsts(), selected: first, cells: this.destsFor(first), chosen: pos });
    this.emit(singles);
  }

  private secondDest(id: number): MarblePos | null {
    const p = this.splitFor(id);
    return p ? destOf(p.moves[1]!, '7', this.wirePos) : null;
  }
  private splitFor(id: number): Play | undefined {
    if (!this.sel || this.first === null || !this.dest) return undefined;
    const first = this.first, d = this.dest;
    return this.cands().find((p) => p.moves.length === 2 && firstMarble(p) === first && (p.moves[1] as { marble: number }).marble === id
      && samePos(destOf(p.moves[0]!, '7', this.wirePos), d));
  }

  private pickSecond(id: number): void {
    const p = this.splitFor(id);
    if (!p || this.first === null || !this.dest) { this.promptCb(T.pickSecond(0)); return; }
    this.targets({ marbles: this.seconds, selected: this.first, chosen: this.dest, cells: [this.secondDest(id)!].filter(Boolean) as MarblePos[] });
    this.emit([p]);
  }

  private dragStart(id: number): boolean {
    if (!this.sel) return false;
    if (this.step === 'marble2') {
      const d = this.secondDest(id);
      if (!d) return false;
      this.targets({ marbles: this.seconds, selected: this.first, chosen: this.dest, cells: [d] });
      return true;
    }
    if (!this.firsts().includes(id)) return false;
    if (this.first !== id) this.pickMarble(id);
    return true;
  }

  private drop(id: number, cell: MarblePos | null): void {
    if (!cell) return; // dropped away from a destination: the marble glides back, selection stays
    if (this.step === 'marble2') { if (samePos(cell, this.secondDest(id))) this.pickSecond(id); return; }
    if (id === this.first) this.pickCell(cell);
  }

  private pickNothing(): void {
    // A tap on empty space only steps back while choosing a destination (never cancels a ready confirm).
    if (this.step === 'dest' && !this.dest && this.sel) this.selectCard(this.sel);
  }

  cancelPending(): void {
    if (this.sel && this.scene && this.firsts().length) { this.selectCard(this.sel); return; }
    this.first = null; this.dest = null; this.step = 'none';
    this.scene?.setSelection({ cardId: this.sel?.id ?? null, marbleId: null });
    this.targets(null);
    this.pendingCb(null);
    this.promptCb(null);
  }

  showHints(on: boolean): void {
    if (!this.scene) return;
    if (!on) { this.scene.setHints(null); return; }
    const legal = this.plays.filter((p) => !isDiscard(p));
    const marbleIds = [...new Set(this.cands().map(firstMarble).filter((x): x is number => x !== undefined))];
    this.scene.setHints({ cardIds: [...new Set((legal.length ? legal : this.plays).map((p) => p.cardId))], marbleIds });
  }

  legalCardIds(_v: RoomView): string[] {
    const legal = this.plays.filter((p) => !isDiscard(p));
    return [...new Set((legal.length ? legal : this.plays).map((p) => p.cardId))];
  }

  dispose(): void { this.disposed = true; this.off(); this.ro?.disconnect(); this.scene?.dispose(); this.scene = null; }
}
