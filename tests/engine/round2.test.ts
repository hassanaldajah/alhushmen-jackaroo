import { describe, expect, it } from 'vitest';
import { randomHex } from '../../src/worker/auth';
import {
  BAD_PER_10S, RoomCore, buildScoreboard, emptyRoom, expectedFrom, memoryStore, type GameStore, type Out,
} from '../../src/worker/core';
import { cleanName, parseClientMsg } from '../../src/worker/validate';
import { seededRng } from '../../src/engine/rng';
import {
  CLOSE_ABUSE, EST_DEFAULT_MS, HOST_GRACE_MS, HOST_VOTE_COOLDOWN_MS, HOST_VOTE_MS, JOKE_COUNT, MUSIC_ACTS_PER_10S,
  type ClientMsg, type GameRecord, type RoomView, type ServerMsg,
} from '../../src/shared/protocol';

function makeRoom(store: GameStore = memoryStore(), seed = 5) {
  let n = 0;
  const meta = new Map([['dQw4w9WgXcQ', { title: 'song', thumb: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg' }]]);
  return new RoomCore(emptyRoom(), {
    rng: seededRng(seed),
    newId: () => (++n).toString(16).padStart(10, '0'),
    videoMeta: (id) => meta.get(id) ?? null,
    store,
  });
}
type Msg = { to: string; msg: ServerMsg };
const msgs = (outs: Out[]) => outs.filter((o): o is Msg => 'to' in o);
const view = (core: RoomCore, key: string, now = 1000): RoomView => core.viewFor(core.conns.get(key)!, now);
const send = (core: RoomCore, key: string, m: ClientMsg, now = 1000) => core.message(key, m, now);
const idOf = (core: RoomCore, key: string) => view(core, key).you.id;
const errOf = (outs: Out[]) => msgs(outs).find((o) => o.msg.t === 'error')?.msg as { code: string } | undefined;
const notices = (outs: Out[], key: string) =>
  msgs(outs).filter((o) => o.to === key && o.msg.t === 'notice').map((o) => (o.msg as { code: string }).code);

function people(core: RoomCore, n: number, seat = true, now = 1000) {
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    const k = 'k' + i;
    core.connect(k, randomHex(16), now);
    send(core, k, { t: 'name', name: 'P' + i }, now);
    if (seat && i < 4) send(core, k, { t: 'sit', seat: i }, now);
    keys.push(k);
  }
  return keys;
}
function pair(core: RoomCore, a: string, b: string, now = 1000) {
  send(core, a, { t: 'partnerReq', to: idOf(core, b) }, now);
  return send(core, b, { t: 'partnerAnswer', from: idOf(core, a), accept: true }, now);
}
function readyTable(store?: GameStore, seed?: number) {
  const core = makeRoom(store, seed);
  people(core, 4);
  send(core, 'k0', { t: 'hostClaim' });
  pair(core, 'k0', 'k2');
  pair(core, 'k1', 'k3');
  return core;
}
/** Plays a whole game through the room using the server's own legal plays. */
function playOut(core: RoomCore, t0 = 2000): { outs: Out[]; now: number } {
  let now = t0;
  const all: Out[] = [];
  for (let i = 0; i < 5000 && core.s.phase === 'playing'; i++) {
    const g = core.s.game!;
    const key = 'k' + g.turn; // readyTable seats k<i> at seat i
    const hint = msgs(send(core, key, { t: 'hint' }, now))[0]!.msg as { t: 'hint'; plays: { cardId: string; moves: never[] }[] };
    const good = hint.plays.filter((p) => (p.moves[0] as unknown as { k: string } | undefined)?.k !== 'discard');
    const p = (good.length ? good : hint.plays)[0]!;
    now += 3000;
    all.push(...send(core, key, { t: 'play', cardId: p.cardId, moves: p.moves }, now));
  }
  return { outs: all, now };
}

describe('display names', () => {
  it('strips markup, control, bidi and zero-width chars; caps length; needs a letter', () => {
    expect(cleanName('<img src=x onerror=alert(1)>حسن')).toBe('حسن');
    expect(cleanName('a<b>c')).toBe('ac');
    expect(cleanName('ab‮cd​\u0000')).toBe('abcd');
    expect(cleanName('حُسن')).toBe('حُسن'); // damma kept
    expect(cleanName('é́́́́')).toBe('é́́'); // NFKC composes, then the zalgo run is cut
    expect(cleanName('x'.repeat(17))).toBeNull();
    expect(cleanName('x'.repeat(16))).toBe('x'.repeat(16));
    expect(cleanName('<<>>')).toBeNull();
    expect(cleanName('!!!')).toBeNull();
    expect(cleanName('   ')).toBeNull();
    expect(cleanName(42)).toBeNull();
  });
  it('unique among present people; required before sitting or claiming host', () => {
    const core = makeRoom();
    core.connect('a', randomHex(16), 1);
    core.connect('b', randomHex(16), 1);
    expect(errOf(send(core, 'a', { t: 'sit', seat: 0 }))?.code).toBe('not_named');
    expect(errOf(send(core, 'a', { t: 'hostClaim' }))?.code).toBe('not_named');
    expect(view(core, 'a').you.named).toBe(false);
    send(core, 'a', { t: 'name', name: 'Hasan' });
    expect(errOf(send(core, 'b', { t: 'name', name: 'hasan' }))?.code).toBe('name_taken');
    send(core, 'b', { t: 'name', name: 'Ali' });
    expect(view(core, 'b').you).toMatchObject({ name: 'Ali', named: true });
  });
});

describe('message validation (round 2)', () => {
  it('parses new messages and rejects extra fields and bad ids', () => {
    expect(parseClientMsg('{"t":"hostClaim"}')).toEqual({ t: 'hostClaim' });
    expect(parseClientMsg('{"t":"hostClaim","x":1}')).toBeNull();
    expect(parseClientMsg('{"t":"ping","extra":true}')).toBeNull();
    expect(parseClientMsg('{"t":"partnerReq","to":"00000000ab"}')).toEqual({ t: 'partnerReq', to: '00000000ab' });
    expect(parseClientMsg('{"t":"partnerReq","to":"<x>"}')).toBeNull();
    expect(parseClientMsg('{"t":"partnerAnswer","from":"00000000ab","accept":"yes"}')).toBeNull();
    expect(parseClientMsg('{"t":"hostVote","choice":"keep"}')).toEqual({ t: 'hostVote', choice: 'keep' });
    expect(parseClientMsg('{"t":"hostVote","choice":"nope"}')).toBeNull();
    expect(parseClientMsg('{"t":"qSkip"}')).toEqual({ t: 'qSkip' });
    expect(parseClientMsg('{"t":"qSkip","itemId":"00000000ab"}')).toEqual({ t: 'qSkip', itemId: '00000000ab' });
    expect(parseClientMsg('{"t":"qPause","paused":1}')).toBeNull();
    expect(parseClientMsg('{"t":"swapAnswer","from":"00000000ab","accept":false}')).toEqual({ t: 'swapAnswer', from: '00000000ab', accept: false });
    expect(parseClientMsg('{"t":"scoreboard"}')).toEqual({ t: 'scoreboard' });
    expect(parseClientMsg('{"t":"play","cardId":"AS","moves":[{"k":"burn"}],"seat":2}')).toBeNull();
  });
  it('closes a socket that keeps sending malformed frames; others unaffected', () => {
    const core = makeRoom();
    people(core, 2, false);
    let closed: Out[] = [];
    for (let i = 0; i <= BAD_PER_10S; i++) closed = send(core, 'k0', null as unknown as ClientMsg);
    expect(closed).toContainEqual({ close: 'k0', code: CLOSE_ABUSE, reason: 'abuse' });
    expect(core.conns.has('k0')).toBe(false);
    expect(core.conns.has('k1')).toBe(true);
  });
});

describe('host selection', () => {
  it('first claim wins atomically; later claims get host_taken', () => {
    const core = makeRoom();
    people(core, 3, false);
    expect(view(core, 'k1').hostId).toBeNull();
    const out = send(core, 'k1', { t: 'hostClaim' });
    expect(notices(out, 'k2')).toContain('host_claimed');
    expect(errOf(send(core, 'k2', { t: 'hostClaim' }))?.code).toBe('host_taken');
    expect(view(core, 'k0').hostId).toBe(idOf(core, 'k1'));
    expect(view(core, 'k1').you.host).toBe(true);
  });
  it('host leaving beyond the grace reopens the claim; return within grace keeps it', () => {
    const core = makeRoom();
    const sids = [randomHex(16), randomHex(16)];
    sids.forEach((sid, i) => { core.connect('k' + i, sid, 1000); send(core, 'k' + i, { t: 'name', name: 'P' + i }); });
    send(core, 'k0', { t: 'hostClaim' });
    core.disconnect('k0', 2000);
    expect(core.nextAlarm()).toBe(2000 + HOST_GRACE_MS);
    core.connect('k0b', sids[0]!, 3000);
    expect(core.alarm(2000 + HOST_GRACE_MS)).toEqual([]);
    expect(view(core, 'k0b').you.host).toBe(true);
    core.disconnect('k0b', 20_000);
    const out = core.alarm(20_000 + HOST_GRACE_MS);
    expect(notices(out, 'k1')).toContain('host_left');
    expect(view(core, 'k1').hostId).toBeNull();
    expect(msgs(send(core, 'k1', { t: 'hostClaim' }, 40_000)).some((o) => o.msg.t === 'error')).toBe(false);
  });
  it('change-host vote: majority of present decides; timeout keeps host and sets a cooldown', () => {
    const core = makeRoom();
    people(core, 4, false);
    send(core, 'k0', { t: 'hostClaim' });
    expect(errOf(send(core, 'k1', { t: 'hostVote', choice: 'keep' }))?.code).toBe('no_vote');
    send(core, 'k1', { t: 'hostVoteStart' });
    expect(errOf(send(core, 'k2', { t: 'hostVoteStart' }))?.code).toBe('vote_open');
    const c = idOf(core, 'k2');
    send(core, 'k1', { t: 'hostVote', choice: c });
    send(core, 'k2', { t: 'hostVote', choice: c });
    expect(view(core, 'k3').hostVote).toMatchObject({ voters: 4, tally: { [c]: 2 } });
    expect(view(core, 'k0').hostId).toBe(idOf(core, 'k0')); // 2 of 4 is not a majority
    const out = send(core, 'k3', { t: 'hostVote', choice: c });
    expect(notices(out, 'k0')).toContain('host_changed');
    expect(view(core, 'k0').hostId).toBe(c);
    expect(view(core, 'k0').hostVote).toBeNull();
    // Failed vote -> cooldown
    send(core, 'k0', { t: 'hostVoteStart' }, 5000);
    send(core, 'k0', { t: 'hostVote', choice: idOf(core, 'k0') }, 5000);
    expect(core.nextAlarm()).toBe(5000 + HOST_VOTE_MS);
    expect(notices(core.alarm(5000 + HOST_VOTE_MS), 'k1')).toContain('host_kept');
    expect(view(core, 'k0').hostId).toBe(c);
    expect(errOf(send(core, 'k0', { t: 'hostVoteStart' }, 5000 + HOST_VOTE_MS + 1))?.code).toBe('vote_cooldown');
    expect(errOf(send(core, 'k0', { t: 'hostVoteStart' }, 5000 + HOST_VOTE_MS + HOST_VOTE_COOLDOWN_MS + 1))).toBeUndefined();
  });
  it('host can hand over; non-host powers rejected', () => {
    const core = makeRoom();
    people(core, 4);
    send(core, 'k0', { t: 'hostClaim' });
    for (const m of [{ t: 'shuffleTeams' }, { t: 'start' }, { t: 'kick', id: idOf(core, 'k0') }, { t: 'hostGive', to: idOf(core, 'k1') }] as ClientMsg[]) {
      expect(errOf(send(core, 'k1', m))?.code).toBe('not_host');
    }
    send(core, 'k0', { t: 'hostGive', to: idOf(core, 'k3') });
    expect(view(core, 'k1').hostId).toBe(idOf(core, 'k3'));
  });
});

describe('partner requests and teams', () => {
  it('accepted partners sit opposite each other; others are moved aside', () => {
    const core = makeRoom();
    people(core, 4);
    const out = pair(core, 'k0', 'k1'); // seats 0 and 1 -> must end up opposite
    expect(notices(out, 'k3')).toContain('team_formed');
    const v = view(core, 'k0');
    const s0 = v.seats.find((x) => x.id === idOf(core, 'k0'))!.index;
    const s1 = v.seats.find((x) => x.id === idOf(core, 'k1'))!.index;
    expect((s0 + 2) % 4).toBe(s1);
    expect(v.seats.filter((x) => x.id).length).toBe(4);
    expect(v.seats.filter((x) => x.paired).length).toBe(2);
    expect(v.canStart).toBe(false);
    pair(core, 'k2', 'k3');
    expect(view(core, 'k0').canStart).toBe(true);
  });
  it('decline notifies the requester; race loser gets partner_taken; mutual request pairs', () => {
    const core = makeRoom();
    people(core, 4);
    send(core, 'k0', { t: 'partnerReq', to: idOf(core, 'k2') });
    expect(view(core, 'k2').requests).toEqual([{ kind: 'partner', from: idOf(core, 'k0'), to: idOf(core, 'k2'), at: 1000 }]);
    expect(view(core, 'k1').requests).toEqual([]); // only requests involving the viewer
    expect(notices(send(core, 'k2', { t: 'partnerAnswer', from: idOf(core, 'k0'), accept: false }), 'k0')).toContain('partner_declined');
    send(core, 'k0', { t: 'partnerReq', to: idOf(core, 'k2') });
    send(core, 'k1', { t: 'partnerReq', to: idOf(core, 'k2') });
    const out = send(core, 'k2', { t: 'partnerAnswer', from: idOf(core, 'k0'), accept: true });
    expect(notices(out, 'k1')).toContain('partner_taken');
    expect(view(core, 'k1').requests).toEqual([]);
    expect(errOf(send(core, 'k1', { t: 'partnerReq', to: idOf(core, 'k0') }))?.code).toBe('has_partner');
    send(core, 'k1', { t: 'partnerReq', to: idOf(core, 'k3') });
    send(core, 'k3', { t: 'partnerReq', to: idOf(core, 'k1') }); // mutual = accept
    expect(view(core, 'k0').canStart).toBe(true);
  });
  it('spectators cannot request; standing up breaks the team', () => {
    const core = makeRoom();
    people(core, 5);
    expect(errOf(send(core, 'k4', { t: 'partnerReq', to: idOf(core, 'k0') }))?.code).toBe('not_seated');
    expect(errOf(send(core, 'k0', { t: 'partnerReq', to: idOf(core, 'k4') }))?.code).toBe('not_seated');
    pair(core, 'k0', 'k2');
    const out = send(core, 'k2', { t: 'stand' });
    expect(notices(out, 'k0')).toContain('team_broken');
    expect(view(core, 'k0').seats.every((x) => !x.paired)).toBe(true);
    pair(core, 'k1', 'k3');
    expect(notices(send(core, 'k1', { t: 'partnerBreak' }), 'k3')).toContain('team_broken');
  });
  it('host shuffle pairs all 4 seated players randomly, partners opposite', () => {
    const core = makeRoom();
    people(core, 3);
    send(core, 'k0', { t: 'hostClaim' });
    expect(errOf(send(core, 'k0', { t: 'shuffleTeams' }))?.code).toBe('teams_incomplete');
    core.connect('k3', randomHex(16), 1000);
    send(core, 'k3', { t: 'name', name: 'P3' });
    send(core, 'k3', { t: 'sit', seat: 3 });
    const out = send(core, 'k0', { t: 'shuffleTeams' });
    expect(notices(out, 'k2')).toContain('teams_shuffled');
    const v = view(core, 'k1');
    expect(v.seats.every((x) => x.paired && x.id)).toBe(true);
    expect(v.canStart).toBe(true);
  });
  it('start requires 2 complete teams', () => {
    const core = makeRoom();
    people(core, 4);
    send(core, 'k0', { t: 'hostClaim' });
    expect(errOf(send(core, 'k0', { t: 'start' }))?.code).toBe('teams_incomplete');
    pair(core, 'k0', 'k2');
    expect(errOf(send(core, 'k0', { t: 'start' }))?.code).toBe('teams_incomplete');
    pair(core, 'k1', 'k3');
    expect(errOf(send(core, 'k0', { t: 'start' }))).toBeUndefined();
    expect(core.s.phase).toBe('playing');
  });
});

describe('dealer jokes', () => {
  it('a joke cue goes out with every deal, index in range', () => {
    const core = readyTable();
    const out = send(core, 'k0', { t: 'start' });
    const j = msgs(out).filter((o) => o.msg.t === 'joke');
    expect(j).toHaveLength(4);
    const m = j[0]!.msg as { t: 'joke'; seat: number; index: number; dealNo: number };
    expect(m.seat).toBe(core.s.game!.dealer);
    expect(m.index).toBeGreaterThanOrEqual(0);
    expect(m.index).toBeLessThan(JOKE_COUNT);
    expect(m.dealNo).toBe(1);
  });
  it('never repeats before the whole list is used, also across refills', () => {
    const core = makeRoom();
    const next = () => (core as unknown as { nextJoke(): number }).nextJoke();
    const seq = Array.from({ length: JOKE_COUNT * 4 }, next);
    for (let k = 0; k < 4; k++) expect(new Set(seq.slice(k * JOKE_COUNT, (k + 1) * JOKE_COUNT)).size).toBe(JOKE_COUNT);
    for (let i = 1; i < seq.length; i++) expect(seq[i]).not.toBe(seq[i - 1]);
  });
});

describe('game end, result, scoreboard, expected duration', () => {
  it('plays until both teams finish, records margin and duration, saves and persists', () => {
    const store = memoryStore();
    const core = readyTable(store);
    send(core, 'k0', { t: 'start' }, 2000);
    const { outs, now } = playOut(core);
    expect(core.s.phase).toBe('ended');
    const kinds = msgs(outs).filter((o) => o.to === 'k0' && o.msg.t === 'event').flatMap((o) => (o.msg as { events: { kind: string }[] }).events.map((e) => e.kind));
    expect(kinds.filter((k) => k === 'win')).toHaveLength(1);
    expect(kinds).toContain('teamDone');
    expect(kinds.at(-1)).toBe('over');
    // after the first team finished, its seats never moved again
    const v = view(core, 'k1', now);
    const r = v.result!;
    expect(r.order.map((o) => o.team).sort()).toEqual(['A', 'B']);
    expect(r.winner).toBe(r.order[0]!.team);
    expect(r.marginTurns).toBe(r.order[1]!.turns - r.order[0]!.turns);
    expect(r.marginMs).toBe(r.order[1]!.ms - r.order[0]!.ms);
    expect(r.durationMs).toBe(now - 2000);
    expect(r.teams).toEqual({ A: ['P0', 'P2'], B: ['P1', 'P3'] });
    expect(r.saved).toBe(true);
    expect(r.expectedMs).toBe(EST_DEFAULT_MS);
    expect(v.scores[r.winner]).toBe(1);
    expect(v.clock.elapsedMs).toBe(r.durationMs);
    expect(store.rows).toHaveLength(1);
    // Scoreboard from a fresh core (DO restart) reads the same store
    const core2 = makeRoom(store);
    core2.connect('x', randomHex(16), now);
    const sb = msgs(send(core2, 'x', { t: 'scoreboard' }, now))[0]!.msg as { t: 'scoreboard'; board: ReturnType<typeof buildScoreboard> };
    expect(sb.board.total).toBe(1);
    const winners = r.teams[r.winner];
    expect(sb.board.players.find((p) => p.names[0] === winners[0])).toMatchObject({ wins: 1, games: 1 });
    expect(sb.board.teams[0]).toMatchObject({ names: [...winners].sort(), wins: 1, games: 1 });
    // views and results never leak session ids
    for (const sid of Object.keys(core.s.people)) expect(JSON.stringify([v, sb])).not.toContain(sid);
    // next game lobby: teams kept, seats can change, host still host
    expect(errOf(send(core, 'k1', { t: 'again' }, now))?.code).toBe('not_host');
    send(core, 'k0', { t: 'again' }, now);
    const lv = view(core, 'k0', now);
    expect(lv.phase).toBe('lobby');
    expect(lv.canStart).toBe(true);
    expect(lv.result).toBeNull();
    expect(lv.you.host).toBe(true);
  }, 60_000);
  it('expected duration uses the reasoned constant, then the average of saved games', () => {
    const rec = (d: number, i: number): GameRecord => ({
      id: 'g' + i, startedAt: i, endedAt: i + d, durationMs: d, turns: 300, teams: { A: ['a', 'b'], B: ['c', 'd'] },
      winner: 'A', order: [], marginMs: 0, marginTurns: 0,
    });
    expect(expectedFrom([])).toEqual({ ms: EST_DEFAULT_MS, from: 'estimate' });
    expect(expectedFrom([rec(1000, 1), rec(2000, 2)]).from).toBe('estimate');
    expect(expectedFrom([rec(1000, 1), rec(2000, 2), rec(3000, 3)])).toEqual({ ms: 2000, from: 'history' });
    expect(EST_DEFAULT_MS).toBeGreaterThan(20 * 60_000);
    expect(EST_DEFAULT_MS).toBeLessThan(60 * 60_000);
    const store = memoryStore();
    [rec(600_000, 1), rec(1_200_000, 2), rec(1_800_000, 3)].forEach((r) => store.save(r));
    const core = makeRoom(store);
    core.connect('a', randomHex(16), 1);
    expect(view(core, 'a').clock).toMatchObject({ expectedMs: 1_200_000, expectedFrom: 'history', elapsedMs: 0, startedAt: null });
  });
  it('scoreboard totals per team (pair of names) and per player', () => {
    const g = (w: 'A' | 'B', A: string[], B: string[], i: number): GameRecord => ({
      id: 'g' + i, startedAt: i, endedAt: i, durationMs: 1, turns: 1, teams: { A, B }, winner: w, order: [], marginMs: 0, marginTurns: 0,
    });
    const b = buildScoreboard([g('A', ['x', 'y'], ['z', 'w'], 3), g('B', ['z', 'x'], ['y', 'w'], 2), g('A', ['y', 'x'], ['w', 'z'], 1)]);
    expect(b.teams[0]).toEqual({ names: ['x', 'y'], wins: 2, games: 2 });
    expect(b.players.find((p) => p.names[0] === 'x')).toEqual({ names: ['x'], wins: 2, games: 3 });
    expect(b.players.find((p) => p.names[0] === 'w')).toEqual({ names: ['w'], wins: 1, games: 3 });
    expect(b.total).toBe(3);
  });
  it('clock excludes time paused by an open seat', () => {
    const core = readyTable();
    send(core, 'k0', { t: 'start' }, 2000);
    core.disconnect('k2', 3000);
    core.alarm(3000 + 60_000); // seat opens, game pauses at 63000
    expect(view(core, 'k0', 70_000).clock).toMatchObject({ paused: true, elapsedMs: 61_000 });
    core.connect('sp', randomHex(16), 80_000);
    send(core, 'sp', { t: 'name', name: 'SP' }, 80_000);
    send(core, 'sp', { t: 'sit', seat: 2 }, 80_000);
    expect(view(core, 'k0', 90_000).clock).toMatchObject({ paused: false, elapsedMs: 61_000 + 10_000 });
  });
});

describe('seat swap between games', () => {
  it('a spectator and a player exchange places in the lobby by mutual consent; never mid-game', () => {
    const core = readyTable();
    for (let i = 4; i < 8; i++) { core.connect('k' + i, randomHex(16), 1000); send(core, 'k' + i, { t: 'name', name: 'P' + i }); }
    expect(errOf(send(core, 'k4', { t: 'stand' }))).toBeUndefined(); // spectator: no-op
    expect(errOf(send(core, 'k1', { t: 'stand' }))?.code).toBe('full'); // 4 spectators already
    send(core, 'k4', { t: 'swapReq', to: idOf(core, 'k1') });
    expect(notices(send(core, 'k1', { t: 'swapAnswer', from: idOf(core, 'k4'), accept: true }), 'k4')).toContain('swapped');
    const v = view(core, 'k0');
    expect(v.seats[1]!.id).toBe(idOf(core, 'k4'));
    expect(v.spectators.map((x) => x.id)).toContain(idOf(core, 'k1'));
    expect(v.seats[1]!.paired).toBe(false); // newcomer must re-partner
    pair(core, 'k4', 'k3');
    send(core, 'k0', { t: 'start' });
    expect(errOf(send(core, 'k5', { t: 'swapReq', to: idOf(core, 'k0') }))?.code).toBe('not_lobby');
    expect(errOf(send(core, 'k0', { t: 'partnerBreak' }))?.code).toBe('not_lobby');
  });
});

describe('music: anyone controls, last action wins, never touches the game', () => {
  it('spectators can skip, stop, pause, play; stale skips ignored; per-person rate limit', () => {
    const core = readyTable();
    send(core, 'k0', { t: 'start' }, 2000);
    core.connect('sp', randomHex(16), 2000);
    const turn = core.s.game!.turn;
    const hands = JSON.stringify(core.s.game!.hands);
    for (let i = 0; i < 3; i++) send(core, 'k1', { t: 'qAdd', videoId: 'dQw4w9WgXcQ' }, 3000);
    const first = core.s.playing!.itemId;
    send(core, 'sp', { t: 'qPause', paused: true }, 4000);
    expect(view(core, 'k0', 4000).nowPlaying).toMatchObject({ paused: true, pausedAt: 4000 });
    send(core, 'k2', { t: 'qPause', paused: false }, 6000);
    expect(core.s.playing!.startedAt).toBe(3000 + 2000);
    expect(view(core, 'k0', 6000).musicLast).toMatchObject({ act: 'resume', by: 'P2' });
    send(core, 'sp', { t: 'qSkip', itemId: first }, 7000);
    const second = core.s.playing!.itemId;
    expect(second).not.toBe(first);
    expect(send(core, 'k3', { t: 'qSkip', itemId: first }, 7001)).toEqual([]); // aimed at an already-skipped track
    expect(core.s.playing!.itemId).toBe(second);
    const third = core.s.queue[1]!.id;
    send(core, 'sp', { t: 'qPlay', id: third }, 8000);
    expect(core.s.playing!.itemId).toBe(third);
    send(core, 'k0', { t: 'qStop' }, 9000);
    expect(core.s.playing).toBeNull();
    expect(view(core, 'k1', 9000).musicLast).toMatchObject({ act: 'stop', by: 'P0' });
    // the game was never touched
    expect(core.s.game!.turn).toBe(turn);
    expect(JSON.stringify(core.s.game!.hands)).toBe(hands);
    // rate limit: per person, others unaffected
    let limited = false;
    for (let i = 0; i < MUSIC_ACTS_PER_10S * 3; i++) {
      if (errOf(send(core, 'sp', { t: 'qPause', paused: i % 2 === 0 }, 20_000))?.code === 'rate') limited = true;
      if (!core.s.playing) send(core, 'k3', { t: 'qAdd', videoId: 'dQw4w9WgXcQ' }, 20_000);
    }
    expect(limited).toBe(true);
    expect(errOf(send(core, 'k2', { t: 'qSkip' }, 20_000))).toBeUndefined();
  });
});

describe('hidden hands per seat (round 2 views)', () => {
  it('each seat view only carries its own card faces, before and after the first team finishes', () => {
    const core = readyTable(undefined, 9);
    core.connect('sp', randomHex(16), 1500);
    send(core, 'k0', { t: 'start' }, 2000);
    const check = () => {
      const g = core.s.game!;
      for (let viewer = 0; viewer < 4; viewer++) {
        const key = 'k' + viewer;
        const seat = view(core, key).you.seat!;
        const json = JSON.stringify(view(core, key));
        for (let s = 0; s < 4; s++) for (const c of g.hands[s]!) {
          if (s === seat) expect(json).toContain(`"id":"${c.id}"`); else expect(json).not.toContain(`"id":"${c.id}"`);
        }
        for (const c of g.deck) expect(json).not.toContain(`"id":"${c.id}"`);
      }
      const sj = JSON.stringify(view(core, 'sp'));
      for (const h of g.hands) for (const c of h) expect(sj).not.toContain(`"id":"${c.id}"`);
    };
    check();
    // advance until the first team is done, then check again
    for (let i = 0; i < 5000 && core.s.game!.done.length === 0; i++) {
      const g = core.s.game!;
      const key = 'k' + g.turn;
      const hint = msgs(send(core, key, { t: 'hint' }, 3000 + i * 3000))[0]!.msg as { t: 'hint'; plays: { cardId: string; moves: never[] }[] };
      const good = hint.plays.filter((p) => (p.moves[0] as unknown as { k: string } | undefined)?.k !== 'discard');
      const p = (good.length ? good : hint.plays)[0]!;
      send(core, key, { t: 'play', cardId: p.cardId, moves: p.moves }, 3000 + i * 3000);
    }
    expect(core.s.game!.done).toHaveLength(1);
    check();
    const done = core.s.game!.done[0]!;
    const v = view(core, 'k0', 9_000_000);
    expect(v.seats.filter((x) => x.teamDone).every((x) => x.team === done && x.cards === 0)).toBe(true);
    expect(v.finishes).toHaveLength(1);
    expect(v.phase).toBe('playing');
  }, 60_000);
});
