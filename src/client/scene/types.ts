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
  /** Last card each seat threw (the centre pile keeps one per player), or null. */
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

/** What the current player may touch on the board right now (set by the UI bridge from the server's legal plays). */
export interface Targets {
  /** Marbles that can be tapped or dragged now (ring + lift on hover). */
  marbles?: number[];
  /** Legal destination squares of the selected marble (rings); a tap or a drop on one picks it. */
  cells?: MarblePos[];
  /** Marble that is selected (gold ring). */
  selected?: number | null;
  /** Chosen destination: a ghost of `selected` waits there until the player confirms. */
  chosen?: MarblePos | null;
}

export interface SceneEvents {
  onPickCard?: (cardId: string) => void;
  onPickMarble?: (marbleId: number) => void;
  onPickCell?: (pos: MarblePos) => void;
  /** Tap on empty board/background. */
  onPickNothing?: () => void;
  /** A drag started on a target marble; return true to let the marble follow the finger. */
  onDragStart?: (marbleId: number) => boolean;
  /** Drag ended: the nearest target cell under the marble (null = dropped elsewhere, it glides back). */
  onDrop?: (marbleId: number, cell: MarblePos | null) => void;
  onSfx?: (name: SfxName) => void;
  /** Pointer hover over an own card (mouse only); null when leaving. Informational: the scene already previews it. */
  onHoverCard?: (cardId: string | null) => void;
  /** Quality changed. reason 'auto' = scene degraded itself (show toast "خفّضنا الجودة عشان الأداء" with Undo -> setQuality('high')). */
  onQuality?: (q: Quality, reason: 'auto' | 'user') => void;
  onStatus?: (s: 'ready' | 'context-lost' | 'restored' | 'degraded') => void;
  /** The player moved the camera away from (true) or back to (false) the default seat view. */
  onCamera?: (moved: boolean) => void;
  /** A frame was drawn after the camera or a card moved (reposition HTML labels). */
  onFrame?: () => void;
}

export interface SceneOptions {
  events?: SceneEvents;
  /** null/undefined = follow the OS media query; true/false = user setting. */
  reducedMotion?: boolean | null;
  /** Initial quality; default = localStorage 'gfx' ('high' | 'low'), else 'high'. */
  quality?: Quality;
}

export interface Hints { cardIds?: string[]; marbleIds?: number[]; cells?: MarblePos[] }

export interface ScreenPoint { x: number; y: number }

export interface SceneApi {
  applyView(view: SceneView): void;
  playDeal(view: SceneView): Promise<void>;
  playMove(ev: MoveEvent): Promise<void>;
  /** A card leaves a hand for that seat's spot in the centre pile (play, discard, burn). */
  playThrow(seat: number, card: CardRef): Promise<void>;
  skipAnimations(): void;
  setSelection(sel: { cardId?: string | null; marbleId?: number | null }): void;
  /** On request only; never selects anything. Pass null to clear. */
  setHints(h: Hints | null): void;
  /** Interactive marbles / destinations for the current step (null = nothing on the board is interactive). */
  setTargets(t: Targets | null): void;
  /**
   * Phone: while a card is selected, shrink the own hand to a thin strip whose bottom edge sits `bottom` canvas px
   * above the canvas bottom (between `left` and `right` insets). null = normal hand.
   */
  setHandStrip(b: { bottom: number; left?: number; right?: number } | null): void;
  /** CSS px covered by HUD/hand bar; the board is framed in the free area. */
  setInsets(i: { top?: number; bottom?: number }): void;
  /** Spectators only: which seat's side is at the bottom (0..3). Ignored for players. Default 0 (neutral). */
  setViewSeat(seat: number, animated?: boolean): void;
  /** Graphics quality; persisted in localStorage 'gfx'. Applies live. */
  setQuality(q: Quality): void;
  readonly quality: Quality;
  /** CSS px (relative to the canvas) above the avatar's head at a seat, for speech bubbles; null if off-screen. */
  seatAnchor(seat: number): ScreenPoint | null;
  /** Top centre of an own card on screen (tooltip anchor) and its on-screen width; null if hidden/off-screen. */
  cardAnchor(cardId: string): (ScreenPoint & { w: number }) | null;
  /** Centre of a marble on screen (CSS px relative to the canvas); null if off-screen. */
  marbleAnchor(marbleId: number): ScreenPoint | null;
  /** Centre of a board cell on screen (CSS px relative to the canvas); null if off-screen. */
  cellAnchor(pos: MarblePos): ScreenPoint | null;
  /** Pirate NPC: point above his head, and his chest badge (centre + on-screen width). */
  npcAnchor(): { head: ScreenPoint | null; badge: (ScreenPoint & { w: number }) | null };
  /** Pirate pulls the folded paper out of his pocket; resolves when he is ready to read. */
  npcRead(): Promise<void>;
  /** Pirate folds the paper away. */
  npcDone(): void;
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
