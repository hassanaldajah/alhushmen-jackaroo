/** Skip: only the very first turn of a game, once, current player only; no card lost. */
import { describe, expect, it } from 'vitest';
import { randomHex } from '../../src/worker/auth';
import { RoomCore, MSG_PER_10S, emptyRoom, type Out } from '../../src/worker/core';
import { parseClientMsg } from '../../src/worker/validate';
import { applySkip, canSkip, legalPlays, newGame, applyPlay } from '../../src/engine/game';
import { seededRng } from '../../src/engine/rng';
import type { ClientMsg, RoomView, ServerMsg } from '../../src/shared/protocol';
import type { Seat } from '../../src/shared/board';

function makeRoom(seed = 11) {
  let n = 0;
  return new RoomCore(emptyRoom(), { rng: seededRng(seed), newId: () => (++n).toString(16).padStart(10, '0'), videoMeta: () => null });
}
type Msg = { to: string; msg: ServerMsg };
const msgs = (o: Out[]) => o.filter((x): x is Msg => 'to' in x);
const errOf = (o: Out[]) => (msgs(o).find((x) => x.msg.t === 'error')?.msg as { code: string } | undefined)?.code;
const view = (c: RoomCore, k: string, now = 1000): RoomView => c.viewFor(c.conns.get(k)!, now);
const send = (c: RoomCore, k: string, m: ClientMsg, now = 1000) => c.message(k, m, now);
const idOf = (c: RoomCore, k: string) => view(c, k).you.id;
function started(seed = 11) {
  const core = makeRoom(seed);
  const sids = [0, 1, 2, 3].map(() => randomHex(16));
  sids.forEach((sid, i) => { core.connect('k' + i, sid, 1000); send(core, 'k' + i, { t: 'name', name: 'P' + i }); send(core, 'k' + i, { t: 'sit', seat: i }); });
  send(core, 'k0', { t: 'hostClaim' });
  for (const [a, b] of [['k0', 'k2'], ['k1', 'k3']] as const) {
    send(core, a, { t: 'partnerReq', to: idOf(core, b) });
    send(core, b, { t: 'partnerAnswer', from: idOf(core, a), accept: true });
  }
  send(core, 'k0', { t: 'start' });
  return { core, sids };
}
const playFirst = (core: RoomCore, now = 1000) => {
  const g = core.s.game!;
  const p = legalPlays(g, g.turn)[0]!;
  return send(core, 'k' + g.turn, { t: 'play', cardId: p.cardId, moves: p.moves }, now);
};

describe('skip: message shape', () => {
  it('accepts the bare message and rejects extra keys or junk', () => {
    expect(parseClientMsg('{"t":"skip"}')).toEqual({ t: 'skip' });
    expect(parseClientMsg('{"t":"skip","seat":1}')).toBeNull();
    expect(parseClientMsg('{"t":"skip","x":null}')).toBeNull();
    expect(parseClientMsg('{"t":"Skip"}')).toBeNull();
    expect(parseClientMsg('["skip"]')).toBeNull();
  });
  it('a malformed skip changes nothing and is answered with bad_msg', () => {
    const { core } = started();
    const turn = core.s.game!.turn;
    const out = core.message('k' + turn, parseClientMsg('{"t":"skip","n":2}'), 1000);
    expect(errOf(out)).toBe('bad_msg');
    expect(core.s.game!.turn).toBe(turn);
  });
});

describe('skip: first turn only, once per game', () => {
  it('the first player may skip: turn passes, hand unchanged, canSkip shown only to him', () => {
    const { core } = started();
    const g = core.s.game!;
    const t = g.turn;
    const next = ((t + 1) % 4) as Seat;
    expect(view(core, 'k' + t).game!.canSkip).toBe(true);
    for (const s of [0, 1, 2, 3].filter((s) => s !== t)) expect(view(core, 'k' + s).game!.canSkip).toBe(false);
    const hand = g.hands[t]!.map((c) => c.id);
    const out = send(core, 'k' + t, { t: 'skip' });
    expect(errOf(out)).toBeUndefined();
    expect(msgs(out).some((m) => m.msg.t === 'event' && m.msg.kind === 'skip')).toBe(true);
    expect(core.s.game!.turn).toBe(next);
    expect(core.s.game!.hands[t]!.map((c) => c.id)).toEqual(hand);
    expect(core.s.game!.turns).toBe(0);
    expect(core.s.game!.skipUsed).toBe(true);
    expect(view(core, 'k' + next).game!.canSkip).toBe(false);
  });
  it('a second skip (next player) is rejected with no_skip; he must play normally', () => {
    const { core } = started();
    const t = core.s.game!.turn;
    send(core, 'k' + t, { t: 'skip' });
    const next = core.s.game!.turn;
    const hand = core.s.game!.hands[next]!.length;
    expect(errOf(send(core, 'k' + next, { t: 'skip' }))).toBe('no_skip');
    expect(core.s.game!.turn).toBe(next);
    expect(core.s.game!.hands[next]!.length).toBe(hand);
  });
  it('skip after the first card was played is rejected', () => {
    const { core } = started();
    expect(errOf(playFirst(core))).toBeUndefined();
    const t = core.s.game!.turn;
    expect(view(core, 'k' + t).game!.canSkip).toBe(false);
    expect(errOf(send(core, 'k' + t, { t: 'skip' }))).toBe('no_skip');
    expect(core.s.game!.turn).toBe(t);
  });
  it('a non-current player cannot skip', () => {
    const { core } = started();
    const t = core.s.game!.turn;
    const other = (t + 2) % 4;
    expect(errOf(send(core, 'k' + other, { t: 'skip' }))).toBe('not_turn');
    expect(core.s.game!.turn).toBe(t);
    expect(core.s.game!.skipUsed).toBeFalsy();
  });
  it('spectators cannot skip', () => {
    const { core } = started();
    core.connect('sp', randomHex(16), 1000);
    expect(errOf(send(core, 'sp', { t: 'skip' }))).toBe('not_player');
  });
  it('the used flag survives a DO restart and a new game resets it', () => {
    const { core } = started();
    send(core, 'k' + core.s.game!.turn, { t: 'skip' });
    const fresh = new RoomCore(JSON.parse(JSON.stringify(core.s)), { rng: seededRng(3), newId: () => randomHex(5), videoMeta: () => null });
    expect(fresh.s.game!.skipUsed).toBe(true);
    // engine: a brand-new game starts with the skip available again
    const { state } = newGame(seededRng(5), 0);
    expect(state.skipUsed).toBeFalsy();
    expect(canSkip(state, state.turn)).toBe(true);
    // room: host back to lobby, start again -> first player may skip
    send(core, 'k0', { t: 'toLobby' }, 2000);
    for (let i = 0; i < 4; i++) send(core, 'k' + i, { t: 'ready', value: true }, 2000);
    send(core, 'k0', { t: 'start' }, 2000);
    const g = core.s.game!;
    expect(g.skipUsed).toBeFalsy();
    expect(view(core, 'k' + g.turn, 2000).game!.canSkip).toBe(true);
  });
});

describe('skip: paused, ended, rate limit', () => {
  it('ignored while the game is paused (disconnected turn holder)', () => {
    const { core, sids } = started();
    const t = core.s.game!.turn;
    core.disconnect('k' + t, 2000);
    core.connect('back', sids[t]!, 2000);
    // pause by another seat dropping out
    const other = (t + 1) % 4;
    core.disconnect('k' + other, 2000);
    const s = core.s.seats[other]!;
    (s as { open?: boolean }).open = true; // open seat pauses the game
    expect(view(core, 'back', 3000).game!.paused).toBe(true);
    expect(send(core, 'back', { t: 'skip' }, 3000)).toEqual([]);
    expect(core.s.game!.turn).toBe(t);
    expect(core.s.game!.skipUsed).toBeFalsy();
  });
  it('ignored when the game is over', () => {
    const { core } = started();
    const t = core.s.game!.turn;
    core.s.game!.over = true;
    expect(send(core, 'k' + t, { t: 'skip' })).toEqual([]);
    expect(core.s.game!.skipUsed).toBeFalsy();
  });
  it('rate limited like other actions', () => {
    const { core } = started();
    const t = core.s.game!.turn;
    const other = 'k' + ((t + 1) % 4);
    let last: Out[] = [];
    for (let i = 0; i < MSG_PER_10S + 1; i++) last = send(core, other, { t: 'skip' }, 5000);
    expect(errOf(last)).toBe('rate');
  });
});

describe('engine applySkip', () => {
  it('rejects not_turn, no_skip after a play, ended when over', () => {
    const rng = seededRng(9);
    const { state } = newGame(rng, 0);
    const t = state.turn;
    expect(applySkip(state, ((t + 1) % 4) as Seat, rng)).toEqual({ ok: false, code: 'not_turn' });
    const p = legalPlays(state, t)[0]!;
    expect(applyPlay(state, t, p, rng).ok).toBe(true);
    expect(applySkip(state, state.turn, rng)).toEqual({ ok: false, code: 'no_skip' });
    state.over = true;
    expect(applySkip(state, state.turn, rng)).toEqual({ ok: false, code: 'ended' });
  });
});
