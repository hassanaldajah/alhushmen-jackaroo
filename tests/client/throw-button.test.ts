/**
 * Missing throw ("ارمِ") button on phones. Root cause: on the first turns every legal move is "out" with a base
 * marble, and the own base sits right under the enlarged selected card. The scene checked the own cards before the
 * board targets, so a tap on a base marble was reported as a tap on the selected card; the table then re-selected
 * the card, which reset the bridge to "pick a marble" and the confirm step never came up.
 */
import { describe, expect, it } from 'vitest';
import { SceneBridge, type PendingMove } from '../../src/client/ui/bridge';
import { choosePick } from '../../src/client/scene/layout';
import type { Card, Net, RoomView } from '../../src/client/net/types';
import type { Play } from '../../src/shared/protocol';

function rig(plays: Play[]) {
  const h: Record<string, Array<(v: unknown) => void>> = {};
  const net = { on: (k: string, f: (v: unknown) => void) => { (h[k] ??= []).push(f); return () => {}; }, send: () => {} } as unknown as Net;
  const b = new SceneBridge(net);
  const scene = { setTargets: () => {}, setSelection: () => {}, setHints: () => {}, applyView: () => {}, setHandStrip: () => {} };
  (b as unknown as { scene: unknown }).scene = scene;
  const marbles = Array.from({ length: 16 }, (_, id) => ({ id, owner: Math.floor(id / 4), pos: { zone: 'base' } }));
  b.setView({
    phase: 'playing', you: { id: 'me', seat: 0 }, seats: [0, 1, 2, 3].map((i) => ({ index: i, cards: 4 })), turnSeat: 0, hand: [],
    clock: { startedAt: 1 }, game: { marbles, dealer: 3, turn: 0, dealNo: 1, deck: 30, last: null, controls: [0, 1, 2, 3], paused: false, canSkip: true },
  } as unknown as RoomView);
  let pending: PendingMove | null = null;
  b.onPending((p) => { pending = p; });
  h.hint?.forEach((f) => f({ plays }));
  const priv = b as unknown as { pickMarble(id: number): void; pickCell(p: unknown): void };
  return { b, priv, get pending() { return pending as PendingMove | null; } };
}

describe('throw button: first-turn "out" with a base marble', () => {
  const ace: Card = { id: 'AS', rank: 'A', suit: 'S' };
  const plays: Play[] = [0, 1, 2, 3].map((m) => ({ cardId: 'AS', moves: [{ k: 'out', marble: m }] }));

  it('card -> base marble -> start square reaches the throw step', () => {
    const r = rig(plays);
    r.b.selectCard(ace);
    expect(r.pending?.many).toBe(true);
    r.b.beginChoice(); // the throw button
    r.priv.pickMarble(1); // one landing square (own start): plays at once
    expect(r.pending?.go).toBe(true);
    expect(r.pending?.options.map((o) => o.moves)).toEqual([[{ k: 'out', marble: 1 }]]);
  });

  it('re-selecting the same card resets the flow (why a scene tap on the selected card must be ignored)', () => {
    const r = rig(plays);
    r.b.selectCard(ace);
    r.b.beginChoice();
    r.priv.pickMarble(1);
    expect(r.pending?.go).toBe(true);
    r.b.selectCard(ace); // what the old table did for every tap that hit the enlarged card
    expect(r.pending?.go).toBeFalsy(); // back to the start of the flow
  });

  it('a tap near a target marble goes to the board, not to the selected card lying over it', () => {
    expect(choosePick({ marble: 1 }, { id: 'AS', near: true }, 'AS')).toBe('target');
    expect(choosePick({ marble: 1 }, { id: 'AS', near: false }, 'AS')).toBe('target');
    expect(choosePick({ cell: { zone: 'track', index: 0 } }, { id: 'KH', near: false }, 'AS')).toBe('target');
  });

  it('another card still wins on a close hit; without targets cards pick normally', () => {
    expect(choosePick({ marble: 1 }, { id: 'KH', near: true }, 'AS')).toBe('card');
    expect(choosePick(null, { id: 'KH', near: false }, null)).toBe('card');
    expect(choosePick(null, null, 'AS')).toBeNull();
  });
});
