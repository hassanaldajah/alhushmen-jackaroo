import { describe, expect, it } from 'vitest';
import { randomHex } from '../../src/worker/auth';
import { RoomCore, emptyRoom, memoryStore, type Out } from '../../src/worker/core';
import { cleanChat, parseClientMsg } from '../../src/worker/validate';
import { genericTurn, iceServers, STUN, TURNIX_URL, type TurnixCache } from '../../src/worker/ice';
import { csp } from '../../src/worker/headers';
import { seededRng } from '../../src/engine/rng';
import { CHAT_HISTORY, CHAT_MAX_LEN, CHAT_PER_WINDOW, type ClientMsg, type ServerMsg } from '../../src/shared/protocol';

function room() {
  let n = 0;
  return new RoomCore(emptyRoom(), { rng: seededRng(1), newId: () => (++n).toString(16).padStart(10, '0'), videoMeta: () => null, store: memoryStore() });
}
type Msg = { to: string; msg: ServerMsg };
const msgs = (o: Out[]) => o.filter((x): x is Msg => 'to' in x);
const send = (c: RoomCore, k: string, m: ClientMsg, now = 1000) => c.message(k, m, now);

describe('text chat', () => {
  it('cleans text: control/bidi/zero-width removed, ZWJ emoji kept, length capped', () => {
    expect(cleanChat('hi‮ there​\n\nyo\u0000')).toBe('hi there yo');
    expect(cleanChat('👨‍👩‍👧')).toBe('👨‍👩‍👧');
    expect(cleanChat('<b>x</b>')).toBe('<b>x</b>'); // plain text; client uses textContent
    expect(cleanChat('a'.repeat(CHAT_MAX_LEN))).toHaveLength(CHAT_MAX_LEN);
    expect(cleanChat('a'.repeat(CHAT_MAX_LEN + 1))).toBeNull();
    expect(cleanChat(' ​ ')).toBeNull();
    expect(parseClientMsg('{"t":"chat","text":"hi","html":"<b>"}')).toBeNull();
    expect(parseClientMsg('{"t":"chat","text":5}')).toBeNull();
    expect(parseClientMsg('{"t":"chat","text":"hi"}')).toEqual({ t: 'chat', text: 'hi' });
  });
  it('relays to everyone with server-set sender, keeps last 50 in memory, rate-limits, no views/state change', () => {
    const c = room();
    c.connect('a', randomHex(16), 1); c.connect('b', randomHex(16), 1);
    expect(msgs(send(c, 'a', { t: 'chat', text: 'x' }))[0]!.msg).toMatchObject({ t: 'error', code: 'not_named' });
    send(c, 'a', { t: 'name', name: 'Ali' }); send(c, 'b', { t: 'name', name: 'Bo' });
    const before = JSON.stringify(c.s);
    const out = send(c, 'a', { t: 'chat', text: 'مرحبا' }, 2000);
    expect(out.map((o) => (o as Msg).to).sort()).toEqual(['a', 'b']);
    expect(out.every((o) => (o as Msg).msg.t === 'chat')).toBe(true);
    expect((out[0] as Msg).msg).toMatchObject({ t: 'chat', msg: { name: 'Ali', text: 'مرحبا', at: 2000 } });
    expect(JSON.stringify(c.s)).toBe(before); // never persisted, never touches room state
    let limited = false;
    for (let i = 0; i < CHAT_PER_WINDOW + 1; i++) if (msgs(send(c, 'a', { t: 'chat', text: 'm' + i }, 2001))[0]!.msg.t === 'error') limited = true;
    expect(limited).toBe(true);
    expect(msgs(send(c, 'b', { t: 'chat', text: 'still ok' }, 2001))[0]!.msg.t).toBe('chat');
    for (let i = 0; i < 60; i++) send(c, 'b', { t: 'chat', text: 'n' + i }, 10_000 + i * 2000);
    const hist = msgs(c.connect('z', randomHex(16), 999_999)).find((o) => o.to === 'z' && o.msg.t === 'chatHistory')!.msg as { msgs: { text: string }[] };
    expect(hist.msgs).toHaveLength(CHAT_HISTORY);
    expect(hist.msgs.at(-1)!.text).toBe('n59');
  });
});

describe('ICE / TURN config', () => {
  const pw = randomHex(12);
  it('STUN only when nothing is configured', async () => {
    expect(await iceServers({}, (() => { throw new Error('no fetch'); }) as unknown as typeof fetch)).toEqual({ iceServers: [STUN], turn: false });
  });
  it('generic TURN needs urls + username + credential; bad urls dropped', async () => {
    expect(genericTurn({ TURN_URLS: 'turn:t.example:3478', TURN_USERNAME: 'u' })).toBeNull();
    expect(genericTurn({ TURN_URLS: 'http://evil, javascript:x', TURN_USERNAME: 'u', TURN_CREDENTIAL: pw })).toBeNull();
    const g = genericTurn({ TURN_URLS: ' turn:t.example:3478?transport=udp , turns:t.example:443?transport=tcp,bad url ', TURN_USERNAME: 'u', TURN_CREDENTIAL: pw });
    expect(g).toEqual({ urls: ['turn:t.example:3478?transport=udp', 'turns:t.example:443?transport=tcp'], username: 'u', credential: pw });
    const r = await iceServers({ TURN_URLS: 'turn:t.example:3478', TURN_USERNAME: 'u', TURN_CREDENTIAL: pw });
    expect(r.turn).toBe(true);
    expect(r.iceServers[0]).toEqual(STUN);
  });
  it('CSP is not derived from the Host header', () => {
    expect(csp('evil.example\r\nX: y')).not.toContain('evil');
  });
  describe('Turnix', () => {
    const token = randomHex(20);
    const tx = (status = 200) => {
      const calls: { url: string; init: RequestInit }[] = [];
      const f = (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (status !== 200) return new Response(JSON.stringify({ error: 'Usage limit exceeded' }), { status });
        return new Response(JSON.stringify({
          iceServers: [
            { urls: ['stun:stun.turnix.io:3478'] },
            { username: 'u-1', credential: 'c-1', urls: ['turn:eu.turnix.io:3478?transport=udp', 'turns:eu.turnix.io:443?transport=tcp', 'http://bad'] },
          ],
          expiresAt: new Date(10_000_000).toISOString(),
        }), { status: 200 });
      }) as unknown as typeof fetch;
      return { f, calls };
    };
    it('fetches short-lived credentials server-side with the Bearer token, returns only iceServers', async () => {
      const { f, calls } = tx();
      const r = await iceServers({ TURNIX_API_TOKEN: token }, f, 1000, { v: null });
      expect(calls[0]!.url).toBe(TURNIX_URL);
      expect(calls[0]!.init.method).toBe('POST');
      expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer ' + token);
      expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ ttl: 3600 });
      expect(r.turn).toBe(true);
      expect(r.iceServers[1]).toEqual({ username: 'u-1', credential: 'c-1', urls: ['turn:eu.turnix.io:3478?transport=udp', 'turns:eu.turnix.io:443?transport=tcp'] });
      expect(JSON.stringify(r)).not.toContain(token);
      expect(Object.keys(r).sort()).toEqual(['iceServers', 'turn']);
    });
    it('caches for a few minutes, then refetches', async () => {
      const { f, calls } = tx();
      const cache: { v: TurnixCache | null } = { v: null };
      await iceServers({ TURNIX_API_TOKEN: token }, f, 1000, cache);
      await iceServers({ TURNIX_API_TOKEN: token }, f, 1000 + 60_000, cache);
      expect(calls).toHaveLength(1);
      await iceServers({ TURNIX_API_TOKEN: token }, f, 1000 + 6 * 60_000, cache);
      expect(calls).toHaveLength(2);
    });
    it('falls back to STUN only on 429 / network error / unset token', async () => {
      expect(await iceServers({ TURNIX_API_TOKEN: token }, tx(429).f, 1000)).toEqual({ iceServers: [STUN], turn: false });
      const boom = (async () => { throw new Error('net'); }) as unknown as typeof fetch;
      expect(await iceServers({ TURNIX_API_TOKEN: token }, boom, 1000)).toEqual({ iceServers: [STUN], turn: false });
      const { f, calls } = tx();
      expect(await iceServers({}, f, 1000)).toEqual({ iceServers: [STUN], turn: false });
      expect(calls).toHaveLength(0);
    });
  });
});
