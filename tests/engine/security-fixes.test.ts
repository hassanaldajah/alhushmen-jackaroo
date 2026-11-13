import { describe, expect, it } from 'vitest';
import {
  COOKIE_NAME, RL_GLOBAL_MAX_FAILS, RL_GLOBAL_MAX_GAP_S, globalWait, ipBucket, randomHex, readCapped, sessionCookie,
  signSession, verifySession,
} from '../../src/worker/auth';
import { csp, insecureDev, withSecurityHeaders, wssOrigins } from '../../src/worker/headers';
import { BAD_PER_10S, KICK_BAN_MS, RoomCore, emptyRoom, memoryStore, type Out } from '../../src/worker/core';
import { seededRng } from '../../src/engine/rng';
import { CLOSE_ABUSE, CLOSE_KICKED, MAX_MSG_BYTES, type ClientMsg, type ServerMsg } from '../../src/shared/protocol';
import { frameTooBig, parseClientMsg } from '../../src/worker/validate';

describe('production stays strict without DEV_INSECURE', () => {
  it('cookie is __Host-jk with Secure; CSP upgrades and HSTS is set', () => {
    const c = sessionCookie('tok');
    expect(c.startsWith(COOKIE_NAME + '=')).toBe(true);
    expect(COOKIE_NAME).toBe('__Host-jk');
    expect(c).toMatch(/; Secure;/);
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Strict/);
    expect(c).toMatch(/Path=\//);
    const h = withSecurityHeaders(new Response('x'), 'alhushmen.alhasan.dev').headers;
    expect(h.get('Content-Security-Policy')).toContain('upgrade-insecure-requests');
    expect(h.get('Strict-Transport-Security')).toContain('max-age=');
    expect(h.get('Referrer-Policy')).toBe('no-referrer');
  });
  it('insecure dev mode only with DEV_INSECURE=1 on plain http', () => {
    expect(insecureDev({}, new URL('http://192.168.1.5:8787/'))).toBe(false);
    expect(insecureDev({ DEV_INSECURE: '0' }, new URL('http://192.168.1.5:8787/'))).toBe(false);
    expect(insecureDev({ DEV_INSECURE: '1' }, new URL('https://alhushmen.alhasan.dev/'))).toBe(false);
    expect(insecureDev({ DEV_INSECURE: '1' }, new URL('http://192.168.1.5:8787/'))).toBe(true);
  });
  it('CSP wss origins come only from the allowlist config', () => {
    expect(wssOrigins({ ALLOWED_ORIGINS: 'https://alhushmen.alhasan.dev, http://localhost:5173, https://bad/x' })).toEqual(['wss://alhushmen.alhasan.dev']);
    expect(csp('evil', true, ['wss://alhushmen.alhasan.dev'])).toContain("connect-src 'self' wss://alhushmen.alhasan.dev");
  });
});

describe('login gate (M3, L6)', () => {
  it('IPv6 is bucketed by /64; IPv4 unchanged', () => {
    expect(ipBucket('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(ipBucket('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(ipBucket('2001:db8::5')).toBe('2001:db8:0:0::/64');
    expect(ipBucket('203.0.113.9')).toBe('203.0.113.9');
  });
  it('global gate slows down past the cap, never a long lockout; known browsers bypass', () => {
    const now = 1_000_000;
    expect(globalWait({ start: now - 1000, fails: RL_GLOBAL_MAX_FAILS - 1, last: now }, now, false)).toBe(0);
    expect(globalWait({ start: now - 1000, fails: RL_GLOBAL_MAX_FAILS, last: now }, now, false)).toBe(1);
    expect(globalWait({ start: now - 1000, fails: RL_GLOBAL_MAX_FAILS + 10_000, last: now }, now, false)).toBe(RL_GLOBAL_MAX_GAP_S);
    expect(globalWait({ start: now - 1000, fails: RL_GLOBAL_MAX_FAILS + 10_000, last: now - RL_GLOBAL_MAX_GAP_S * 1000 }, now, false)).toBe(0);
    expect(globalWait({ start: now - 1000, fails: RL_GLOBAL_MAX_FAILS + 10_000, last: now }, now, true)).toBe(0);
  });
  it('expired but signed sessions count as known only within the grace', async () => {
    const secret = randomHex(32);
    const tok = await signSession({ sid: randomHex(16), exp: 1000 }, secret);
    expect(await verifySession(tok, secret, 2_000_000)).toBeNull();
    expect(await verifySession(tok, secret, 2_000_000, 10_000_000)).not.toBeNull();
    expect(await verifySession(tok, randomHex(32), 2_000_000, 10_000_000)).toBeNull();
  });
  it('body cap holds for chunked bodies', async () => {
    const big = new ReadableStream({ start(c) { for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(400)); c.close(); } });
    expect(await readCapped(new Request('https://x/', { method: 'POST', body: big, duplex: 'half' } as RequestInit), 1024)).toBeNull();
    expect(await readCapped(new Request('https://x/', { method: 'POST', body: '{"phrase":"x"}' }), 1024)).toBe('{"phrase":"x"}');
  });
});

describe('kick ban by display name (M4)', () => {
  const room = () => {
    let n = 0;
    return new RoomCore(emptyRoom(), { rng: seededRng(2), newId: () => (++n).toString(16).padStart(10, '0'), videoMeta: () => null, store: memoryStore() });
  };
  const send = (c: RoomCore, k: string, m: ClientMsg, now = 1000) => c.message(k, m, now);
  const err = (o: Out[]) => (o.find((x) => 'to' in x && x.msg.t === 'error') as { msg: ServerMsg & { code: string } } | undefined)?.msg.code;
  it('a kicked player cannot reuse the name for 30 min (any network); others in the same house are fine', () => {
    const c = room();
    c.connect('h', randomHex(16), 1000);
    send(c, 'h', { t: 'name', name: 'Host' });
    send(c, 'h', { t: 'hostClaim' });
    c.connect('x', randomHex(16), 1000);
    send(c, 'x', { t: 'name', name: 'Troll' });
    const xid = c.viewFor(c.conns.get('x')!, 1000).you.id;
    expect(send(c, 'h', { t: 'kick', id: xid })).toContainEqual({ close: 'x', code: CLOSE_KICKED, reason: 'kicked' });
    c.connect('x2', randomHex(16), 2000); // new login = new sid
    expect(err(send(c, 'x2', { t: 'name', name: 'troll' }, 2000))).toBe('banned');
    expect(err(send(c, 'x2', { t: 'name', name: 'TROLL' }, 2000))).toBe('banned');
    send(c, 'x2', { t: 'name', name: 'Sibling' }, 2000);
    expect(err(send(c, 'x2', { t: 'sit', seat: 0 }, 2000))).toBeUndefined(); // not banned by IP
    const later = 1000 + KICK_BAN_MS + 1;
    c.connect('x3', randomHex(16), later);
    expect(err(send(c, 'x3', { t: 'name', name: 'Troll' }, later))).toBeUndefined();
  });
});

describe('oversized frames (QA F1)', () => {
  const room = () => {
    let n = 0;
    return new RoomCore(emptyRoom(), { rng: seededRng(2), newId: () => (++n).toString(16).padStart(10, '0'), videoMeta: () => null, store: memoryStore() });
  };
  it('frames over 16 KiB get too_big, never crash; repeats close the socket', () => {
    expect(frameTooBig('x'.repeat(MAX_MSG_BYTES + 1))).toBe(true);
    expect(frameTooBig('ح'.repeat(MAX_MSG_BYTES / 2 + 1))).toBe(true); // 2 bytes each in UTF-8
    expect(frameTooBig('x'.repeat(MAX_MSG_BYTES))).toBe(false);
    expect(frameTooBig(new ArrayBuffer(MAX_MSG_BYTES + 1))).toBe(true);
    expect(parseClientMsg('{"t":"chat","text":"' + 'a'.repeat(MAX_MSG_BYTES) + '"}')).toBeNull();
    const c = room();
    c.connect('a', randomHex(16), 1);
    c.connect('b', randomHex(16), 1);
    expect(c.message('a', 'too_big', 2)).toEqual([{ to: 'a', msg: { t: 'error', code: 'too_big' } }]);
    const out: Out[] = [];
    // The socket closes as soon as the limit is crossed; later calls return [] (connection gone), so collect all.
    for (let i = 0; i < BAD_PER_10S + 1; i++) out.push(...c.message('a', 'too_big', 3));
    expect(out).toContainEqual({ close: 'a', code: CLOSE_ABUSE, reason: 'abuse' });
    expect(c.conns.has('b')).toBe(true);
  });
});
