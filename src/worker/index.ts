/**
 * Worker entry: static assets + API. All game state lives in the single GameRoom Durable Object.
 * Secrets (PASSPHRASE, SESSION_SECRET, YT_API_KEY, TURN_*) are read from env only and never logged.
 */

import {
  COOKIE_NAME, COOKIE_NAME_DEV, RL_KNOWN_GRACE_MS, SESSION_TTL_S, randomHex, readCapped, readCookie, sessionCookie, signSession, verifySession, type Session,
} from './auth';
import { ROBOTS_TXT, insecureDev, withSecurityHeaders, wssOrigins } from './headers';
import type { Env } from './env';
import { CLOSE_AUTH } from '../shared/protocol';

export { GameRoom } from './room';

const ROOM_NAME = 'main';

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

function originAllowed(req: Request, env: Env): boolean {
  const origin = req.headers.get('Origin');
  if (!origin) return false;
  // Exact match against the configured allowlist only; never derived from Host / X-Forwarded-Host (checklist 2-3).
  return (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
}

function configured(env: Env): boolean {
  return !!env.PASSPHRASE && !!env.SESSION_SECRET && env.SESSION_SECRET.length >= 32;
}

async function session(req: Request, env: Env): Promise<Session | null> {
  const dev = insecureDev(env, new URL(req.url));
  const tok = readCookie(req.headers.get('Cookie'), dev ? COOKIE_NAME_DEV : COOKIE_NAME);
  if (!tok || !env.SESSION_SECRET) return null;
  return verifySession(tok, env.SESSION_SECRET, Date.now());
}

async function tabSid(tab: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('tab:' + tab)));
  return Array.from(mac.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

function room(env: Env): DurableObjectStub {
  return env.ROOM.get(env.ROOM.idFromName(ROOM_NAME));
}

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  if (!configured(env)) return json({ ok: false, reason: 'not_configured' }, 503);
  const path = url.pathname;

  if (path === '/api/auth') {
    if (req.method !== 'POST') return json({ ok: false }, 405);
    if (!originAllowed(req, env)) return json({ ok: false }, 403);
    const len = Number(req.headers.get('content-length') ?? '0');
    if (len > 1024) return json({ ok: false }, 413);
    const text = await readCapped(req, 1024); // hard cap even for chunked bodies (L6)
    if (text === null) return json({ ok: false }, 413);
    let phrase: unknown;
    try {
      phrase = (JSON.parse(text) as { phrase?: unknown } | null)?.phrase;
    } catch {
      phrase = undefined;
    }
    // Malformed input gets the same answer as a wrong phrase (L3 / checklist 7), never 500 or a match.
    if (typeof phrase !== 'string' || phrase.length > 128) return json({ ok: false }, 401);
    const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
    // A browser that already holds a signed session (even recently expired) skips the global gate (M3).
    const prev = readCookie(req.headers.get('Cookie'), insecureDev(env, url) ? COOKIE_NAME_DEV : COOKIE_NAME);
    const known = !!prev && !!(await verifySession(prev, env.SESSION_SECRET!, Date.now(), RL_KNOWN_GRACE_MS));
    const r = await room(env).fetch('https://room/internal/auth', {
      method: 'POST',
      body: JSON.stringify({ ip, phrase, known }),
    });
    const verdict = (await r.json()) as { ok: boolean; wait?: number };
    if (!verdict.ok) return json({ ok: false, ...(verdict.wait ? { wait: verdict.wait } : {}) }, verdict.wait ? 429 : 401);
    const s: Session = { sid: randomHex(16), exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S };
    const token = await signSession(s, env.SESSION_SECRET!);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(token, SESSION_TTL_S, insecureDev(env, url)) });
  }

  if (path === '/api/logout') {
    if (req.method !== 'POST' || !originAllowed(req, env)) return json({ ok: false }, 403);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0, insecureDev(env, url)) });
  }

  const s = await session(req, env);
  if (!s) {
    // Browsers hide HTTP status on failed upgrades, so tell WS clients with close code 4401 instead.
    if (path === '/api/ws' && req.headers.get('Upgrade')?.toLowerCase() === 'websocket' && originAllowed(req, env)) {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].close(CLOSE_AUTH, 'auth');
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return json({ ok: false, reason: 'auth' }, 401);
  }

  if (path === '/api/session') return json({ ok: true });

  if (path === '/api/ws') {
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ ok: false }, 426);
    if (!originAllowed(req, env)) return json({ ok: false }, 403);
    // Each browser tab is its own player. The tab id lives in sessionStorage (survives a refresh and the passphrase
    // being typed again, never shared between tabs). Identity = HMAC(secret, tab id): stable across logins, unguessable
    // for other players, and bound to the server secret. Without a valid tab id the login session id is used.
    const tab = url.searchParams.get('t') ?? '';
    const sid = /^[0-9a-f]{16}$/.test(tab) ? await tabSid(tab, env.SESSION_SECRET!) : s.sid;
    const headers = new Headers({ Upgrade: 'websocket', 'X-Sid': sid });
    return room(env).fetch(new Request('https://room/internal/ws', { headers }));
  }

  if (path === '/api/search') {
    if (req.method !== 'GET') return json({ ok: false }, 405);
    const q = url.searchParams.get('q') ?? '';
    if (q.length > 200) return json({ ok: false }, 400);
    const u = new URL('https://room/internal/search');
    u.searchParams.set('q', q);
    return room(env).fetch(new Request(u.toString(), { headers: { 'X-Sid': s.sid } }));
  }

  if (path === '/api/ice') {
    if (req.method !== 'GET') return json({ ok: false }, 405);
    // Session required (above); per-session rate limit lives in the DO.
    return room(env).fetch(new Request('https://room/internal/ice', { headers: { 'X-Sid': s.sid } }));
  }

  return json({ ok: false }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const host = url.host;
    const secure = !insecureDev(env, url);
    const wss = wssOrigins(env);
    if (url.pathname === '/robots.txt') {
      return withSecurityHeaders(new Response(ROBOTS_TXT, { headers: { 'content-type': 'text/plain' } }), host, secure, wss);
    }
    if (url.pathname.startsWith('/api/')) {
      const res = await handleApi(req, env, url);
      if (res.status === 101) return res; // WebSocket upgrade: pass through untouched
      return withSecurityHeaders(res, host, secure, wss);
    }
    const res = await env.ASSETS.fetch(req);
    return withSecurityHeaders(res, host, secure, wss);
  },
} satisfies ExportedHandler<Env>;
