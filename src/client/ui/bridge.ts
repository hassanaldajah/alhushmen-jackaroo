import { TRACK_LEN } from '../../shared/board';
import type { GameEvent, MarblePos as WirePos, Move, Play } from '../../shared/protocol';
import { createScene, isWebGLAvailable } from '../scene';
import type { CardRef, MarblePos, Quality, SceneApi, SceneView } from '../scene';
import type { Card, Net, RoomView } from '../net/types';
import { T } from './ar';
import { reducedMotion } from './tokens';

/** One way to complete the chosen card. Nothing is sent until the user confirms an option. */
export interface PendingOption { summary: string; moves: Move[] }
export interface PendingMove { cardId: string; options: PendingOption[] }

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
  /** Short Arabic prompt for the next step ("اختر الحجر"), null when none. */
  onPrompt(cb: (s: string | null) => void): void;
  /** The scene reports a tap on one of the own cards. */
  onCardPick(cb: (cardId: string) => void): void;
  seatAnchor(seat: number): { x: number; y: number } | null;
  setViewSeat(seat: number): void;
  readonly quality: Quality;
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

export function toSceneView(v: RoomView): SceneView {
  const g = v.game;
  const marbles: MarblePos[] = Array.from({ length: 16 }, (_, i) => ({ zone: 'base', seat: Math.floor(i / 4), slot: i % 4 }) as MarblePos);
  if (g) for (const m of g.marbles) marbles[m.id] = toScenePos(m.pos, m.id);
  const table: (CardRef | null)[] = [null, null, null, null];
  if (g?.last) table[g.last.seat] = toRef(g.last.card);
  return {
    mySeat: v.you.seat, dealer: g?.dealer ?? 0, turn: g?.turn ?? 0,
    hand: v.hand.map(toRef), handCounts: v.seats.map((s) => s.cards), marbles, table,
  };
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

/** Adapts the typed scene API to the Table. Move building uses the server's legal plays (hint reply). */
export class SceneBridge implements SceneHost, HintSource {
  private scene: SceneApi | null = null;
  private plays: Play[] = [];
  private hintKey = '';
  private sel: Card | null = null;
  private marble: number | null = null;
  private view: RoomView | null = null;
  private latest: SceneView | null = null;
  private dealWanted = false;
  private busy = 0;
  private chain: Promise<void> = Promise.resolve();
  private pendingCb: (p: PendingMove | null) => void = () => {};
  private promptCb: (s: string | null) => void = () => {};
  private cardCb: (id: string) => void = () => {};
  private qualityCb: (q: Quality, r: 'auto' | 'user') => void = () => {};
  private ro: ResizeObserver | null = null;
  private off: () => void;

  constructor(private net: Net) {
    const offHint = net.on('hint', (m) => { this.plays = m.plays; if (this.sel) this.selectCard(this.sel); });
    // A hint reply lost in a reconnect must be re-requested for the same turn.
    const offStatus = net.on('status', (s) => { if (s === 'open') this.hintKey = ''; }); // the fresh view after open asks again
    this.off = () => { offHint(); offStatus(); };
  }

  mount(container: HTMLElement): void {
    if (!isWebGLAvailable()) { container.append(this.fallback()); return; }
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none';
    container.append(canvas);
    this.scene = createScene(canvas, {
      reducedMotion: reducedMotion(),
      events: {
        onPickCard: (id) => this.cardCb(id),
        onPickMarble: (id) => this.pickMarble(id),
        onPickNothing: () => { if (this.marble !== null) this.cancelPending(); },
        onQuality: (q, r) => this.qualityCb(q, r),
      },
    });
    if (!this.scene) { canvas.remove(); container.append(this.fallback()); return; }
    this.ro = new ResizeObserver(() => this.scene?.resize());
    this.ro.observe(container);
    if (this.view) this.setView(this.view);
  }

  private fallback(): HTMLElement {
    const d = document.createElement('div');
    d.className = 'overlay'; d.style.position = 'absolute'; d.style.background = 'transparent';
    d.textContent = T.loading;
    return d;
  }

  /** True when the WebGL scene is running (it draws the own hand itself). */
  get active(): boolean { return this.scene !== null; }
  get quality(): Quality { return this.scene?.quality ?? 'high'; }
  setQuality(q: Quality): void { this.scene?.setQuality(q); }
  onQuality(cb: (q: Quality, reason: 'auto' | 'user') => void): void { this.qualityCb = cb; }
  setViewSeat(seat: number): void { this.scene?.setViewSeat(seat, true); }
  seatAnchor(seat: number): { x: number; y: number } | null { return this.scene?.seatAnchor(seat) ?? null; }
  onPending(cb: (p: PendingMove | null) => void): void { this.pendingCb = cb; }
  onPrompt(cb: (s: string | null) => void): void { this.promptCb = cb; }
  onCardPick(cb: (cardId: string) => void): void { this.cardCb = cb; }

  setView(v: RoomView): void {
    this.view = v;
    const sv = toSceneView(v);
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
    if (!this.scene) return;
    if (kind === 'deal') { this.dealWanted = true; if (this.view) this.setView(this.view); return; }
    for (const e of events) {
      if ((e.kind !== 'hop' && e.kind !== 'out' && e.kind !== 'swap') || e.marble === undefined || !e.from || !e.to || e.seat === undefined) continue;
      const m = e.marble;
      const path: MarblePos[] = [toScenePos(e.from, m)];
      if (e.kind === 'hop' && e.from.zone === 'track' && e.to.zone === 'track' && e.n) {
        const dir = e.n < 0 ? -1 : 1;
        let sq = e.from.square;
        for (let i = 0; i < Math.min(Math.abs(e.n), TRACK_LEN); i++) { sq = (sq + dir + TRACK_LEN) % TRACK_LEN; path.push({ zone: 'track', index: sq }); }
      } else path.push(toScenePos(e.to, m));
      const seat = e.seat;
      const ev = { seat, card: e.card ? toRef(e.card) : null, marbleId: m, path, swapWith: e.kind === 'swap' ? e.other : undefined };
      this.run(() => this.scene!.playMove(ev));
    }
  }

  // ---- card / marble selection state machine

  private cands(): Play[] { return this.sel ? this.plays.filter((p) => p.cardId === this.sel!.id) : []; }

  selectCard(card: Card | null): void {
    this.sel = card; this.marble = null;
    this.scene?.setSelection({ cardId: card?.id ?? null, marbleId: null });
    this.pendingCb(null);
    if (!card) { this.promptCb(null); return; }
    const c = this.cands();
    if (!c.length) { this.promptCb(this.plays.length ? T.noMoves : null); return; }
    // No marble to pick (discard only, or a 10 whose only legal play is burn): offer the options directly,
    // otherwise a burn-only hand could never be sent (deadlock).
    if (c.every((p) => firstMarble(p) === undefined)) { this.emit(c); return; }
    this.promptCb(T.pickMarble);
  }

  private emit(options: Play[]): void {
    if (!this.sel) return;
    const rank = this.sel.rank;
    this.promptCb(null);
    this.pendingCb({ cardId: this.sel.id, options: options.map((p) => ({ summary: describe(p, rank), moves: p.moves })) });
  }

  private pickMarble(id: number): void {
    if (!this.sel) return;
    const c = this.cands();
    if (this.marble !== null) { // second step: Jack target
      const o = c.filter((p) => p.moves[0]?.k === 'swap' && firstMarble(p) === this.marble && (p.moves[0] as { target: number }).target === id);
      if (o.length) this.emit(o); else this.promptCb(T.pickTarget);
      return;
    }
    const own = c.filter((p) => firstMarble(p) === id);
    if (!own.length) { this.promptCb(T.pickMarble); return; }
    this.scene?.setSelection({ cardId: this.sel.id, marbleId: id });
    const swaps = own.filter((p) => p.moves[0]?.k === 'swap');
    if (swaps.length === own.length && swaps.length > 1) { this.marble = id; this.promptCb(T.pickTarget); return; }
    this.emit([...own, ...c.filter((p) => p.moves[0]?.k === 'burn')]);
  }

  cancelPending(): void {
    this.marble = null;
    this.scene?.setSelection({ cardId: this.sel?.id ?? null, marbleId: null });
    this.pendingCb(null);
    this.promptCb(this.sel ? T.pickMarble : null);
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

  dispose(): void { this.off(); this.ro?.disconnect(); this.scene?.dispose(); this.scene = null; }
}
