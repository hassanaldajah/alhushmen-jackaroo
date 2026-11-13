// Scene-local types. The UI bridge maps src/shared/protocol.ts views into these
// (protocol MarblePos {track, square} -> {zone:'track', index: square}; base/home gain the owner seat).

export type Suit = 'S' | 'H' | 'D' | 'C';
export type Rank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'JOKER';

export interface CardRef { id: string; rank: Rank; suit: Suit | null }

/**
 * Marble position. Track index 0..75 (TRACK_LEN, src/shared/board.ts) is absolute; seat s starts at index s*19 (SEGMENT).
 * Track runs counter-clockwise seen from above. home/base slot 0..3
 * (home slot 0 is the one nearest the track). Marble id = seat*4 + slot at start.
 */
export type MarblePos =
  | { zone: 'base'; seat: number; slot: number }
  | { zone: 'track'; index: number }
  | { zone: 'home'; seat: number; slot: number };

export interface SceneView {
  /** Seat shown at the bottom; null = spectator (seat 0 at bottom, no own hand). */
  mySeat: number | null;
  dealer: number;
  turn: number;
  /** Own hand, face-up. Empty for spectators. */
  hand: CardRef[];
  /** Card counts for all 4 seats (own seat included). */
  handCounts: number[];
  /** 16 entries indexed by marble id. */
  marbles: MarblePos[];
  /** Last played card per seat, or null. */
  table: (CardRef | null)[];
}

export interface MoveEvent {
  seat: number;
  /** Played card (null = none, e.g. pure marble animation). */
  card: CardRef | null;
  marbleId: number;
  /** Full cell-by-cell path including start. Hops once per entry. */
  path: MarblePos[];
  /** Marbles sent back to base after landing (capture). */
  captured?: { marbleId: number; to: MarblePos }[];
  /** Jack: marble that swaps places with marbleId. */
  swapWith?: number;
}

export type Quality = 'high' | 'low';

export type SfxName = 'deal' | 'flip' | 'throw' | 'hop' | 'capture';

export interface SceneEvents {
  onPickCard?: (cardId: string) => void;
  onPickMarble?: (marbleId: number) => void;
  onPickCell?: (pos: MarblePos) => void;
  /** Tap on empty board/background. */
  onPickNothing?: () => void;
  onSfx?: (name: SfxName) => void;
  /** Pointer hover over an own card (mouse only); null when leaving. Informational: the scene already previews it. */
  onHoverCard?: (cardId: string | null) => void;
  /** Quality changed. reason 'auto' = scene degraded itself (show toast "خفّضنا الجودة عشان الأداء" with Undo -> setQuality('high')). */
  onQuality?: (q: Quality, reason: 'auto' | 'user') => void;
  onStatus?: (s: 'ready' | 'context-lost' | 'restored' | 'degraded') => void;
}

export interface SceneOptions {
  events?: SceneEvents;
  /** null/undefined = follow the OS media query; true/false = user setting. */
  reducedMotion?: boolean | null;
  /** Initial quality; default = localStorage 'gfx' ('high' | 'low'), else 'high'. */
  quality?: Quality;
}

export interface Hints { cardIds?: string[]; marbleIds?: number[]; cells?: MarblePos[] }

export interface SceneApi {
  applyView(view: SceneView): void;
  playDeal(view: SceneView): Promise<void>;
  playMove(ev: MoveEvent): Promise<void>;
  skipAnimations(): void;
  setSelection(sel: { cardId?: string | null; marbleId?: number | null }): void;
  /** On request only; never selects anything. Pass null to clear. */
  setHints(h: Hints | null): void;
  /** CSS px covered by HUD/hand bar; the board is framed in the free area. */
  setInsets(i: { top?: number; bottom?: number }): void;
  /** Spectators only: which seat's side is at the bottom (0..3). Ignored for players. Default 0 (neutral). */
  setViewSeat(seat: number, animated?: boolean): void;
  /** Graphics quality; persisted in localStorage 'gfx'. Applies live. */
  setQuality(q: Quality): void;
  readonly quality: Quality;
  /** CSS px (relative to the canvas) above the avatar's head at a seat, for speech bubbles; null if off-screen. */
  seatAnchor(seat: number): { x: number; y: number } | null;
  resetCamera(animated?: boolean): void;
  setZoom(z: number, animated?: boolean): void;
  setReducedMotion(v: boolean | null): void;
  setInteractive(v: boolean): void;
  /** Arabic text alternative for the canvas (role="img" label). */
  describe(): string;
  resize(): void;
  readonly stats: { drawCalls: number; triangles: number; degradeLevel: number };
  dispose(): void;
}
