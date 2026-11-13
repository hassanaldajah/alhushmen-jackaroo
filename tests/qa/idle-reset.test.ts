import { describe, expect, it } from 'vitest';
import { randomHex } from '../../src/worker/auth';
import { IDLE_RESET_MS, RoomCore, emptyRoom, memoryStore } from '../../src/worker/core';
import { seededRng } from '../../src/engine/rng';
import type { ClientMsg } from '../../src/shared/protocol';

function table() {
  let n = 0;
  const core = new RoomCore(emptyRoom(), { rng: seededRng(5), newId: () => (++n).toString(16).padStart(10, '0'), videoMeta: () => null, store: memoryStore() });
  const send = (k: string, m: ClientMsg, now = 1000) => core.message(k, m, now);
  for (let i = 0; i < 4; i++) {
    core.connect('k' + i, randomHex(16), 1000);
    send('k' + i, { t: 'name', name: 'P' + i });
    send('k' + i, { t: 'sit', seat: i });
  }
  send('k0', { t: 'hostClaim' });
  const pair = (a: string, b: string) => {
    const bId = core.viewFor(core.conns.get(b)!, 1000).you.id;
    const aId = core.viewFor(core.conns.get(a)!, 1000).you.id;
    send(a, { t: 'partnerReq', to: bId });
    send(b, { t: 'partnerAnswer', from: aId, accept: true });
  };
  pair('k0', 'k2');
  pair('k1', 'k3');
  return { core, send };
}

describe('old unfinished game is dropped (new game / empty room)', () => {
  it('host "toLobby" mid-game discards the game and saves no result', () => {
    const { core, send } = table();
    send('k0', { t: 'start' }, 2000);
    expect(core.s.phase).toBe('playing');
    send('k0', { t: 'toLobby' }, 3000);
    expect(core.s.phase).toBe('lobby');
    expect(core.s.game).toBeNull();
  });

  it('a non-host cannot discard the game', () => {
    const { core, send } = table();
    send('k0', { t: 'start' }, 2000);
    send('k1', { t: 'toLobby' }, 3000);
    expect(core.s.phase).toBe('playing');
  });

  it('empty room for IDLE_RESET_MS: alarm returns the room to a clean lobby', () => {
    const { core, send } = table();
    send('k0', { t: 'start' }, 2000);
    for (let i = 0; i < 4; i++) core.disconnect('k' + i, 5000);
    expect(core.nextAlarm()).not.toBeNull();
    core.alarm(5000 + IDLE_RESET_MS - 1);
    expect(core.s.phase).toBe('playing'); // not yet
    core.alarm(5000 + IDLE_RESET_MS);
    expect(core.s.phase).toBe('lobby');
    expect(core.s.game).toBeNull();
    expect(core.s.seats.every((r) => r === null)).toBe(true);
  });

  it('first person back after the idle limit finds the lobby even without an alarm', () => {
    const { core, send } = table();
    send('k0', { t: 'start' }, 2000);
    for (let i = 0; i < 4; i++) core.disconnect('k' + i, 5000);
    core.connect('late', randomHex(16), 5000 + IDLE_RESET_MS + 10);
    expect(core.s.phase).toBe('lobby');
    expect(core.s.game).toBeNull();
  });

  it('someone returning before the limit keeps the game', () => {
    const { core, send } = table();
    send('k0', { t: 'start' }, 2000);
    for (let i = 0; i < 4; i++) core.disconnect('k' + i, 5000);
    core.connect('x', randomHex(16), 5000 + IDLE_RESET_MS - 1000);
    core.alarm(5000 + IDLE_RESET_MS + 5);
    expect(core.s.phase).toBe('playing');
  });
});
