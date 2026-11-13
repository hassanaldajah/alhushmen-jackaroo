import { describe, expect, it } from 'vitest';
import {
  applyPlay, buildGameView, controlledMarbles, fullDeck, handOf, legalPlays, newGame, type GameState,
} from '../../src/engine/game';
import { seededRng, shuffle, cryptoRng } from '../../src/engine/rng';
import { TRACK_LEN, startSquare, type Seat } from '../../src/shared/board';
import type { Card, MarblePos, Move, Rank } from '../../src/shared/protocol';

const rng = seededRng(42);

/** Empty board, seat 0 to move, custom hands. */
function setup(hands: Partial<Record<Seat, Rank[]>> = {}, turn: Seat = 0): GameState {
  const { state } = newGame(seededRng(1), 3);
  state.marbles = Array.from({ length: 16 }, () => ({ zone: 'base' }) as MarblePos);
  const deck = fullDeck();
  const take = (r: Rank): Card => {
    const i = deck.findIndex((c) => c.rank === r);
    return deck.splice(i, 1)[0]!;
  };
  const filler = (): Card => { for (const r of ['2', '3', '5', '6', '8', '9', 'Q'] as Rank[]) if (deck.some((c) => c.rank === r)) return take(r); throw new Error('deck'); };
  const custom = [0, 1, 2, 3].map((s) => (hands[s as Seat] ?? []).map(take));
  state.hands = custom.map((h) => { while (h.length < 4) h.push(filler()); return h; });
  state.deck = deck;
  state.turn = turn;
  return state;
}
const T = (square: number): MarblePos => ({ zone: 'track', square: ((square % TRACK_LEN) + TRACK_LEN) % TRACK_LEN });
const H = (slot: number): MarblePos => ({ zone: 'home', slot });
const B: MarblePos = { zone: 'base' };
const card = (s: GameState, seat: Seat, rank: Rank): string => s.hands[seat]!.find((c) => c.rank === rank)!.id;
const play = (s: GameState, seat: Seat, rank: Rank, moves: Move[]) => applyPlay(s, seat, { cardId: card(s, seat, rank), moves }, rng);

describe('deal and deck', () => {
  it('full deck has 52 unique cards', () => {
    const d = fullDeck();
    expect(d).toHaveLength(52);
    expect(new Set(d.map((c) => c.id)).size).toBe(52);
  });
  it('new game deals 4 cards each, starts left of dealer, all marbles in base', () => {
    const { state, events } = newGame(seededRng(7), 2);
    expect(state.hands.map((h) => h.length)).toEqual([4, 4, 4, 4]);
    expect(state.turn).toBe(3);
    expect(state.deck).toHaveLength(36);
    expect(state.marbles.every((m) => m.zone === 'base')).toBe(true);
    expect(events.map((e) => e.kind)).toEqual(['shuffle', 'deal']);
  });
  it('re-deals when all hands are empty, rotating the dealer, and reshuffles when short', () => {
    const { state } = newGame(seededRng(9), 0);
    const r = seededRng(10);
    let deals = 1;
    let shuffles = 0;
    for (let i = 0; i < 16 * 4 && !state.winner; i++) {
      const p = legalPlays(state, state.turn)[0]!;
      const res = applyPlay(state, state.turn, p, r);
      expect(res.ok).toBe(true);
      if (res.ok) {
        deals += res.events.filter((e) => e.kind === 'deal').length;
        shuffles += res.events.filter((e) => e.kind === 'shuffle').length;
      }
    }
    expect(deals).toBeGreaterThanOrEqual(4);
    expect(shuffles).toBeGreaterThanOrEqual(1);
    expect(state.dealer).toBe((deals - 1) % 4);
  });
  it('Fisher-Yates with crypto RNG is roughly uniform', () => {
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 4000; i++) counts[shuffle([0, 1, 2, 3], cryptoRng)[0]!]!++;
    for (const c of counts) expect(c).toBeGreaterThan(850);
  });
});

describe('turn and ownership checks', () => {
  it('rejects play out of turn and cards not in hand', () => {
    const s = setup({ 0: ['K', '2', '2', '2'], 1: ['K', '3', '3', '3'] });
    expect(applyPlay(s, 1, { cardId: card(s, 1, 'K'), moves: [{ k: 'out', marble: 4 }] }, rng)).toEqual({ ok: false, code: 'not_turn' });
    expect(applyPlay(s, 0, { cardId: 'KH-fake', moves: [{ k: 'out', marble: 0 }] }, rng)).toEqual({ ok: false, code: 'no_card' });
    expect(applyPlay(s, 0, { cardId: card(s, 1, 'K'), moves: [{ k: 'out', marble: 0 }] }, rng).ok).toBe(false);
  });
  it('cannot move opponent or partner marbles while own are not finished', () => {
    const s = setup({ 0: ['K', '2', '2', '2'] });
    expect(play(s, 0, 'K', [{ k: 'out', marble: 4 }]).ok).toBe(false);
    expect(play(s, 0, 'K', [{ k: 'out', marble: 8 }]).ok).toBe(false);
  });
  it('rejects malformed moves', () => {
    const s = setup({ 0: ['K', '2', '2', '2'] });
    s.marbles[0] = T(5);
    expect(applyPlay(s, 0, { cardId: card(s, 0, '2'), moves: [] }, rng).ok).toBe(false);
    expect(applyPlay(s, 0, { cardId: card(s, 0, '2'), moves: [{ k: 'step', marble: 99, n: 2 }] }, rng).ok).toBe(false);
    expect(applyPlay(s, 0, { cardId: card(s, 0, '2'), moves: [{ k: 'step', marble: 0, n: 3 }] }, rng).ok).toBe(false);
    expect(applyPlay(s, 0, { cardId: card(s, 0, '2'), moves: [{ k: 'step', marble: 0, n: 2 }, { k: 'step', marble: 1, n: 0 }] }, rng).ok).toBe(false);
  });
  it('turn passes to the next seat and the card is discarded', () => {
    const s = setup({ 0: ['K', '2', '2', '2'] });
    expect(play(s, 0, 'K', [{ k: 'out', marble: 0 }]).ok).toBe(true);
    expect(s.turn).toBe(1);
    expect(s.hands[0]).toHaveLength(3);
    expect(s.last?.card.rank).toBe('K');
  });
});

describe('getting out (A, K)', () => {
  it('K moves a base marble to the start square', () => {
    const s = setup({ 0: ['K', '2', '2', '2'] });
    expect(play(s, 0, 'K', [{ k: 'out', marble: 1 }]).ok).toBe(true);
    expect(s.marbles[1]).toEqual(T(startSquare(0)));
  });
  it('A can get out', () => {
    const s = setup({ 1: ['A', '2', '2', '2'] }, 1);
    expect(play(s, 1, 'A', [{ k: 'out', marble: 4 }]).ok).toBe(true);
    expect(s.marbles[4]).toEqual(T(startSquare(1)));
  });
  it('K cannot move forward', () => {
    const s = setup({ 0: ['K', '2', '2', '2'] });
    s.marbles[0] = T(3);
    expect(play(s, 0, 'K', [{ k: 'step', marble: 0, n: 13 }]).ok).toBe(false);
  });
  it('cannot get out onto own marble on start', () => {
    const s = setup({ 0: ['K', '2', '2', '2'] });
    s.marbles[0] = T(0);
    expect(play(s, 0, 'K', [{ k: 'out', marble: 1 }]).ok).toBe(false);
  });
  it('getting out captures an opponent sitting on my start', () => {
    const s = setup({ 0: ['K', '2', '2', '2'] });
    s.marbles[5] = T(0);
    const r = play(s, 0, 'K', [{ k: 'out', marble: 0 }]);
    expect(r.ok).toBe(true);
    expect(s.marbles[5]).toEqual(B);
    if (r.ok) expect(r.events.some((e) => e.kind === 'capture' && e.marble === 5)).toBe(true);
  });
  it('cannot get out a marble that is not in base', () => {
    const s = setup({ 0: ['K', '2', '2', '2'] });
    s.marbles[0] = T(10);
    expect(play(s, 0, 'K', [{ k: 'out', marble: 0 }]).ok).toBe(false);
  });
});

describe('number cards', () => {
  it.each([['2', 2], ['3', 3], ['5', 5], ['6', 6], ['8', 8], ['9', 9], ['Q', 12]] as [Rank, number][])('%s moves %i forward', (r, n) => {
    const s = setup({ 0: [r, '2', '2', '2'] });
    s.marbles[0] = T(4);
    expect(play(s, 0, r, [{ k: 'step', marble: 0, n }]).ok).toBe(true);
    expect(s.marbles[0]).toEqual(T(4 + n));
  });
  it('A moves 1 or 11', () => {
    const s = setup({ 0: ['A', 'A', '2', '2'] });
    s.marbles[0] = T(4);
    expect(play(s, 0, 'A', [{ k: 'step', marble: 0, n: 1 }]).ok).toBe(true);
    expect(s.marbles[0]).toEqual(T(5));
    s.turn = 0;
    expect(play(s, 0, 'A', [{ k: 'step', marble: 0, n: 11 }]).ok).toBe(true);
    expect(s.marbles[0]).toEqual(T(16));
  });
  it('A cannot move other amounts', () => {
    const s = setup({ 0: ['A', '2', '2', '2'] });
    s.marbles[0] = T(4);
    expect(play(s, 0, 'A', [{ k: 'step', marble: 0, n: 5 }]).ok).toBe(false);
  });
  it('base marbles cannot move forward', () => {
    const s = setup({ 0: ['5', '2', '2', '2'] });
    expect(play(s, 0, '5', [{ k: 'step', marble: 0, n: 5 }]).ok).toBe(false);
  });
  it('wraps around the track for other seats', () => {
    const s = setup({ 3: ['9', '2', '2', '2'] }, 3);
    s.marbles[12] = T(70);
    expect(play(s, 3, '9', [{ k: 'step', marble: 12, n: 9 }]).ok).toBe(true);
    expect(s.marbles[12]).toEqual(T(3));
  });
});

describe('4 backward', () => {
  it('moves 4 backward on the track', () => {
    const s = setup({ 0: ['4', '2', '2', '2'] });
    s.marbles[0] = T(10);
    expect(play(s, 0, '4', [{ k: 'step', marble: 0, n: 4 }]).ok).toBe(true);
    expect(s.marbles[0]).toEqual(T(6));
  });
  it('backward from start goes behind start, then can enter home quickly', () => {
    const s = setup({ 0: ['4', '5', '2', '2'] });
    s.marbles[0] = T(0);
    expect(play(s, 0, '4', [{ k: 'step', marble: 0, n: 4 }]).ok).toBe(true);
    expect(s.marbles[0]).toEqual(T(TRACK_LEN - 4));
    s.turn = 0;
    expect(play(s, 0, '5', [{ k: 'step', marble: 0, n: 5 }]).ok).toBe(true);
    expect(s.marbles[0]).toEqual(H(1));
  });
  it('cannot move base or home marbles backward', () => {
    const s = setup({ 0: ['4', '2', '2', '2'] });
    s.marbles[1] = H(2);
    expect(play(s, 0, '4', [{ k: 'step', marble: 0, n: 4 }]).ok).toBe(false);
    expect(play(s, 0, '4', [{ k: 'step', marble: 1, n: 4 }]).ok).toBe(false);
  });
  it('backward landing captures', () => {
    const s = setup({ 0: ['4', '2', '2', '2'] });
    s.marbles[0] = T(10);
    s.marbles[6] = T(6);
    expect(play(s, 0, '4', [{ k: 'step', marble: 0, n: 4 }]).ok).toBe(true);
    expect(s.marbles[6]).toEqual(B);
  });
});

describe('capturing and passing', () => {
  it('landing on an opponent sends it to base', () => {
    const s = setup({ 0: ['5', '2', '2', '2'] });
    s.marbles[0] = T(3);
    s.marbles[5] = T(8);
    const r = play(s, 0, '5', [{ k: 'step', marble: 0, n: 5 }]);
    expect(r.ok).toBe(true);
    expect(s.marbles[5]).toEqual(B);
    expect(s.marbles[0]).toEqual(T(8));
  });
  it('landing on a partner marble also sends it to base (Q5)', () => {
    const s = setup({ 0: ['5', '2', '2', '2'] });
    s.marbles[0] = T(3);
    s.marbles[9] = T(8);
    expect(play(s, 0, '5', [{ k: 'step', marble: 0, n: 5 }]).ok).toBe(true);
    expect(s.marbles[9]).toEqual(B);
  });
  it('passing over marbles does not capture (Q6)', () => {
    const s = setup({ 0: ['8', '2', '2', '2'] });
    s.marbles[0] = T(3);
    s.marbles[5] = T(6);
    s.marbles[4] = T(startSquare(1)); // protected, can be passed
    s.marbles[0] = T(startSquare(1) - 3);
    expect(play(s, 0, '8', [{ k: 'step', marble: 0, n: 8 }]).ok).toBe(true);
    expect(s.marbles[4]).toEqual(T(startSquare(1)));
  });
  it('cannot land on a protected marble on its own start', () => {
    const s = setup({ 0: ['5', '2', '2', '2'] });
    s.marbles[4] = T(startSquare(1));
    s.marbles[0] = T(startSquare(1) - 5);
    expect(play(s, 0, '5', [{ k: 'step', marble: 0, n: 5 }]).ok).toBe(false);
  });
});

describe('home entry (exact, Q4)', () => {
  it('enters home with exact count', () => {
    const s = setup({ 0: ['3', '2', '2', '2'] });
    s.marbles[0] = T(TRACK_LEN - 1);
    const r = play(s, 0, '3', [{ k: 'step', marble: 0, n: 3 }]);
    expect(r.ok).toBe(true);
    expect(s.marbles[0]).toEqual(H(2));
    if (r.ok) expect(r.events.some((e) => e.kind === 'home')).toBe(true);
  });
  it('overshooting home is illegal and marbles never lap past home', () => {
    const s = setup({ 0: ['6', '2', '2', '2'] });
    s.marbles[0] = T(TRACK_LEN - 1);
    expect(play(s, 0, '6', [{ k: 'step', marble: 0, n: 6 }]).ok).toBe(false);
  });
  it('cannot pass or land on own home marbles', () => {
    const s = setup({ 0: ['3', '2', '2', '2'] });
    s.marbles[1] = H(1);
    s.marbles[0] = T(TRACK_LEN - 1);
    expect(play(s, 0, '3', [{ k: 'step', marble: 0, n: 3 }]).ok).toBe(false);
    expect(play(s, 0, '2', [{ k: 'step', marble: 0, n: 2 }]).ok).toBe(false);
  });
  it('marbles inside home can move deeper exactly', () => {
    const s = setup({ 0: ['2', '3', '3', '3'] });
    s.marbles[0] = H(0);
    expect(play(s, 0, '2', [{ k: 'step', marble: 0, n: 2 }]).ok).toBe(true);
    expect(s.marbles[0]).toEqual(H(2));
    s.turn = 0;
    expect(play(s, 0, '3', [{ k: 'step', marble: 0, n: 3 }]).ok).toBe(false);
  });
  it('home entry uses the owner home lane for seat 2', () => {
    const s = setup({ 2: ['2', '3', '3', '3'] }, 2);
    s.marbles[8] = T(startSquare(2) - 1);
    expect(play(s, 2, '2', [{ k: 'step', marble: 8, n: 2 }]).ok).toBe(true);
    expect(s.marbles[8]).toEqual(H(1));
  });
});

describe('7 split (Q9)', () => {
  it('7 with one marble', () => {
    const s = setup({ 0: ['7', '2', '2', '2'] });
    s.marbles[0] = T(2);
    expect(play(s, 0, '7', [{ k: 'step', marble: 0, n: 7 }]).ok).toBe(true);
    expect(s.marbles[0]).toEqual(T(9));
  });
  it('7 split over two marbles must total 7', () => {
    const s = setup({ 0: ['7', '2', '2', '2'] });
    s.marbles[0] = T(2);
    s.marbles[1] = T(20);
    expect(play(s, 0, '7', [{ k: 'step', marble: 0, n: 3 }, { k: 'step', marble: 1, n: 3 }]).ok).toBe(false);
    expect(play(s, 0, '7', [{ k: 'step', marble: 0, n: 3 }, { k: 'step', marble: 0, n: 4 }]).ok).toBe(false);
    expect(play(s, 0, '7', [{ k: 'step', marble: 0, n: 3 }, { k: 'step', marble: 1, n: 4 }]).ok).toBe(true);
    expect(s.marbles[0]).toEqual(T(5));
    expect(s.marbles[1]).toEqual(T(24));
  });
  it('captures only at final stops, not while passing', () => {
    const s = setup({ 0: ['7', '2', '2', '2'] });
    s.marbles[0] = T(2);
    s.marbles[1] = T(20);
    s.marbles[5] = T(4); // passed by marble 0 (lands on 7)
    s.marbles[6] = T(22); // landed on by marble 1
    expect(play(s, 0, '7', [{ k: 'step', marble: 0, n: 5 }, { k: 'step', marble: 1, n: 2 }]).ok).toBe(true);
    expect(s.marbles[5]).toEqual(T(4));
    expect(s.marbles[6]).toEqual(B);
  });
  it('a split is illegal if any part is illegal, and state is untouched', () => {
    const s = setup({ 0: ['7', '2', '2', '2'] });
    s.marbles[0] = T(2);
    s.marbles[1] = T(TRACK_LEN - 1);
    const before = JSON.stringify(s);
    expect(play(s, 0, '7', [{ k: 'step', marble: 0, n: 2 }, { k: 'step', marble: 1, n: 5 }]).ok).toBe(false);
    expect(JSON.stringify(s)).toBe(before);
  });
  it('7 can be split into home', () => {
    const s = setup({ 0: ['7', '2', '2', '2'] });
    s.marbles[0] = T(TRACK_LEN - 2);
    s.marbles[1] = T(10);
    expect(play(s, 0, '7', [{ k: 'step', marble: 0, n: 3 }, { k: 'step', marble: 1, n: 4 }]).ok).toBe(true);
    expect(s.marbles[0]).toEqual(H(1));
  });
});

describe('10: move or burn (Q8)', () => {
  it('moves 10', () => {
    const s = setup({ 0: ['10', '2', '2', '2'] });
    s.marbles[0] = T(1);
    expect(play(s, 0, '10', [{ k: 'step', marble: 0, n: 10 }]).ok).toBe(true);
    expect(s.marbles[0]).toEqual(T(11));
  });
  it('burn skips the next player, who loses one card', () => {
    const s = setup({ 0: ['10', '2', '2', '2'] });
    const r = play(s, 0, '10', [{ k: 'burn' }]);
    expect(r.ok).toBe(true);
    expect(s.turn).toBe(2);
    expect(s.hands[1]).toHaveLength(3);
    expect(s.last?.burned).toBe(true);
    if (r.ok) expect(r.events.some((e) => e.kind === 'burn' && e.seat === 1)).toBe(true);
  });
  it('burn is always legal, even with no marble out', () => {
    const s = setup({ 0: ['10', '2', '2', '2'] });
    expect(legalPlays(s, 0).some((p) => p.moves[0]!.k === 'burn')).toBe(true);
  });
  it('only a 10 can burn', () => {
    const s = setup({ 0: ['9', '2', '2', '2'] });
    expect(play(s, 0, '9', [{ k: 'burn' }]).ok).toBe(false);
  });
});

describe('J swap (Q11)', () => {
  it('swaps own track marble with an opponent track marble', () => {
    const s = setup({ 0: ['J', '2', '2', '2'] });
    s.marbles[0] = T(5);
    s.marbles[5] = T(40);
    expect(play(s, 0, 'J', [{ k: 'swap', marble: 0, target: 5 }]).ok).toBe(true);
    expect(s.marbles[0]).toEqual(T(40));
    expect(s.marbles[5]).toEqual(T(5));
  });
  it('cannot swap with partner, base, home or protected marbles', () => {
    const s = setup({ 0: ['J', '2', '2', '2'] });
    s.marbles[0] = T(5);
    s.marbles[8] = T(50); // partner
    s.marbles[4] = T(startSquare(1)); // protected opponent
    s.marbles[6] = H(0); // opponent home
    expect(play(s, 0, 'J', [{ k: 'swap', marble: 0, target: 8 }]).ok).toBe(false);
    expect(play(s, 0, 'J', [{ k: 'swap', marble: 0, target: 4 }]).ok).toBe(false);
    expect(play(s, 0, 'J', [{ k: 'swap', marble: 0, target: 6 }]).ok).toBe(false);
    expect(play(s, 0, 'J', [{ k: 'swap', marble: 0, target: 7 }]).ok).toBe(false);
    s.marbles[0] = T(0); // own protected
    s.marbles[5] = T(30);
    expect(play(s, 0, 'J', [{ k: 'swap', marble: 0, target: 5 }]).ok).toBe(false);
  });
});

describe('no legal move: discard (Q2)', () => {
  it('discard is allowed only when nothing is playable', () => {
    const s = setup({ 0: ['2', '3', '5', '6'] });
    expect(legalPlays(s, 0).every((p) => p.moves[0]!.k === 'discard')).toBe(true);
    expect(play(s, 0, '5', [{ k: 'discard' }]).ok).toBe(true);
    expect(s.last?.discarded).toBe(true);
    expect(s.turn).toBe(1);
  });
  it('discard is rejected when a legal play exists', () => {
    const s = setup({ 0: ['K', '3', '5', '6'] });
    expect(play(s, 0, '5', [{ k: 'discard' }]).ok).toBe(false);
  });
});

describe('partner marbles after finishing, and winning', () => {
  it('a finished player controls the partner marbles', () => {
    const s = setup({ 0: ['K', '2', '2', '2'] });
    s.marbles[0] = H(0); s.marbles[1] = H(1); s.marbles[2] = H(2); s.marbles[3] = H(3);
    expect(controlledMarbles(s, 0)).toEqual([8, 9, 10, 11]);
    expect(play(s, 0, 'K', [{ k: 'out', marble: 8 }]).ok).toBe(true);
    expect(s.marbles[8]).toEqual(T(startSquare(2)));
  });
  it('finishing the last own marble with the first half of a 7 lets the rest move a partner marble', () => {
    const s = setup({ 0: ['7', '2', '2', '2'] });
    s.marbles[0] = T(TRACK_LEN - 1); s.marbles[1] = H(1); s.marbles[2] = H(2); s.marbles[3] = H(3);
    s.marbles[8] = T(10);
    const r = play(s, 0, '7', [{ k: 'step', marble: 0, n: 1 }, { k: 'step', marble: 8, n: 6 }]);
    expect(r.ok).toBe(true);
    expect(s.marbles[8]).toEqual(T(16));
    if (r.ok) expect(r.events.some((e) => e.kind === 'finish' && e.seat === 0)).toBe(true);
  });
  it('team wins when all 8 marbles are home', () => {
    const s = setup({ 2: ['A', '2', '3', '3'] }, 2);
    for (let i = 0; i < 4; i++) s.marbles[i] = H(i);
    for (let i = 9; i < 12; i++) s.marbles[i] = H(i - 8);
    s.marbles[8] = T(startSquare(2) - 1);
    expect(play(s, 2, '2', [{ k: 'step', marble: 8, n: 2 }]).ok).toBe(false); // slot 1 taken
    const r3 = applyPlay(s, 2, { cardId: card(s, 2, 'A'), moves: [{ k: 'step', marble: 8, n: 1 }] }, rng);
    expect(r3.ok).toBe(true);
    expect(s.winner).toBe('A');
    if (r3.ok) expect(r3.events.at(-1)).toEqual({ kind: 'win', team: 'A' });
    // Round 2: play continues for the other team; team A seats are skipped and hold no cards.
    expect(s.over).toBe(false);
    expect(s.hands[0]).toEqual([]);
    expect(s.hands[2]).toEqual([]);
    expect([1, 3]).toContain(s.turn);
    expect(applyPlay(s, 0, { cardId: 'AS', moves: [{ k: 'discard' }] }, rng)).toEqual({ ok: false, code: 'ended' });
  });
});

describe('full games with random legal plays', () => {
  it('always terminate with a winner and keep invariants', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const r = seededRng(seed * 7919);
      const { state } = newGame(r, (seed % 4) as Seat);
      let turns = 0;
      while (!state.winner && turns < 20000) {
        const plays = legalPlays(state, state.turn);
        expect(plays.length).toBeGreaterThan(0);
        // prefer progress so games finish: pick a random play
        const p = plays[r.int(plays.length)]!;
        const res = applyPlay(state, state.turn, p, r);
        expect(res.ok).toBe(true);
        // invariants: no two marbles on one square, no two in one home slot of the same seat
        const sq = state.marbles.flatMap((m) => (m.zone === 'track' ? [m.square] : []));
        expect(new Set(sq).size).toBe(sq.length);
        for (let seat = 0; seat < 4; seat++) {
          const slots = state.marbles.slice(seat * 4, seat * 4 + 4).flatMap((m) => (m.zone === 'home' ? [m.slot] : []));
          expect(new Set(slots).size).toBe(slots.length);
        }
        turns++;
      }
      expect(state.winner).not.toBeNull();
    }
  }, 120_000);
});

describe('hidden hands (leak test)', () => {
  it('views never contain cards of other seats', () => {
    const { state } = newGame(seededRng(5), 0);
    for (const viewer of [null, 0, 1, 2, 3] as (Seat | null)[]) {
      const json = JSON.stringify({ game: buildGameView(state, viewer, false), hand: handOf(state, viewer) });
      for (let seat = 0; seat < 4; seat++) {
        if (seat === viewer) continue;
        for (const c of state.hands[seat]!) expect(json).not.toContain(`"id":"${c.id}"`);
      }
      for (const c of state.deck) expect(json).not.toContain(`"id":"${c.id}"`);
      if (viewer !== null) {
        for (const c of state.hands[viewer]!) expect(json).toContain(`"id":"${c.id}"`);
      }
    }
  });
});
