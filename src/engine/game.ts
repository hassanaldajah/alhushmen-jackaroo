/**
 * Pure Jackaroo engine (ruleset "jordan", owner-approved defaults Q1-Q12 in docs/rules-ar.md).
 * No I/O. All randomness comes from the injected Rng. State is plain JSON.
 *
 * Rules implemented:
 *  - A: out, or 1, or 11 (Q7). K: out only. Q: 12. 2,3,5,6,8,9: forward by value (Q1: 5 is plain).
 *  - 4: 4 backward, track marbles only (Q10). 7: 7 with one marble or split over two (Q9: capture on final stop only).
 *  - 10: 10 forward or burn the next player's turn (Q8: always allowed; burned player loses one random card).
 *  - J: swap one of your track marbles with an opponent track marble; protected/home marbles excluded (Q11).
 *  - Out: onto own start; blocked if own marble already there; any other marble there is captured.
 *  - Landing on any marble sends it to its base (Q5, team included), except a protected marble
 *    (a marble sitting on its own start square) which cannot be landed on. Passing over marbles is allowed (Q6).
 *  - Home entry must be exact and cannot pass own home marbles (Q4).
 *  - No legal play with any card: discard one card of choice (Q2). No partner exchange (Q3).
 *  - 4 cards each per deal, dealer rotates, reshuffle full deck when the pile is short (Q12).
 *  - After all 4 own marbles are home, a player moves the partner's marbles. Team with all 8 home wins.
 *  - Game end (round 2): the first team with all 8 home is the winner, but play continues (its seats are
 *    skipped and get no cards) until the other team also finishes; then `over` is set. `turns` counts
 *    plays/discards; `doneTurn[i]` is the turn count when `done[i]` finished (margin in turns).
 */

import {
  HOME_SLOTS, MARBLES_PER_SEAT, SEATS, TRACK_LEN, marbleOwner, nextSeat, partnerOf, progressOf,
  startSquare, teamOf, type Seat,
} from '../shared/board';
import type {
  Card, GameEvent, GameView, MarbleId, MarblePos, Move, Play, Rank, Suit, Team,
} from '../shared/protocol';
import { shuffle, type Rng } from './rng';

export const RULESET = 'jordan';
export const HAND_SIZE = 4;
const RANKS: Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS: Suit[] = ['S', 'H', 'D', 'C'];

export interface GameState {
  ruleset: string;
  marbles: MarblePos[]; // index = MarbleId
  hands: Card[][]; // index = seat
  deck: Card[]; // draw pile, top = last element
  discard: Card[];
  dealer: Seat;
  turn: Seat;
  dealNo: number;
  last: GameView['last'];
  winner: Team | null;
  /** Teams in finishing order (done[0] === winner). */
  done: Team[];
  /** Value of `turns` when each team in `done` finished. */
  doneTurn: number[];
  /** Plays (including discards and burns) made this game. */
  turns: number;
  /** Both teams finished: no more plays. */
  over: boolean;
  /** The one first-turn skip of this game was used (optional: games saved before Skip existed). */
  skipUsed?: boolean;
}

export type PlayResult =
  | { ok: true; events: GameEvent[] }
  | { ok: false; code: 'not_turn' | 'no_card' | 'illegal' | 'ended' | 'no_skip' };

/** True when this seat's team already brought all 8 marbles home (seat is skipped). */
export function seatDone(state: GameState, seat: Seat): boolean {
  return (state.done ?? []).includes(teamOf(seat));
}

/** Next seat after `seat` whose team is still playing (falls back to plain next). */
export function nextActive(state: GameState, seat: Seat): Seat {
  let n = nextSeat(seat);
  for (let i = 0; i < 4 && seatDone(state, n); i++) n = nextSeat(n);
  return n;
}

export function fullDeck(): Card[] {
  const out: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) out.push({ id: r + s, rank: r, suit: s });
  return out;
}

export function newGame(rng: Rng, dealer: Seat = 0): { state: GameState; events: GameEvent[] } {
  const state: GameState = {
    ruleset: RULESET,
    marbles: Array.from({ length: 16 }, () => ({ zone: 'base' }) as MarblePos),
    hands: [[], [], [], []],
    deck: [],
    discard: [],
    dealer,
    turn: nextSeat(dealer),
    dealNo: 0,
    last: null,
    winner: null,
    done: [],
    doneTurn: [],
    turns: 0,
    over: false,
  };
  const events = deal(state, rng);
  return { state, events };
}

/** Deal HAND_SIZE cards to everyone, one at a time starting left of the dealer. */
export function deal(state: GameState, rng: Rng): GameEvent[] {
  const events: GameEvent[] = [];
  const active = SEATS.filter((s) => !seatDone(state, s)).length;
  if (state.deck.length < HAND_SIZE * active) {
    state.deck = shuffle(fullDeck(), rng);
    state.discard = [];
    events.push({ kind: 'shuffle', seat: state.dealer });
  }
  for (let i = 0; i < HAND_SIZE; i++) {
    for (let k = 1; k <= 4; k++) {
      const seat = ((state.dealer + k) % 4) as Seat;
      if (seatDone(state, seat)) continue;
      state.hands[seat]!.push(state.deck.pop()!);
    }
  }
  state.dealNo++;
  state.turn = nextActive(state, state.dealer);
  events.push({ kind: 'deal', seat: state.dealer });
  return events;
}

// ---------------------------------------------------------------- helpers

export function clone(state: GameState): GameState {
  return structuredClone(state);
}

function isHome(p: MarblePos): boolean {
  return p.zone === 'home';
}

export function seatFinished(state: GameState, seat: Seat): boolean {
  for (let i = 0; i < MARBLES_PER_SEAT; i++) if (!isHome(state.marbles[seat * 4 + i]!)) return false;
  return true;
}

export function teamWon(state: GameState, team: Team): boolean {
  return SEATS.filter((s) => teamOf(s) === team).every((s) => seatFinished(state, s));
}

/** Marbles this seat may move right now: own, or partner's once all own marbles are home. */
export function controlledMarbles(state: GameState, seat: Seat): MarbleId[] {
  const owner = seatFinished(state, seat) ? partnerOf(seat) : seat;
  return [0, 1, 2, 3].map((i) => owner * 4 + i);
}

function occupantAt(state: GameState, square: number): MarbleId {
  return state.marbles.findIndex((p) => p.zone === 'track' && p.square === square);
}

export function isProtected(state: GameState, id: MarbleId): boolean {
  const p = state.marbles[id]!;
  return p.zone === 'track' && p.square === startSquare(marbleOwner(id));
}

function homeSlotFree(state: GameState, owner: Seat, slot: number): boolean {
  for (let i = 0; i < 4; i++) {
    const p = state.marbles[owner * 4 + i]!;
    if (p.zone === 'home' && p.slot === slot) return false;
  }
  return true;
}

function cardValue(rank: Rank): number {
  switch (rank) {
    case 'A': return 1;
    case 'J': return 11;
    case 'Q': return 12;
    case 'K': return 13;
    default: return Number(rank);
  }
}

// ---------------------------------------------------------------- atomic moves (mutate state)

type Fail = { fail: true };
const FAIL: Fail = { fail: true };

/** Land a marble on a track square, capturing a non-protected occupant. */
function landOn(state: GameState, id: MarbleId, square: number, events: GameEvent[], by: Seat): boolean {
  const occ = occupantAt(state, square);
  if (occ === id) return true;
  if (occ >= 0) {
    if (isProtected(state, occ)) return false;
    const from = state.marbles[occ]!;
    state.marbles[occ] = { zone: 'base' };
    events.push({ kind: 'capture', seat: by, marble: occ, other: id, from, to: { zone: 'base' } });
  }
  state.marbles[id] = { zone: 'track', square };
  return true;
}

function doOut(state: GameState, id: MarbleId, events: GameEvent[], by: Seat): boolean {
  if (state.marbles[id]!.zone !== 'base') return false;
  const owner = marbleOwner(id);
  const sq = startSquare(owner);
  const occ = occupantAt(state, sq);
  if (occ >= 0 && marbleOwner(occ) === owner) return false; // own marble already on start
  const capEvents: GameEvent[] = [];
  if (!landOn(state, id, sq, capEvents, by)) return false;
  events.push({ kind: 'out', seat: by, marble: id, from: { zone: 'base' }, to: { zone: 'track', square: sq } });
  events.push(...capEvents);
  return true;
}

function doForward(state: GameState, id: MarbleId, n: number, events: GameEvent[], by: Seat): boolean {
  const from = state.marbles[id]!;
  const owner = marbleOwner(id);
  if (n < 1) return false;
  if (from.zone === 'base') return false;
  if (from.zone === 'home') {
    const target = from.slot + n;
    if (target >= HOME_SLOTS) return false;
    for (let s = from.slot + 1; s <= target; s++) if (!homeSlotFree(state, owner, s)) return false;
    state.marbles[id] = { zone: 'home', slot: target };
    events.push({ kind: 'hop', seat: by, marble: id, from, to: state.marbles[id], n });
    return true;
  }
  const t = progressOf(owner, from.square) + n;
  if (t < TRACK_LEN) {
    const square = (startSquare(owner) + t) % TRACK_LEN;
    const capEvents: GameEvent[] = [];
    if (!landOn(state, id, square, capEvents, by)) return false;
    events.push({ kind: 'hop', seat: by, marble: id, from, to: state.marbles[id], n }, ...capEvents);
    return true;
  }
  const slot = t - TRACK_LEN;
  if (slot >= HOME_SLOTS) return false; // exact entry only
  for (let s = 0; s <= slot; s++) if (!homeSlotFree(state, owner, s)) return false;
  state.marbles[id] = { zone: 'home', slot };
  events.push({ kind: 'hop', seat: by, marble: id, from, to: state.marbles[id], n });
  events.push({ kind: 'home', seat: by, marble: id, to: state.marbles[id] });
  return true;
}

function doBackward(state: GameState, id: MarbleId, n: number, events: GameEvent[], by: Seat): boolean {
  const from = state.marbles[id]!;
  if (from.zone !== 'track') return false;
  const square = (from.square - n + TRACK_LEN * 2) % TRACK_LEN;
  const capEvents: GameEvent[] = [];
  if (!landOn(state, id, square, capEvents, by)) return false;
  events.push({ kind: 'hop', seat: by, marble: id, from, to: state.marbles[id], n: -n }, ...capEvents);
  return true;
}

function doSwap(state: GameState, a: MarbleId, b: MarbleId, events: GameEvent[], by: Seat): boolean {
  const pa = state.marbles[a]!;
  const pb = state.marbles[b]!;
  if (pa.zone !== 'track' || pb.zone !== 'track') return false;
  if (teamOf(marbleOwner(a)) === teamOf(marbleOwner(b))) return false;
  if (isProtected(state, a) || isProtected(state, b)) return false;
  state.marbles[a] = pb;
  state.marbles[b] = pa;
  events.push({ kind: 'swap', seat: by, marble: a, other: b, from: pa, to: pb });
  return true;
}

function isMarbleId(x: unknown): x is MarbleId {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < 16;
}

/**
 * Apply the moves of one card on a scratch state. Returns events or FAIL.
 * Does not touch hands/turn. Does not handle burn/discard.
 */
function simulateCard(state: GameState, seat: Seat, rank: Rank, moves: Move[]): GameEvent[] | Fail {
  const ev: GameEvent[] = [];
  const ctl = (id: MarbleId): boolean => controlledMarbles(state, seat).includes(id);
  const m0 = moves[0];
  if (!m0) return FAIL;

  if (rank === '7') {
    if (moves.length < 1 || moves.length > 2) return FAIL;
    let total = 0;
    const used = new Set<MarbleId>();
    for (const m of moves) {
      if (m.k !== 'step' || !isMarbleId(m.marble) || !Number.isInteger(m.n) || m.n < 1 || m.n > 7) return FAIL;
      if (used.has(m.marble)) return FAIL;
      used.add(m.marble);
      if (!ctl(m.marble)) return FAIL; // re-evaluated: partner's marbles become usable after finishing
      total += m.n;
      if (!doForward(state, m.marble, m.n, ev, seat)) return FAIL;
      if (teamWon(state, teamOf(seat)) && total < 7) {
        // Game already won mid-split: remaining steps are void.
        return ev;
      }
    }
    return total === 7 ? ev : FAIL;
  }

  if (moves.length !== 1) return FAIL;
  const m = m0;
  if (m.k === 'burn' || m.k === 'discard') return FAIL;
  if (!isMarbleId(m.marble) || !ctl(m.marble)) return FAIL;

  switch (rank) {
    case 'A':
      if (m.k === 'out') return doOut(state, m.marble, ev, seat) ? ev : FAIL;
      if (m.k === 'step' && (m.n === 1 || m.n === 11)) return doForward(state, m.marble, m.n, ev, seat) ? ev : FAIL;
      return FAIL;
    case 'K':
      return m.k === 'out' && doOut(state, m.marble, ev, seat) ? ev : FAIL;
    case 'J':
      if (m.k !== 'swap' || !isMarbleId(m.target)) return FAIL;
      return doSwap(state, m.marble, m.target, ev, seat) ? ev : FAIL;
    case '4':
      return m.k === 'step' && m.n === 4 && doBackward(state, m.marble, 4, ev, seat) ? ev : FAIL;
    default: {
      const v = cardValue(rank);
      return m.k === 'step' && m.n === v && doForward(state, m.marble, v, ev, seat) ? ev : FAIL;
    }
  }
}

// ---------------------------------------------------------------- enumeration

/** All legal plays (excluding discard) for one card, deduplicated by resulting moves. */
export function playsForCard(state: GameState, seat: Seat, card: Card): Play[] {
  const out: Play[] = [];
  const ctl = controlledMarbles(state, seat);
  const tryMoves = (moves: Move[]): void => {
    const s = clone(state);
    if (!('fail' in (simulateCard(s, seat, card.rank, moves) as object))) out.push({ cardId: card.id, moves });
  };
  switch (card.rank) {
    case 'A':
      for (const id of ctl) { tryMoves([{ k: 'out', marble: id }]); tryMoves([{ k: 'step', marble: id, n: 1 }]); tryMoves([{ k: 'step', marble: id, n: 11 }]); }
      break;
    case 'K':
      for (const id of ctl) tryMoves([{ k: 'out', marble: id }]);
      break;
    case 'J':
      for (const id of ctl) for (let t = 0; t < 16; t++) tryMoves([{ k: 'swap', marble: id, target: t }]);
      break;
    case '10':
      out.push({ cardId: card.id, moves: [{ k: 'burn' }] });
      for (const id of ctl) tryMoves([{ k: 'step', marble: id, n: 10 }]);
      break;
    case '7': {
      for (const id of ctl) tryMoves([{ k: 'step', marble: id, n: 7 }]);
      // Split: first marble from current control; second may include partner's if first finishes the seat.
      const all = [...ctl, ...controlledMarbles(state, partnerOf(seat))];
      for (const a of ctl) for (let n = 1; n <= 6; n++) for (const b of all) {
        if (a !== b) tryMoves([{ k: 'step', marble: a, n }, { k: 'step', marble: b, n: 7 - n }]);
      }
      break;
    }
    case '4':
      for (const id of ctl) tryMoves([{ k: 'step', marble: id, n: 4 }]);
      break;
    default:
      for (const id of ctl) tryMoves([{ k: 'step', marble: id, n: cardValue(card.rank) }]);
  }
  return out;
}

export function legalPlays(state: GameState, seat: Seat): Play[] {
  if (state.over || seatDone(state, seat)) return [];
  const hand = state.hands[seat]!;
  const plays = hand.flatMap((c) => playsForCard(state, seat, c));
  if (plays.length === 0) return hand.map((c) => ({ cardId: c.id, moves: [{ k: 'discard' }] }));
  return plays;
}

export function hasLegalPlay(state: GameState, seat: Seat): boolean {
  return state.hands[seat]!.some((c) => playsForCard(state, seat, c).length > 0);
}

// ---------------------------------------------------------------- apply

function removeCard(state: GameState, seat: Seat, cardId: string): Card | null {
  const hand = state.hands[seat]!;
  const i = hand.findIndex((c) => c.id === cardId);
  if (i < 0) return null;
  return hand.splice(i, 1)[0]!;
}

/** Validate and apply a play for `seat`. Mutates `state` only on success. */
export function applyPlay(state: GameState, seat: Seat, play: Play, rng: Rng): PlayResult {
  if (state.over || seatDone(state, seat)) return { ok: false, code: 'ended' };
  if (state.turn !== seat) return { ok: false, code: 'not_turn' };
  if (!play || typeof play.cardId !== 'string' || !Array.isArray(play.moves) || play.moves.length > 2) {
    return { ok: false, code: 'illegal' };
  }
  const card = state.hands[seat]!.find((c) => c.id === play.cardId);
  if (!card) return { ok: false, code: 'no_card' };

  const events: GameEvent[] = [];
  const m0 = play.moves[0];
  if (!m0) return { ok: false, code: 'illegal' };

  let burned = false;
  let discarded = false;
  if (m0.k === 'discard') {
    if (play.moves.length !== 1 || hasLegalPlay(state, seat)) return { ok: false, code: 'illegal' };
    discarded = true;
    events.push({ kind: 'discard', seat, card });
  } else if (m0.k === 'burn') {
    if (card.rank !== '10' || play.moves.length !== 1) return { ok: false, code: 'illegal' };
    burned = true;
    events.push({ kind: 'throw', seat, card });
  } else {
    const scratch = clone(state);
    const res = simulateCard(scratch, seat, card.rank, play.moves);
    if ('fail' in (res as object)) return { ok: false, code: 'illegal' };
    const wasFinished = SEATS.map((s) => seatFinished(state, s));
    state.marbles = scratch.marbles;
    events.push({ kind: 'throw', seat, card }, ...(res as GameEvent[]));
    for (const s of SEATS) if (!wasFinished[s] && seatFinished(state, s)) events.push({ kind: 'finish', seat: s });
  }

  removeCard(state, seat, card.id);
  state.discard.push(card);
  state.last = { seat, card, ...(burned ? { burned: true } : {}), ...(discarded ? { discarded: true } : {}) };

  state.turns = (state.turns ?? 0) + 1;
  state.done ??= [];
  state.doneTurn ??= [];
  for (const team of ['A', 'B'] as Team[]) {
    if (state.done.includes(team) || !teamWon(state, team)) continue;
    state.done.push(team);
    state.doneTurn.push(state.turns);
    if (!state.winner) {
      state.winner = team;
      events.push({ kind: 'win', team });
    } else {
      events.push({ kind: 'teamDone', team });
    }
    // A finished team gets no more cards; its remaining cards go to the discard pile.
    for (const s of SEATS) if (teamOf(s) === team) state.discard.push(...state.hands[s]!.splice(0));
  }
  if (state.done.length >= 2) {
    state.over = true;
    events.push({ kind: 'over', team: state.winner! });
    return { ok: true, events };
  }

  advanceTurn(state, rng, events, burned);
  return { ok: true, events };
}

/** Skip is only for the very first turn of a game, once: no card played yet and no skip used yet. */
export function canSkip(state: GameState, seat: Seat | null): boolean {
  return seat !== null && !state.over && state.turn === seat && !seatDone(state, seat)
    && (state.turns ?? 0) === 0 && !state.skipUsed && state.discard.length === 0;
}

/**
 * Skip (owner request): only the player holding the very first turn of the game, once per game, may pass
 * so the next player starts normally. The hand stays unchanged, no marble moves, `turns` is not counted.
 * Mutates `state` only on success.
 */
export function applySkip(state: GameState, seat: Seat, rng: Rng): PlayResult {
  if (state.over || seatDone(state, seat)) return { ok: false, code: 'ended' };
  if (state.turn !== seat) return { ok: false, code: 'not_turn' };
  if (!canSkip(state, seat)) return { ok: false, code: 'no_skip' };
  state.skipUsed = true;
  const events: GameEvent[] = [{ kind: 'skip', seat }];
  advanceTurn(state, rng, events, false);
  return { ok: true, events };
}

function allHandsEmpty(state: GameState): boolean {
  return state.hands.every((h) => h.length === 0);
}

function advanceTurn(state: GameState, rng: Rng, events: GameEvent[], burn: boolean): void {
  let next = nextActive(state, state.turn);
  if (burn) {
    const hand = state.hands[next]!;
    if (hand.length > 0) {
      const lost = hand.splice(rng.int(hand.length), 1)[0]!;
      state.discard.push(lost);
      events.push({ kind: 'burn', seat: next, card: lost });
      next = nextActive(state, next);
    }
  }
  if (allHandsEmpty(state)) {
    state.dealer = nextSeat(state.dealer);
    events.push(...deal(state, rng));
    return;
  }
  for (let i = 0; i < 4 && state.hands[next]!.length === 0; i++) next = nextActive(state, next);
  state.turn = next;
}

// ---------------------------------------------------------------- views

/** Public game view for one viewer (seat or null for spectators). Never includes other hands. */
export function buildGameView(state: GameState, viewer: Seat | null, paused: boolean): GameView {
  return {
    marbles: state.marbles.map((pos, id) => ({ id, owner: marbleOwner(id), pos: { ...pos } })),
    dealer: state.dealer,
    turn: state.turn,
    dealNo: state.dealNo,
    deck: state.deck.length,
    last: state.last ? { ...state.last, card: { ...state.last.card } } : null,
    controls: viewer === null ? [] : controlledMarbles(state, viewer),
    paused,
    canSkip: canSkip(state, viewer),
  };
}

export function handOf(state: GameState, viewer: Seat | null): Card[] {
  if (viewer === null) return [];
  return state.hands[viewer]!.map((c) => ({ ...c }));
}

export function handCounts(state: GameState): number[] {
  return state.hands.map((h) => h.length);
}
