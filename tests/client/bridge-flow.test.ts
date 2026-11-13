import { describe, expect, it } from 'vitest';
import { SceneBridge, destOf, hopPath, type PendingMove } from '../../src/client/ui/bridge';
import { JokeBag } from '../../src/client/ui/joke';
import type { Card, Net, RoomView } from '../../src/client/net/types';
import type { MarblePos as WirePos, Play } from '../../src/shared/protocol';
import type { Targets } from '../../src/client/scene/types';

function fakeNet() {
  const h: Record<string, Array<(v: unknown) => void>> = {};
  const sent: unknown[] = [];
  const net = { on: (k: string, f: (v: unknown) => void) => { (h[k] ??= []).push(f); return () => {}; }, send: (m: unknown) => sent.push(m) };
  return { net: net as unknown as Net, sent, fire: (k: string, v: unknown) => h[k]?.forEach((f) => f(v)) };
}

function view(pos: Record<number, WirePos>, extra: Partial<RoomView> = {}): RoomView {
  const marbles = Array.from({ length: 16 }, (_, id) => ({ id, owner: Math.floor(id / 4), pos: pos[id] ?? { zone: 'base' } }));
  return {
    phase: 'playing', you: { id: 'me', name: 'x', named: true, seat: 0, spectator: false, host: false }, hostId: null, hostVote: null, hostVoteCooldownUntil: 0,
    requests: [], canStart: false, clock: { startedAt: 1000, elapsedMs: 0, paused: false, expectedMs: 1, expectedFrom: 'estimate' }, finishes: [], result: null, musicLast: null,
    seats: [0, 1, 2, 3].map((i) => ({ index: i, team: i % 2 ? 'B' : 'A', id: null, name: null, ready: true, connected: true, open: false, cards: 4, finished: false, paired: true, teamDone: false })),
    spectators: [], turnSeat: 1, scores: { A: 0, B: 0 }, hand: [], winner: null,
    game: { marbles, dealer: 0, turn: 1, dealNo: 1, deck: 30, last: null, controls: [0, 1, 2, 3], paused: false },
    queue: [], nowPlaying: null, voiceIds: [], voice: [], names: {}, serverNow: 0, ...extra,
  } as unknown as RoomView;
}

/** A bridge with a stand-in scene that records what the board would highlight. */
function rig(plays: Play[], v: RoomView) {
  const { net, fire } = fakeNet();
  const b = new SceneBridge(net);
  const log: { targets: Targets | null } = { targets: null };
  const scene = { setTargets: (t: Targets | null) => { log.targets = t; }, setSelection: () => {}, setHints: () => {}, applyView: () => {} };
  (b as unknown as { scene: unknown }).scene = scene;
  b.setView(v);
  let pending: PendingMove | null = null; let prompt: string | null = null;
  b.onPending((p) => { pending = p; }); b.onPrompt((s) => { prompt = s; });
  fire('hint', { plays });
  const priv = b as unknown as { pickMarble(id: number): void; pickCell(p: unknown): void; dragStart(id: number): boolean; drop(id: number, c: unknown): void };
  return { b, log, priv, get pending() { return pending as PendingMove | null; }, get prompt() { return prompt; } };
}

describe('destinations follow the engine movement', () => {
  const at = (p: Record<number, WirePos>) => (id: number) => p[id];
  it('out goes to the owner start square', () => {
    expect(destOf({ k: 'out', marble: 5 }, 'K', at({}))).toEqual({ zone: 'track', index: 19 });
  });
  it('forward past the home entry goes into the home lane (exact slot)', () => {
    expect(destOf({ k: 'step', marble: 0, n: 3 }, '3', at({ 0: { zone: 'track', square: 74 } }))).toEqual({ zone: 'home', seat: 0, slot: 1 });
    expect(destOf({ k: 'step', marble: 4, n: 5 }, '5', at({ 4: { zone: 'track', square: 75 } }))).toEqual({ zone: 'track', index: 4 });
  });
  it('the 4 goes backward and wraps', () => {
    expect(destOf({ k: 'step', marble: 0, n: 4 }, '4', at({ 0: { zone: 'track', square: 2 } }))).toEqual({ zone: 'track', index: 74 });
  });
  it('the Jack lands on the target marble square', () => {
    expect(destOf({ k: 'swap', marble: 0, target: 6 }, 'J', at({ 0: { zone: 'track', square: 3 }, 6: { zone: 'track', square: 40 } }))).toEqual({ zone: 'track', index: 40 });
  });
  it('hop paths walk square by square into the home lane', () => {
    const p = hopPath({ zone: 'track', square: 74 }, { zone: 'home', slot: 1 }, 0, 3);
    expect(p).toEqual([{ zone: 'track', index: 74 }, { zone: 'track', index: 75 }, { zone: 'home', seat: 0, slot: 0 }, { zone: 'home', seat: 0, slot: 1 }]);
    const back = hopPath({ zone: 'track', square: 1 }, { zone: 'track', square: 73 }, 0, -4);
    expect(back.map((x) => (x as { index: number }).index)).toEqual([1, 0, 75, 74, 73]);
  });
});

describe('own marble moved by its player: card -> marble -> destination -> confirm', () => {
  const card7: Card = { id: '7S', rank: '7', suit: 'S' };
  const pos = { 4: { zone: 'track', square: 20 }, 5: { zone: 'track', square: 30 } } as Record<number, WirePos>;
  const plays: Play[] = [
    { cardId: '7S', moves: [{ k: 'step', marble: 4, n: 7 }] },
    { cardId: '7S', moves: [{ k: 'step', marble: 4, n: 3 }, { k: 'step', marble: 5, n: 4 }] },
    { cardId: '7S', moves: [{ k: 'step', marble: 5, n: 7 }] },
  ];
  const v = view(pos, { you: { id: 'me', name: 'x', named: true, seat: 1, spectator: false, host: false } as RoomView['you'] });

  it('only the marbles with a legal play are interactive, then their destinations', () => {
    const r = rig(plays, v);
    r.b.selectCard(card7);
    expect(r.pending?.many).toBe(true); // several plays: the throw button opens the choice
    expect(r.log.targets).toBeNull(); // nothing on the board is interactive before that
    r.b.beginChoice();
    expect(r.log.targets?.marbles?.sort()).toEqual([4, 5]);
    expect(r.pending).toBeNull(); // nothing to send before the player picks a marble
    r.priv.pickMarble(4);
    expect(r.log.targets?.selected).toBe(4);
    expect(r.log.targets?.cells).toEqual(expect.arrayContaining([{ zone: 'track', index: 27 }, { zone: 'track', index: 23 }]));
    r.priv.pickMarble(9); // not a legal marble: ignored
    expect(r.log.targets?.selected).toBe(4);
  });

  it('a full 7 confirms with exactly that play', () => {
    const r = rig(plays, v);
    r.b.selectCard(card7); r.b.beginChoice(); r.priv.pickMarble(4); r.priv.pickCell({ zone: 'track', index: 27 });
    expect(r.pending?.options.map((o) => o.moves)).toEqual([[{ k: 'step', marble: 4, n: 7 }]]);
    expect(r.pending?.go).toBe(true); // chosen after the throw button: sent at once
    expect(r.log.targets?.chosen).toEqual({ zone: 'track', index: 27 });
  });

  it('a split 7 asks for the second marble, chosen by the mover', () => {
    const r = rig(plays, v);
    r.b.selectCard(card7); r.b.beginChoice(); r.priv.pickMarble(4); r.priv.pickCell({ zone: 'track', index: 23 });
    // only one marble can take the rest: no extra tap needed
    expect(r.log.targets?.marbles).toEqual([5]);
    expect(r.pending?.go).toBe(true);
    expect(r.pending?.options.map((o) => o.moves)).toEqual([[{ k: 'step', marble: 4, n: 3 }, { k: 'step', marble: 5, n: 4 }]]);
  });

  it('drag and drop on a destination works like taps; a drop elsewhere changes nothing', () => {
    const r = rig(plays, v);
    r.b.selectCard(card7);
    expect(r.priv.dragStart(5)).toBe(false); // before the throw button nothing moves
    r.b.beginChoice();
    expect(r.priv.dragStart(5)).toBe(true);
    r.priv.drop(5, null);
    expect(r.pending).toBeNull();
    r.priv.drop(5, { zone: 'track', index: 37 });
    expect(r.pending?.options.map((o) => o.moves)).toEqual([[{ k: 'step', marble: 5, n: 7 }]]);
    expect(r.priv.dragStart(12)).toBe(false); // someone else's marble
  });

  it('the 10 offers the burn as a side option while a marble can still be moved', () => {
    const p10: Play[] = [{ cardId: '10H', moves: [{ k: 'burn' }] }, { cardId: '10H', moves: [{ k: 'step', marble: 4, n: 10 }] }];
    const r = rig(p10, v);
    r.b.selectCard({ id: '10H', rank: '10', suit: 'H' } as Card);
    expect(r.pending?.many).toBe(true);
    r.b.beginChoice();
    expect(r.pending?.alt).toBe(true);
    expect(r.pending?.options.map((o) => o.moves)).toEqual([[{ k: 'burn' }]]);
    expect(r.log.targets?.marbles).toEqual([4]);
  });
});

describe('automatic moves: one legal play needs no marble picking', () => {
  const pos = { 4: { zone: 'track', square: 20 }, 5: { zone: 'track', square: 30 } } as Record<number, WirePos>;
  const v = view(pos, { you: { id: 'me', name: 'x', named: true, seat: 1, spectator: false, host: false } as RoomView['you'] });
  const five: Card = { id: '5S', rank: '5', suit: 'S' };

  it('a single play is ready on select (throw button sends it), previewed but not tappable', () => {
    const r = rig([{ cardId: '5S', moves: [{ k: 'step', marble: 4, n: 5 }] }], v);
    r.b.selectCard(five);
    expect(r.pending?.options.map((o) => o.moves)).toEqual([[{ k: 'step', marble: 4, n: 5 }]]);
    expect(r.pending?.many).toBeFalsy();
    expect(r.pending?.go).toBeFalsy(); // never sent without the throw tap
    expect(r.log.targets).toEqual({ selected: 4, chosen: { zone: 'track', index: 25 } });
    expect(r.log.targets?.marbles).toBeUndefined();
  });

  it('several marbles: tapping one with a single destination plays it at once', () => {
    const r = rig([{ cardId: '5S', moves: [{ k: 'step', marble: 4, n: 5 }] }, { cardId: '5S', moves: [{ k: 'step', marble: 5, n: 5 }] }], v);
    r.b.selectCard(five);
    expect(r.pending?.many).toBe(true);
    r.b.beginChoice();
    expect(r.log.targets?.marbles?.sort()).toEqual([4, 5]);
    r.priv.pickMarble(5);
    expect(r.pending?.go).toBe(true);
    expect(r.pending?.options.map((o) => o.moves)).toEqual([[{ k: 'step', marble: 5, n: 5 }]]);
  });

  it('one marble with two destinations (Ace 1 or 11) goes straight to the destination choice', () => {
    const ace: Card = { id: 'AS', rank: 'A', suit: 'S' };
    const r = rig([{ cardId: 'AS', moves: [{ k: 'step', marble: 4, n: 1 }] }, { cardId: 'AS', moves: [{ k: 'step', marble: 4, n: 11 }] }], v);
    r.b.selectCard(ace);
    r.b.beginChoice();
    expect(r.log.targets?.selected).toBe(4);
    expect(r.log.targets?.cells).toEqual([{ zone: 'track', index: 21 }, { zone: 'track', index: 31 }]);
    expect(r.pending).toBeNull();
    r.priv.pickCell({ zone: 'track', index: 31 });
    expect(r.pending?.go).toBe(true);
    expect(r.pending?.options[0]?.moves).toEqual([{ k: 'step', marble: 4, n: 11 }]);
  });

  it('no legal play anywhere: the engine discard is the single play of the card', () => {
    const r = rig([{ cardId: '5S', moves: [{ k: 'discard' }] }, { cardId: 'KH', moves: [{ k: 'discard' }] }], v);
    r.b.selectCard(five);
    expect(r.pending?.options.map((o) => o.moves)).toEqual([[{ k: 'discard' }]]);
    expect(r.pending?.go).toBeFalsy();
  });
});

describe('centre pile keeps one thrown card per player', () => {
  it('remembers every seat and resets for a new game', () => {
    const { net } = fakeNet();
    const b = new SceneBridge(net);
    const c = (id: string) => ({ id, rank: id.slice(0, -1), suit: id.slice(-1) });
    const g = (last: unknown, startedAt = 1000) => {
      const v = view({});
      v.game!.last = last as never; v.clock.startedAt = startedAt; v.turnSeat = 0;
      return v;
    };
    b.setView(g({ seat: 1, card: c('5H') }));
    b.setView(g({ seat: 2, card: c('9S') }));
    b.onEvent('throw', [{ kind: 'throw', seat: 3, card: c('KD') as never }]);
    expect(b.pileCards.map((x) => x?.id ?? null)).toEqual([null, '5H', '9S', 'KD']);
    b.setView(g(null, 2000));
    expect(b.pileCards).toEqual([null, null, null, null]);
  });
});

describe('joke bag', () => {
  it('draws every joke once before repeating, never twice in a row', () => {
    let seed = 7;
    const bag = new JokeBag(() => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }, 60);
    const first = Array.from({ length: 60 }, () => bag.next());
    expect(new Set(first).size).toBe(60);
    const next = bag.next();
    expect(next).not.toBe(first[59]);
  });
});
