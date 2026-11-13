import { describe, expect, it } from 'vitest';
import { SceneBridge, type PendingMove } from '../../src/client/ui/bridge';
import type { Card, Net } from '../../src/client/net/types';

function fakeNet() {
  const h: Record<string, Array<(v: unknown) => void>> = {};
  const net = { on: (k: string, f: (v: unknown) => void) => { (h[k] ??= []).push(f); return () => {}; }, send: () => {} };
  return { net: net as unknown as Net, fire: (k: string, v: unknown) => h[k]?.forEach((f) => f(v)) };
}

describe('bridge: burn-only 10 (C1)', () => {
  it('offers the burn directly when the 10 has no marble move', () => {
    const { net, fire } = fakeNet();
    const b = new SceneBridge(net);
    let pending: PendingMove | null = null;
    b.onPending((p) => { pending = p; });
    fire('hint', { plays: [{ cardId: '10H', moves: [{ k: 'burn' }] }] });
    b.selectCard({ id: '10H', rank: '10', suit: 'H' } as Card);
    expect(pending).not.toBeNull();
    expect(pending!.options.map((o) => o.moves)).toEqual([[{ k: 'burn' }]]);
  });
});
