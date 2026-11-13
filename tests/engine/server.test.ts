import { describe, expect, it } from 'vitest';
import {
  constantTimeEqual, normalizePhrase, phraseMatches, recordFailure, signSession, verifySession, waitSeconds,
  readCookie, randomHex, RL_FREE_FAILS,
} from '../../src/worker/auth';
import { RoomCore, emptyRoom, SEAT_HOLD_MS, type Out } from '../../src/worker/core';
import { parseClientMsg, cleanName } from '../../src/worker/validate';
import { parseSearch, normalizeQuery, decodeEntities } from '../../src/worker/youtube';
import { seededRng } from '../../src/engine/rng';
import { CLOSE_FULL, CLOSE_KICKED, type ClientMsg, type RoomView, type ServerMsg } from '../../src/shared/protocol';

// Random per-run test secrets, never a real phrase.
const SECRET = randomHex(32);
const PHRASE_BASE = 'كلمة' + randomHex(4);

describe('passphrase normalization and compare', () => {
  it('strips tashkeel, tatweel and invisible chars, applies NFKC', () => {
    expect(normalizePhrase('  م\u064Eر\u0652ح\u064Eب\u064Bا  ')).toBe('مرحبا');
    expect(normalizePhrase('م\u0640\u0640\u0640رحبا')).toBe('مرحبا');
    expect(normalizePhrase('مر\u200Bحبا')).toBe('مرحبا');
    expect(normalizePhrase('ﻣﺮﺣﺒﺎ')).toBe('مرحبا'); // presentation forms -> NFKC
    expect(normalizePhrase('a   b')).toBe('a b');
  });
  it('accepts a phrase differing only in diacritics, rejects others', async () => {
    const withMarks = Array.from(PHRASE_BASE).map((ch, i) => (i === 1 ? ch + '\u064E' : ch)).join('') + '\u0640';
    expect(await phraseMatches(withMarks, PHRASE_BASE, SECRET)).toBe(true);
    expect(await phraseMatches(PHRASE_BASE + 'x', PHRASE_BASE, SECRET)).toBe(false);
    expect(await phraseMatches('', PHRASE_BASE, SECRET)).toBe(false);
    expect(await phraseMatches('', '', SECRET)).toBe(false); // unset phrase never matches
  });
  it('constant-time compare handles length mismatch', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});

describe('session cookie', () => {
  it('signs and verifies, rejects tamper and expiry', async () => {
    const now = Date.now();
    const sid = randomHex(16);
    const tok = await signSession({ sid, exp: Math.floor(now / 1000) + 60 }, SECRET);
    expect((await verifySession(tok, SECRET, now))?.sid).toBe(sid);
    expect(await verifySession(tok, randomHex(32), now)).toBeNull();
    expect(await verifySession(tok.slice(0, -2) + 'AA', SECRET, now)).toBeNull();
    expect(await verifySession(tok, SECRET, now + 61_000)).toBeNull();
    expect(readCookie(`a=1; __Host-jk=${tok}`, '__Host-jk')).toBe(tok);
  });
});

describe('auth rate limit policy', () => {
  it('gives a few free tries, then exponential backoff', () => {
    let rec = null as ReturnType<typeof recordFailure> | null;
    const now = 1_000_000;
    for (let i = 0; i < RL_FREE_FAILS; i++) { rec = recordFailure(rec, now); expect(waitSeconds(rec, now)).toBe(0); }
    rec = recordFailure(rec, now);
    expect(waitSeconds(rec, now)).toBe(5);
    rec = recordFailure(rec, now);
    expect(waitSeconds(rec, now)).toBe(10);
    for (let i = 0; i < 20; i++) rec = recordFailure(rec, now);
    expect(waitSeconds(rec, now)).toBe(900);
  });
});

describe('message validation', () => {
  it('accepts well-formed messages and rejects junk', () => {
    expect(parseClientMsg('{"t":"play","cardId":"10H","moves":[{"k":"burn"}]}')).toEqual({ t: 'play', cardId: '10H', moves: [{ k: 'burn' }] });
    expect(parseClientMsg('{"t":"play","cardId":"10H","moves":[{"k":"burn","x":1}]}')).toBeNull();
    expect(parseClientMsg('{"t":"play","cardId":"1H","moves":[{"k":"burn"}]}')).toBeNull();
    expect(parseClientMsg('{"t":"play","cardId":"7H","moves":[{"k":"step","marble":0,"n":3},{"k":"step","marble":1,"n":4},{"k":"burn"}]}')).toBeNull();
    expect(parseClientMsg('{"t":"sit","seat":4}')).toBeNull();
    expect(parseClientMsg('{"t":"qAdd","videoId":"dQw4w9WgXcQ"}')).toEqual({ t: 'qAdd', videoId: 'dQw4w9WgXcQ' });
    expect(parseClientMsg('{"t":"qAdd","videoId":"bad id"}')).toBeNull();
    expect(parseClientMsg('x'.repeat(20000))).toBeNull();
    expect(parseClientMsg('{"t":"nope"}')).toBeNull();
    expect(parseClientMsg('{"t":"signal","to":"abcdef0123","data":{"d":{"type":"offer","sdp":"v=0"},"x":1}}')).toBeNull();
    expect(parseClientMsg('{"t":"signal","to":"abcdef0123","data":{"c":{"candidate":"a","sdpMid":"0","sdpMLineIndex":0}}}')).not.toBeNull();
  });
  it('cleans names (bidi overrides, length)', () => {
    expect(cleanName(' أبو\u202Eعلي ')).toBe('أبوعلي');
    expect(cleanName('')).toBeNull();
    expect(cleanName('x'.repeat(17))).toBeNull();
  });
});

describe('youtube parsing', () => {
  it('returns only videoId/title/thumb with safe values', () => {
    const r = parseSearch({
      items: [
        { id: { videoId: 'dQw4w9WgXcQ' }, snippet: { title: 'Tom &amp; Jerry &#39;x&#39;', thumbnails: { medium: { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg' } }, channelTitle: 'c' } },
        { id: { videoId: 'bad' }, snippet: { title: 'x' } },
        { id: { videoId: 'abcdefghijk' }, snippet: { title: '<b>', thumbnails: { medium: { url: 'javascript:alert(1)' } } } },
      ],
    });
    expect(r).toEqual([
      { videoId: 'dQw4w9WgXcQ', title: "Tom & Jerry 'x'", thumb: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg' },
      { videoId: 'abcdefghijk', title: '<b>', thumb: 'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg' },
    ]);
    expect(normalizeQuery('x'.repeat(81))).toBeNull();
    expect(normalizeQuery('  Fairuz  ')).toBe('fairuz');
    expect(decodeEntities('&#x41;&lt;')).toBe('A<');
  });
});

// ---------------------------------------------------------------- room core

function makeRoom() {
  let n = 0;
  const meta = new Map<string, { title: string; thumb: string }>([['dQw4w9WgXcQ', { title: 'song', thumb: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg' }]]);
  const core = new RoomCore(emptyRoom(), {
    rng: seededRng(3),
    newId: () => (++n).toString(16).padStart(10, '0'),
    videoMeta: (id) => meta.get(id) ?? null,
  });
  return core;
}
const views = (outs: Out[]) => outs.filter((o): o is { to: string; msg: ServerMsg } => 'to' in o && o.msg.t === 'view');
const lastView = (outs: Out[], key: string): RoomView => {
  const v = views(outs).filter((o) => o.to === key).at(-1);
  if (!v || v.msg.t !== 'view') throw new Error('no view for ' + key);
  return v.msg.view;
};
const send = (core: RoomCore, key: string, m: ClientMsg, now = 1000) => core.message(key, m, now);

const idOf = (core: RoomCore, key: string) => core.viewFor(core.conns.get(key)!, 1000).you.id;
function pair(core: RoomCore, a: string, b: string, now = 1000) {
  send(core, a, { t: 'partnerReq', to: idOf(core, b) }, now);
  return send(core, b, { t: 'partnerAnswer', from: idOf(core, a), accept: true }, now);
}

function fullTable() {
  const core = makeRoom();
  const sids = [0, 1, 2, 3].map(() => randomHex(16));
  sids.forEach((sid, i) => core.connect('k' + i, sid, 1000));
  sids.forEach((_, i) => { send(core, 'k' + i, { t: 'name', name: 'P' + i }); send(core, 'k' + i, { t: 'sit', seat: i }); });
  send(core, 'k0', { t: 'hostClaim' });
  pair(core, 'k0', 'k2');
  pair(core, 'k1', 'k3');
  const out = send(core, 'k0', { t: 'start' });
  return { core, sids, out };
}

describe('room: seats, spectators, capacity', () => {
  it('host is claimed (first wins); only host can start; needs 2 complete teams', () => {
    const core = makeRoom();
    core.connect('a', randomHex(16), 1);
    core.connect('b', randomHex(16), 1);
    send(core, 'a', { t: 'name', name: 'A' });
    send(core, 'b', { t: 'name', name: 'B' });
    send(core, 'a', { t: 'sit', seat: 0 });
    send(core, 'b', { t: 'sit', seat: 1 });
    send(core, 'a', { t: 'hostClaim' });
    expect(send(core, 'b', { t: 'start' })[0]).toMatchObject({ msg: { t: 'error', code: 'not_host' } });
    expect(send(core, 'a', { t: 'start' })[0]).toMatchObject({ msg: { t: 'error', code: 'teams_incomplete' } });
    expect(send(core, 'b', { t: 'sit', seat: 0 })[0]).toMatchObject({ msg: { t: 'error', code: 'seat_taken' } });
  });
  it('caps at 4 seats + 4 spectators', () => {
    const { core } = fullTable();
    for (let i = 0; i < 4; i++) expect(core.connect('s' + i, randomHex(16), 2).some((o) => 'close' in o)).toBe(false);
    const r = core.connect('s9', randomHex(16), 2);
    expect(r).toContainEqual({ close: 's9', code: CLOSE_FULL, reason: 'full' });
  });
  it('a reconnecting player gets the seat and hand back', () => {
    const { core, sids } = fullTable();
    expect(send(core, 'k1', { t: 'name', name: 'لاعب' })[0]).toMatchObject({ msg: { code: 'not_lobby' } }); // no rename mid-game
    const before = core.viewFor(core.conns.get('k1')!, 1500).hand;
    core.disconnect('k1', 2000);
    const v = lastView(core.connect('k1b', sids[1]!, 3000), 'k1b');
    expect(v.you.seat).toBe(1);
    expect(v.hand).toEqual(before);
  });
  it('a seat left for 60 s opens and pauses the game; a spectator may take it', () => {
    const { core } = fullTable();
    core.disconnect('k2', 2000);
    expect(core.nextAlarm()).toBe(2000 + SEAT_HOLD_MS);
    const out = core.alarm(2000 + SEAT_HOLD_MS);
    const v = lastView(out, 'k0');
    expect(v.seats[2]!.open).toBe(true);
    expect(v.game!.paused).toBe(true);
    core.connect('sp', randomHex(16), 70_000);
    send(core, 'sp', { t: 'name', name: 'SP' }, 70_000);
    const v2 = lastView(send(core, 'sp', { t: 'sit', seat: 2 }, 70_001), 'sp');
    expect(v2.you.seat).toBe(2);
    expect(v2.game!.paused).toBe(false);
    expect(v2.hand).toHaveLength(4);
  });
  it('host can kick; kicked session is refused', () => {
    const core = makeRoom();
    const sb = randomHex(16);
    core.connect('a', randomHex(16), 1);
    core.connect('b', sb, 1);
    send(core, 'a', { t: 'name', name: 'A' });
    send(core, 'b', { t: 'name', name: 'B' });
    send(core, 'a', { t: 'hostClaim' });
    send(core, 'a', { t: 'sit', seat: 0 });
    const bid = lastView(send(core, 'b', { t: 'sit', seat: 1 }), 'b').you.id;
    expect(send(core, 'a', { t: 'kick', id: bid })).toContainEqual({ close: 'b', code: CLOSE_KICKED, reason: 'kicked' });
    expect(core.connect('b2', sb, 2)).toContainEqual({ close: 'b2', code: CLOSE_KICKED, reason: 'kicked' });
  });
});

describe('room: play flow and hidden hands (full view leak test)', () => {
  it('each socket sees only its own hand; spectators see none', () => {
    const { core, out } = fullTable();
    core.connect('spec', randomHex(16), 1500);
    const g = core.s.game!;
    const vs = [0, 1, 2, 3].map((i) => lastView(out, 'k' + i));
    const spec = lastView(core.connect('spec2', randomHex(16), 1500), 'spec');
    for (let viewer = 0; viewer < 4; viewer++) {
      const json = JSON.stringify(vs[viewer]);
      for (let seat = 0; seat < 4; seat++) {
        for (const c of g.hands[seat]!) {
          if (seat === viewer) expect(json).toContain(`"id":"${c.id}"`);
          else expect(json).not.toContain(`"id":"${c.id}"`);
        }
      }
      for (const c of g.deck) expect(json).not.toContain(`"id":"${c.id}"`);
      expect(vs[viewer]!.seats.map((s) => s.cards)).toEqual([4, 4, 4, 4]);
    }
    const sj = JSON.stringify(spec);
    for (const h of g.hands) for (const c of h) expect(sj).not.toContain(`"id":"${c.id}"`);
    expect(spec.hand).toEqual([]);
    // session ids never leak
    for (const v of [...vs, spec]) for (const sid of Object.keys(core.s.people)) expect(JSON.stringify(v)).not.toContain(sid);
  });
  it('rejects plays out of turn and by spectators; accepts a legal play; hint only for the mover', () => {
    const { core } = fullTable();
    core.connect('spec', randomHex(16), 1500);
    const g = core.s.game!;
    const turn = g.turn;
    const other = (turn + 1) % 4;
    const oc = g.hands[other]![0]!;
    expect(send(core, 'k' + other, { t: 'play', cardId: oc.id, moves: [{ k: 'discard' }] })[0]).toMatchObject({ msg: { code: 'not_turn' } });
    expect(send(core, 'spec', { t: 'play', cardId: oc.id, moves: [{ k: 'discard' }] })[0]).toMatchObject({ msg: { code: 'not_player' } });
    expect(send(core, 'spec', { t: 'hint' })[0]).toMatchObject({ msg: { t: 'hint', plays: [] } });
    const hint = send(core, 'k' + turn, { t: 'hint' })[0] as unknown as { msg: { t: 'hint'; plays: { cardId: string; moves: never[] }[] } };
    expect(hint.msg.plays.length).toBeGreaterThan(0);
    const p = hint.msg.plays[0]!;
    const res = send(core, 'k' + turn, { t: 'play', cardId: p.cardId, moves: p.moves });
    expect(res.some((o) => 'to' in o && o.msg.t === 'event')).toBe(true);
    expect(g.turn).not.toBe(turn);
    // events never carry hidden cards except the public played/burned card
    for (const o of res) if ('to' in o && o.msg.t === 'event') for (const e of o.msg.events) if (e.card) expect(g.discard.map((c) => c.id)).toContain(e.card.id);
  });
});

describe('room: music queue and signalling', () => {
  it('queue add uses server metadata, caps, skip rules', () => {
    const { core } = fullTable();
    core.connect('spec', randomHex(16), 1500);
    const v = lastView(send(core, 'spec', { t: 'qAdd', videoId: 'dQw4w9WgXcQ', title: '<script>', thumb: 'x' }), 'spec');
    expect(v.queue[0]).toMatchObject({ videoId: 'dQw4w9WgXcQ', title: 'song' });
    expect(v.nowPlaying?.itemId).toBe(v.queue[0]!.id);
    expect(send(core, 'spec', { t: 'qAdd', videoId: 'aaaaaaaaaaa' })[0]).toMatchObject({ msg: { code: 'unknown_video' } });
    for (let i = 0; i < 4; i++) send(core, 'spec', { t: 'qAdd', videoId: 'dQw4w9WgXcQ' }, 20_000);
    expect(send(core, 'spec', { t: 'qAdd', videoId: 'dQw4w9WgXcQ' }, 20_000)[0]).toMatchObject({ msg: { code: 'queue_full' } });
    const v2 = lastView(send(core, 'k1', { t: 'qSkip' }), 'k1');
    expect(v2.queue).toHaveLength(4);
  });
  it('relays signals only to the addressed peer, tagged with sender id', () => {
    const { core, out } = fullTable();
    const id1 = lastView(out, 'k1').you.id;
    const id0 = lastView(out, 'k0').you.id;
    const r = send(core, 'k0', { t: 'signal', to: id1, data: { d: { type: 'offer', sdp: 'v=0' } } });
    expect(r).toEqual([{ to: 'k1', msg: { t: 'signal', from: id0, data: { d: { type: 'offer', sdp: 'v=0' } } } }]);
  });
  it('rate-limits floods', () => {
    const { core } = fullTable();
    let limited = false;
    for (let i = 0; i < 200; i++) if ((send(core, 'k0', { t: 'ping' }, 5000)[0] as { msg?: { t: string } } | undefined)?.msg?.t === 'error') limited = true;
    expect(limited).toBe(true);
  });
});
