/**
 * QA full pass (docs/qa-full.md). Tests marked it.fails document CONFIRMED BUGS: they assert the desired
 * behaviour and are expected to fail today; when a bug is fixed vitest flags it so the marker can be removed.
 */
import { describe, expect, it } from 'vitest';
import { randomHex } from '../../src/worker/auth';
import { RoomCore, SEAT_HOLD_MS, MSG_PER_10S, emptyRoom, type Out } from '../../src/worker/core';
import { parseClientMsg, cleanName, cleanChat } from '../../src/worker/validate';
import { applyPlay, fullDeck, legalPlays, newGame, type GameState } from '../../src/engine/game';
import { seededRng } from '../../src/engine/rng';
import { TRACK_LEN, startSquare, type Seat } from '../../src/shared/board';
import { CLOSE_ABUSE, HOST_GRACE_MS, type Card, type ClientMsg, type MarblePos, type Move, type Rank, type RoomView, type ServerMsg } from '../../src/shared/protocol';

function makeRoom(seed = 11) {
  let n = 0;
  return new RoomCore(emptyRoom(), {
    rng: seededRng(seed),
    newId: () => (++n).toString(16).padStart(10, '0'),
    videoMeta: () => ({ title: 't', thumb: 'https://i.ytimg.com/x.jpg' }),
  });
}
type Msg = { to: string; msg: ServerMsg };
const msgs = (o: Out[]) => o.filter((x): x is Msg => 'to' in x);
const errOf = (o: Out[]) => (msgs(o).find((x) => x.msg.t === 'error')?.msg as { code: string } | undefined)?.code;
const view = (c: RoomCore, k: string, now = 1000): RoomView => c.viewFor(c.conns.get(k)!, now);
const send = (c: RoomCore, k: string, m: ClientMsg, now = 1000) => c.message(k, m, now);
const idOf = (c: RoomCore, k: string) => view(c, k).you.id;
function table() {
  const core = makeRoom();
  const sids = [0, 1, 2, 3].map(() => randomHex(16));
  sids.forEach((sid, i) => { core.connect('k' + i, sid, 1000); send(core, 'k' + i, { t: 'name', name: 'P' + i }); send(core, 'k' + i, { t: 'sit', seat: i }); });
  send(core, 'k0', { t: 'hostClaim' });
  for (const [a, b] of [['k0', 'k2'], ['k1', 'k3']] as const) {
    send(core, a, { t: 'partnerReq', to: idOf(core, b) });
    send(core, b, { t: 'partnerAnswer', from: idOf(core, a), accept: true });
  }
  return { core, sids };
}
const started = () => { const t = table(); send(t.core, 'k0', { t: 'start' }); return t; };

describe('validate: prototype-key message types', () => {
  for (const t of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    it(`parseClientMsg does not throw for t=${t} (own-key lookup only)`, () => {
      expect(parseClientMsg(JSON.stringify({ t }))).toBeNull();
    });
  }
  it('plain junk still returns null', () => {
    for (const raw of ['', '[]', 'null', '{"t":1}', '{"t":"nope"}', '{"t":"sit","seat":1.5}', '{"t":"sit","seat":-1}', '{"t":"sit","seat":"1"}']) {
      expect(parseClientMsg(raw)).toBeNull();
    }
  });
  it('rejects ids/cards with bad shape and NaN-like numbers', () => {
    expect(parseClientMsg('{"t":"play","cardId":"AS","moves":[{"k":"step","marble":16,"n":1}]}')).toBeNull();
    expect(parseClientMsg('{"t":"play","cardId":"AS","moves":[{"k":"step","marble":0,"n":13}]}')).toBeNull();
    expect(parseClientMsg('{"t":"play","cardId":"AS","moves":[]}')).toBeNull();
    expect(parseClientMsg('{"t":"play","cardId":"AS","moves":[null]}')).toBeNull();
    expect(parseClientMsg('{"t":"kick","id":"zzzzzzzz"}')).toBeNull();
  });
});

describe('names: uniqueness', () => {
  it('a seated player who is offline keeps the name reserved', () => {
    const { core } = started();
    core.disconnect('k1', 2000);
    core.connect('x', randomHex(16), 2100);
    expect(errOf(send(core, 'x', { t: 'name', name: 'P1' }, 2100))).toBe('name_taken');
  });
  it('case-insensitive collision between connected players', () => {
    const core = makeRoom();
    core.connect('a', randomHex(16), 1); core.connect('b', randomHex(16), 1);
    send(core, 'a', { t: 'name', name: 'Omar' });
    expect(errOf(send(core, 'b', { t: 'name', name: 'oMAR' }))).toBe('name_taken');
  });
  it('cleanName edge cases', () => {
    expect(cleanName('   ')).toBeNull();
    expect(cleanName('!!!')).toBeNull();
    expect(cleanName('a'.repeat(17))).toBeNull();
    expect(cleanName('‮evil')).toBe('evil');
    expect(cleanName('😀')).toBeNull(); // emoji only: no letter/digit
    expect(cleanChat('x'.repeat(301))).toBeNull();
  });
});

describe('simultaneous actions', () => {
  it('two clients sit in the same seat: first wins, second gets seat_taken', () => {
    const core = makeRoom();
    core.connect('a', randomHex(16), 1); core.connect('b', randomHex(16), 1);
    send(core, 'a', { t: 'name', name: 'A' }); send(core, 'b', { t: 'name', name: 'B' });
    expect(errOf(send(core, 'a', { t: 'sit', seat: 2 }))).toBeUndefined();
    expect(errOf(send(core, 'b', { t: 'sit', seat: 2 }))).toBe('seat_taken');
    expect(view(core, 'b').you.seat).toBeNull();
  });
  it('double-click play of the same card: second is rejected, hand not corrupted', () => {
    const { core } = started();
    const g = core.s.game!;
    const key = 'k' + g.turn;
    const all = legalPlays(g, g.turn);
    const p = all.find((x) => (x.moves[0] as Move).k !== 'discard') ?? all[0]!;
    const first = send(core, key, { t: 'play', cardId: p.cardId, moves: p.moves }, 2000);
    expect(errOf(first)).toBeUndefined();
    const hands = core.s.game!.hands.map((h) => h.length);
    const second = send(core, key, { t: 'play', cardId: p.cardId, moves: p.moves }, 2001);
    expect(['not_turn', 'no_card']).toContain(errOf(second));
    expect(core.s.game!.hands.map((h) => h.length)).toEqual(hands);
  });
  it('out-of-turn and spectator plays are rejected', () => {
    const { core } = started();
    const g = core.s.game!;
    const other = 'k' + ((g.turn + 1) % 4);
    const c = core.s.game!.hands[(g.turn + 1) % 4]![0]!;
    expect(errOf(send(core, other, { t: 'play', cardId: c.id, moves: [{ k: 'burn' }] }))).toBe('not_turn');
    core.connect('sp', randomHex(16), 1500);
    expect(errOf(send(core, 'sp', { t: 'play', cardId: c.id, moves: [{ k: 'burn' }] }, 1500))).toBe('not_player');
  });
  it('host claim race: exactly one winner', () => {
    const core = makeRoom();
    ['a', 'b', 'c'].forEach((k) => { core.connect(k, randomHex(16), 1); send(core, k, { t: 'name', name: k }); });
    const r = ['a', 'b', 'c'].map((k) => errOf(send(core, k, { t: 'hostClaim' })));
    expect(r.filter((x) => x === undefined)).toHaveLength(1);
    expect(r.filter((x) => x === 'host_taken')).toHaveLength(2);
  });
});

describe('reconnect and seat hold (5 min)', () => {
  it('seat stays reserved just before SEAT_HOLD_MS, opens exactly at it', () => {
    const { core } = started();
    core.disconnect('k2', 10_000);
    expect(core.alarm(10_000 + SEAT_HOLD_MS - 1)).toEqual([]);
    expect(core.s.seats[2]!.open).toBe(false);
    core.alarm(10_000 + SEAT_HOLD_MS);
    expect(core.s.seats[2]!.open).toBe(true);
  });
  it('player returning after the seat opened (nobody took it) gets it back with the same hand', () => {
    const { core, sids } = started();
    const hand = core.s.game!.hands[2]!.map((c) => c.id);
    core.disconnect('k2', 10_000);
    core.alarm(10_000 + SEAT_HOLD_MS + 5);
    const outs = core.connect('k2b', sids[2]!, 10_000 + SEAT_HOLD_MS + 10);
    const v = msgs(outs).filter((o) => o.to === 'k2b' && o.msg.t === 'view').at(-1)!.msg as { view: RoomView };
    expect(v.view.you.seat).toBe(2);
    expect(v.view.hand.map((c) => c.id)).toEqual(hand);
    expect(v.view.game!.paused).toBe(false);
  });
  it('a held disconnected turn pauses the game and the clock until the player returns (M2)', () => {
    const { core, sids } = started();
    const turn = core.s.game!.turn;
    core.disconnect('k' + turn, 2000);
    const v = view(core, 'k' + ((turn + 1) % 4), 100_000);
    expect(v.game!.paused).toBe(true);
    expect(v.clock.paused).toBe(true);
    expect(v.clock.elapsedMs).toBe(1000);
    expect(v.seats[turn]!.connected).toBe(false);
    core.connect('back', sids[turn]!, 100_000);
    const v2 = view(core, 'back', 100_000);
    expect(v2.game!.paused).toBe(false);
    expect(v2.clock.elapsedMs).toBe(1000);
  });
  it('a disconnected non-turn player does not pause the table', () => {
    const { core } = started();
    const other = (core.s.game!.turn + 1) % 4;
    core.disconnect('k' + other, 2000);
    expect(view(core, 'k' + core.s.game!.turn, 3000).game!.paused).toBe(false);
  });
  it('restore after a DO restart with no sockets stamps leftAt/hostLeftAt and schedules the alarm (H2)', () => {
    const { core } = started();
    const fresh = new RoomCore(structuredClone(core.s), { rng: seededRng(3), newId: () => randomHex(5), videoMeta: () => null });
    expect(fresh.nextAlarm()).toBeNull();
    expect(fresh.restore([], 50_000)).toEqual([]);
    expect(fresh.s.seats.every((r) => r!.leftAt === 50_000)).toBe(true);
    expect(fresh.s.hostLeftAt).toBe(50_000);
    expect(fresh.nextAlarm()).toBe(50_000 + SEAT_HOLD_MS);
    fresh.alarm(50_000 + SEAT_HOLD_MS);
    expect(fresh.s.seats.every((r) => r!.open)).toBe(true);
  });
  it('restore drops sockets of banned sids (kick cannot be bypassed after hibernation, M4)', () => {
    const { core, sids } = started();
    const st = structuredClone(core.s);
    st.banned = [sids[3]!];
    const fresh = new RoomCore(st, { rng: seededRng(3), newId: () => randomHex(5), videoMeta: () => null });
    const drop = fresh.restore(sids.map((sid, i) => ({ key: 'k' + i, sid, muted: true })), 50_000);
    expect(drop).toEqual(['k3']);
    expect(fresh.conns.has('k3')).toBe(false);
    expect(fresh.s.seats[0]!.leftAt).toBeNull();
    expect(fresh.s.seats[3]!.leftAt).toBe(50_000);
  });
  it('replaced session (second tab, same sid) closes the older socket and keeps seat', () => {
    const { core, sids } = started();
    const outs = core.connect('k1new', sids[1]!, 3000);
    expect(outs).toContainEqual(expect.objectContaining({ close: 'k1', reason: 'replaced' }));
    expect(core.disconnect('k1', 3001)).toEqual([]); // stale close must not mark the seat as left
    expect(core.s.seats[1]!.leftAt).toBeNull();
  });
  it('host grace: host disconnect keeps host for 5 min, then frees it; reconnect in time keeps it', () => {
    const { core, sids } = table();
    core.disconnect('k0', 5000);
    expect(core.hostSid()).toBe(sids[0]);
    core.connect('k0b', sids[0]!, 5000 + HOST_GRACE_MS - 1);
    expect(core.s.hostLeftAt).toBeNull();
    core.disconnect('k0b', 9000);
    core.alarm(9000 + HOST_GRACE_MS);
    expect(core.hostSid()).toBeNull();
  });
  it('kicked player mid-game: seat opens and a spectator can take it', () => {
    const { core } = started();
    const out = send(core, 'k0', { t: 'kick', id: idOf(core, 'k3') }, 2000);
    expect(out).toContainEqual(expect.objectContaining({ close: 'k3', reason: 'kicked' }));
    expect(core.s.seats[3]!.open).toBe(true);
    core.connect('sp', randomHex(16), 2100);
    send(core, 'sp', { t: 'name', name: 'SP' }, 2100);
    expect(errOf(send(core, 'sp', { t: 'sit', seat: 3 }, 2100))).toBeUndefined();
    expect(view(core, 'sp', 2100).you.seat).toBe(3);
  });
});

describe('rate limits', () => {
  it('flood: error rate after MSG_PER_10S, socket closed (4429) after 2x', () => {
    const core = makeRoom();
    core.connect('a', randomHex(16), 1);
    let last: Out[] = [];
    for (let i = 0; i < MSG_PER_10S + 1; i++) last = send(core, 'a', { t: 'ping' }, 5);
    expect(errOf(last)).toBe('rate');
    for (let i = 0; i < MSG_PER_10S; i++) last = send(core, 'a', { t: 'ping' }, 5);
    expect(last).toContainEqual(expect.objectContaining({ close: 'a', code: CLOSE_ABUSE }));
  });
  it('window resets after 10 s', () => {
    const core = makeRoom();
    core.connect('a', randomHex(16), 1);
    for (let i = 0; i < MSG_PER_10S + 5; i++) send(core, 'a', { t: 'ping' }, 5);
    expect(errOf(send(core, 'a', { t: 'ping' }, 10_100))).toBeUndefined();
  });
  it('chat: 6th message in 5 s is rate limited', () => {
    const core = makeRoom();
    core.connect('a', randomHex(16), 1);
    send(core, 'a', { t: 'name', name: 'A' });
    const r = [1, 2, 3, 4, 5, 6].map((i) => errOf(send(core, 'a', { t: 'chat', text: 'm' + i }, 100)));
    expect(r.slice(0, 5).every((x) => x === undefined)).toBe(true);
    expect(r[5]).toBe('rate');
  });
});

describe('lobby edge cases', () => {
  it('start refused when a seated player is offline', () => {
    const { core } = table();
    core.disconnect('k1', 2000);
    expect(errOf(send(core, 'k0', { t: 'start' }, 2000))).toBe('teams_incomplete');
  });
  it('seat changes and ready are refused mid-game', () => {
    const { core } = started();
    expect(errOf(send(core, 'k1', { t: 'sit', seat: 0 }))).toBe('seat_taken');
    expect(errOf(send(core, 'k1', { t: 'ready', value: true }))).toBe('not_lobby');
    expect(errOf(send(core, 'k1', { t: 'stand' }))).toBe('not_lobby');
  });
  it('spectator cap: 5th spectator refused', () => {
    const { core } = table();
    for (let i = 0; i < 4; i++) core.connect('s' + i, randomHex(16), 2);
    expect(core.connect('s5', randomHex(16), 2)).toContainEqual(expect.objectContaining({ close: 's5', reason: 'full' }));
  });
  it('swap request between two spectators is refused', () => {
    const core = makeRoom();
    ['a', 'b'].forEach((k) => { core.connect(k, randomHex(16), 1); send(core, k, { t: 'name', name: k }); });
    expect(errOf(send(core, 'a', { t: 'swapReq', to: idOf(core, 'b') }))).toBe('not_seated');
  });
  it('toLobby by host mid-game drops the game with no score', () => {
    const { core } = started();
    send(core, 'k0', { t: 'toLobby' }, 3000);
    expect(core.s.phase).toBe('lobby');
    expect(core.s.scores).toEqual({ A: 0, B: 0 });
    expect(core.s.game).toBeNull();
  });
  it('non-host cannot again/toLobby/kick/shuffle', () => {
    const { core } = started();
    for (const t of ['toLobby', 'again', 'shuffleTeams'] as const) expect(errOf(send(core, 'k1', { t }))).toBe('not_host');
    expect(errOf(send(core, 'k1', { t: 'kick', id: idOf(core, 'k2') }))).toBe('not_host');
  });
});

describe('scoreboard', () => {
  it('scoreboard request works for spectators and is empty at start', () => {
    const core = makeRoom();
    core.connect('a', randomHex(16), 1);
    const m = msgs(send(core, 'a', { t: 'scoreboard' }))[0]!.msg as { t: string; board: { total: number } };
    expect(m.t).toBe('scoreboard');
    expect(m.board.total).toBe(0);
  });
});

// ---------------------------------------------------------------- engine edge cases

function setup(hands: Partial<Record<Seat, Rank[]>> = {}, turn: Seat = 0): GameState {
  const { state } = newGame(seededRng(1), 3);
  state.marbles = Array.from({ length: 16 }, () => ({ zone: 'base' }) as MarblePos);
  const deck = fullDeck();
  const take = (r: Rank): Card => deck.splice(deck.findIndex((c) => c.rank === r), 1)[0]!;
  const fill = (): Card => take((['2', '3', '5', '6', '8', '9'] as Rank[]).find((r) => deck.some((c) => c.rank === r))!);
  state.hands = [0, 1, 2, 3].map((s) => { const h = (hands[s as Seat] ?? []).map(take); while (h.length < 4) h.push(fill()); return h; });
  state.deck = deck; state.turn = turn;
  return state;
}
const T = (s: number): MarblePos => ({ zone: 'track', square: ((s % TRACK_LEN) + TRACK_LEN) % TRACK_LEN });
const H = (slot: number): MarblePos => ({ zone: 'home', slot });
const rng = seededRng(5);
const cid = (s: GameState, seat: Seat, r: Rank) => s.hands[seat]!.find((c) => c.rank === r)!.id;

describe('engine: edge cases', () => {
  it('A step 5 rejected; 4 with n!=4 rejected; K as step rejected', () => {
    const s = setup({ 0: ['K', 'A', '4'] });
    s.marbles[0] = T(0);
    expect(applyPlay(s, 0, { cardId: cid(s, 0, 'K'), moves: [{ k: 'step', marble: 0, n: 12 }] }, rng)).toMatchObject({ ok: false });
    expect(applyPlay(s, 0, { cardId: cid(s, 0, 'A'), moves: [{ k: 'step', marble: 0, n: 5 }] }, rng)).toMatchObject({ ok: false });
    expect(applyPlay(s, 0, { cardId: cid(s, 0, '4'), moves: [{ k: 'step', marble: 0, n: 3 }] }, rng)).toMatchObject({ ok: false });
  });
  it('cannot control opponent marbles or partner marbles before finishing', () => {
    const s = setup({ 0: ['5'] });
    s.marbles[4] = T(30); s.marbles[8] = T(40);
    expect(applyPlay(s, 0, { cardId: cid(s, 0, '5'), moves: [{ k: 'step', marble: 4, n: 5 }] }, rng)).toMatchObject({ ok: false });
    expect(applyPlay(s, 0, { cardId: cid(s, 0, '5'), moves: [{ k: 'step', marble: 8, n: 5 }] }, rng)).toMatchObject({ ok: false });
  });
  it('J: swap with partner/own marble, home marble or base marble is illegal', () => {
    const s = setup({ 0: ['J'] });
    s.marbles[0] = T(10); s.marbles[8] = T(20); s.marbles[4] = H(0); s.marbles[1] = T(30);
    for (const target of [8, 1, 4, 5]) {
      expect(applyPlay(s, 0, { cardId: cid(s, 0, 'J'), moves: [{ k: 'swap', marble: 0, target }] }, rng)).toMatchObject({ ok: false });
    }
  });
  it('7 split with the same marble twice, total 8, or total 3 is illegal', () => {
    const s = setup({ 0: ['7'] });
    s.marbles[0] = T(10); s.marbles[1] = T(20);
    const c = cid(s, 0, '7');
    expect(applyPlay(s, 0, { cardId: c, moves: [{ k: 'step', marble: 0, n: 3 }, { k: 'step', marble: 0, n: 4 }] }, rng)).toMatchObject({ ok: false });
    expect(applyPlay(s, 0, { cardId: c, moves: [{ k: 'step', marble: 0, n: 4 }, { k: 'step', marble: 1, n: 4 }] }, rng)).toMatchObject({ ok: false });
    expect(applyPlay(s, 0, { cardId: c, moves: [{ k: 'step', marble: 0, n: 3 }] }, rng)).toMatchObject({ ok: false });
  });
  it('failed play leaves state untouched (atomic, even when the 2nd split leg fails)', () => {
    const s = setup({ 0: ['7'] });
    s.marbles[0] = T(10); s.marbles[1] = H(3);
    const before = JSON.stringify(s);
    const r = applyPlay(s, 0, { cardId: cid(s, 0, '7'), moves: [{ k: 'step', marble: 0, n: 3 }, { k: 'step', marble: 1, n: 4 }] }, rng);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(s)).toBe(before);
  });
  it('4 backward onto a protected start square is illegal', () => {
    const s = setup({ 0: ['4'] });
    s.marbles[0] = T(startSquare(1) + 4);
    s.marbles[4] = T(startSquare(1));
    expect(applyPlay(s, 0, { cardId: cid(s, 0, '4'), moves: [{ k: 'step', marble: 0, n: 4 }] }, rng)).toMatchObject({ ok: false });
  });
  it('when team A finishes, its seats are skipped, hands emptied, game not over yet', () => {
    const s = setup({ 0: ['A'] });
    for (const id of [0, 1, 2, 3]) s.marbles[id] = H(id);
    for (const id of [8, 9, 10]) s.marbles[id] = H(id - 7);
    s.marbles[11] = T(startSquare(2) - 1 + TRACK_LEN);
    const res = applyPlay(s, 0, { cardId: cid(s, 0, 'A'), moves: [{ k: 'step', marble: 11, n: 1 }] }, rng);
    expect(res.ok).toBe(true);
    expect(s.winner).toBe('A');
    expect(s.over).toBe(false);
    expect(s.hands[0]).toHaveLength(0);
    expect(s.hands[2]).toHaveLength(0);
    expect([1, 3]).toContain(s.turn);
  });
});
