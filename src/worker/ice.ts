/**
 * ICE servers for the voice mesh. STUN is always included (free).
 * TURN, only if the owner configured it (secrets via `wrangler secret put`, never in files):
 *  - Cloudflare Realtime TURN: TURN_KEY_ID + TURN_KEY_API_TOKEN (short-lived credentials generated per request).
 *  - Generic TURN (e.g. a self-hosted coturn or any free provider): TURN_URLS (comma list of turn:/turns: URLs),
 *    TURN_USERNAME, TURN_CREDENTIAL. These are static, so only authenticated, rate-limited sessions receive them.
 *  - Turnix: TURNIX_API_TOKEN (short-lived credentials fetched server-side, see turnixIce).
 * If none is set: STUN only, and some CGNAT/mobile networks will not connect.
 */

import type { IceServer } from '../shared/protocol';

export const STUN: IceServer = { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] };
const TURN_TTL_S = 4 * 60 * 60;

export interface IceEnv {
  TURN_KEY_ID?: string; TURN_KEY_API_TOKEN?: string;
  TURN_URLS?: string; TURN_USERNAME?: string; TURN_CREDENTIAL?: string;
  /** Turnix API token (secret). Credentials are fetched server-side per /api/ice request (cached briefly). */
  TURNIX_API_TOKEN?: string;
}

const ICE_URL_RE = /^(stun|turns?):[A-Za-z0-9.:?=&_\-\[\]]+$/;

/** Generic TURN from env; null when not (fully) configured or malformed. */
export function genericTurn(env: IceEnv): IceServer | null {
  const urls = (env.TURN_URLS ?? '').split(',').map((u) => u.trim()).filter((u) => ICE_URL_RE.test(u) && u.length <= 256).slice(0, 8);
  if (!urls.length || !env.TURN_USERNAME || !env.TURN_CREDENTIAL) return null;
  if (env.TURN_USERNAME.length > 256 || env.TURN_CREDENTIAL.length > 256) return null;
  return { urls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL };
}

function cleanServer(x: unknown): IceServer | null {
  const o = x as { urls?: unknown; username?: unknown; credential?: unknown };
  const urls = Array.isArray(o?.urls) ? o.urls : typeof o?.urls === 'string' ? [o.urls] : [];
  const ok = urls.filter((u): u is string => typeof u === 'string' && ICE_URL_RE.test(u));
  if (!ok.length) return null;
  const s: IceServer = { urls: ok };
  if (typeof o.username === 'string') s.username = o.username;
  if (typeof o.credential === 'string') s.credential = o.credential;
  return s;
}

/**
 * Turnix (turnix.io, free plan: no overage, 429 at the allowance, so it can never bill).
 * Per official docs (turnix.io/docs/api-reference/credentials, read 2026-11-13):
 *   POST https://turnix.io/api/v1/credentials/ice, Authorization: Bearer <token>, JSON body {ttl}
 *   -> 200 {iceServers: [STUN, TURN{username, credential, urls}], expiresAt: ISO-8601}.
 * We do not send X-TURN-CLIENT-IP (players' IPs stay private); Turnix then geo-routes by the Worker's IP.
 * The token is a secret (TURNIX_API_TOKEN), used only server-side, never returned or logged.
 */
export const TURNIX_URL = 'https://turnix.io/api/v1/credentials/ice';
export const TURNIX_TTL_S = 3600;
/** Reuse one fetched credential for this long (must stay well under the TTL). */
export const TURNIX_CACHE_MS = 5 * 60_000;

export interface TurnixCache { servers: IceServer[]; until: number }

export async function turnixIce(
  env: IceEnv, fetcher: typeof fetch, now: number, cache?: { v: TurnixCache | null },
): Promise<IceServer[] | null> {
  const token = env.TURNIX_API_TOKEN;
  if (!token || token.length > 512) return null;
  if (cache?.v && cache.v.until > now) return cache.v.servers;
  try {
    const r = await fetcher(TURNIX_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: TURNIX_TTL_S }),
    });
    if (!r.ok) return null; // 401/422/429 (free allowance used up) -> fall back, body never logged
    const j = (await r.json()) as { iceServers?: unknown; expiresAt?: unknown };
    const list = (Array.isArray(j.iceServers) ? j.iceServers : []).map(cleanServer).filter((x): x is IceServer => !!x);
    if (!list.some((x) => (x.urls as string[]).some((u) => u.startsWith('turn')))) return null;
    const exp = typeof j.expiresAt === 'string' ? Date.parse(j.expiresAt) : NaN;
    const until = Math.min(now + TURNIX_CACHE_MS, Number.isFinite(exp) ? exp - 60_000 : now + TURNIX_CACHE_MS);
    if (cache && until > now) cache.v = { servers: list, until };
    return list;
  } catch {
    return null;
  }
}

export async function iceServers(
  env: IceEnv, fetcher: typeof fetch = fetch, now = Date.now(), cache?: { v: TurnixCache | null },
): Promise<{ iceServers: IceServer[]; turn: boolean }> {
  const tx = await turnixIce(env, fetcher, now, cache);
  const cf = await cloudflareIce(env, fetcher);
  const gen = genericTurn(env);
  const servers = [...(tx ?? []), ...(tx && !cf.turn ? [] : cf.iceServers), ...(gen ? [gen] : [])];
  return { iceServers: servers.length ? servers : [STUN], turn: !!tx || cf.turn || !!gen };
}

async function cloudflareIce(env: IceEnv, fetcher: typeof fetch): Promise<{ iceServers: IceServer[]; turn: boolean }> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN || !/^[A-Za-z0-9]{8,64}$/.test(env.TURN_KEY_ID)) {
    return { iceServers: [STUN], turn: false };
  }
  try {
    const r = await fetcher(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_TTL_S }),
    });
    if (!r.ok) return { iceServers: [STUN], turn: false };
    const j = (await r.json()) as { iceServers?: unknown };
    const list = (Array.isArray(j.iceServers) ? j.iceServers : [j.iceServers]).map(cleanServer).filter((x): x is IceServer => !!x);
    const hasTurn = list.some((s) => (s.urls as string[]).some((u) => u.startsWith('turn')));
    return { iceServers: hasTurn ? list : [STUN, ...list], turn: hasTurn };
  } catch {
    return { iceServers: [STUN], turn: false };
  }
}
