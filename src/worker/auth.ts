/**
 * Passphrase + session helpers (pure WebCrypto, runs in Workers and Node 22 tests).
 * Secrets come only from env; nothing here logs or stores a phrase.
 */

const enc = new TextEncoder();

// Arabic tashkeel / Quranic marks, superscript alef, tatweel, and invisible format chars (ZWJ/ZWNJ, LRM/RLM/ALM, bidi, BOM, soft hyphen).
const STRIP_RE = /[\u0610-\u061A\u061C\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED\u08D3-\u08FF\u0640\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u00AD]/g;
// Look-alike letters that phone keyboards (Arabic / Persian / Urdu layouts) swap. Escapes only, so file encoding can never break them.
const ALEF_RE = /[\u0622\u0623\u0625\u0671\u0672\u0673\u0675]/g; // madda, hamza above/below, wasla -> alef
const YA_RE = /[\u0649\u06CC\u06CD\u06CE\u06D0\u06D2]/g; // alef maqsura, Farsi yeh, yeh barree -> ya
const KAF_RE = /[\u06A9\u06AA]/g; // keheh, swash kaf -> kaf
const HEH_RE = /[\u0629\u06BE\u06C0-\u06C3\u06D5]/g; // ta marbuta, heh doachashmee, heh goal, ae -> heh

/**
 * NFKC (presentation forms, NBSP), strip tashkeel/tatweel/invisible chars, fold look-alike letters,
 * collapse whitespace, trim. phraseMatches applies it to BOTH the submitted and the configured phrase,
 * so the stored secret never has to be re-set when this changes.
 */
export function normalizePhrase(input: string): string {
  return input.normalize('NFKC').replace(STRIP_RE, '')
    .replace(ALEF_RE, '\u0627').replace(YA_RE, '\u064A').replace(KAF_RE, '\u0643').replace(HEH_RE, '\u0647')
    .replace(/\s+/gu, ' ').trim();
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await hmacKey(secret);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

/** Constant-time equality for equal-length byte arrays (length mismatch returns false). */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Compare a submitted phrase with the configured one. Both are normalized, then HMAC'd with a
 * key derived from the session secret, so the comparison is fixed-length and constant-time.
 */
export async function phraseMatches(submitted: string, configured: string, sessionSecret: string): Promise<boolean> {
  const want = normalizePhrase(configured);
  if (!want) return false;
  const k = 'phrase-cmp:' + sessionSecret;
  const [a, b] = await Promise.all([hmac(k, normalizePhrase(submitted)), hmac(k, want)]);
  return constantTimeEqual(a, b);
}

// ---------------------------------------------------------------- base64url

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function randomHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- session cookie

export const COOKIE_NAME = '__Host-jk';
export const SESSION_TTL_S = 12 * 60 * 60;

export interface Session { sid: string; exp: number }

export async function signSession(s: Session, secret: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(s)));
  const sig = b64url(await hmac('session:' + secret, payload));
  return `${payload}.${sig}`;
}

/** graceMs > 0 accepts a correctly signed token that expired at most graceMs ago (used only to relax the global login gate). */
export async function verifySession(token: string, secret: string, nowMs: number, graceMs = 0): Promise<Session | null> {
  if (token.length > 512) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = unb64url(token.slice(dot + 1));
  if (!sig) return null;
  const want = await hmac('session:' + secret, payload);
  if (!constantTimeEqual(sig, want)) return null;
  const raw = unb64url(payload);
  if (!raw) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(raw)) as Session;
    if (typeof s.sid !== 'string' || !/^[0-9a-f]{32}$/.test(s.sid) || typeof s.exp !== 'number') return null;
    if (s.exp * 1000 + graceMs <= nowMs) return null;
    return s;
  } catch {
    return null;
  }
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Local-dev only (plain http on a LAN address, enabled by the DEV_INSECURE var that is never in wrangler.toml). */
export const COOKIE_NAME_DEV = 'jk';

export function sessionCookie(token: string, maxAge = SESSION_TTL_S, insecureDev = false): string {
  if (insecureDev) return `${COOKIE_NAME_DEV}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

// ---------------------------------------------------------------- rate limit (pure policy)

export type RateRecord = { fails: number; until: number; last: number };

export const RL_FREE_FAILS = 4;
export const RL_MAX_WAIT_S = 15 * 60;
export const RL_RESET_MS = 60 * 60 * 1000;
export const RL_GLOBAL_WINDOW_MS = 10 * 60 * 1000;
/** Above this many failures per window the global gate slows logins down (never a hard block). */
export const RL_GLOBAL_MAX_FAILS = 40;
/** Max global gap between attempts once over the cap. */
export const RL_GLOBAL_MAX_GAP_S = 20;
/** Browsers holding a signed session (valid or expired up to this long) skip the global gate. */
export const RL_KNOWN_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

export interface GlobalRate { start: number; fails: number; last: number }

/**
 * Global gate (M3): within the window, after RL_GLOBAL_MAX_FAILS failures every new attempt must wait a gap
 * that grows with the excess (1 s, 2 s, 4 s ... capped at RL_GLOBAL_MAX_GAP_S) since the last failure.
 * An outsider can slow strangers down but never lock friends out, and known browsers bypass it.
 */
export function globalWait(g: GlobalRate | null, now: number, known: boolean): number {
  if (known || !g || now - g.start > RL_GLOBAL_WINDOW_MS || g.fails < RL_GLOBAL_MAX_FAILS) return 0;
  const over = g.fails - RL_GLOBAL_MAX_FAILS;
  const gap = Math.min(RL_GLOBAL_MAX_GAP_S, 2 ** Math.floor(over / 10)) * 1000;
  const left = (g.last ?? g.start) + gap - now;
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/** Rate-limit bucket for an IP: IPv4 as is, IPv6 by its /64 prefix (a /64 is one subscriber). */
export function ipBucket(ip: string): string {
  if (!ip.includes(':')) return ip.trim();
  const [head = '', tail = ''] = ip.trim().toLowerCase().split('::', 2);
  const h = head ? head.split(':') : [];
  const t = ip.includes('::') ? (tail ? tail.split(':') : []) : [];
  const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return groups.slice(0, 4).map((g) => (g || '0').replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

/** Read a request body with a hard byte cap even without Content-Length (chunked). null = too big. */
export async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { try { await reader.cancel(); } catch { /* noop */ } return null; }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.byteLength; }
  return new TextDecoder().decode(all);
}

/** Seconds the client must wait now (0 = may try). */
export function waitSeconds(rec: RateRecord | null, now: number): number {
  if (!rec || rec.until <= now) return 0;
  return Math.ceil((rec.until - now) / 1000);
}

/** Record a failure; returns the updated record (exponential backoff after a few free tries). */
export function recordFailure(rec: RateRecord | null, now: number): RateRecord {
  const fresh = !rec || now - rec.last > RL_RESET_MS;
  const fails = (fresh ? 0 : rec!.fails) + 1;
  const over = fails - RL_FREE_FAILS;
  const waitS = over > 0 ? Math.min(RL_MAX_WAIT_S, 5 * 2 ** (over - 1)) : 0;
  return { fails, until: now + waitS * 1000, last: now };
}
